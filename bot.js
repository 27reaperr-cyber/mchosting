/**
 * Minecraft Server Telegram Bot
 * ---------------------------------------------------------------
 * Single-file production-ready implementation.
 *
 * Stack:
 *   - telegraf            (Telegram Bot framework)
 *   - better-sqlite3      (persistence)
 *   - openai              (used as OnlySQ client; OnlySQ is OpenAI-compatible)
 *   - undici              (HTTP fetch + streaming downloads)
 *   - dotenv              (config)
 *
 * Features:
 *   - Manage Bukkit / Spigot / Paper Minecraft servers
 *   - Live version parsing (PaperMC Fill v3 API + GetBukkit)
 *   - Accept plugin / map / config files (direct upload OR URL)
 *   - OnlySQ AI:
 *       * Decides where to extract uploaded archives (plugins/, worlds/, etc.)
 *       * Analyses server startup logs and suggests fixes
 *   - Access control:
 *       * Admin defined in .env (ADMIN_ID)
 *       * Admin panel: grant/revoke access by @username or user id,
 *         list authorised users, choose AI model from /v1/models
 *
 * Author: senior full-stack & DevOps
 * License: MIT
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');

const { Telegraf, Markup, session } = require('telegraf');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const { request } = require('undici');

// =====================================================================
// 0. CONFIG & VALIDATION
// =====================================================================

const ENV = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    ADMIN_ID: Number(process.env.ADMIN_ID),
    ONLYSQ_API_KEY: process.env.ONLYSQ_API_KEY,
    ONLYSQ_BASE_URL: process.env.ONLYSQ_BASE_URL || 'https://api.onlysq.ru/v1',
    ONLYSQ_DEFAULT_MODEL: process.env.ONLYSQ_DEFAULT_MODEL || 'claude-haiku-4-5',
    SERVERS_ROOT: path.resolve(process.env.SERVERS_ROOT || './servers'),
    JAVA_BIN: process.env.JAVA_BIN || 'java',
    JVM_XMS: process.env.JVM_XMS || '1G',
    JVM_XMX: process.env.JVM_XMX || '2G',
    MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 50),
    DB_PATH: path.resolve(process.env.DB_PATH || './data/bot.db'),
    PAPER_UA: process.env.PAPER_UA || 'mc-tg-bot/1.0.0 (+https://github.com/local)',
};

(function validateEnv() {
    const missing = [];
    if (!ENV.BOT_TOKEN) missing.push('BOT_TOKEN');
    if (!ENV.ADMIN_ID || Number.isNaN(ENV.ADMIN_ID)) missing.push('ADMIN_ID');
    if (!ENV.ONLYSQ_API_KEY) missing.push('ONLYSQ_API_KEY');
    if (missing.length) {
        console.error('❌ Missing required env vars: ' + missing.join(', '));
        console.error('   Copy .env.example → .env and fill in the values.');
        process.exit(1);
    }
})();

// Ensure base directories
fs.mkdirSync(ENV.SERVERS_ROOT, { recursive: true });
fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true });

// ---------------------------------------------------------------
// JAVA AUTO-DETECTION
// ---------------------------------------------------------------
// We try to resolve a usable `java` binary at startup. If the user-provided
// JAVA_BIN works -> we use it. Otherwise we scan JAVA_HOME, $PATH (via
// `which`), and common Linux/macOS/Windows paths. The result is stored back
// into ENV.JAVA_BIN so spawn() never gets a bare 'java' that hits ENOENT.
//
// If nothing works, ENV.JAVA_BIN stays as-is and ENV.JAVA_AVAILABLE = false,
// so we can show a helpful, actionable error to the user before spawning.
// ---------------------------------------------------------------
function tryJavaBinary(bin) {
    if (!bin) return null;
    try {
        const r = spawnSync(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        if (r.error) return null;
        if (r.status === 0 || r.status === null) {
            // `java -version` prints to stderr; just having a clean exit is enough.
            const out = (r.stderr?.toString() || r.stdout?.toString() || '').trim();
            return { bin, version: out.split('\n')[0] || 'unknown' };
        }
    } catch { /* ignore */ }
    return null;
}

function resolveJavaBin(preferred) {
    const candidates = [];
    if (preferred) candidates.push(preferred);
    if (process.env.JAVA_HOME) {
        candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    }
    // `which java` (POSIX) / `where java` (Windows)
    try {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const r = spawnSync(whichCmd, ['java'], { stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.status === 0) {
            const found = r.stdout.toString().split('\n').map(s => s.trim()).filter(Boolean);
            for (const f of found) candidates.push(f);
        }
    } catch { /* ignore */ }
    // Common locations
    candidates.push(
        '/usr/bin/java',
        '/usr/local/bin/java',
        '/opt/java/bin/java',
        'C:\\Program Files\\Java\\jre\\bin\\java.exe',
        'C:\\Program Files\\Eclipse Adoptium\\jre\\bin\\java.exe',
    );
    // Glob-like scan of /usr/lib/jvm/*/bin/java
    try {
        const jvmDir = '/usr/lib/jvm';
        if (fs.existsSync(jvmDir)) {
            for (const entry of fs.readdirSync(jvmDir)) {
                candidates.push(path.join(jvmDir, entry, 'bin', 'java'));
            }
        }
    } catch { /* ignore */ }

    const seen = new Set();
    for (const c of candidates) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        const ok = tryJavaBinary(c);
        if (ok) return ok;
    }
    return null;
}

(function detectJava() {
    const found = resolveJavaBin(ENV.JAVA_BIN);
    if (found) {
        ENV.JAVA_BIN = found.bin;
        ENV.JAVA_AVAILABLE = true;
        ENV.JAVA_VERSION_STR = found.version;
    } else {
        ENV.JAVA_AVAILABLE = false;
        ENV.JAVA_VERSION_STR = '';
    }
})();

// Also try to locate `javac` (used by the AI-plugin generator for compilation)
function resolveJavacBin() {
    const candidates = [];
    if (process.env.JAVAC_BIN) candidates.push(process.env.JAVAC_BIN);
    if (process.env.JAVA_HOME) {
        candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javac'));
    }
    if (ENV.JAVA_BIN) {
        // Sibling of resolved java binary
        candidates.push(path.join(path.dirname(ENV.JAVA_BIN), 'javac'));
    }
    try {
        const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['javac'],
            { stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.status === 0) {
            for (const f of r.stdout.toString().split('\n').map(s => s.trim()).filter(Boolean)) {
                candidates.push(f);
            }
        }
    } catch { /* ignore */ }
    for (const c of candidates) {
        if (!c) continue;
        try {
            const r = spawnSync(c, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
            if (!r.error && (r.status === 0 || r.status === null)) return c;
        } catch { /* ignore */ }
    }
    return null;
}
ENV.JAVAC_BIN = resolveJavacBin();

// =====================================================================
// 1. LOGGER
// =====================================================================

const log = {
    _ts: () => new Date().toISOString(),
    info:  (...a) => console.log  (`[${log._ts()}] [INFO ]`, ...a),
    warn:  (...a) => console.warn (`[${log._ts()}] [WARN ]`, ...a),
    error: (...a) => console.error(`[${log._ts()}] [ERROR]`, ...a),
    debug: (...a) => process.env.DEBUG && console.log(`[${log._ts()}] [DEBUG]`, ...a),
};

// =====================================================================
// 1b. HTML ESCAPING (we use parse_mode='HTML' everywhere — safer than Markdown)
// =====================================================================

/** Escape user-supplied / dynamic text for Telegram HTML parse mode. */
function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Strip HTML noise from an error message and shorten it for logs/UI.
 * Many providers return a giant HTML 404 page that floods both logs
 * and chat messages — we condense it to something useful like
 *   "404 Not Found - OnlySq (HTML)".
 */
function briefHttpError(msg, max = 220) {
    let s = String(msg ?? '').trim();
    // Detect HTML payload and replace with title/code summary
    if (/<!doctype|<html[\s>]|<head[\s>]/i.test(s)) {
        const codeMatch = s.match(/^\s*(\d{3})\b/);
        const titleMatch = s.match(/<title>([^<]+)<\/title>/i);
        const code = codeMatch ? codeMatch[1] : '';
        const title = titleMatch ? titleMatch[1].trim() : 'HTML response';
        s = `${code ? code + ' ' : ''}${title} (HTML)`.trim();
    }
    // Collapse whitespace and trim
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max - 1) + '…';
    return s;
}

// =====================================================================
// 2. DATABASE
// =====================================================================

