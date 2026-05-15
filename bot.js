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


const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
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
    // Auto-port allocation range. Each new server gets a random free port
    // from this range so multiple users never collide.
    PORT_RANGE_MIN: Number(process.env.PORT_RANGE_MIN || 25600),
    PORT_RANGE_MAX: Number(process.env.PORT_RANGE_MAX || 26600),
    // Optional manual override for public IP — useful for VPS/NAT setups
    // where ipify et al. return the wrong address.
    PUBLIC_IP: process.env.PUBLIC_IP || '',
    // Branding string appended to default MOTD; user can edit later.
    BRAND_MOTD: process.env.BRAND_MOTD || 'made by @mchost_drbot',
};

(function validateEnv() {
    const missing = [];
    if (!ENV.BOT_TOKEN) missing.push('BOT_TOKEN');
    if (!ENV.ADMIN_ID || Number.isNaN(ENV.ADMIN_ID)) missing.push('ADMIN_ID');
    if (!ENV.ONLYSQ_API_KEY) missing.push('ONLYSQ_API_KEY');
    if (missing.length) {
        console.error('❌ Missing required env vars: ' + missing.join(', '));
        console.error('   Задайте переменные окружения через панель хостинга.');
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
 * Strip markdown / HTML formatting from raw AI output before showing it
 * in Telegram. We use HTML parse_mode for our own messages, so we must NOT
 * let the AI inject angle brackets or markdown stars — it would either
 * render as broken HTML or escape into the user message.
 *
 * Rules:
 *   - Remove ```fenced``` code blocks (keep their content).
 *   - Strip `inline code` backticks (keep content).
 *   - Strip **bold** and *italic* / __bold__ / _italic_ markers.
 *   - Strip leading list markers like "- ", "* ", "1. ".
 *   - Strip leading `#`/`##` headings.
 *   - Replace HTML tags with their textual content.
 *   - Collapse 3+ consecutive blank lines to 2.
 */
function stripAiFormatting(text) {
    if (text === null || text === undefined) return '';
    let s = String(text);
    // Remove triple-backtick fences but keep their body
    s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body);
    // Inline code
    s = s.replace(/`([^`]+)`/g, '$1');
    // Bold / italic
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*\n]+)\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/_([^_\n]+)_/g, '$1');
    // Strikethrough
    s = s.replace(/~~([^~]+)~~/g, '$1');
    // Markdown links [text](url) -> "text (url)"
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
    // Headings
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    // Block-quotes
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    // List markers
    s = s.replace(/^\s{0,3}[-*+]\s+/gm, '• ');
    s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
    // Strip any leftover HTML tags
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    // Collapse excessive blank lines
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
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
        port       INTEGER NOT NULL DEFAULT 25565,
        slots      INTEGER NOT NULL DEFAULT 20,
        motd       TEXT    NOT NULL DEFAULT '',
        start_cmd  TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);
`);

// Migrations: add columns for older databases. Each ALTER is wrapped in try/catch
// so re-running on an already-migrated DB is a no-op.
for (const stmt of [
    `ALTER TABLE servers ADD COLUMN port      INTEGER NOT NULL DEFAULT 25565`,
    `ALTER TABLE servers ADD COLUMN slots     INTEGER NOT NULL DEFAULT 20`,
    `ALTER TABLE servers ADD COLUMN motd      TEXT    NOT NULL DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN start_cmd TEXT`,
]) {
    try { db.exec(stmt); } catch { /* column already exists */ }
}

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
        // NOTE: response_format is NOT sent — OnlySQ/many providers don't support it
        // and return 500. For JSON mode we instead instruct the model in the system
        // prompt and extract JSON manually from the response text.
        const resp = await onlysq.chat.completions.create({
            model: m,
            messages,
            max_tokens: maxTokens,
        });
        const raw = resp.choices?.[0]?.message?.content?.trim() ?? '';
        if (jsonMode) {
            // Strip markdown fences if present, extract first JSON object/array
            const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
            const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
            return match ? match[1] : cleaned;
        }
        // For human-facing output: strip markdown / HTML formatting so it
        // can be safely shown inside our HTML-formatted Telegram messages.
        return stripAiFormatting(raw);
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

// ---------------------------------------------------------------
// Spigot / Bukkit mirror.
//
// The original `download.getbukkit.org` host is frequently blocked or
// returns DNS NXDOMAIN from many cloud providers. We use multiple
// mirrors and fall back transparently:
//   1) https://cdn.getbukkit.org/        (alternative CDN, usually up)
//   2) https://download.getbukkit.org/   (original)
//   3) https://serverjars.com/api/...    (well-maintained mirror with JSON API)
//   4) Mojang BuildTools                 (last resort — compiles from source)
//
// `getServerVersions('spigot'|'bukkit')` returns a curated list of known
// versions. `resolveServerDownload` then probes mirrors in order and
// returns the first URL that responds with a HEAD 200.
// ---------------------------------------------------------------
const SpigotBukkitMirror = {
    KNOWN_VERSIONS: [
        '1.21.4', '1.21.3', '1.21.1', '1.21',
        '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20',
        '1.19.4', '1.19.2', '1.19',
        '1.18.2', '1.18.1', '1.18',
        '1.17.1', '1.17',
        '1.16.5', '1.16.4', '1.16.3', '1.16.1',
        '1.15.2', '1.15.1', '1.15',
        '1.14.4', '1.14.3', '1.14.2', '1.14.1',
        '1.13.2', '1.13.1', '1.13',
        '1.12.2', '1.12.1', '1.12',
        '1.11.2', '1.11.1', '1.11',
        '1.10.2', '1.10',
        '1.9.4', '1.9.2', '1.9',
        '1.8.8',
    ],

    list() { return [...this.KNOWN_VERSIONS]; },

    mirrorsFor(flavor, version) {
        // Spigot file naming used by all mirrors
        const spigotName  = `spigot-${version}.jar`;
        const bukkitName  = `craftbukkit-${version}.jar`;
        const fname       = flavor === 'spigot' ? spigotName : bukkitName;
        // serverjars.com type names differ
        const sjType      = flavor === 'spigot' ? 'spigot' : 'bukkit';
        const urls = [];
        if (flavor === 'spigot') {
            urls.push(`https://cdn.getbukkit.org/spigot/${spigotName}`);
            urls.push(`https://download.getbukkit.org/spigot/${spigotName}`);
        } else {
            urls.push(`https://cdn.getbukkit.org/craftbukkit/${bukkitName}`);
            urls.push(`https://download.getbukkit.org/craftbukkit/${bukkitName}`);
        }
        urls.push(`https://serverjars.com/api/fetchJar/${sjType}/${version}`);
        return { urls, filename: fname };
    },

    async getDownload(flavor, version) {
        const { urls, filename } = this.mirrorsFor(flavor, version);
        // Probe each mirror with HEAD (some servers don't support HEAD;
        // we accept any 2xx OR a 405 (method not allowed) as a sign the
        // URL exists, then trust the download phase to verify).
        for (const url of urls) {
            try {
                const ok = await urlIsAlive(url);
                if (ok) return { url, filename };
            } catch { /* try next */ }
        }
        // No mirror responded — still return the first URL so the caller's
        // download error message points to a concrete URL the user can debug.
        return { url: urls[0], filename };
    },
};

/** Best-effort "is this URL reachable" check used by mirror fallback. */
async function urlIsAlive(url) {
    // 1) DNS first — catches the "getaddrinfo ENOTFOUND" case fast.
    try {
        const host = new URL(url).hostname;
        await dns.lookup(host);
    } catch { return false; }
    // 2) HEAD probe (short timeout). Some CDNs reject HEAD with 405
    // but still serve GET correctly — we treat 405 as "alive".
    try {
        const res = await request(url, {
            method: 'HEAD',
            headers: { 'User-Agent': ENV.PAPER_UA },
            headersTimeout: 4500,
            bodyTimeout: 4500,
            maxRedirections: 5,
        });
        res.body.dump?.();
        return (res.statusCode >= 200 && res.statusCode < 400) || res.statusCode === 405;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------
// Forge (MinecraftForge) installer support.
//
// We use the official maven-metadata to list installers, then download
// `forge-<mc>-<build>-installer.jar` and run it locally with
// `java -jar installer.jar --installServer`. After installation we
// detect the actual launch entrypoint:
//   - Modern Forge (>= 1.17): a run.sh script + libraries/.../unix_args.txt
//     (we use the args file with `java @args.txt nogui`).
//   - Older Forge: a forge-<ver>-universal.jar in the install dir.
// The result is stored in servers.start_cmd as a JSON-serialised command
// recipe; startServer() honours it when present.
// ---------------------------------------------------------------
const ForgeAPI = {
    metaUrl: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    promoUrl: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',

    _cache: null,
    _cacheAt: 0,

    /** Returns a map { '<mcVersion>': '<forgeBuild>', ... } using the promotions API. */
    async getRecommendedBuilds() {
        if (this._cache && Date.now() - this._cacheAt < 60_000) return this._cache;
        const { statusCode, body } = await request(this.promoUrl, {
            headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/json' },
            headersTimeout: 8000,
            bodyTimeout: 8000,
            maxRedirections: 5,
        });
        if (statusCode !== 200) {
            body.dump?.();
            throw new Error(`Forge promotions API ${statusCode}`);
        }
        const data = await body.json();
        // promos keys look like '1.20.1-recommended', '1.20.1-latest'
        const result = {};
        for (const [key, build] of Object.entries(data.promos || {})) {
            const m = key.match(/^(.+?)-(recommended|latest)$/);
            if (!m) continue;
            const mc = m[1];
            const tag = m[2];
            // Prefer recommended over latest
            if (!result[mc] || tag === 'recommended') result[mc] = String(build);
        }
        this._cache = result;
        this._cacheAt = Date.now();
        return result;
    },

    async listVersions() {
        const builds = await this.getRecommendedBuilds();
        // Sort by semver descending (1.21 > 1.20.4 > 1.20.1 > …)
        const versions = Object.keys(builds).sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const x = pa[i] || 0, y = pb[i] || 0;
                if (x !== y) return y - x;
            }
            return 0;
        });
        return versions;
    },

    async getInstallerDownload(mcVersion) {
        const builds = await this.getRecommendedBuilds();
        const build = builds[mcVersion];
        if (!build) throw new Error(`Нет сборки Forge для ${mcVersion}`);
        const fullVer = `${mcVersion}-${build}`;
        const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
        return { url, filename: `forge-${fullVer}-installer.jar`, fullVer, mcVersion, build };
    },
};

