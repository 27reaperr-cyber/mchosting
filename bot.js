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
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');

const { Telegraf, Markup, session } = require('telegraf');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const { request, stream } = require('undici');

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

// =====================================================================
// 1. LOGGER
// =====================================================================

const log = {
    _ts: () => new Date().toISOString(),
    info: (...a) => console.log(`[${log._ts()}] [INFO ]`, ...a),
    warn: (...a) => console.warn(`[${log._ts()}] [WARN ]`, ...a),
    error: (...a) => console.error(`[${log._ts()}] [ERROR]`, ...a),
    debug: (...a) => process.env.DEBUG && console.log(`[${log._ts()}] [DEBUG]`, ...a),
};

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
        flavor     TEXT    NOT NULL,        -- paper | spigot | bukkit
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

// Settings helpers
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
// Initialise default model
if (!getSetting('ai_model')) setSetting('ai_model', ENV.ONLYSQ_DEFAULT_MODEL);

// Access helpers
function isAdmin(tgId) { return Number(tgId) === ENV.ADMIN_ID; }

function hasAccess(tgId, username) {
    if (isAdmin(tgId)) return true;
    const byId = db.prepare(`SELECT 1 FROM users WHERE tg_id = ?`).get(tgId);
    if (byId) return true;

    // Promote pending @username → real user record
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
    // target: either numeric id or @username
    const t = String(target).trim().replace(/^@/, '');
    if (/^\d+$/.test(t)) {
        const id = Number(t);
        db.prepare(
            `INSERT OR IGNORE INTO users(tg_id, username, granted_by) VALUES (?,?,?)`
        ).run(id, null, grantedBy);
        return { kind: 'id', value: id };
    }
    // username — we can't resolve it to id without the user contacting the bot,
    // so we store it as "pending"; when that user writes /start, they're auto-promoted.
    db.prepare(
        `INSERT OR REPLACE INTO pending_usernames(username, granted_by) VALUES (?,?)`
    ).run(t, grantedBy);
    return { kind: 'username', value: t };
}