const db = new Database(ENV.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        tg_id      INTEGER PRIMARY KEY,
        username   TEXT,
        granted_by INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS pending_usernames (
        username   TEXT PRIMARY KEY COLLATE NOCASE,
        granted_by INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS servers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id   INTEGER NOT NULL,
        name       TEXT    NOT NULL,
        flavor     TEXT    NOT NULL,
        mc_version TEXT    NOT NULL,
        dir        TEXT    NOT NULL UNIQUE,
        jar        TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);
`);

// Ensure admin from .env always has access
db.prepare(
    `INSERT OR IGNORE INTO users(tg_id, username, granted_by) VALUES (?, ?, ?)`
).run(ENV.ADMIN_ID, 'admin', ENV.ADMIN_ID);

function getSetting(key, fallback = null) {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return r ? r.value : fallback;
}
function setSetting(key, value) {
    db.prepare(
        `INSERT INTO settings(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(key, String(value));
}
if (!getSetting('ai_model')) setSetting('ai_model', ENV.ONLYSQ_DEFAULT_MODEL);

// Access helpers
function isAdmin(tgId) { return Number(tgId) === ENV.ADMIN_ID; }

function hasAccess(tgId, username) {
    if (isAdmin(tgId)) return true;
    const byId = db.prepare(`SELECT 1 FROM users WHERE tg_id = ?`).get(tgId);
    if (byId) return true;

    if (username) {
        const pending = db.prepare(
            `SELECT granted_by FROM pending_usernames WHERE username = ? COLLATE NOCASE`
        ).get(username);
        if (pending) {
            db.prepare(
                `INSERT OR IGNORE INTO users(tg_id, username, granted_by) VALUES (?,?,?)`
            ).run(tgId, username, pending.granted_by);
            db.prepare(`DELETE FROM pending_usernames WHERE username = ? COLLATE NOCASE`)
                .run(username);
            return true;
        }
    }
    return false;
}

function grantAccess(target, grantedBy) {
    const t = String(target).trim().replace(/^@/, '');
    if (!t) return { kind: 'error', value: 'empty' };
    if (/^\d+$/.test(t)) {
        const id = Number(t);
        db.prepare(
            `INSERT OR IGNORE INTO users(tg_id, username, granted_by) VALUES (?,?,?)`
        ).run(id, null, grantedBy);
        return { kind: 'id', value: id };
    }
    if (!/^[A-Za-z0-9_]{3,32}$/.test(t)) return { kind: 'error', value: 'bad_username' };
    db.prepare(
        `INSERT OR REPLACE INTO pending_usernames(username, granted_by) VALUES (?,?)`
    ).run(t, grantedBy);
    return { kind: 'username', value: t };
}

function revokeAccess(target) {
    const t = String(target).trim().replace(/^@/, '');
    if (!t) return { ok: false, reason: 'empty' };
    if (/^\d+$/.test(t)) {
        const id = Number(t);
        if (id === ENV.ADMIN_ID) return { ok: false, reason: 'Нельзя удалить главного администратора.' };
        const r = db.prepare(`DELETE FROM users WHERE tg_id = ?`).run(id);
        return { ok: r.changes > 0, kind: 'id', value: id };
    }
    const r1 = db.prepare(`DELETE FROM users WHERE username = ? COLLATE NOCASE`).run(t);
    const r2 = db.prepare(`DELETE FROM pending_usernames WHERE username = ? COLLATE NOCASE`).run(t);
    return { ok: (r1.changes + r2.changes) > 0, kind: 'username', value: t };
}

function listUsers() {
    const users = db.prepare(`SELECT tg_id, username, granted_by, created_at FROM users ORDER BY created_at`).all();
    const pending = db.prepare(`SELECT username, granted_by, created_at FROM pending_usernames ORDER BY created_at`).all();
    return { users, pending };
}

// =====================================================================
// 3. OnlySQ CLIENT (OpenAI-compatible)
// =====================================================================

const onlysq = new OpenAI({
    apiKey: ENV.ONLYSQ_API_KEY,
    baseURL: ENV.ONLYSQ_BASE_URL,
});

/**
 * Try a few endpoints — OnlySQ may not expose /v1/models the same way as OpenAI.
 * On any failure, return a curated fallback list (so admin panel still works).
 */
async function listOnlySqModels() {
    const fallback = [
        'claude-haiku-4-5',
        'claude-sonnet-4-5',
        'gpt-4o',
        'gpt-4o-mini',
        'gemini-2.5-pro',
        'deepseek-r1',
    ];

    // 1) Try the OpenAI SDK's models.list (auto-paged)
    try {
        const r = await onlysq.models.list();
        const items = [];
        for await (const m of r) items.push(m);
        if (items.length) return items.map((m) => m.id).filter(Boolean).sort();
    } catch (e) {
        log.warn('models.list via SDK failed:', briefHttpError(e.message));
    }

    // 2) Try a raw GET against {base}/models — strip duplicate /v1 if present
    const tryUrls = new Set();
    const base = ENV.ONLYSQ_BASE_URL.replace(/\/+$/, '');
    tryUrls.add(`${base}/models`);
    // If base already ends with /v1, also try the root + /v1/models
    if (/\/v1$/.test(base)) tryUrls.add(`${base.replace(/\/v1$/, '')}/models`);
    // Some providers expose /v1beta or /api/models
    tryUrls.add(`${base.replace(/\/v1$/, '')}/api/models`);

    for (const url of tryUrls) {
        try {
            const { statusCode, body } = await request(url, {
                headers: {
                    'Authorization': `Bearer ${ENV.ONLYSQ_API_KEY}`,
                    'Accept': 'application/json',
                },
            });
            if (statusCode !== 200) {
                body.dump?.(); // drain
                continue;
            }
            const data = await body.json().catch(() => null);
            if (!data) continue;
            const arr = Array.isArray(data) ? data
                      : Array.isArray(data.data) ? data.data
                      : Array.isArray(data.models) ? data.models
                      : null;
            if (arr && arr.length) {
                return arr.map((m) => m.id || m.name || m).filter(Boolean).sort();
            }
        } catch (e) {
            log.warn(`models endpoint ${url} failed:`, briefHttpError(e.message));
        }
    }

    log.warn('All model-listing attempts failed, using fallback list.');
    return fallback;
}

async function aiChat({ system, user, model, jsonMode = false, maxTokens = 1500 }) {
    const m = model || getSetting('ai_model') || ENV.ONLYSQ_DEFAULT_MODEL;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    try {
        const resp = await onlysq.chat.completions.create({
            model: m,
            messages,
            max_tokens: maxTokens,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        });
        return resp.choices?.[0]?.message?.content?.trim() ?? '';
    } catch (e) {
        // Clean up the message — OpenAI SDK includes raw HTML when provider returns 404.
        const brief = briefHttpError(e?.message || String(e));
        const err = new Error(brief);
        err.original = e;
        throw err;
    }
}

// =====================================================================
// 4. MINECRAFT VERSION PROVIDERS
// =====================================================================

const PaperAPI = {
    base: 'https://fill.papermc.io/v3',
    headers: () => ({ 'User-Agent': ENV.PAPER_UA, Accept: 'application/json' }),

    async listVersions(project = 'paper') {
        const { body, statusCode } = await request(`${this.base}/projects/${project}`, {
            headers: this.headers(),
        });
        if (statusCode !== 200) {
            body.dump?.();
            throw new Error(`Paper API ${statusCode}`);
        }
        const data = await body.json();
        const versions = [];
        for (const list of Object.values(data.versions || {})) {
            for (const v of list) versions.push(v);
        }
        return versions;
    },

    async getDownload(project, mcVersion) {
        const { body, statusCode } = await request(
            `${this.base}/projects/${project}/versions/${mcVersion}/builds`,
            { headers: this.headers() }
        );
        if (statusCode !== 200) {
            body.dump?.();
            throw new Error(`Paper builds API ${statusCode}`);
        }
        const builds = await body.json();
        const stable = builds.find((b) => b.channel === 'STABLE') || builds[0];
        if (!stable) throw new Error('No builds found');
        const dl = stable.downloads?.['server:default'];
        if (!dl?.url) throw new Error('No server:default download');
        return { url: dl.url, filename: dl.name || `${project}-${mcVersion}.jar`, sha256: dl.checksums?.sha256 };
    },
};

const GetBukkitAPI = {
    KNOWN_VERSIONS: [
        '1.21.1', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.19.2',
        '1.18.2', '1.17.1', '1.16.5', '1.15.2', '1.14.4', '1.13.2', '1.12.2',
        '1.11.2', '1.10.2', '1.9.4', '1.8.8',
    ],
    spigotUrl: (v) => `https://download.getbukkit.org/spigot/spigot-${v}.jar`,
    bukkitUrl: (v) => `https://download.getbukkit.org/craftbukkit/craftbukkit-${v}.jar`,

    list() { return [...this.KNOWN_VERSIONS]; },
    getDownload(flavor, version) {
        if (flavor === 'spigot') return { url: this.spigotUrl(version), filename: `spigot-${version}.jar` };
        if (flavor === 'bukkit') return { url: this.bukkitUrl(version), filename: `craftbukkit-${version}.jar` };
        throw new Error('Unknown flavor: ' + flavor);
    },
};

async function getServerVersions(flavor) {
    if (flavor === 'paper') return await PaperAPI.listVersions('paper');
    return GetBukkitAPI.list();
}
async function resolveServerDownload(flavor, version) {
    if (flavor === 'paper') return await PaperAPI.getDownload('paper', version);
    return GetBukkitAPI.getDownload(flavor, version);
}

// =====================================================================
// 5. FILE / DOWNLOAD UTILITIES
// =====================================================================

async function downloadToFile(url, dest, extraHeaders = {}) {
    const headers = { 'User-Agent': ENV.PAPER_UA, ...extraHeaders };
    let res;
    try {
        res = await request(url, { headers, maxRedirections: 10 });
    } catch (e) {
        throw new Error(`Network error: ${e.message}`);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
        res.body.dump?.();
        throw new Error(`HTTP ${res.statusCode} when downloading ${url}`);
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(res.body, createWriteStream(dest));
    return dest;
}

function safeName(s) {
    return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'server';
}

function ensureDirSync(p) { fs.mkdirSync(p, { recursive: true }); }

function detectFileKind(filename) {
    const f = String(filename || '').toLowerCase();
    if (f.endsWith('.jar')) return 'jar';
    if (f.endsWith('.zip')) return 'zip';
    if (f.endsWith('.tar.gz') || f.endsWith('.tgz')) return 'tar.gz';
    if (f.endsWith('.tar')) return 'tar';
    if (f.endsWith('.yml') || f.endsWith('.yaml')) return 'yaml';
    if (f.endsWith('.json')) return 'json';
    if (f.endsWith('.properties')) return 'properties';
    if (f.endsWith('.mcworld') || f.endsWith('.mcpack')) return 'mcworld';
    return 'unknown';
}

/**
 * Verify that `child` resolves inside `parent` (prevents path-escape via `..`).
 */
function isPathInside(parent, child) {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// =====================================================================
// 6. SERVER REPOSITORY (CRUD over `servers` table)
// =====================================================================

const ServersRepo = {
    create({ ownerId, name, flavor, mcVersion, dir, jar }) {
        const info = db.prepare(
            `INSERT INTO servers(owner_id, name, flavor, mc_version, dir, jar) VALUES (?,?,?,?,?,?)`
        ).run(ownerId, name, flavor, mcVersion, dir, jar);
        return this.byId(info.lastInsertRowid);
    },
    byId(id) { return db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id); },
    listByOwner(ownerId) {
        return db.prepare(`SELECT * FROM servers WHERE owner_id = ? ORDER BY id DESC`).all(ownerId);
    },
    listAll() { return db.prepare(`SELECT * FROM servers ORDER BY id DESC`).all(); },
    delete(id) { return db.prepare(`DELETE FROM servers WHERE id = ?`).run(id).changes; },
};

// =====================================================================
// 7. RUNTIME REGISTRY (in-memory: live processes)
// =====================================================================

/** Map<serverId, { child, chatId, log: string[], startedAt }> */
const RUNNING = new Map();

function tailString(s, max = 4000) {
    if (s.length <= max) return s;
    return '…' + s.slice(s.length - max);
}

async function startServer(server, ctx) {
    if (RUNNING.has(server.id)) {
        await ctx.reply('⚠️ Сервер уже запущен.').catch(() => {});
        return;
    }

    // ---- Pre-flight: make sure java is actually available. ----
    // If we couldn't locate java at startup, OR the previously-resolved binary
    // has disappeared, re-detect once. If still nothing — bail out with a
    // detailed, actionable message (no more cryptic `ENOENT`).
    if (!ENV.JAVA_AVAILABLE || !ENV.JAVA_BIN || !tryJavaBinary(ENV.JAVA_BIN)) {
        const redetected = resolveJavaBin(ENV.JAVA_BIN);
        if (redetected) {
            ENV.JAVA_BIN = redetected.bin;
            ENV.JAVA_AVAILABLE = true;
            ENV.JAVA_VERSION_STR = redetected.version;
            log.info('Java re-detected at runtime:', ENV.JAVA_BIN);
        } else {
            ENV.JAVA_AVAILABLE = false;
            await ctx.reply(
                '❌ <b>Java не найдена на этом хосте.</b>\n\n' +
                'Бот не может запустить Minecraft-сервер, потому что в системе ' +
                'отсутствует исполняемый файл <code>java</code>.\n\n' +
                '<b>Что сделать:</b>\n' +
                '• Ubuntu/Debian: <code>sudo apt update &amp;&amp; sudo apt install -y openjdk-21-jre-headless</code>\n' +
                '• Alpine: <code>apk add openjdk21-jre</code>\n' +
                '• Docker: используйте базовый образ <code>eclipse-temurin:21-jre</code>\n\n' +
                'После установки укажите путь в <code>.env</code>:\n' +
                '<code>JAVA_BIN=/usr/bin/java</code>\n' +
                'или экспортируйте <code>JAVA_HOME</code>, и перезапустите бота.',
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
    }

    await fsp.writeFile(path.join(server.dir, 'eula.txt'), 'eula=true\n');

    const args = [
        `-Xms${ENV.JVM_XMS}`,
        `-Xmx${ENV.JVM_XMX}`,
        '-XX:+UseG1GC',
        '-jar', server.jar,
        'nogui',
    ];
    log.info(`Starting server #${server.id} (${server.flavor} ${server.mc_version}) in ${server.dir} via ${ENV.JAVA_BIN}`);

    let child;
    try {
        child = spawn(ENV.JAVA_BIN, args, {
            cwd: server.dir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (e) {
        log.error(`spawn() threw synchronously for server #${server.id}:`, e.message);
        await ctx.reply(
            `❌ Не удалось запустить процесс Java: <code>${esc(e.message)}</code>\n` +
            `Путь: <code>${esc(ENV.JAVA_BIN)}</code>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
    }

    const state = {
        child,
        chatId: ctx.chat.id,
        log: [],
        startedAt: Date.now(),
        bootLogForAI: '',
        bootDone: false,
    };
    RUNNING.set(server.id, state);

    const collect = (chunk) => {
        const text = chunk.toString('utf8');
        state.log.push(text);
        if (state.log.length > 500) state.log.shift();
        if (!state.bootDone) {
            state.bootLogForAI += text;
            if (state.bootLogForAI.length > 8000) state.bootLogForAI = state.bootLogForAI.slice(-8000);
            if (/Done \([\d.]+s\)!/.test(text) || /For help, type/.test(text)) {
                state.bootDone = true;
                ctx.telegram.sendMessage(
                    state.chatId,
                    `✅ Сервер «<b>${esc(server.name)}</b>» успешно запустился.`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }
        }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (e) => {
        log.error(`Child error for server #${server.id}:`, e.message);
        RUNNING.delete(server.id);
        let hint = '';
        if (/ENOENT/i.test(e.message)) {
            hint =
                '\n\n<i>Похоже, исполняемый файл <code>java</code> недоступен. ' +
                'Установите OpenJDK 17+ и пропишите путь в <code>JAVA_BIN</code> в <code>.env</code>.</i>';
        }
        ctx.telegram.sendMessage(
            state.chatId,
            `❌ Не удалось запустить процесс Java: <code>${esc(e.message)}</code>` +
            `\nИспользуемый путь: <code>${esc(ENV.JAVA_BIN)}</code>${hint}`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    });

    child.on('exit', async (code) => {
        RUNNING.delete(server.id);
        const tail = tailString(state.log.join(''), 3500);
        await ctx.telegram.sendMessage(
            state.chatId,
            `🛑 Сервер «<b>${esc(server.name)}</b>» остановлен (код ${esc(code)}).`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
        if (code !== 0) {
            try {
                const verdict = await aiAnalyseStartup(tail, server);
                await ctx.telegram.sendMessage(
                    state.chatId,
                    `🤖 <b>AI-разбор завершения сервера:</b>\n${esc(verdict)}`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            } catch (e) { log.warn('AI post-mortem failed:', e.message); }
        }
    });

    setTimeout(async () => {
        const st = RUNNING.get(server.id);
        if (!st || st.bootDone) return;
        try {
            const verdict = await aiAnalyseStartup(st.bootLogForAI, server);
            ctx.telegram.sendMessage(
                st.chatId,
                `🤖 <b>AI-диагностика запуска (20 сек):</b>\n${esc(verdict)}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        } catch (e) { log.warn('AI boot-check failed:', e.message); }
    }, 20_000);

    await ctx.reply(
        `🚀 Сервер «<b>${esc(server.name)}</b>» запускается…\n` +
        `Лог появится через несколько секунд.`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📜 Показать лог', `srv:log:${server.id}`)],
                [Markup.button.callback('🛑 Остановить',   `srv:stop:${server.id}`)],
                [Markup.button.callback('⬅️ К серверу',    `srv:open:${server.id}`)],
            ]),
        }
    ).catch(() => {});
}

function stopServer(serverId) {
    const st = RUNNING.get(serverId);
    if (!st) return false;
    try { st.child.stdin.write('stop\n'); } catch {}
    setTimeout(() => {
        if (RUNNING.has(serverId)) {
            try { st.child.kill('SIGTERM'); } catch {}
        }
    }, 8000);
    return true;
}

// =====================================================================
// 8. AI HELPERS  (startup analysis + file placement)
// =====================================================================

async function aiAnalyseStartup(logText, server) {
    const system = `Ты — эксперт по администрированию Minecraft-серверов
(Paper/Spigot/Bukkit). Тебе дают хвост лога старта сервера.
Кратко (5–10 строк, на русском) ответь:
1) Запустился ли сервер корректно (Да / Нет / Частично).
2) Если есть ошибки — какие и как их исправить.
3) Дай 1–2 совета по оптимизации, если уместно.
Не выдумывай факты, опирайся только на лог.`;
    const user = `Сервер: ${server.flavor} ${server.mc_version}, директория ${server.dir}\n\n=== ЛОГ ===\n${logText}`;
    return await aiChat({ system, user, maxTokens: 600 });
}

async function aiPlanFilePlacement({ filename, kind, server, listing }) {
    const system = `Ты — ассистент по установке файлов на Minecraft-сервер
(${server.flavor} ${server.mc_version}).
Дано имя файла, его тип и (для архивов) список вложенных файлов.
Реши, КУДА положить файл или его содержимое внутри директории сервера.

Стандартные подкаталоги:
  - plugins/      → плагины (.jar) для Bukkit/Spigot/Paper
  - world/        → файлы основного мира
  - world_nether/, world_the_end/  → дополнительные миры
  - config/       → конфигурации плагинов
  - .             → корень (для server.properties, bukkit.yml и т. п.)

Ответ верни СТРОГО в JSON формате (без обрамления):
{
  "action": "place" | "extract",
  "target": "<относительный путь>",
  "reason": "<короткое объяснение на русском, 1–2 предложения>"
}
Если файл — это .jar и в имени видно слово plugin / название плагина — target="plugins".
Если архив содержит level.dat — это карта мира, target="world".
Если архив содержит много .jar — target="plugins", action="extract".
Если непонятно — используй target="." и пометь в reason неопределённость.`;

    const userMsg =
        `Файл: ${filename}\n` +
        `Тип: ${kind}\n` +
        (listing ? `Содержимое архива (до 50 записей):\n${listing.slice(0, 50).join('\n')}` : '');

    const raw = await aiChat({ system, user: userMsg, jsonMode: true, maxTokens: 400 });
    try {
        const j = JSON.parse(raw);
        if (!j.target || typeof j.target !== 'string') j.target = '.';
        if (!j.action) j.action = ['zip', 'tar', 'tar.gz'].includes(kind) ? 'extract' : 'place';
        if (j.action !== 'place' && j.action !== 'extract') j.action = 'place';
        if (typeof j.reason !== 'string') j.reason = '';
        return j;
    } catch {
        if (kind === 'jar') return { action: 'place', target: 'plugins', reason: 'JAR → плагины (heuristic).' };
        if (['zip', 'tar.gz', 'tar'].includes(kind)) {
            return { action: 'extract', target: '.', reason: 'Архив → корень (heuristic).' };
        }
        return { action: 'place', target: '.', reason: 'Неизвестный тип → корень (heuristic).' };
    }
}

// ---------------------------------------------------------------
// 8b. AI PLUGIN / SCRIPT GENERATOR
// ---------------------------------------------------------------
// Generate a brand-new plugin or script from a natural-language prompt.
// The AI also receives a brief snapshot of the server's plugins/ folder
// so it can avoid duplicating functionality and pick a sensible type.
//
// Supported output types:
//   - skript      → a .sk file placed under plugins/Skript/scripts/
//   - java-plugin → Bukkit/Spigot/Paper plugin source.
//                   We save .java + plugin.yml under a sources/ folder, and
//                   try to compile to a .jar in plugins/ when `javac` is
//                   available locally.
//   - command-block / mcfunction → a .mcfunction datapack file under
//                   world/datapacks/<id>/data/<ns>/functions/<name>.mcfunction
// ---------------------------------------------------------------

async function listServerPluginsSnapshot(server) {
    const dir = path.join(server.dir, 'plugins');
    try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && /\.jar$/i.test(e.name))
            .map((e) => e.name)
            .slice(0, 40);
    } catch {
        return [];
    }
}

async function aiGeneratePluginOrScript({ prompt, server }) {
    const plugins = await listServerPluginsSnapshot(server);
    const skriptInstalled = plugins.some((n) => /^skript[-_]/i.test(n));

    const system =
`Ты — старший разработчик Minecraft (Bukkit/Spigot/Paper) и эксперт по Skript.
Твоя задача — по промту пользователя написать ОДИН файл: либо Skript-скрипт (.sk),
либо полную исходнику Bukkit/Spigot/Paper-плагина, либо .mcfunction.

Правила:
• Если в списке плагинов есть Skript — предпочитай type="skript" (проще в установке).
• Иначе пиши полноценный Java-плагин (type="java-plugin").
• Для простых команд и крафт-рецептов в ванилле можно выбрать type="mcfunction".
• Плагин должен быть САМОДОСТАТОЧНЫМ, без внешних библиотек (кроме Bukkit API).
• Для Java: один файл .java + plugin.yml, package не используй (default package), main = имя класса.
• plugin.yml обязателен, в нём api-version: "1.13" или выше (если версия MC это позволяет).
• Имя файла без пробелов, в ASCII (латиница + _).

Вывод СТРОГО в виде JSON:
{
  "type": "skript" | "java-plugin" | "mcfunction",
  "name": "<короткое имя, без пробелов>",
  "summary": "<1-2 предложения об установке / командах>",
  "files": [ { "path": "<имя файла>", "content": "<полное содержимое>" }, ... ]
}
Для type="skript" в files ровно ОДИН файл *.sk.
Для type="java-plugin" обязательны ровно 2 файла: <Name>.java и plugin.yml.
Для type="mcfunction" один *.mcfunction или дополнительные pack.mcmeta/json.
Никакого обрамления в бэктики. Только JSON.`;

    const userMsg =
        `Сервер: ${server.flavor} ${server.mc_version}\n` +
        `Skript установлен: ${skriptInstalled ? 'да' : 'нет'}\n` +
        `Текущие плагины: ${plugins.length ? plugins.join(', ') : 'пусто'}\n\n` +
        `Промт пользователя:\n${prompt}`;

    const raw = await aiChat({ system, user: userMsg, jsonMode: true, maxTokens: 3000 });
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Some models still wrap JSON in fences; try to extract.
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('AI вернула не JSON.');
        parsed = JSON.parse(m[0]);
    }
    if (!parsed || !Array.isArray(parsed.files) || !parsed.files.length) {
        throw new Error('AI не вернула файлы.');
    }
    for (const f of parsed.files) {
        if (typeof f.path !== 'string' || typeof f.content !== 'string') {
            throw new Error('AI вернула файл без path/content.');
        }
        // Reject path traversal in the file names returned by the AI.
        if (f.path.includes('..') || path.isAbsolute(f.path) || /[\\]/.test(f.path)) {
            throw new Error(`AI вернула небезопасный путь: ${f.path}`);
        }
    }
    parsed.type = parsed.type || 'skript';
    parsed.name = (parsed.name || `ai_${Date.now()}`).replace(/[^A-Za-z0-9_\-]+/g, '_').slice(0, 40);
    parsed.summary = String(parsed.summary || '').slice(0, 800);
    return parsed;
}

/**
 * Try to compile a single-file Java plugin source into a .jar.
 * Requires `javac` and `jar` to be available locally.
 * Returns the path to the produced .jar, or null on failure.
 */
async function tryCompileJavaPlugin({ javaFile, pluginYmlPath, outDir, pluginName }) {
    if (!ENV.JAVAC_BIN) return null;
    const jarBin = (() => {
        const candidates = [];
        if (ENV.JAVA_BIN) candidates.push(path.join(path.dirname(ENV.JAVA_BIN), 'jar'));
        if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'jar'));
        try {
            const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['jar'],
                { stdio: ['ignore', 'pipe', 'ignore'] });
            if (r.status === 0) {
                for (const f of r.stdout.toString().split('\n').map((s) => s.trim()).filter(Boolean)) {
                    candidates.push(f);
                }
            }
        } catch { /* ignore */ }
        for (const c of candidates) {
            try {
                const r = spawnSync(c, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
                if (!r.error && (r.status === 0 || r.status === null)) return c;
            } catch { /* ignore */ }
        }
        return null;
    })();
    if (!jarBin) return null;

    const buildDir = path.join(outDir, '_build');
    await fsp.mkdir(buildDir, { recursive: true });

    // Best-effort: try to find a bukkit/spigot/paper API jar on disk so the
    // class compiles. Most Paper jars contain the API.
    let classpath = '';
    try {
        const serverJars = (await fsp.readdir(path.dirname(outDir)))
            .filter((f) => /\.jar$/i.test(f))
            .map((f) => path.join(path.dirname(outDir), f));
        if (serverJars.length) classpath = serverJars.join(path.delimiter);
    } catch { /* ignore */ }

    const javacArgs = ['-d', buildDir];
    if (classpath) javacArgs.push('-cp', classpath);
    javacArgs.push(javaFile);

    try {
        await runCmd(ENV.JAVAC_BIN, javacArgs);
    } catch (e) {
        log.warn('javac failed:', e.message);
        return null;
    }

    // Copy plugin.yml into build dir root
    try {
        await fsp.copyFile(pluginYmlPath, path.join(buildDir, 'plugin.yml'));
    } catch (e) {
        log.warn('copy plugin.yml failed:', e.message);
        return null;
    }

    const jarPath = path.join(outDir, `${pluginName}.jar`);
    try {
        await runCmd(jarBin, ['cf', jarPath, '-C', buildDir, '.']);
    } catch (e) {
        log.warn('jar cf failed:', e.message);
        return null;
    }
    // Cleanup intermediate build dir
    await fsp.rm(buildDir, { recursive: true, force: true }).catch(() => {});
    return jarPath;
}

// =====================================================================
// 9. ARCHIVE EXTRACTION (zip/tar via system tools — no native deps)
// =====================================================================

function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        let out = '', err = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('exit', (code) => code === 0
            ? resolve({ out, err })
            : reject(new Error(`${cmd} exit ${code}: ${err || out}`)));
        p.on('error', reject);
    });
}

async function listArchive(archivePath, kind) {
    try {
        if (kind === 'zip') {
            const { out } = await runCmd('unzip', ['-Z', '-1', archivePath]);
            return out.split('\n').filter(Boolean);
        }
        if (kind === 'tar.gz' || kind === 'tar') {
            const flag = kind === 'tar.gz' ? '-tzf' : '-tf';
            const { out } = await runCmd('tar', [flag, archivePath]);
            return out.split('\n').filter(Boolean);
        }
    } catch (e) {
        log.warn(`Archive listing failed (${kind}):`, e.message);
    }
    return [];
}

async function extractArchive(archivePath, kind, destDir) {
    await fsp.mkdir(destDir, { recursive: true });
    if (kind === 'zip')     return runCmd('unzip', ['-o', archivePath, '-d', destDir]);
    if (kind === 'tar.gz')  return runCmd('tar', ['-xzf', archivePath, '-C', destDir]);
    if (kind === 'tar')     return runCmd('tar', ['-xf',  archivePath, '-C', destDir]);
    throw new Error('Unsupported archive: ' + kind);
}

// =====================================================================
// 10. TELEGRAM BOT
// =====================================================================

const bot = new Telegraf(ENV.BOT_TOKEN, { handlerTimeout: 9_000_000 });
bot.use(session({ defaultSession: () => ({}) }));

// ---- access middleware ----
bot.use(async (ctx, next) => {
    const u = ctx.from;
    if (!u) return next();
    if (!hasAccess(u.id, u.username)) {
        const txt =
            `🚫 Доступ к боту ограничен.\n` +
            `Ваш Telegram ID: <code>${esc(u.id)}</code>\n` +
            `Попросите администратора выдать доступ.`;
        // Answer callback if any, then send a plain message
        if (ctx.callbackQuery) await ctx.answerCbQuery('Нет доступа', { show_alert: true }).catch(() => {});
        await ctx.reply(txt, { parse_mode: 'HTML' }).catch(() => {});
        return;
    }
    return next();
});

// =====================================================================
// 10b. SAFE EDIT / SEND HELPERS
// =====================================================================

/**
 * Edit the message that triggered the callback. If editing fails
 * (no original message, content identical, message too old, etc.),
 * fall back to sending a new message.
 *
 * Always pass HTML-safe content here.
 */
async function safeEdit(ctx, text, extra = {}) {
    const opts = { parse_mode: 'HTML', disable_web_page_preview: true, ...extra };
    // If we don't have a callback message, we can't edit — just reply.
    if (!ctx.callbackQuery || !ctx.callbackQuery.message) {
        return ctx.reply(text, opts).catch((e) => {
            log.warn('safeEdit reply failed:', e.message);
        });
    }
    try {
        return await ctx.editMessageText(text, opts);
    } catch (e) {
        const desc = e.response?.description || e.message || '';
        // "message is not modified" is harmless: only the keyboard or whitespace differs.
        if (/message is not modified/i.test(desc)) return;
        // For any other reason (message can't be edited, too old, was deleted, was a non-text message…)
        // — fall back to a new message so the UX never silently breaks.
        log.debug('editMessageText fell back to reply:', desc);
        return ctx.reply(text, opts).catch((e2) => log.warn('safeEdit reply failed:', e2.message));
    }
}

// ---- main menu ----
function mainMenuKeyboard(ctx) {
    const adm = isAdmin(ctx.from.id);
    const rows = [
        [Markup.button.callback('🆕 Новый сервер',           'srv:new')],
        [Markup.button.callback('📂 Мои серверы',            'srv:list')],
        [Markup.button.callback('📦 Загрузить файл / плагин', 'srv:upload')],
        [Markup.button.callback('✨ AI: сгенерировать плагин / скрипт', 'srv:aigen')],
    ];
    if (adm) rows.push([Markup.button.callback('⚙️ Админ-панель', 'adm:open')]);
    return Markup.inlineKeyboard(rows);
}

function mainMenuText(ctx) {
    return (
        `👋 Привет, <b>${esc(ctx.from.first_name || 'пользователь')}</b>!\n\n` +
        `Я помогу установить и запустить Minecraft-сервер ` +
        `(Bukkit / Spigot / Paper) и интегрирую AI-помощника от OnlySQ.\n\n` +
        `Выберите действие:`
    );
}

bot.start(async (ctx) => {
    ctx.session = {}; // reset
    await ctx.reply(mainMenuText(ctx), { parse_mode: 'HTML', ...mainMenuKeyboard(ctx) });
});

bot.command('cancel', async (ctx) => {
    ctx.session = {};
    await ctx.reply('✖️ Операция отменена.', mainMenuKeyboard(ctx));
});

bot.command('java', async (ctx) => {
    // Quick diagnostic: report Java availability without trying to start a server.
    if (ENV.JAVA_AVAILABLE) {
        return ctx.reply(
            `✅ Java найдена.\n` +
            `Путь: <code>${esc(ENV.JAVA_BIN)}</code>\n` +
            `Версия: <code>${esc(ENV.JAVA_VERSION_STR || 'unknown')}</code>\n` +
            `javac: ${ENV.JAVAC_BIN ? `<code>${esc(ENV.JAVAC_BIN)}</code>` : '<i>не найден</i>'}`,
            { parse_mode: 'HTML' }
        );
    }
    return ctx.reply(
        `❌ Java не найдена. Запуск серверов невозможен.\n` +
        `Проверено: <code>JAVA_BIN=${esc(ENV.JAVA_BIN)}</code>, $JAVA_HOME, $PATH, /usr/lib/jvm/*.\n` +
        `Установите OpenJDK 21 и пропишите путь в .env.`,
        { parse_mode: 'HTML' }
    );
});

bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Только для админа.');
    return openAdminPanel(ctx);
});

// Re-open main menu (edit in place when triggered by a callback)
bot.action('menu:main', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    ctx.session.wizard = null;
    ctx.session.adminWait = null;
    ctx.session.uploadWait = null;
    ctx.session.aigenWait = null;
    return safeEdit(ctx, mainMenuText(ctx), mainMenuKeyboard(ctx));
});

// ---------- "Новый сервер" wizard ----------
bot.action('srv:new', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    ctx.session.wizard = { step: 'flavor' };
    return safeEdit(ctx,
        '🧱 Выберите сборку сервера:',
        Markup.inlineKeyboard([
            [Markup.button.callback('Paper (рекомендуется)', 'new:flavor:paper')],
            [Markup.button.callback('Spigot', 'new:flavor:spigot')],
            [Markup.button.callback('Bukkit', 'new:flavor:bukkit')],
            [Markup.button.callback('⬅️ В меню', 'menu:main')],
        ])
    );
});

bot.action(/^new:flavor:(paper|spigot|bukkit)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const flavor = ctx.match[1];
    ctx.session.wizard = { step: 'version', flavor };
    await safeEdit(ctx, `🔍 Получаю список версий для <b>${esc(flavor)}</b>…`);
    let versions;
    try {
        versions = await getServerVersions(flavor);
    } catch (e) {
        return safeEdit(ctx,
            `❌ Не удалось получить версии: <code>${esc(e.message)}</code>`,
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]])
        );
    }
    if (!versions.length) {
        return safeEdit(ctx, '❌ Список версий пуст.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]));
    }
    ctx.session.wizard.versions = versions;
    return renderVersionPage(ctx, 0);
});

async function renderVersionPage(ctx, page) {
    const all = ctx.session.wizard?.versions || [];
    if (!all.length) {
        return safeEdit(ctx, 'Сессия истекла. Нажмите /start.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]));
    }
    const flavor = ctx.session.wizard.flavor;
    const perPage = 12;
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const slice = all.slice(safePage * perPage, (safePage + 1) * perPage);
    const buttons = slice.map((v) => [Markup.button.callback(v, `new:ver:${v}`)]);
    const nav = [];
    if (safePage > 0) nav.push(Markup.button.callback('⬅️', `new:page:${safePage - 1}`));
    nav.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, 'noop'));
    if (safePage < totalPages - 1) nav.push(Markup.button.callback('➡️', `new:page:${safePage + 1}`));
    buttons.push(nav);
    buttons.push([Markup.button.callback('⬅️ Назад', 'srv:new')]);

    return safeEdit(ctx,
        `Выберите версию Minecraft для <b>${esc(flavor)}</b> ` +
        `(всего ${all.length}, страница ${safePage + 1}/${totalPages}):`,
        Markup.inlineKeyboard(buttons)
    );
}

bot.action(/^new:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!ctx.session.wizard?.versions) {
        return safeEdit(ctx, 'Сессия истекла. Нажмите /start.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]));
    }
    return renderVersionPage(ctx, Number(ctx.match[1]));
});

bot.action('noop', async (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.action(/^new:ver:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!ctx.session.wizard?.flavor) {
        return safeEdit(ctx, 'Сессия истекла. Нажмите /start.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]));
    }
    const version = ctx.match[1];
    ctx.session.wizard.mcVersion = version;
    ctx.session.wizard.step = 'name';
    return safeEdit(ctx,
        `Версия: <b>${esc(version)}</b>.\n` +
        `Введите имя для нового сервера ` +
        `(латиница, цифры, точка, тире, подчёркивание; 2–40 символов).\n\n` +
        `Для отмены — /cancel`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `new:flavor:${ctx.session.wizard.flavor}`)]])
    );
});

// Text handler for wizard steps and admin steps
bot.on('text', async (ctx, next) => {
    const w = ctx.session.wizard;
    const a = ctx.session.adminWait;

    // ----- Admin: waiting for username/id input -----
    if (a) {
        const text = ctx.message.text.trim();
        ctx.session.adminWait = null;
        if (a.action === 'grant') {
            const r = grantAccess(text, ctx.from.id);
            if (r.kind === 'id') {
                await ctx.reply(`✅ Доступ выдан пользователю с ID <code>${esc(r.value)}</code>.`,
                    { parse_mode: 'HTML' });
            } else if (r.kind === 'username') {
                await ctx.reply(
                    `✅ Доступ выдан @${esc(r.value)}. ` +
                    `Когда пользователь напишет /start — он будет добавлен автоматически.`,
                    { parse_mode: 'HTML' }
                );
            } else {
                await ctx.reply('⚠️ Не удалось распознать ID или username.');
            }
        } else if (a.action === 'revoke') {
            const r = revokeAccess(text);
            if (r.ok) {
                await ctx.reply(`✅ Доступ отозван (<code>${esc(r.value)}</code>).`,
                    { parse_mode: 'HTML' });
            } else {
                await ctx.reply(`⚠️ ${esc(r.reason || 'Не найден / нельзя удалить.')}`,
                    { parse_mode: 'HTML' });
            }
        }
        return openAdminPanel(ctx);
    }

    // ----- Wizard: server name -----
    if (w && w.step === 'name') {
        const name = ctx.message.text.trim();
        if (!/^[\w.-]{2,40}$/.test(name)) {
            return ctx.reply('❌ Имя должно быть 2–40 символов: буквы/цифры/._-');
        }
        const dirName = `${ctx.from.id}_${safeName(name)}_${Date.now()}`;
        const dir = path.join(ENV.SERVERS_ROOT, dirName);
        ensureDirSync(dir);

        const dlMsg = await ctx.reply(`⬇️ Скачиваю <b>${esc(w.flavor)} ${esc(w.mcVersion)}</b>…`,
            { parse_mode: 'HTML' });

        let jarPath;
        try {
            const dl = await resolveServerDownload(w.flavor, w.mcVersion);
            jarPath = path.join(dir, safeName(dl.filename));
            await downloadToFile(dl.url, jarPath);
        } catch (e) {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            ctx.session.wizard = null;
            try { await ctx.telegram.deleteMessage(ctx.chat.id, dlMsg.message_id); } catch {}
            return ctx.reply(`❌ Не удалось скачать: <code>${esc(e.message)}</code>`,
                { parse_mode: 'HTML', ...mainMenuKeyboard(ctx) });
        }
        const srv = ServersRepo.create({
            ownerId: ctx.from.id,
            name,
            flavor: w.flavor,
            mcVersion: w.mcVersion,
            dir,
            jar: jarPath,
        });
        ctx.session.wizard = null;
        try { await ctx.telegram.deleteMessage(ctx.chat.id, dlMsg.message_id); } catch {}
        await ctx.reply(
            `✅ Сервер «<b>${esc(name)}</b>» (${esc(w.flavor)} ${esc(w.mcVersion)}) установлен.\n` +
            `Папка: <code>${esc(dir)}</code>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ Запустить', `srv:start:${srv.id}`)],
                    [Markup.button.callback('📂 К списку серверов', 'srv:list')],
                    [Markup.button.callback('⬅️ В меню', 'menu:main')],
                ]),
            }
        );
        return;
    }

    // ----- Upload wizard: URL input -----
    if (ctx.session.uploadWait) {
        const url = ctx.message.text.trim();
        if (!/^https?:\/\//i.test(url)) {
            return ctx.reply('Введите корректный URL (http/https) или /cancel.');
        }
        const serverId = ctx.session.uploadWait.serverId;
        ctx.session.uploadWait = null;
        return handleIncomingFile(ctx, { kind: 'url', url, serverId });
    }

    // ----- AI plugin/script generation prompt -----
    if (ctx.session.aigenWait) {
        const promptText = ctx.message.text.trim();
        const { serverId } = ctx.session.aigenWait;
        ctx.session.aigenWait = null;
        if (promptText.length < 5) {
            return ctx.reply('Опишите задачу подробнее (минимум 5 символов) или /cancel.');
        }
        return handleAiGenerate(ctx, serverId, promptText);
    }

    return next();
});

// ---------- "Мои серверы" ----------
bot.action('srv:list', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const owned = isAdmin(ctx.from.id) ? ServersRepo.listAll() : ServersRepo.listByOwner(ctx.from.id);
    if (!owned.length) {
        return safeEdit(ctx,
            'У вас нет серверов. Создайте новый.',
            mainMenuKeyboard(ctx)
        );
    }
    const rows = owned.map((s) => {
        const live = RUNNING.has(s.id) ? '🟢 ' : '⚪ ';
        return [Markup.button.callback(
            `${live}#${s.id} ${s.name} (${s.flavor} ${s.mc_version})`,
            `srv:open:${s.id}`
        )];
    });
    rows.push([Markup.button.callback('⬅️ В меню', 'menu:main')]);
    return safeEdit(ctx, '📂 Ваши серверы:', Markup.inlineKeyboard(rows));
});

bot.action(/^srv:open:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ServersRepo.byId(Number(ctx.match[1]));
    if (!s) {
        return safeEdit(ctx, 'Сервер не найден.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ К списку', 'srv:list')]]));
    }
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return safeEdit(ctx, '🚫 Это не ваш сервер.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ К списку', 'srv:list')]]));
    }
    const live = RUNNING.has(s.id);
    return safeEdit(ctx,
        `📦 <b>${esc(s.name)}</b>\n` +
        `Сборка: ${esc(s.flavor)} ${esc(s.mc_version)}\n` +
        `Папка: <code>${esc(s.dir)}</code>\n` +
        `Статус: ${live ? '🟢 запущен' : '⚪ остановлен'}`,
        Markup.inlineKeyboard([
            live
                ? [Markup.button.callback('🛑 Остановить', `srv:stop:${s.id}`)]
                : [Markup.button.callback('▶️ Запустить',  `srv:start:${s.id}`)],
            [Markup.button.callback('📦 Загрузить файл',  `srv:upfor:${s.id}`)],
            [Markup.button.callback('📜 Лог',             `srv:log:${s.id}`)],
            [Markup.button.callback('🗑 Удалить',          `srv:delask:${s.id}`)],
            [Markup.button.callback('⬅️ К списку',         'srv:list')],
        ])
    );
});

bot.action(/^srv:start:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ServersRepo.byId(Number(ctx.match[1]));
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    await startServer(s, ctx);
});

bot.action(/^srv:stop:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    if (stopServer(id)) {
        await ctx.reply('🛑 Отправлена команда <code>stop</code> серверу.', { parse_mode: 'HTML' });
    } else {
        await ctx.reply('Сервер не запущен.');
    }
});

bot.action(/^srv:log:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    const st = RUNNING.get(id);
    if (!st) return ctx.reply('Сервер не запущен (нет live-лога).');
    const tail = tailString(st.log.join(''), 3500);
    await ctx.reply(
        `<pre>${esc(tail || '(пусто)')}</pre>`,
        { parse_mode: 'HTML' }
    );
});

// Two-step delete: ask for confirmation first
bot.action(/^srv:delask:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    return safeEdit(ctx,
        `❓ Удалить сервер «<b>${esc(s.name)}</b>» #${id}?\n` +
        `Это также удалит папку <code>${esc(s.dir)}</code>.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('🗑 Да, удалить',     `srv:del:${id}`)],
            [Markup.button.callback('⬅️ Нет, назад',       `srv:open:${id}`)],
        ])
    );
});

bot.action(/^srv:del:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    if (RUNNING.has(id)) stopServer(id);
    // Extra safety: make sure dir is actually inside SERVERS_ROOT before rm -rf
    if (s.dir && isPathInside(ENV.SERVERS_ROOT, s.dir)) {
        await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    } else {
        log.warn(`Refusing to rm server dir outside root: ${s.dir}`);
    }
    ServersRepo.delete(id);
    return safeEdit(ctx, `🗑 Сервер #${id} удалён.`, mainMenuKeyboard(ctx));
});

// ---------- Upload (general) ----------
bot.action('srv:upload', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const owned = isAdmin(ctx.from.id) ? ServersRepo.listAll() : ServersRepo.listByOwner(ctx.from.id);
    if (!owned.length) {
        return safeEdit(ctx, 'Сначала создайте сервер.', mainMenuKeyboard(ctx));
    }
    const rows = owned.map((s) => [
        Markup.button.callback(`#${s.id} ${s.name}`, `srv:upfor:${s.id}`),
    ]);
    rows.push([Markup.button.callback('⬅️ В меню', 'menu:main')]);
    return safeEdit(ctx, 'Выберите сервер для загрузки:', Markup.inlineKeyboard(rows));
});

bot.action(/^srv:upfor:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    ctx.session.uploadWait = { serverId: id };
    return safeEdit(ctx,
        `📦 Пришлите <b>файл</b> (документ) или <b>ссылку</b> (http/https) ` +
        `на плагин/карту/архив для сервера «<b>${esc(s.name)}</b>».\n\n` +
        `Лимит: <b>${ENV.MAX_UPLOAD_MB} МБ</b> (для прямой загрузки в Telegram).\n` +
        `Для отмены — /cancel`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)]])
    );
});

// ---------- AI Generate plugin/script ----------
bot.action('srv:aigen', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const owned = isAdmin(ctx.from.id) ? ServersRepo.listAll() : ServersRepo.listByOwner(ctx.from.id);
    if (!owned.length) {
        return safeEdit(ctx, 'Сначала создайте сервер.', mainMenuKeyboard(ctx));
    }
    const rows = owned.map((s) => [
        Markup.button.callback(`#${s.id} ${s.name}`, `srv:aigenfor:${s.id}`),
    ]);
    rows.push([Markup.button.callback('⬅️ В меню', 'menu:main')]);
    return safeEdit(ctx,
        '✨ Выберите сервер, для которого AI сгенерирует плагин или скрипт:',
        Markup.inlineKeyboard(rows)
    );
});

bot.action(/^srv:aigenfor:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    }
    ctx.session.aigenWait = { serverId: id };
    return safeEdit(ctx,
        `✨ Опишите, что должен делать плагин или скрипт для «<b>${esc(s.name)}</b>».\n\n` +
        `Примеры:\n` +
        `• <i>защита от входа в игру новых игроков без whitelist</i>\n` +
        `• <i>команда /heal которая лечит игрока</i>\n` +
        `• <i>автоматическое объявление времени каждые 5 минут</i>\n\n` +
        `Отправьте одним сообщением. Для отмены — /cancel`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Отмена', `srv:open:${id}`)]])
    );
});

async function handleAiGenerate(ctx, serverId, promptText) {
    const server = ServersRepo.byId(serverId);
    if (!server) return ctx.reply('Сервер не найден.');
    if (!isAdmin(ctx.from.id) && server.owner_id !== ctx.from.id) {
        return ctx.reply('🚫 Это не ваш сервер.');
    }

    const waitMsg = await ctx.reply(
        `🤖 AI (<code>${esc(getSetting('ai_model'))}</code>) анализирует сервер и пишет код…`,
        { parse_mode: 'HTML' }
    );

    let result;
    try {
        result = await aiGeneratePluginOrScript({ prompt: promptText, server });
    } catch (e) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}
        return ctx.reply(
            `❌ AI не смогла сгенерировать: <code>${esc(briefHttpError(e.message))}</code>`,
            { parse_mode: 'HTML' }
        );
    }

    // Decide where to write the files.
    let baseDir, descriptionPath, summaryExtra = '';
    if (result.type === 'skript') {
        baseDir = path.join(server.dir, 'plugins', 'Skript', 'scripts');
        descriptionPath = 'plugins/Skript/scripts/';
        summaryExtra = '\nℹ️ Для работы скрипта нужен плагин <b>Skript</b>. ' +
            'После перезапуска сервера выполните <code>/sk reload all</code>.';
    } else if (result.type === 'mcfunction') {
        baseDir = path.join(server.dir, 'world', 'datapacks', `ai_${result.name}`, 'data', 'ai', 'functions');
        descriptionPath = path.relative(server.dir, baseDir);
        summaryExtra = '\nℹ️ Это датапак. После запуска сервера выполните ' +
            '<code>/reload</code>, затем вызывайте функции через <code>/function ai:&lt;name&gt;</code>.';
    } else {
        // java-plugin: write sources somewhere safe inside server dir
        baseDir = path.join(server.dir, '_ai_sources', result.name);
        descriptionPath = path.relative(server.dir, baseDir);
    }
    await fsp.mkdir(baseDir, { recursive: true });

    // Write all files; refuse anything escaping the dir.
    const writtenRel = [];
    for (const f of result.files) {
        const dest = path.join(baseDir, f.path);
        if (!isPathInside(server.dir, dest)) {
            try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}
            return ctx.reply(`❌ Небезопасный путь файла: <code>${esc(f.path)}</code>`,
                { parse_mode: 'HTML' });
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, f.content, 'utf8');
        writtenRel.push(path.relative(server.dir, dest));
    }

    // For Java plugin: try to compile in-place into plugins/
    let extraNote = '';
    if (result.type === 'java-plugin') {
        const javaFile = path.join(baseDir, result.files.find((f) => /\.java$/i.test(f.path))?.path || '');
        const ymlFile  = path.join(baseDir, result.files.find((f) => /plugin\.yml$/i.test(f.path))?.path || '');
        if (fs.existsSync(javaFile) && fs.existsSync(ymlFile)) {
            if (ENV.JAVAC_BIN) {
                const pluginsDir = path.join(server.dir, 'plugins');
                await fsp.mkdir(pluginsDir, { recursive: true });
                const jar = await tryCompileJavaPlugin({
                    javaFile,
                    pluginYmlPath: ymlFile,
                    outDir: pluginsDir,
                    pluginName: result.name,
                });
                if (jar) {
                    extraNote = `\n✅ Плагин скомпилирован: <code>plugins/${esc(path.basename(jar))}</code>` +
                        `\nПерезапустите сервер для загрузки.`;
                } else {
                    extraNote = `\n⚠️ Авто-компиляция не удалась. Исходники сохранены в ` +
                        `<code>${esc(descriptionPath)}</code> — соберите вручную (<code>javac</code> + <code>jar</code>).`;
                }
            } else {
                extraNote = `\n⚠️ <b>javac</b> не найден. Исходники сохранены в ` +
                    `<code>${esc(descriptionPath)}</code>.\nУстановите JDK (не JRE), например ` +
                    `<code>openjdk-21-jdk</code>, и повторите генерацию.`;
            }
        }
    }

    try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}

    const fileListMsg = writtenRel.map((p) => `• <code>${esc(p)}</code>`).join('\n');
    await ctx.reply(
        `✨ <b>Готово!</b> AI сгенерировала (<i>${esc(result.type)}</i>):\n` +
        fileListMsg +
        `\n\n📝 <b>Описание от AI:</b>\n<i>${esc(result.summary || '(пусто)')}</i>` +
        summaryExtra + extraNote,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('▶️ Запустить сервер', `srv:start:${server.id}`)],
                [Markup.button.callback('⬅️ К серверу', `srv:open:${server.id}`)],
            ]),
        }
    );
}

// Document upload
bot.on('document', async (ctx) => {
    const u = ctx.session.uploadWait;
    if (!u) return ctx.reply('Сначала нажмите «📦 Загрузить файл» и выберите сервер.');
    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > ENV.MAX_UPLOAD_MB * 1024 * 1024) {
        return ctx.reply(`❌ Файл больше ${ENV.MAX_UPLOAD_MB} МБ.`);
    }
    ctx.session.uploadWait = null;
    return handleIncomingFile(ctx, {
        kind: 'tg',
        fileId: doc.file_id,
        filename: doc.file_name || `file_${Date.now()}`,
        serverId: u.serverId,
    });
});

async function handleIncomingFile(ctx, opts) {
    const server = ServersRepo.byId(opts.serverId);
    if (!server) return ctx.reply('Сервер не найден.');
    if (!isAdmin(ctx.from.id) && server.owner_id !== ctx.from.id) {
        return ctx.reply('🚫 Это не ваш сервер.');
    }

    const dlMsg = await ctx.reply('⬇️ Загружаю файл…');

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mctgbot-'));
    let localFile, filename;
    try {
        if (opts.kind === 'url') {
            const url = opts.url;
            let raw;
            try {
                raw = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
            } catch { raw = ''; }
            filename = raw || `download_${Date.now()}`;
            localFile = path.join(tmpDir, safeName(filename));
            await downloadToFile(url, localFile);
        } else {
            const link = await ctx.telegram.getFileLink(opts.fileId);
            filename = opts.filename;
            localFile = path.join(tmpDir, safeName(filename));
            await downloadToFile(link.href, localFile);
        }
    } catch (e) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        try { await ctx.telegram.deleteMessage(ctx.chat.id, dlMsg.message_id); } catch {}
        return ctx.reply(`❌ Ошибка загрузки: <code>${esc(e.message)}</code>`,
            { parse_mode: 'HTML' });
    }

    const kind = detectFileKind(filename);
    let listing = null;
    if (['zip', 'tar.gz', 'tar'].includes(kind)) {
        listing = await listArchive(localFile, kind);
    }

    await ctx.telegram.editMessageText(
        ctx.chat.id, dlMsg.message_id, undefined,
        `🤖 Спрашиваю AI (модель: <code>${esc(getSetting('ai_model'))}</code>), куда положить файл…`,
        { parse_mode: 'HTML' }
    ).catch(() => {});

    let plan;
    try {
        plan = await aiPlanFilePlacement({ filename, kind, server, listing });
    } catch (e) {
        plan = {
            action: kind === 'jar' ? 'place' : 'extract',
            target: kind === 'jar' ? 'plugins' : '.',
            reason: `AI недоступен (${briefHttpError(e.message)}), используем эвристику.`,
        };
    }
    log.info(`AI plan for ${filename}:`, plan);

    // Safety: validate target path is INSIDE server.dir (no `..`, no absolute)
    const target = String(plan.target || '.').replace(/\\/g, '/');
    let destDir;
    if (target === '' || target === '.' || target === './') {
        destDir = server.dir;
    } else if (path.isAbsolute(target) || target.split('/').some((p) => p === '..')) {
        // Reject and fall back to root
        log.warn(`AI proposed unsafe path '${target}', falling back to server root.`);
        destDir = server.dir;
    } else {
        destDir = path.join(server.dir, target);
        if (!isPathInside(server.dir, destDir)) {
            log.warn(`AI path '${target}' resolves outside server dir, falling back.`);
            destDir = server.dir;
        }
    }
    await fsp.mkdir(destDir, { recursive: true });

    try {
        if (plan.action === 'extract' && ['zip', 'tar.gz', 'tar'].includes(kind)) {
            await extractArchive(localFile, kind, destDir);
            await ctx.telegram.editMessageText(
                ctx.chat.id, dlMsg.message_id, undefined,
                `✅ Архив <b>${esc(filename)}</b> распакован в ` +
                `<code>${esc(path.relative(server.dir, destDir) || '.')}</code>\n` +
                `🤖 Обоснование AI: <i>${esc(plan.reason)}</i>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('⬅️ К серверу', `srv:open:${server.id}`)],
                    ]),
                }
            ).catch(() => {});
        } else {
            const baseName = safeName(path.basename(filename));
            const finalPath = path.join(destDir, baseName);
            if (!isPathInside(server.dir, finalPath)) {
                throw new Error('Финальный путь вне директории сервера.');
            }
            await fsp.copyFile(localFile, finalPath);
            await ctx.telegram.editMessageText(
                ctx.chat.id, dlMsg.message_id, undefined,
                `✅ Файл <b>${esc(filename)}</b> сохранён в ` +
                `<code>${esc(path.relative(server.dir, finalPath))}</code>\n` +
                `🤖 Обоснование AI: <i>${esc(plan.reason)}</i>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('⬅️ К серверу', `srv:open:${server.id}`)],
                    ]),
                }
            ).catch(() => {});
        }
    } catch (e) {
        await ctx.reply(`❌ Ошибка установки: <code>${esc(e.message)}</code>`,
            { parse_mode: 'HTML' });
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

// =====================================================================
// 11. ADMIN PANEL
// =====================================================================

function adminPanelKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Выдать доступ',  'adm:grant')],
        [Markup.button.callback('➖ Отозвать доступ', 'adm:revoke')],
        [Markup.button.callback('👥 Список пользователей', 'adm:list')],
        [Markup.button.callback(`🧠 Модель AI (${getSetting('ai_model')})`, 'adm:model')],
        [Markup.button.callback('⬅️ В меню', 'menu:main')],
    ]);
}

async function openAdminPanel(ctx) {
    if (!isAdmin(ctx.from.id)) return;
    const text = '⚙️ <b>Админ-панель</b>';
    if (ctx.callbackQuery) {
        return safeEdit(ctx, text, adminPanelKeyboard());
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...adminPanelKeyboard() });
}

bot.action('adm:open', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return openAdminPanel(ctx);
});

bot.action('adm:grant', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminWait = { action: 'grant' };
    return safeEdit(ctx,
        '➕ Введите <b>@username</b> или числовой Telegram ID пользователя ' +
        'для <b>выдачи</b> доступа:',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Отмена', 'adm:open')]])
    );
});

bot.action('adm:revoke', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminWait = { action: 'revoke' };
    return safeEdit(ctx,
        '➖ Введите <b>@username</b> или числовой Telegram ID пользователя ' +
        'для <b>отзыва</b> доступа:',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Отмена', 'adm:open')]])
    );
});

bot.action('adm:list', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    const { users, pending } = listUsers();
    const u = users.map((x) =>
        `• <code>${esc(x.tg_id)}</code>` +
        (x.username ? ` (@${esc(x.username)})` : '') +
        (x.tg_id === ENV.ADMIN_ID ? ' 👑' : '')
    ).join('\n') || '<i>нет</i>';
    const p = pending.map((x) =>
        `• @${esc(x.username)} <i>(ожидает /start)</i>`
    ).join('\n') || '<i>нет</i>';
    return safeEdit(ctx,
        `👥 <b>Пользователи с доступом:</b>\n${u}\n\n` +
        `<b>Ожидают подтверждения:</b>\n${p}`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'adm:open')]])
    );
});

bot.action('adm:model', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    await safeEdit(ctx, '🔍 Получаю список моделей с OnlySQ…');
    let models;
    try {
        models = await listOnlySqModels();
    } catch (e) {
        models = [];
        log.warn('listOnlySqModels threw:', e.message);
    }
    const cur = getSetting('ai_model');
    if (!models || !models.length) {
        return safeEdit(ctx,
            `Текущая модель: <b>${esc(cur)}</b>\n\n` +
            `Список моделей получить не удалось. Можно оставить текущую.`,
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'adm:open')]])
        );
    }
    const slice = models.slice(0, 30);
    const buttons = slice.map((m) => [
        Markup.button.callback(`${m === cur ? '✅ ' : ''}${m}`, `adm:setmodel:${m}`),
    ]);
    buttons.push([Markup.button.callback('⬅️ Назад', 'adm:open')]);
    return safeEdit(ctx,
        `Текущая модель: <b>${esc(cur)}</b>\nВыберите новую:`,
        Markup.inlineKeyboard(buttons)
    );
});

bot.action(/^adm:setmodel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    const m = ctx.match[1];
    setSetting('ai_model', m);
    return safeEdit(ctx,
        `✅ Модель AI установлена: <b>${esc(m)}</b>`,
        adminPanelKeyboard()
    );
});

// =====================================================================
// 12. GLOBAL ERROR HANDLING
// =====================================================================

bot.catch((err, ctx) => {
    // Telegraf passes us the full TelegramError; log everything we have.
    const desc = err?.response?.description || err?.message || 'unknown error';
    log.error('Telegraf error:', err);
    // Reply WITHOUT parse_mode to avoid a second parse failure.
    try { ctx.reply('⚠️ Внутренняя ошибка: ' + desc); } catch {}
});

process.on('unhandledRejection', (r) => log.error('UnhandledRejection:', r));
process.on('uncaughtException',  (e) => log.error('UncaughtException:', e));

// =====================================================================
// 13. GRACEFUL SHUTDOWN
// =====================================================================

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}. Stopping running servers…`);
    for (const [, st] of RUNNING) {
        try { st.child.stdin.write('stop\n'); } catch {}
    }
    const deadline = Date.now() + 8000;
    while (RUNNING.size && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
    }
    for (const [, st] of RUNNING) { try { st.child.kill('SIGKILL'); } catch {} }
    try { bot.stop(signal); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
}
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// =====================================================================
// 14. LAUNCH
// =====================================================================

bot.launch().then(() => {
    log.info('🤖 Bot started. Admin ID:', ENV.ADMIN_ID);
    log.info('   Default model:', getSetting('ai_model'));
    log.info('   Servers root:', ENV.SERVERS_ROOT);
    if (ENV.JAVA_AVAILABLE) {
        log.info('   Java:', ENV.JAVA_BIN, '|', ENV.JAVA_VERSION_STR);
    } else {
        log.warn('   ⚠️  Java НЕ НАЙДЕНА! Серверы не смогут запускаться.');
        log.warn('   Установите OpenJDK 17+ или укажите JAVA_BIN в .env');
    }
    log.info('   javac:', ENV.JAVAC_BIN || '<not found>');
}).catch((e) => {
    log.error('Failed to launch bot:', e);
    process.exit(1);
});