async function getServerVersions(flavor) {
    if (flavor === 'paper')  return await PaperAPI.listVersions('paper');
    if (flavor === 'forge')  return await ForgeAPI.listVersions();
    return SpigotBukkitMirror.list();
}
async function resolveServerDownload(flavor, version) {
    if (flavor === 'paper') return await PaperAPI.getDownload('paper', version);
    if (flavor === 'forge') return await ForgeAPI.getInstallerDownload(version);
    return await SpigotBukkitMirror.getDownload(flavor, version);
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
    create({ ownerId, name, flavor, mcVersion, dir, jar, port = 25565, slots = 20, motd = '', startCmd = null }) {
        const info = db.prepare(
            `INSERT INTO servers(owner_id, name, flavor, mc_version, dir, jar, port, slots, motd, start_cmd)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(ownerId, name, flavor, mcVersion, dir, jar, port, slots, motd, startCmd);
        return this.byId(info.lastInsertRowid);
    },
    byId(id) { return db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id); },
    listByOwner(ownerId) {
        return db.prepare(`SELECT * FROM servers WHERE owner_id = ? ORDER BY id DESC`).all(ownerId);
    },
    listAll() { return db.prepare(`SELECT * FROM servers ORDER BY id DESC`).all(); },
    delete(id) { return db.prepare(`DELETE FROM servers WHERE id = ?`).run(id).changes; },
    setPort(id, port) {
        db.prepare(`UPDATE servers SET port = ? WHERE id = ?`).run(port, id);
    },
};

/**
 * Recursively look for a file matching `pattern` inside `root`, up to `depth`
 * directory levels. Returns the absolute path of the first match, or null.
 * Used after the Forge installer finishes to find unix_args.txt.
 */
async function findFile(root, pattern, depth = 4) {
    if (depth < 0) return null;
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); }
    catch { return null; }
    // BFS: files first, then subdirs
    for (const e of entries) {
        if (e.isFile() && pattern.test(e.name)) return path.join(root, e.name);
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            const sub = await findFile(path.join(root, e.name), pattern, depth - 1);
            if (sub) return sub;
        }
    }
    return null;
}

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
        await ctx.reply('<tg-emoji emoji-id="5870982283724328568">⚠️</tg-emoji> Сервер уже запущен.').catch(() => {});
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
                '<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> <b>Java не найдена на этом хосте.</b>\n\n' +
                'Бот не может запустить Minecraft-сервер, потому что в системе ' +
                'отсутствует исполняемый файл <code>java</code>.\n\n' +
                '<b>Что сделать:</b>\n' +
                '• Ubuntu/Debian: <code>sudo apt update &amp;&amp; sudo apt install -y openjdk-21-jre-headless</code>\n' +
                '• Alpine: <code>apk add openjdk21-jre</code>\n' +
                '• Docker: используйте базовый образ <code>eclipse-temurin:21-jre</code>\n\n' +
                '<tg-emoji emoji-id="6028435952299413210">ℹ</tg-emoji> Укажите переменную окружения <code>JAVA_BIN=/usr/bin/java</code>\n' +
                'или экспортируйте <code>JAVA_HOME</code> и перезапустите бота.',
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
    }

    await fsp.writeFile(path.join(server.dir, 'eula.txt'), 'eula=true\n');

    // Build command line. Forge (modern) uses an args file (`@unix_args.txt`),
    // everything else uses `-jar <server.jar>`.
    let args;
    let recipe = null;
    try { recipe = server.start_cmd ? JSON.parse(server.start_cmd) : null; } catch { recipe = null; }

    if (recipe && recipe.mode === 'forge-args' && recipe.argsFile) {
        const argsPath = path.join(server.dir, recipe.argsFile);
        if (!fs.existsSync(argsPath)) {
            await ctx.reply(
                `❌ Не найдён файл запуска Forge: <code>${esc(recipe.argsFile)}</code>\n` +
                `Попробуйте переустановить сервер.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
        args = [
            `-Xms${ENV.JVM_XMS}`,
            `-Xmx${ENV.JVM_XMX}`,
            '-XX:+UseG1GC',
            `@${recipe.argsFile}`,
            'nogui',
        ];
    } else {
        const jarRel = recipe?.mode === 'jar' && recipe.jar
            ? recipe.jar
            : path.relative(server.dir, server.jar) || server.jar;
        args = [
            `-Xms${ENV.JVM_XMS}`,
            `-Xmx${ENV.JVM_XMX}`,
            '-XX:+UseG1GC',
            '-jar', jarRel,
            'nogui',
        ];
    }
    log.info(`Starting server #${server.id} (${server.flavor} ${server.mc_version}) in ${server.dir} via ${ENV.JAVA_BIN}: ${args.join(' ')}`);

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

    // Console live-refresh: when a console message is open, debounce-update
    // the SAME message every ~1.2s so users see output appear in place.
    let consoleRefreshTimer = null;
    const scheduleConsoleRefresh = () => {
        if (!state.consoleMsg) return;
        if (consoleRefreshTimer) return;
        consoleRefreshTimer = setTimeout(() => {
            consoleRefreshTimer = null;
            // Best-effort — ignore failures (message deleted / not modified)
            refreshConsoleMessage(ctx, server, state, null).catch(() => {});
        }, 1200);
    };

    const collect = (chunk) => {
        const text = chunk.toString('utf8');
        state.log.push(text);
        if (state.log.length > 500) state.log.shift();
        scheduleConsoleRefresh();
        if (!state.bootDone) {
            state.bootLogForAI += text;
            if (state.bootLogForAI.length > 8000) state.bootLogForAI = state.bootLogForAI.slice(-8000);
            if (/Done \([\d.]+s\)!/.test(text) || /For help, type/.test(text)) {
                state.bootDone = true;
                // Announce success + IP:port + full status (player count via SLP)
                (async () => {
                    const port = readServerPort(server.dir, server.port || 25565);
                    const ip = await getPublicIp().catch(() => null);
                    // Give the server a beat to bind the port before pinging.
                    await new Promise((r) => setTimeout(r, 1500));
                    const status = await queryMinecraftStatus('127.0.0.1', port).catch(() => null);

                    const uptime = Math.round((Date.now() - state.startedAt) / 1000);
                    const connStr = ip ? `${ip}:${port}` : `??:${port}`;
                    let playersLine = '';
                    let motdLine = '';
                    let verLine  = '';
                    if (status) {
                        const online = status.players?.online ?? '?';
                        const max    = status.players?.max ?? server.slots ?? '?';
                        playersLine = `\n👥 Онлайн: <b>${esc(online)}</b>/<b>${esc(max)}</b>`;
                        const motd = motdToString(status.description);
                        if (motd) motdLine = `\n📝 MOTD: <code>${esc(motd.slice(0, 100))}</code>`;
                        if (status.version?.name) verLine = `\n⛙️ Версия игры: <code>${esc(status.version.name)}</code>`;
                    }

                    ctx.telegram.sendMessage(
                        state.chatId,
                        `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Сервер «<b>${esc(server.name)}</b>» запущен!\n\n` +
                        `📍 Адрес: <code>${esc(connStr)}</code>\n` +
                        `⚙️ Сборка: ${esc(server.flavor)} ${esc(server.mc_version)}` +
                        verLine +
                        playersLine +
                        motdLine +
                        `\n⏱ Время старта: <b>${uptime}с</b>`,
                        {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('🖥 Консоль',     `srv:console:${server.id}`)],
                                [Markup.button.callback('📊 Статус',    `srv:status:${server.id}`)],
                                [Markup.button.callback('⬅️ К серверу', `srv:open:${server.id}`)],
                            ]),
                        }
                    ).catch(() => {});
                })();
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
                'Установите OpenJDK 21+ и задайте переменную окружения <code>JAVA_BIN</code> через хостинг.</i>';
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
                    `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>AI-разбор завершения сервера:</b>\n${esc(verdict)}`,
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
                `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>AI-диагностика запуска (20 сек):</b>\n${esc(verdict)}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        } catch (e) { log.warn('AI boot-check failed:', e.message); }
    }, 20_000);

    await ctx.reply(
        `<tg-emoji emoji-id="5963103826075456248">🚀</tg-emoji> Сервер «<b>${esc(server.name)}</b>» запускается…\n` +
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
// 7b. IP / PORT UTILITIES
// =====================================================================

// Cache the public IP for 10 minutes — it almost never changes on a host
// and the auto-info banner uses it on every server-status refresh.
let _publicIpCache = { ip: null, at: 0 };

/**
 * Fetch the public IP of the host. Strategy (with fallbacks):
 *   0) ENV.PUBLIC_IP — forced override for VPS behind NAT / Docker
 *   1) cached value, if fresh
 *   2) parallel race against several public lookup services
 *   3) DNS-based services (myip.opendns.com via resolver4)
 *   4) hostname → IP local fallback (last resort — may return a LAN IP)
 */
async function getPublicIp() {
    if (ENV.PUBLIC_IP && /^\d{1,3}(\.\d{1,3}){3}$/.test(ENV.PUBLIC_IP)) {
        return ENV.PUBLIC_IP;
    }
    if (_publicIpCache.ip && Date.now() - _publicIpCache.at < 600_000) {
        return _publicIpCache.ip;
    }

    const httpServices = [
        'https://api.ipify.org',
        'https://ipv4.icanhazip.com',
        'https://checkip.amazonaws.com',
        'https://api.seeip.org',
        'https://ifconfig.me/ip',
        'https://ipinfo.io/ip',
    ];

    const probeHttp = (url) => (async () => {
        const { statusCode, body } = await request(url, {
            headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'text/plain' },
            headersTimeout: 4500,
            bodyTimeout: 4500,
            maxRedirections: 3,
        });
        if (statusCode !== 200) { body.dump?.(); throw new Error('status ' + statusCode); }
        const txt = (await body.text()).trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(txt)) throw new Error('not an ipv4');
        return txt;
    })();

    // Race — first successful response wins.
    try {
        const ip = await Promise.any(httpServices.map(probeHttp));
        _publicIpCache = { ip, at: Date.now() };
        return ip;
    } catch { /* all failed, try DNS-based */ }

    // DNS fallback: OpenDNS "myip.opendns.com" returns the caller's IP
    try {
        const Resolver = require('dns').promises.Resolver;
        const r = new Resolver();
        r.setServers(['208.67.222.222', '208.67.220.220']);
        const ips = await r.resolve4('myip.opendns.com');
        const ip = ips[0];
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
            _publicIpCache = { ip, at: Date.now() };
            return ip;
        }
    } catch { /* ignore */ }

    // Last resort: local hostname → IP (may be 127.0.0.1 or LAN)
    try {
        const nets = os.networkInterfaces();
        for (const list of Object.values(nets)) {
            for (const n of list || []) {
                if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')) {
                    return n.address;
                }
            }
        }
    } catch { /* ignore */ }

    return null;
}

// =====================================================================
// 7b.1 AUTO-PORT ALLOCATOR
// =====================================================================
// Each user / server gets its own random free port from [PORT_RANGE_MIN,
// PORT_RANGE_MAX]. This prevents two servers (possibly from different
// users) from binding the same port and silently failing to start.
//
// Algorithm:
//   1) Collect all ports already used by other servers in the DB.
//   2) Pick a random candidate not in that set.
//   3) Verify the OS can bind the port (handles ports taken by other
//      processes on the host).
//   4) Retry up to 80 times; then sequentially scan the range.
// =====================================================================
function _isPortFree(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.close(() => resolve(true)))
            .listen(port, host);
    });
}

/** Returns set of ports recorded in DB across all servers. */
function _usedPortsFromDb() {
    const rows = db.prepare(`SELECT port FROM servers`).all();
    return new Set(rows.map((r) => Number(r.port)).filter(Boolean));
}

/**
 * Allocate a free port within [min, max]. Excludes ports already used by
 * other servers (in DB) and ports currently bound on the host.
 */
async function allocateFreePort(min = ENV.PORT_RANGE_MIN, max = ENV.PORT_RANGE_MAX) {
    const used = _usedPortsFromDb();
    const tried = new Set();

    // Random attempts first — fast for sparse ranges.
    for (let i = 0; i < 80; i++) {
        const p = Math.floor(Math.random() * (max - min + 1)) + min;
        if (used.has(p) || tried.has(p)) continue;
        tried.add(p);
        if (await _isPortFree(p)) return p;
    }
    // Sequential scan fallback.
    for (let p = min; p <= max; p++) {
        if (used.has(p) || tried.has(p)) continue;
        if (await _isPortFree(p)) return p;
    }
    throw new Error(`Все порты в диапазоне ${min}-${max} заняты.`);
}

// =====================================================================
// 7b.2 MINECRAFT SERVER STATUS QUERY (SLP — Server List Ping)
// =====================================================================
// Implements the modern (1.7+) Server List Ping protocol so we can
// display online players, MOTD, MC version *as the game sees them*
// without parsing logs. We use a 4-second timeout and never throw —
// failures resolve to null so the UI just hides the section.
// =====================================================================
function _writeVarInt(value) {
    const bytes = [];
    let v = value >>> 0;
    while (true) {
        if ((v & ~0x7f) === 0) { bytes.push(v); break; }
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    return Buffer.from(bytes);
}
function _readVarIntFromBuffer(buf, offset) {
    let value = 0, length = 0, currentByte;
    while (true) {
        if (offset + length >= buf.length) return null;
        currentByte = buf[offset + length];
        value |= (currentByte & 0x7f) << (length * 7);
        length++;
        if ((currentByte & 0x80) === 0) break;
        if (length > 5) return null;
    }
    return { value, length };
}

async function queryMinecraftStatus(host, port, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ host, port });
        let buf = Buffer.alloc(0);
        let settled = false;
        const done = (val) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(val); };

        const timer = setTimeout(() => done(null), timeoutMs);

        sock.once('connect', () => {
            // Handshake (protocol -1 → fall back to latest on server side)
            const hostBuf = Buffer.from(host, 'utf8');
            const hs = Buffer.concat([
                Buffer.from([0x00]),              // packet id
                _writeVarInt(-1 >>> 0),           // protocol version (unknown)
                _writeVarInt(hostBuf.length),
                hostBuf,
                Buffer.from([(port >> 8) & 0xff, port & 0xff]), // unsigned short
                _writeVarInt(1),                  // next state = status
            ]);
            const hsPacket = Buffer.concat([_writeVarInt(hs.length), hs]);
            sock.write(hsPacket);
            // Status request
            const sr = Buffer.from([0x00]);
            const srPacket = Buffer.concat([_writeVarInt(sr.length), sr]);
            sock.write(srPacket);
        });

        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            // Try to parse: VarInt(length) + VarInt(packet id 0x00) + VarInt(strLen) + str
            const lenInfo = _readVarIntFromBuffer(buf, 0);
            if (!lenInfo) return;
            if (buf.length < lenInfo.length + lenInfo.value) return;

            const pidInfo = _readVarIntFromBuffer(buf, lenInfo.length);
            if (!pidInfo) return done(null);
            if (pidInfo.value !== 0x00) return done(null);

            const strLenInfo = _readVarIntFromBuffer(buf, lenInfo.length + pidInfo.length);
            if (!strLenInfo) return done(null);
            const strStart = lenInfo.length + pidInfo.length + strLenInfo.length;
            const strEnd = strStart + strLenInfo.value;
            if (buf.length < strEnd) return;
            const json = buf.slice(strStart, strEnd).toString('utf8');
            try {
                const obj = JSON.parse(json);
                clearTimeout(timer);
                done(obj);
            } catch { done(null); }
        });

        sock.on('error', () => done(null));
        sock.on('close', () => done(null));
    });
}

/** Flatten a Minecraft chat-component MOTD into plain text. */
function motdToString(motd) {
    if (motd === null || motd === undefined) return '';
    if (typeof motd === 'string') return motd.replace(/§[0-9a-frk-o]/gi, '').trim();
    let s = '';
    if (typeof motd.text === 'string') s += motd.text;
    if (Array.isArray(motd.extra)) for (const e of motd.extra) s += motdToString(e);
    return s.replace(/§[0-9a-frk-o]/gi, '').trim();
}

/**
 * Read the `server-port` value from server.properties (if file exists).
 * Falls back to the DB port value, then 25565.
 */
function readServerPort(serverDir, dbPort = 25565) {
    try {
        const propsPath = path.join(serverDir, 'server.properties');
        const content = fs.readFileSync(propsPath, 'utf8');
        const m = content.match(/^server-port\s*=\s*(\d+)/m);
        if (m) return Number(m[1]);
    } catch { /* file not created yet */ }
    return dbPort;
}

/**
 * Write/update a key in server.properties.
 * Creates the file if missing, updates the line if present, appends if absent.
 */
async function writeServerProperty(serverDir, key, value) {
    const propsPath = path.join(serverDir, 'server.properties');
    let content = '';
    try { content = await fsp.readFile(propsPath, 'utf8'); } catch { /* new file */ }
    const regex = new RegExp(`^(${key}\\s*=).*`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `$1${value}`);
    } else {
        content += (content.endsWith('\n') || !content ? '' : '\n') + `${key}=${value}\n`;
    }
    await fsp.writeFile(propsPath, content, 'utf8');
}

// =====================================================================
// 7c. FILE MANAGER (browse/read/delete inside server dir, never above /app)
// =====================================================================

const APP_ROOT = path.resolve('/app');

/** Resolve a relative path inside server.dir; throw if it escapes app root or server dir. */
function resolveServerPath(server, relPath) {
    const base = path.resolve(server.dir);
    const resolved = relPath ? path.resolve(base, relPath) : base;
    // Must stay inside /app (Docker root) — double safety
    if (!resolved.startsWith(APP_ROOT + path.sep) && resolved !== APP_ROOT) {
        throw new Error('Путь выходит за пределы /app');
    }
    // Must stay inside server dir
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        throw new Error('Путь выходит за пределы директории сервера');
    }
    return resolved;
}

/** List directory entries with type tags. Returns max 40 entries. */
async function listDir(absPath) {
    const entries = await fsp.readdir(absPath, { withFileTypes: true });
    return entries.slice(0, 60).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        isFile: e.isFile(),
    }));
}

/** Read a text file, capped at 8 KB for Telegram messages. */
async function readTextFile(absPath, maxBytes = 8000) {
    const stat = await fsp.stat(absPath);
    if (stat.size > 1024 * 1024) throw new Error('Файл слишком большой (> 1 МБ)');
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    const fd = await fsp.open(absPath, 'r');
    try {
        await fd.read(buf, 0, buf.length, 0);
    } finally {
        await fd.close();
    }
    return { text: buf.toString('utf8'), truncated: stat.size > maxBytes, size: stat.size };
}



async function aiAnalyseStartup(logText, server) {
    const system = `Ты — эксперт по администрированию Minecraft-серверов
(Paper/Spigot/Bukkit/Forge). Тебе дают хвост лога старта сервера.
Кратко (5–10 строк, на русском) ответь:
1) Запустился ли сервер корректно (Да / Нет / Частично).
2) Если есть ошибки — какие и как их исправить.
3) Дай 1–2 совета по оптимизации, если уместно.
Не выдумывай факты, опирайся только на лог.