function revokeAccess(target) {
    const t = String(target).trim().replace(/^@/, '');
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

async function listOnlySqModels() {
    try {
        const r = await onlysq.models.list();
        // SDK returns { data: [{id, ...}, ...] } via paged iterator
        const items = [];
        for await (const m of r) items.push(m);
        return items.map((m) => m.id).sort();
    } catch (e) {
        log.warn('models.list failed, falling back to defaults:', e.message);
        return [
            'claude-haiku-4-5',
            'claude-sonnet-4-5',
            'gpt-4o',
            'gpt-4o-mini',
            'gemini-2.5-pro',
            'deepseek-r1',
        ];
    }
}

async function aiChat({ system, user, model, jsonMode = false, maxTokens = 1500 }) {
    const m = model || getSetting('ai_model') || ENV.ONLYSQ_DEFAULT_MODEL;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const resp = await onlysq.chat.completions.create({
        model: m,
        messages,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
    return resp.choices?.[0]?.message?.content?.trim() ?? '';
}

// =====================================================================
// 4. MINECRAFT VERSION PROVIDERS
// =====================================================================

const PaperAPI = {
    base: 'https://fill.papermc.io/v3',
    headers: () => ({ 'User-Agent': ENV.PAPER_UA, Accept: 'application/json' }),

    async listVersions(project = 'paper') {
        // Returns versions grouped → flatten
        const { body, statusCode } = await request(`${this.base}/projects/${project}`, {
            headers: this.headers(),
        });
        if (statusCode !== 200) throw new Error(`Paper API ${statusCode}`);
        const data = await body.json();
        // data.versions is { "1.21": [...], "1.20": [...] }
        const versions = [];
        for (const list of Object.values(data.versions || {})) {
            for (const v of list) versions.push(v);
        }
        // newest first (rely on API order)
        return versions;
    },

    async getDownload(project, mcVersion) {
        const { body, statusCode } = await request(
            `${this.base}/projects/${project}/versions/${mcVersion}/builds`,
            { headers: this.headers() }
        );
        if (statusCode !== 200) throw new Error(`Paper builds API ${statusCode}`);
        const builds = await body.json();
        // first stable build
        const stable = builds.find((b) => b.channel === 'STABLE') || builds[0];
        if (!stable) throw new Error('No builds found');
        const dl = stable.downloads?.['server:default'];
        if (!dl?.url) throw new Error('No server:default download');
        return { url: dl.url, filename: dl.name || `${project}-${mcVersion}.jar`, sha256: dl.checksums?.sha256 };
    },
};

const GetBukkitAPI = {
    // GetBukkit is a static download mirror — versions are known publicly but
    // there's no JSON index. We keep a curated list of widely-used versions.
    // Admin can add more via env in future; for now we offer the most useful range.
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
        throw new Error(`HTTP ${res.statusCode} when downloading ${url}`);
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(res.body, createWriteStream(dest));
    return dest;
}

function safeName(s) {
    return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'server';
}

function ensureDirSync(p) { fs.mkdirSync(p, { recursive: true }); }

function detectFileKind(filename) {
    const f = filename.toLowerCase();
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

/**
 * Map<serverId, { child, chatId, log: string[], startedAt }>
 */
const RUNNING = new Map();

function tailString(s, max = 4000) {
    if (s.length <= max) return s;
    return '…' + s.slice(s.length - max);
}

async function startServer(server, ctx) {
    if (RUNNING.has(server.id)) {
        await ctx.reply('⚠️ Сервер уже запущен.');
        return;
    }
    // Ensure EULA accepted (Mojang requirement) — write eula.txt
    await fsp.writeFile(path.join(server.dir, 'eula.txt'), 'eula=true\n');

    const args = [
        `-Xms${ENV.JVM_XMS}`,
        `-Xmx${ENV.JVM_XMX}`,
        '-XX:+UseG1GC',
        '-jar', server.jar,
        'nogui',
    ];
    log.info(`Starting server #${server.id} (${server.flavor} ${server.mc_version}) in ${server.dir}`);

    const child = spawn(ENV.JAVA_BIN, args, {
        cwd: server.dir,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

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
                ctx.telegram.sendMessage(state.chatId,
                    `✅ Сервер «${server.name}» успешно запустился.`).catch(() => {});
            }
        }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('exit', async (code) => {
        RUNNING.delete(server.id);
        const tail = tailString(state.log.join(''), 3500);
        await ctx.telegram.sendMessage(state.chatId,
            `🛑 Сервер «${server.name}» остановлен (код ${code}).`
        ).catch(() => {});
        // AI post-mortem if non-zero exit
        if (code !== 0) {
            try {
                const verdict = await aiAnalyseStartup(tail, server);
                await ctx.telegram.sendMessage(state.chatId,
                    `🤖 *AI-разбор завершения сервера:*\n${verdict}`,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            } catch (e) { log.warn('AI post-mortem failed:', e.message); }
        }
    });

    // After 20 seconds → if still booting, ask AI if everything looks fine
    setTimeout(async () => {
        const st = RUNNING.get(server.id);
        if (!st || st.bootDone) return;
        try {
            const verdict = await aiAnalyseStartup(st.bootLogForAI, server);
            ctx.telegram.sendMessage(st.chatId,
                `🤖 *AI-диагностика запуска (20 сек):*\n${verdict}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        } catch (e) { log.warn('AI boot-check failed:', e.message); }
    }, 20_000);

    await ctx.reply(
        `🚀 Сервер «${server.name}» запускается…\n` +
        `Лог появится через несколько секунд.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('📜 Показать лог', `srv:log:${server.id}`)],
            [Markup.button.callback('🛑 Остановить',   `srv:stop:${server.id}`)],
        ])
    );
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

/**
 * Ask AI where to place an uploaded file (relative path inside server dir),
 * and — if it's an archive — how to extract its contents.
 *
 * Returns: { action: 'place'|'extract', target: 'plugins'|'world'|'.'|..., reason: string }
 */
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
        if (!j.target) j.target = '.';
        if (!j.action) j.action = kind === 'zip' || kind === 'tar' || kind === 'tar.gz' ? 'extract' : 'place';
        return j;
    } catch {
        // Fallback heuristic
        if (kind === 'jar') return { action: 'place', target: 'plugins', reason: 'JAR → плагины (heuristic).' };
        if (kind === 'zip' || kind === 'tar' || kind === 'tar.gz') {
            return { action: 'extract', target: '.', reason: 'Архив → корень (heuristic).' };
        }
        return { action: 'place', target: '.', reason: 'Неизвестный тип → корень (heuristic).' };
    }
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
        p.on('exit', (code) => code === 0 ? resolve({ out, err })
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
        await ctx.reply(
            `🚫 Доступ к боту ограничен.\n` +
            `Ваш Telegram ID: \`${u.id}\`\n` +
            `Попросите администратора выдать доступ.`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
        return; // do NOT call next()
    }
    return next();
});

// ---- helpers for UI ----
function mainMenu(ctx) {
    const adm = isAdmin(ctx.from.id);
    const rows = [
        [Markup.button.callback('🆕 Новый сервер', 'srv:new')],
        [Markup.button.callback('📂 Мои серверы',  'srv:list')],
        [Markup.button.callback('📦 Загрузить файл / плагин', 'srv:upload')],
    ];
    if (adm) rows.push([Markup.button.callback('⚙️ Админ-панель', 'adm:open')]);
    return Markup.inlineKeyboard(rows);
}

bot.start(async (ctx) => {
    await ctx.reply(
        `👋 Привет, *${ctx.from.first_name || 'пользователь'}*!\n\n` +
        `Я помогу установить и запустить Minecraft-сервер` +
        ` (Bukkit / Spigot / Paper) и интегрирую AI-помощника от OnlySQ.\n\n` +
        `Выберите действие:`,
        { parse_mode: 'Markdown', ...mainMenu(ctx) }
    );
});

bot.command('cancel', async (ctx) => {
    ctx.session = {};
    await ctx.reply('✖️ Операция отменена.', mainMenu(ctx));
});

bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Только для админа.');
    return openAdminPanel(ctx);
});

// ---------- "Новый сервер" wizard ----------
bot.action('srv:new', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.wizard = { step: 'flavor' };
    await ctx.reply(
        '🧱 Выберите сборку сервера:',
        Markup.inlineKeyboard([
            [Markup.button.callback('Paper (рекомендуется)', 'new:flavor:paper')],
            [Markup.button.callback('Spigot', 'new:flavor:spigot')],
            [Markup.button.callback('Bukkit', 'new:flavor:bukkit')],
            [Markup.button.callback('❌ Отмена', 'wiz:cancel')],
        ])
    );
});

bot.action(/^new:flavor:(paper|spigot|bukkit)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const flavor = ctx.match[1];
    ctx.session.wizard = { step: 'version', flavor };
    await ctx.reply(`🔍 Получаю список версий для ${flavor}…`);
    let versions;
    try { versions = await getServerVersions(flavor); }
    catch (e) {
        return ctx.reply(`❌ Не удалось получить версии: ${e.message}`);
    }
    if (!versions.length) return ctx.reply('❌ Список версий пуст.');

    // Show top 12 versions as buttons, rest accessible via pagination
    ctx.session.wizard.versions = versions;
    await renderVersionPage(ctx, 0);
});

async function renderVersionPage(ctx, page) {
    const all = ctx.session.wizard.versions;
    const perPage = 12;
    const totalPages = Math.ceil(all.length / perPage);
    const slice = all.slice(page * perPage, (page + 1) * perPage);
    const buttons = slice.map((v) => [Markup.button.callback(v, `new:ver:${v}`)]);
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️', `new:page:${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
    if (page < totalPages - 1) nav.push(Markup.button.callback('➡️', `new:page:${page + 1}`));
    buttons.push(nav);
    buttons.push([Markup.button.callback('❌ Отмена', 'wiz:cancel')]);
    await ctx.reply(`Выберите версию Minecraft (${all.length} доступно):`,
        Markup.inlineKeyboard(buttons));
}

bot.action(/^new:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.session.wizard?.versions) return ctx.reply('Сессия истекла. /start');
    await renderVersionPage(ctx, Number(ctx.match[1]));
});

bot.action('noop', async (ctx) => ctx.answerCbQuery());

bot.action(/^new:ver:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.session.wizard?.flavor) return ctx.reply('Сессия истекла. /start');
    const version = ctx.match[1];
    ctx.session.wizard.mcVersion = version;
    ctx.session.wizard.step = 'name';
    await ctx.reply(
        `Версия: *${version}*.\n` +
        `Введите имя для нового сервера (a-z, 0-9, _-, до 40 символов):`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('wiz:cancel', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.wizard = null;
    await ctx.reply('✖️ Установка отменена.', mainMenu(ctx));
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
            if (r.kind === 'id')
                await ctx.reply(`✅ Доступ выдан пользователю с ID \`${r.value}\`.`,
                    { parse_mode: 'Markdown' });
            else
                await ctx.reply(`✅ Доступ выдан @${r.value}. Когда пользователь напишет /start — он будет добавлен автоматически.`);
        } else if (a.action === 'revoke') {
            const r = revokeAccess(text);
            await ctx.reply(r.ok ? `✅ Доступ отозван (${r.value}).` : `⚠️ Не найден / нельзя удалить.`);
        }
        return openAdminPanel(ctx);
    }

    // ----- Wizard: server name -----
    if (w && w.step === 'name') {
        const name = ctx.message.text.trim();
        if (!/^[\w.-]{2,40}$/.test(name))
            return ctx.reply('❌ Имя должно быть 2–40 символов: буквы/цифры/._-');
        const dirName = `${ctx.from.id}_${safeName(name)}_${Date.now()}`;
        const dir = path.join(ENV.SERVERS_ROOT, dirName);
        ensureDirSync(dir);

        await ctx.reply(`⬇️ Скачиваю ${w.flavor} ${w.mcVersion}…`);
        let jarPath;
        try {
            const dl = await resolveServerDownload(w.flavor, w.mcVersion);
            jarPath = path.join(dir, dl.filename);
            await downloadToFile(dl.url, jarPath);
        } catch (e) {
            await fsp.rm(dir, { recursive: true, force: true });
            ctx.session.wizard = null;
            return ctx.reply(`❌ Не удалось скачать: ${e.message}`);
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
        await ctx.reply(
            `✅ Сервер «${name}» (${w.flavor} ${w.mcVersion}) установлен.\n` +
            `Папка: \`${dir}\``,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('▶️ Запустить', `srv:start:${srv.id}`)],
                    [Markup.button.callback('📂 К списку серверов', 'srv:list')],
                ]),
            }
        );
        return;
    }

    // ----- Upload wizard: URL input -----
    if (ctx.session.uploadWait) {
        const url = ctx.message.text.trim();
        if (!/^https?:\/\//i.test(url))
            return ctx.reply('Введите корректный URL (http/https) или /cancel.');
        const serverId = ctx.session.uploadWait.serverId;
        ctx.session.uploadWait = null;
        return handleIncomingFile(ctx, { kind: 'url', url, serverId });
    }

    return next();
});