ВАЖНО: пиши ОБЫЧНЫМ ТЕКСТОМ, без какого-либо форматирования.
НЕ используй Markdown (**жирный**, *курсив*, \`код\`, # заголовки, списки с -/* ),
НЕ используй HTML-теги (<b>, <i>, <code>, <pre>, …).
Только чистый текст. Эмодзи допустимы.`;
    const user = `Сервер: ${server.flavor} ${server.mc_version}, директория ${server.dir}\n\n=== ЛОГ ===\n${logText}`;
    return await aiChat({ system, user, maxTokens: 600 });
}

async function aiPlanFilePlacement({ filename, kind, server, listing }) {
    const system = `Ты — ассистент по установке файлов на Minecraft-сервер
(${server.flavor} ${server.mc_version}).
Дано имя файла, его тип и (для архивов) список вложенных файлов.
Реши, КУДА положить файл или его содержимое внутри директории сервера.

ВАЖНО: в поле "reason" пиши ОБЫЧНЫМ ТЕКСТОМ без Markdown/HTML
(никаких **звёздочек**, \`бэктиков\`, <тегов>). Только чистый текст.

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

ВАЖНО про поле "summary": пиши ОБЫЧНЫМ ТЕКСТОМ, без Markdown и HTML
(никаких **bold**, *italic*, \`code\`, # заголовков, тегов <b>/<code>).
Содержимое файлов (поле content) — конечно, код, без ограничений.

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
            `<tg-emoji emoji-id="6037249452824072506">🔒</tg-emoji> Доступ к боту ограничен.\n` +
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
        `<tg-emoji emoji-id="5870764288364252592">🙂</tg-emoji> Привет, <b>${esc(ctx.from.first_name || 'пользователь')}</b>!\n\n` +
        `Я помогу установить и запустить Minecraft-сервер ` +
        `(Bukkit / Spigot / Paper / Forge) и интегрирую AI-помощника от OnlySQ.\n\n` +
        `Порт выдаётся автоматически из диапазона ` +
        `<code>${ENV.PORT_RANGE_MIN}–${ENV.PORT_RANGE_MAX}</code> — порты не пересекаются.\n\n` +
        `Выберите действие:`
    );
}

bot.start(async (ctx) => {
    ctx.session = {}; // reset
    await ctx.reply(mainMenuText(ctx), { parse_mode: 'HTML', ...mainMenuKeyboard(ctx) });
});

bot.command('cancel', async (ctx) => {
    ctx.session = {};
    await ctx.reply('<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> Операция отменена.', { parse_mode: 'HTML', ...mainMenuKeyboard(ctx) });
});

bot.command('java', async (ctx) => {
    // Quick diagnostic: report Java availability without trying to start a server.
    if (ENV.JAVA_AVAILABLE) {
        return ctx.reply(
            `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Java найдена.\n` +
            `Путь: <code>${esc(ENV.JAVA_BIN)}</code>\n` +
            `Версия: <code>${esc(ENV.JAVA_VERSION_STR || 'unknown')}</code>\n` +
            `javac: ${ENV.JAVAC_BIN ? `<code>${esc(ENV.JAVAC_BIN)}</code>` : '<i>не найден</i>'}`,
            { parse_mode: 'HTML' }
        );
    }
    return ctx.reply(
        `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> Java не найдена. Запуск серверов невозможен.\n` +
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
    ctx.session.consoleFor = null;
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
            [Markup.button.callback('Forge (моды)', 'new:flavor:forge')],
            [Markup.button.callback('⬅️ В меню', 'menu:main')],
        ])
    );
});

bot.action(/^new:flavor:(paper|spigot|bukkit|forge)$/, async (ctx) => {
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
        `Это имя будет видно в боте; далее спрошу слоты и MOTD.\n` +
        `Для отмены — /cancel`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `new:flavor:${ctx.session.wizard.flavor}`)]])
    );
});

// Text handler for wizard steps, admin steps, and live console.
bot.on('text', async (ctx, next) => {
    const w = ctx.session.wizard;
    const a = ctx.session.adminWait;

    // ----- Live console: every text becomes a server command -----
    // Highest priority (above wizard/admin) so users in console mode
    // never accidentally get their commands swallowed by another step.
    const cs = ctx.session.consoleFor;
    if (cs && (!w || w.step === 'done') && !a && !ctx.session.uploadWait && !ctx.session.aigenWait) {
        const text = ctx.message.text.trim();
        // Allow /exit (and /cancel) to leave console mode
        if (/^\/(exit|stop_console|cancel)$/i.test(text)) {
            ctx.session.consoleFor = null;
            const st0 = RUNNING.get(cs.serverId);
            if (st0) st0.consoleMsg = null;
            try { await ctx.deleteMessage(); } catch {}
            await ctx.reply('Консоль закрыта.').catch(() => {});
            return;
        }
        const state = RUNNING.get(cs.serverId);
        const server = ServersRepo.byId(cs.serverId);
        if (!state) {
            // Server stopped while user was typing.
            ctx.session.consoleFor = null;
            return ctx.reply('⚠️ Сервер больше не запущен.');
        }
        // Delete user's command message so the chat stays clean.
        try { await ctx.deleteMessage(); } catch { /* old / no rights */ }
        // Strip leading slash if user types Minecraft-style /tp ...
        const cmd = text.replace(/^\//, '');
        try { state.child.stdin.write(cmd + '\n'); }
        catch (e) {
            await ctx.reply('❌ Не удалось отправить команду: ' + e.message).catch(() => {});
            return;
        }
        // Give the server a moment to react, then refresh the console view.
        setTimeout(() => refreshConsoleMessage(ctx, server, state, cmd), 900);
        return;
    }

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
                    `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Доступ выдан @${esc(r.value)}. ` +
                    `Когда пользователь напишет /start — он будет добавлен автоматически.`,
                    { parse_mode: 'HTML' }
                );
            } else {
                await ctx.reply('⚠️ Не удалось распознать ID или username.');
            }
        } else if (a.action === 'revoke') {
            const r = revokeAccess(text);
            if (r.ok) {
                await ctx.reply(`<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Доступ отозван (<code>${esc(r.value)}</code>).`,
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
        w.name = name;
        w.step = 'slots';
        return ctx.reply(
            `👥 Сколько слотов для игроков? Введите число от 1 до 500 (по умолчанию 20).\n` +
            `Например: <code>20</code>\n\n` +
            `Для отмены — /cancel`,
            { parse_mode: 'HTML' }
        );
    }

    // ----- Wizard: slots -----
    if (w && w.step === 'slots') {
        const raw = ctx.message.text.trim();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 500) {
            return ctx.reply('❌ Слоты — целое число от 1 до 500. Попробуйте ещё раз.');
        }
        w.slots = n;
        w.step = 'motd';
        return ctx.reply(
            `📝 Введите название (MOTD), которое будет видно в списке серверов Minecraft.\n` +
            `Максимум 59 символов, можно с форматированием § (например <code>§aMy Server</code>).\n\n` +
            `Отправьте «-» чтобы использовать имя сервера по умолчанию.\n` +
            `Для отмены — /cancel`,
            { parse_mode: 'HTML' }
        );
    }

    // ----- Wizard: motd -> install -----
    if (w && w.step === 'motd') {
        let motd = ctx.message.text.trim();
        if (motd === '-' || motd === '—') motd = w.name;
        if (motd.length > 59) motd = motd.slice(0, 59);
        w.motd = motd;

        const dirName = `${ctx.from.id}_${safeName(w.name)}_${Date.now()}`;
        const dir = path.join(ENV.SERVERS_ROOT, dirName);
        ensureDirSync(dir);

        // Allocate a free port BEFORE downloading — fail-fast if exhausted.
        let port;
        try {
            port = await allocateFreePort();
        } catch (e) {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            ctx.session.wizard = null;
            return ctx.reply(`❌ Не удалось выделить порт: <code>${esc(e.message)}</code>`,
                { parse_mode: 'HTML', ...mainMenuKeyboard(ctx) });
        }

        const dlMsg = await ctx.reply(
            `⬇️ Скачиваю <b>${esc(w.flavor)} ${esc(w.mcVersion)}</b>…\n` +
            `Выделён порт: <code>${port}</code>`,
            { parse_mode: 'HTML' }
        );

        let jarPath, startCmdRecipe = null;
        try {
            const dl = await resolveServerDownload(w.flavor, w.mcVersion);
            const downloadPath = path.join(dir, safeName(dl.filename));
            await downloadToFile(dl.url, downloadPath);

            if (w.flavor === 'forge') {
                // Run the Forge installer (--installServer) inside the new dir.
                await ctx.telegram.editMessageText(
                    ctx.chat.id, dlMsg.message_id, undefined,
                    `⛙️ Устанавливаю Forge (может занять 1-2 минуты)…`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
                if (!ENV.JAVA_AVAILABLE) throw new Error('Java не найдена — установка Forge невозможна.');
                await runCmd(ENV.JAVA_BIN, ['-jar', downloadPath, '--installServer'], { cwd: dir });

                // Locate launch entrypoint after install.
                const entries = await fsp.readdir(dir);
                // Modern (1.17+): unix_args.txt
                const argsTxt = await findFile(dir, /unix_args\.txt$/i, 6);
                if (argsTxt) {
                    startCmdRecipe = { mode: 'forge-args', argsFile: path.relative(dir, argsTxt) };
                    jarPath = path.relative(dir, argsTxt); // stored for reference
                } else {
                    // Older Forge: forge-*-universal.jar OR forge-*.jar (excluding installer)
                    const candidates = entries.filter((f) =>
                        /^forge-.+\.jar$/i.test(f) && !/installer/i.test(f)
                    );
                    if (!candidates.length) throw new Error('Не найдён запускной jar Forge после установки.');
                    jarPath = path.join(dir, candidates[0]);
                    startCmdRecipe = { mode: 'jar', jar: candidates[0] };
                }
            } else {
                jarPath = downloadPath;
                startCmdRecipe = { mode: 'jar', jar: path.basename(downloadPath) };
            }
        } catch (e) {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            ctx.session.wizard = null;
            try { await ctx.telegram.deleteMessage(ctx.chat.id, dlMsg.message_id); } catch {}
            return ctx.reply(`❌ Не удалось скачать/установить: <code>${esc(briefHttpError(e.message))}</code>`,
                { parse_mode: 'HTML', ...mainMenuKeyboard(ctx) });
        }

        const srv = ServersRepo.create({
            ownerId: ctx.from.id,
            name: w.name,
            flavor: w.flavor,
            mcVersion: w.mcVersion,
            dir,
            jar: jarPath,
            port,
            slots: w.slots,
            motd: w.motd,
            startCmd: JSON.stringify(startCmdRecipe),
        });

        // Pre-populate server.properties with port / slots / motd + branding
        // (footer is appended to motd; user can change later via file manager).
        await writeServerProperty(dir, 'server-port',  port).catch(() => {});
        await writeServerProperty(dir, 'query.port',   port).catch(() => {});
        await writeServerProperty(dir, 'max-players',  w.slots).catch(() => {});
        await writeServerProperty(dir, 'motd',         `${w.motd} §8— ${ENV.BRAND_MOTD}`).catch(() => {});
        await writeServerProperty(dir, 'online-mode',  'true').catch(() => {});
        await writeServerProperty(dir, 'enable-status','true').catch(() => {});

        ctx.session.wizard = null;
        try { await ctx.telegram.deleteMessage(ctx.chat.id, dlMsg.message_id); } catch {}

        const ip = await getPublicIp().catch(() => null);
        await ctx.reply(
            `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Сервер «<b>${esc(w.name)}</b>» установлен.\n\n` +
            `⚙️ Сборка: <b>${esc(w.flavor)} ${esc(w.mcVersion)}</b>\n` +
            `📐 Слоты: <b>${w.slots}</b>\n` +
            `📝 MOTD: <code>${esc(w.motd)}</code>\n` +
            `🔌 Порт: <code>${port}</code>\n` +
            `📍 Адрес: <code>${ip ? ip + ':' + port : '??:' + port}</code>\n` +
            `📁 Папка: <code>${esc(dir)}</code>\n\n` +
            `ℹ️ Дописка «${esc(ENV.BRAND_MOTD)}» добавлена в MOTD. Изменить можно в server.properties.`,
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
    const port = readServerPort(s.dir, s.port || 25565);
    const ip   = await getPublicIp().catch(() => null);
    const connStr = ip ? `${ip}:${port}` : `порт ${port}`;

    // Live status (online players, MC version) — only when running.
    let liveLine = '';
    if (live) {
        const st = await queryMinecraftStatus('127.0.0.1', port).catch(() => null);
        if (st) {
            const online = st.players?.online ?? '?';
            const max    = st.players?.max ?? s.slots ?? '?';
            liveLine = `\n👥 Онлайн: <b>${esc(online)}</b>/<b>${esc(max)}</b>`;
            if (st.version?.name) liveLine += `\n⛙️ Протокол: <code>${esc(st.version.name)}</code>`;
        }
    }

    return safeEdit(ctx,
        `<tg-emoji emoji-id="5884479287171485878">📦</tg-emoji> <b>${esc(s.name)}</b>\n` +
        `<tg-emoji emoji-id="5870982283724328568">⚙️</tg-emoji> Сборка: ${esc(s.flavor)} ${esc(s.mc_version)}\n` +
        `<tg-emoji emoji-id="6042011682497106307">📍</tg-emoji> Адрес: <code>${esc(connStr)}</code>\n` +
        `📐 Слоты: <b>${esc(s.slots || 20)}</b>` +
        (s.motd ? `\n📝 MOTD: <code>${esc(String(s.motd).slice(0, 60))}</code>` : '') +
        liveLine + `\n` +
        `<tg-emoji emoji-id="5870528606328852614">📁</tg-emoji> Папка: <code>${esc(s.dir)}</code>\n` +
        `Статус: ${live ? '🟢 запущен' : '⚪ остановлен'}`,
        Markup.inlineKeyboard([
            live
                ? [Markup.button.callback('🛑 Остановить',       `srv:stop:${s.id}`),
                   Markup.button.callback('🖥 Консоль',           `srv:console:${s.id}`)]
                : [Markup.button.callback('▶️ Запустить',         `srv:start:${s.id}`)],
            [Markup.button.callback('📊 Статус / онлайн',      `srv:status:${s.id}`)],
            [Markup.button.callback('📦 Загрузить файл',          `srv:upfor:${s.id}`)],
            [Markup.button.callback('📁 Файловый менеджер',       `fm:browse:${s.id}:`)],
            [Markup.button.callback('📜 Лог',                     `srv:log:${s.id}`)],
            [Markup.button.callback('🗑 Удалить',                  `srv:delask:${s.id}`)],
            [Markup.button.callback('⬅️ К списку',                 'srv:list')],
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

// =====================================================================
// LIVE CONSOLE (send commands + see output)
// =====================================================================
// UX:
//   1) User taps «🖥 Консоль» — we send a fresh message and remember its id
//      in `state.consoleMsg`. The bot listens for the next text message(s)
//      and treats every plain text from this chat (until exit) as a console
//      command.
//   2) On each user command:
//        • we DELETE the user message right away (clean chat)
//        • write the command into the server's stdin
//        • EDIT the console message with the new log tail (so we keep ONE
//          rolling message, not a spam of replies)
//   3) The 'log' button still works for the full historical log.
// =====================================================================

async function refreshConsoleMessage(ctx, server, state, sentCmd) {
    if (!state || !state.consoleMsg) return;
    const tail = tailString(state.log.join(''), 3200);
    const head =
        `<tg-emoji emoji-id="5870982283724328568">⚙️</tg-emoji> <b>Консоль «${esc(server.name)}»</b>` +
        (sentCmd ? `\n➜ отправлено: <code>${esc(sentCmd)}</code>` : '') +
        `\n<i>Отправьте любое сообщение — это будет командой серверу. /exit — выход.</i>\n\n` +
        `<pre>${esc(tail || '(пусто)')}</pre>`;
    try {
        await ctx.telegram.editMessageText(
            state.consoleMsg.chatId,
            state.consoleMsg.messageId,
            undefined,
            head,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Обновить', `srv:console:${server.id}`),
                     Markup.button.callback('❌ Выйти',     `srv:consoff:${server.id}`)],
                    [Markup.button.callback('🛑 Остановить сервер', `srv:stop:${server.id}`)],
                ]),
            }
        );
    } catch (e) {
        // Message too old / not modified — silently ignore.
        if (!/message is not modified/i.test(e?.response?.description || e?.message || '')) {
            log.debug('console edit failed:', e.message);
        }
    }
}

bot.action(/^srv:console:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id)
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    const state = RUNNING.get(id);
    if (!state) {
        return safeEdit(ctx,
            '⚠️ Сервер не запущен. Сначала нажмите «▶️ Запустить».',
            Markup.inlineKeyboard([
                [Markup.button.callback('▶️ Запустить', `srv:start:${id}`)],
                [Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)],
            ])
        );
    }
    // Bind console session: every plain text from this chat becomes a command
    ctx.session.consoleFor = { serverId: id, chatId: ctx.chat.id };
    const tail = tailString(state.log.join(''), 3200);
    const sent = await ctx.reply(
        `<tg-emoji emoji-id="5870982283724328568">⚙️</tg-emoji> <b>Консоль «${esc(s.name)}»</b>\n` +
        `<i>Отправьте любое сообщение — это будет командой серверу. /exit — выйти из консоли.</i>\n\n` +
        `<pre>${esc(tail || '(пусто)')}</pre>`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Обновить', `srv:console:${id}`),
                 Markup.button.callback('❌ Выйти',     `srv:consoff:${id}`)],
                [Markup.button.callback('🛑 Остановить сервер', `srv:stop:${id}`)],
            ]),
        }
    );
    state.consoleMsg = { chatId: ctx.chat.id, messageId: sent.message_id };
});

bot.action(/^srv:consoff:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Консоль закрыта').catch(() => {});
    ctx.session.consoleFor = null;
    const id = Number(ctx.match[1]);
    const st = RUNNING.get(id);
    if (st) st.consoleMsg = null;
    const s = ServersRepo.byId(id);
    return safeEdit(ctx,
        `Консоль закрыта.`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ К серверу', `srv:open:${s?.id || id}`)]])
    );
});

// =====================================================================
// STATUS QUERY (online players, MOTD, version) via SLP
// =====================================================================
bot.action(/^srv:status:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id)
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});
    const live = RUNNING.has(id);
    const port = readServerPort(s.dir, s.port || 25565);
    const ip   = await getPublicIp().catch(() => null);

    let body = `⛙️ <b>${esc(s.name)}</b> — ${esc(s.flavor)} ${esc(s.mc_version)}\n` +
               `📍 <code>${esc(ip ? ip + ':' + port : '??:' + port)}</code>\n` +
               `📐 Слоты: <b>${esc(s.slots || 20)}</b>\n` +
               `Статус: ${live ? '🟢 запущен' : '⚪ остановлен'}`;

    if (live) {
        const st = await queryMinecraftStatus('127.0.0.1', port).catch(() => null);
        if (st) {
            const online = st.players?.online ?? '?';
            const max    = st.players?.max ?? s.slots ?? '?';
            const motd   = motdToString(st.description) || '';
            const names  = (st.players?.sample || []).map((p) => p.name).filter(Boolean);
            body += `\n👥 Онлайн: <b>${esc(online)}</b>/<b>${esc(max)}</b>`;
            if (names.length) body += `\n📦 Игроки: ${names.map((n) => esc(n)).join(', ')}`;
            if (motd) body += `\n📝 MOTD: <code>${esc(motd.slice(0, 80))}</code>`;
            if (st.version?.name) body += `\n⛙️ Игровая версия: <code>${esc(st.version.name)}</code>`;
        } else {
            body += `\n<i>Сервер запущен, но пинг ещё не отвечает (подождите ~10 сек).</i>`;
        }
    }

    return safeEdit(ctx, body,
        Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Обновить', `srv:status:${id}`)],
            [Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)],
        ])
    );
});

// =====================================================================
// FILE MANAGER
// =====================================================================

/** Encode a relative path for use in callback_data (base64url, max 32 chars displayed). */
function encodeRelPath(rel) {
    return Buffer.from(rel || '').toString('base64url');
}
function decodeRelPath(enc) {
    try { return Buffer.from(enc || '', 'base64url').toString('utf8'); } catch { return ''; }
}

bot.action(/^fm:browse:(\d+):(.*)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id      = Number(ctx.match[1]);
    const relPath = decodeRelPath(ctx.match[2]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id)
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});

    let absPath;
    try {
        absPath = resolveServerPath(s, relPath);
    } catch (e) {
        return safeEdit(ctx, `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> ${esc(e.message)}`,
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)]]));
    }

    let stat;
    try { stat = await fsp.stat(absPath); } catch {
        return safeEdit(ctx, 'Путь не найден.',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)]]));
    }

    // If it's a text file — show content
    if (stat.isFile()) {
        const ext = path.extname(absPath).toLowerCase();
        const textExts = ['.txt','.log','.yml','.yaml','.json','.properties','.cfg','.conf','.sk','.java','.toml','.xml','.sh','.md'];
        if (textExts.includes(ext) || stat.size < 8000) {
            try {
                const { text, truncated, size } = await readTextFile(absPath);
                const sizeStr = size > 1024 ? `${(size/1024).toFixed(1)} КБ` : `${size} Б`;
                const parentRel = path.dirname(relPath);
                await safeEdit(ctx,
                    `<tg-emoji emoji-id="5870528606328852614">📁</tg-emoji> <b>${esc(path.basename(absPath))}</b> (${sizeStr})` +
                    (truncated ? ' <i>[обрезан до 8 КБ]</i>' : '') +
                    `\n<pre>${esc(text)}</pre>`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🗑 Удалить файл', `fm:del:${id}:${encodeRelPath(relPath)}`)],
                        [Markup.button.callback('⬅️ Назад', `fm:browse:${id}:${encodeRelPath(parentRel)}`)],
                    ])
                );
                return;
            } catch (e) {
                // fall through to show as binary
            }
        }
        // Non-text or read error
        const parentRel = path.dirname(relPath);
        return safeEdit(ctx,
            `<tg-emoji emoji-id="5870528606328852614">📁</tg-emoji> <b>${esc(path.basename(absPath))}</b>\n` +
            `<i>Бинарный файл или не удалось прочитать.</i>`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🗑 Удалить файл', `fm:del:${id}:${encodeRelPath(relPath)}`)],
                [Markup.button.callback('⬅️ Назад', `fm:browse:${id}:${encodeRelPath(parentRel)}`)],
            ])
        );
    }

    // It's a directory — list contents
    let entries;
    try {
        entries = await listDir(absPath);
    } catch (e) {
        return safeEdit(ctx, `Ошибка чтения директории: ${esc(e.message)}`,
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)]]));
    }

    const rows = entries.map((e) => {
        const childRel = relPath ? `${relPath}/${e.name}` : e.name;
        const icon = e.isDir ? '📂' : '📄';
        return [Markup.button.callback(`${icon} ${e.name}`, `fm:browse:${id}:${encodeRelPath(childRel)}`)];
    });

    // Back button
    const isRoot = !relPath || relPath === '';
    if (!isRoot) {
        const parentRel = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '';
        rows.push([Markup.button.callback('⬅️ Вверх', `fm:browse:${id}:${encodeRelPath(parentRel)}`)]);
    }
    rows.push([Markup.button.callback('⬅️ К серверу', `srv:open:${id}`)]);

    const title = relPath || '/';
    return safeEdit(ctx,
        `<tg-emoji emoji-id="5870528606328852614">📁</tg-emoji> <b>${esc(s.name)}</b> — <code>${esc(title)}</code>\n` +
        `Файлов/папок: ${entries.length}` + (entries.length === 60 ? ' (показаны первые 60)' : ''),
        Markup.inlineKeyboard(rows)
    );
});

// Delete confirmation
bot.action(/^fm:del:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id      = Number(ctx.match[1]);
    const relPath = decodeRelPath(ctx.match[2]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id)
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});

    let absPath;
    try { absPath = resolveServerPath(s, relPath); } catch (e) {
        return safeEdit(ctx, `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> ${esc(e.message)}`);
    }

    const parentRel = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '';
    return safeEdit(ctx,
        `<tg-emoji emoji-id="5870875489362513438">🗑</tg-emoji> Удалить <code>${esc(relPath)}</code>?\n<i>Действие необратимо.</i>`,
        Markup.inlineKeyboard([
            [Markup.button.callback('🗑 Да, удалить', `fm:delok:${id}:${encodeRelPath(relPath)}`)],
            [Markup.button.callback('⬅️ Отмена',       `fm:browse:${id}:${encodeRelPath(parentRel)}`)],
        ])
    );
});

bot.action(/^fm:delok:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id      = Number(ctx.match[1]);
    const relPath = decodeRelPath(ctx.match[2]);
    const s = ServersRepo.byId(id);
    if (!s) return safeEdit(ctx, 'Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id)
        return ctx.answerCbQuery('🚫 Это не ваш сервер.', { show_alert: true }).catch(() => {});

    let absPath;
    try { absPath = resolveServerPath(s, relPath); } catch (e) {
        return safeEdit(ctx, `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> ${esc(e.message)}`);
    }

    try {
        const stat = await fsp.stat(absPath);
        if (stat.isDirectory()) {
            await fsp.rm(absPath, { recursive: true, force: true });
        } else {
            await fsp.unlink(absPath);
        }
    } catch (e) {
        return safeEdit(ctx, `<tg-emoji emoji-id="5870657884844462243">❌</tg-emoji> Ошибка удаления: ${esc(e.message)}`);
    }

    const parentRel = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '';
    return safeEdit(ctx,
        `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> <code>${esc(relPath)}</code> удалён.`,
        Markup.inlineKeyboard([[Markup.button.callback('📁 Вернуться', `fm:browse:${id}:${encodeRelPath(parentRel)}`)]])
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
        `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> AI (<code>${esc(getSetting('ai_model'))}</code>) анализирует сервер и пишет код…`,
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
        `<tg-emoji emoji-id="6041731551845159060">🎉</tg-emoji> <b>Готово!</b> AI сгенерировала (<i>${esc(result.type)}</i>):\n` +
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

    const dlMsg = await ctx.reply('<tg-emoji emoji-id="6039802767931871481">⬇️</tg-emoji> Загружаю файл…');

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
        `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> Спрашиваю AI (модель: <code>${esc(getSetting('ai_model'))}</code>), куда положить файл…`,
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
        [Markup.button.callback('➕ Выдать доступ',     'adm:grant')],
        [Markup.button.callback('➖ Отозвать доступ',   'adm:revoke')],
        [Markup.button.callback('👥 Список пользователей', 'adm:list')],
        [Markup.button.callback(`🧠 Модель AI (${getSetting('ai_model')})`, 'adm:model')],
        [Markup.button.callback('🌐 Публичный IP',      'adm:ip')],
        [Markup.button.callback('⬅️ В меню',            'menu:main')],
    ]);
}

async function openAdminPanel(ctx) {
    if (!isAdmin(ctx.from.id)) return;
    const text = '<tg-emoji emoji-id="5870982283724328568">⚙️</tg-emoji> <b>Админ-панель</b>';
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

bot.action('adm:ip', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    await safeEdit(ctx, '<tg-emoji emoji-id="6028435952299413210">ℹ</tg-emoji> Определяю публичный IP…');
    const ip = await getPublicIp().catch(() => null);
    const servers = ServersRepo.listAll();
    const srvLines = servers.map((s) => {
        const port = readServerPort(s.dir, s.port || 25565);
        return `• <b>${esc(s.name)}</b>: <code>${ip ? ip + ':' + port : '??:' + port}</code>`;
    }).join('\n') || '<i>Серверов нет</i>';

    return safeEdit(ctx,
        `<tg-emoji emoji-id="6042011682497106307">📍</tg-emoji> <b>Публичный IP:</b> <code>${ip ? esc(ip) : 'не определён'}</code>\n\n` +
        `<b>Адреса серверов:</b>\n${srvLines}`,
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
        `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Модель AI установлена: <b>${esc(m)}</b>`,
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