// ---------- "Мои серверы" ----------
bot.action('srv:list', async (ctx) => {
    await ctx.answerCbQuery();
    const owned = isAdmin(ctx.from.id) ? ServersRepo.listAll() : ServersRepo.listByOwner(ctx.from.id);
    if (!owned.length) return ctx.reply('У вас нет серверов. Создайте новый.', mainMenu(ctx));
    const rows = owned.map((s) => {
        const live = RUNNING.has(s.id) ? '🟢 ' : '⚪ ';
        return [Markup.button.callback(
            `${live}#${s.id} ${s.name} (${s.flavor} ${s.mc_version})`,
            `srv:open:${s.id}`
        )];
    });
    await ctx.reply('📂 Ваши серверы:', Markup.inlineKeyboard(rows));
});

bot.action(/^srv:open:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const s = ServersRepo.byId(Number(ctx.match[1]));
    if (!s) return ctx.reply('Сервер не найден.');
    const live = RUNNING.has(s.id);
    await ctx.reply(
        `📦 *${s.name}*\n` +
        `Сборка: ${s.flavor} ${s.mc_version}\n` +
        `Папка: \`${s.dir}\`\n` +
        `Статус: ${live ? '🟢 запущен' : '⚪ остановлен'}`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                live
                    ? [Markup.button.callback('🛑 Остановить', `srv:stop:${s.id}`)]
                    : [Markup.button.callback('▶️ Запустить',  `srv:start:${s.id}`)],
                [Markup.button.callback('📦 Загрузить файл',  `srv:upfor:${s.id}`)],
                [Markup.button.callback('📜 Лог',             `srv:log:${s.id}`)],
                [Markup.button.callback('🗑 Удалить',          `srv:del:${s.id}`)],
            ]),
        }
    );
});

bot.action(/^srv:start:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const s = ServersRepo.byId(Number(ctx.match[1]));
    if (!s) return ctx.reply('Сервер не найден.');
    await startServer(s, ctx);
});

bot.action(/^srv:stop:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    if (stopServer(id)) await ctx.reply('🛑 Отправлена команда `stop` серверу.', { parse_mode: 'Markdown' });
    else                await ctx.reply('Сервер не запущен.');
});

bot.action(/^srv:log:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    const st = RUNNING.get(id);
    if (!st) return ctx.reply('Сервер не запущен (нет live-лога).');
    const tail = tailString(st.log.join(''), 3500);
    await ctx.reply('```\n' + (tail || '(пусто)') + '\n```', { parse_mode: 'Markdown' });
});

bot.action(/^srv:del:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    const s = ServersRepo.byId(id);
    if (!s) return ctx.reply('Сервер не найден.');
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id)
        return ctx.reply('Нельзя удалить чужой сервер.');
    if (RUNNING.has(id)) stopServer(id);
    try { await fsp.rm(s.dir, { recursive: true, force: true }); } catch {}
    ServersRepo.delete(id);
    await ctx.reply(`🗑 Сервер #${id} удалён.`, mainMenu(ctx));
});

// ---------- Upload (general) ----------
bot.action('srv:upload', async (ctx) => {
    await ctx.answerCbQuery();
    const owned = isAdmin(ctx.from.id) ? ServersRepo.listAll() : ServersRepo.listByOwner(ctx.from.id);
    if (!owned.length) return ctx.reply('Сначала создайте сервер.', mainMenu(ctx));
    await ctx.reply('Выберите сервер для загрузки:',
        Markup.inlineKeyboard(owned.map((s) => [
            Markup.button.callback(`#${s.id} ${s.name}`, `srv:upfor:${s.id}`)
        ]))
    );
});

bot.action(/^srv:upfor:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    ctx.session.uploadWait = { serverId: id };
    await ctx.reply(
        `📦 Пришлите файл (документ) или ссылку (http/https) на плагин/карту/архив.\n` +
        `Лимит: ${ENV.MAX_UPLOAD_MB} МБ (для прямой загрузки в Telegram).\n` +
        `Для отмены — /cancel`
    );
});

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
        kind: 'tg', fileId: doc.file_id, filename: doc.file_name || `file_${Date.now()}`,
        serverId: u.serverId,
    });
});

async function handleIncomingFile(ctx, opts) {
    const server = ServersRepo.byId(opts.serverId);
    if (!server) return ctx.reply('Сервер не найден.');
    await ctx.reply('⬇️ Загружаю файл…');

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mctgbot-'));
    let localFile, filename;
    try {
        if (opts.kind === 'url') {
            const url = opts.url;
            filename = decodeURIComponent(url.split('?')[0].split('/').pop()) || `download_${Date.now()}`;
            localFile = path.join(tmpDir, safeName(filename));
            await downloadToFile(url, localFile);
        } else {
            const link = await ctx.telegram.getFileLink(opts.fileId);
            filename = opts.filename;
            localFile = path.join(tmpDir, safeName(filename));
            await downloadToFile(link.href, localFile);
        }
    } catch (e) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        return ctx.reply(`❌ Ошибка загрузки: ${e.message}`);
    }

    const kind = detectFileKind(filename);
    let listing = null;
    if (['zip', 'tar.gz', 'tar'].includes(kind)) {
        listing = await listArchive(localFile, kind);
    }

    await ctx.reply(`🤖 Спрашиваю AI (модель: \`${getSetting('ai_model')}\`), куда положить файл…`,
        { parse_mode: 'Markdown' });

    let plan;
    try {
        plan = await aiPlanFilePlacement({ filename, kind, server, listing });
    } catch (e) {
        plan = { action: kind === 'jar' ? 'place' : 'extract', target: kind === 'jar' ? 'plugins' : '.',
                 reason: `AI недоступен (${e.message}), используем эвристику.` };
    }
    log.info(`AI plan for ${filename}:`, plan);

    // Safety: prevent path-escape
    const safeTarget = path.normalize(plan.target || '.').replace(/^([./\\])+/, '');
    const destDir = path.join(server.dir, safeTarget || '.');
    if (!destDir.startsWith(server.dir)) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        return ctx.reply('❌ AI предложил небезопасный путь. Операция прервана.');
    }
    await fsp.mkdir(destDir, { recursive: true });

    try {
        if (plan.action === 'extract' && ['zip', 'tar.gz', 'tar'].includes(kind)) {
            await extractArchive(localFile, kind, destDir);
            await ctx.reply(
                `✅ Архив *${filename}* распакован в \`${path.relative(server.dir, destDir) || '.'}\`\n` +
                `🤖 Обоснование AI: _${plan.reason}_`,
                { parse_mode: 'Markdown' }
            );
        } else {
            const finalPath = path.join(destDir, path.basename(filename));
            await fsp.copyFile(localFile, finalPath);
            await ctx.reply(
                `✅ Файл *${filename}* сохранён в \`${path.relative(server.dir, finalPath)}\`\n` +
                `🤖 Обоснование AI: _${plan.reason}_`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (e) {
        await ctx.reply(`❌ Ошибка установки: ${e.message}`);
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    }
}

// =====================================================================
// 11. ADMIN PANEL
// =====================================================================

async function openAdminPanel(ctx) {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.reply(
        '⚙️ *Админ-панель*',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('➕ Выдать доступ',  'adm:grant')],
                [Markup.button.callback('➖ Отозвать доступ', 'adm:revoke')],
                [Markup.button.callback('👥 Список пользователей', 'adm:list')],
                [Markup.button.callback(`🧠 Модель AI (${getSetting('ai_model')})`, 'adm:model')],
                [Markup.button.callback('⬅️ В меню', 'adm:close')],
            ]),
        }
    );
}

bot.action('adm:open', async (ctx) => { await ctx.answerCbQuery(); openAdminPanel(ctx); });
bot.action('adm:close', async (ctx) => { await ctx.answerCbQuery(); ctx.reply('Главное меню:', mainMenu(ctx)); });

bot.action('adm:grant', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminWait = { action: 'grant' };
    await ctx.reply('Введите @username или числовой Telegram ID пользователя для выдачи доступа:');
});

bot.action('adm:revoke', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminWait = { action: 'revoke' };
    await ctx.reply('Введите @username или числовой Telegram ID пользователя для отзыва доступа:');
});

bot.action('adm:list', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const { users, pending } = listUsers();
    const u = users.map((x) => `• \`${x.tg_id}\`${x.username ? ` (@${x.username})` : ''}${x.tg_id === ENV.ADMIN_ID ? ' 👑' : ''}`).join('\n') || '_нет_';
    const p = pending.map((x) => `• @${x.username} _(ожидает /start)_`).join('\n') || '_нет_';
    await ctx.reply(
        `👥 *Пользователи с доступом:*\n${u}\n\n*Ожидают подтверждения:*\n${p}`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('adm:model', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await ctx.reply('🔍 Получаю список моделей с OnlySQ…');
    const models = await listOnlySqModels();
    const cur = getSetting('ai_model');
    // To keep within Telegram's button limits, show first 30
    const slice = models.slice(0, 30);
    const buttons = slice.map((m) => [
        Markup.button.callback(`${m === cur ? '✅ ' : ''}${m}`, `adm:setmodel:${m}`)
    ]);
    buttons.push([Markup.button.callback('⬅️ Назад', 'adm:open')]);
    await ctx.reply(
        `Текущая модель: *${cur}*\nВыберите новую:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
});

bot.action(/^adm:setmodel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const m = ctx.match[1];
    setSetting('ai_model', m);
    await ctx.reply(`✅ Модель AI установлена: *${m}*`, { parse_mode: 'Markdown' });
    openAdminPanel(ctx);
});

// =====================================================================
// 12. GLOBAL ERROR HANDLING
// =====================================================================

bot.catch((err, ctx) => {
    log.error('Telegraf error:', err);
    try { ctx.reply('⚠️ Внутренняя ошибка: ' + (err.message || 'unknown')); } catch {}
});

process.on('unhandledRejection', (r) => log.error('UnhandledRejection:', r));
process.on('uncaughtException',  (e) => log.error('UncaughtException:', e));

// =====================================================================
// 13. GRACEFUL SHUTDOWN
// =====================================================================

async function shutdown(signal) {
    log.info(`Received ${signal}. Stopping running servers…`);
    for (const [id, st] of RUNNING) {
        try { st.child.stdin.write('stop\n'); } catch {}
    }
    // wait up to 8s for clean stop
    const deadline = Date.now() + 8000;
    while (RUNNING.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
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
}).catch((e) => {
    log.error('Failed to launch bot:', e);
    process.exit(1);
});
