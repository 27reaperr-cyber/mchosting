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

// ---------------------------------------------------------------
// MULTI-JAVA DETECTION
// ---------------------------------------------------------------
// We need different Java versions for different MC/Forge versions:
//   - MC 1.7.x / 1.8.x / 1.12.2 / 1.15 / 1.16 (legacy Forge) → Java 8
//   - MC 1.16.5 (модерн)                                      → Java 11
//   - MC 1.17 .. 1.20.4                                       → Java 17
//   - MC 1.20.5+                                              → Java 21
//
// ENV.JAVA_INSTALLS — массив { bin, major, version } всех найденных JDK/JRE.
// ENV.JAVA_BIN остаётся «дефолтным» (новейший доступный) для совместимости.
// ---------------------------------------------------------------

function parseJavaMajor(versionStr) {
    if (!versionStr) return 0;
    // Примеры: 'openjdk version "1.8.0_391"', 'openjdk version "21.0.2"'
    const m = versionStr.match(/version\s+"([^"]+)"/);
    if (!m) return 0;
    const v = m[1];
    if (v.startsWith('1.')) return parseInt(v.split('.')[1], 10) || 0;
    return parseInt(v.split('.')[0], 10) || 0;
}

function scanAllJavaBinaries() {
    const found = [];
    const seen = new Set();
    const tryAdd = (bin) => {
        if (!bin || seen.has(bin)) return;
        seen.add(bin);
        const r = tryJavaBinary(bin);
        if (r) {
            const major = parseJavaMajor(r.version);
            found.push({ bin: r.bin, major, version: r.version });
        }
    };
    if (ENV.JAVA_BIN) tryAdd(ENV.JAVA_BIN);
    if (process.env.JAVA_HOME) tryAdd(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    try {
        const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['java'],
            { stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.status === 0) {
            for (const f of r.stdout.toString().split('\n').map(s => s.trim()).filter(Boolean)) {
                tryAdd(f);
            }
        }
    } catch { /* ignore */ }
    for (const p of ['/usr/bin/java', '/usr/local/bin/java', '/opt/java/bin/java']) tryAdd(p);
    // Глобальный скан /usr/lib/jvm/*/bin/java
    try {
        const jvmDir = '/usr/lib/jvm';
        if (fs.existsSync(jvmDir)) {
            for (const entry of fs.readdirSync(jvmDir)) {
                tryAdd(path.join(jvmDir, entry, 'bin', 'java'));
                tryAdd(path.join(jvmDir, entry, 'jre', 'bin', 'java'));
            }
        }
    } catch { /* ignore */ }
    // macOS
    try {
        const macLib = '/Library/Java/JavaVirtualMachines';
        if (fs.existsSync(macLib)) {
            for (const entry of fs.readdirSync(macLib)) {
                tryAdd(path.join(macLib, entry, 'Contents', 'Home', 'bin', 'java'));
            }
        }
    } catch { /* ignore */ }
    return found;
}

(function detectJava() {
    const installs = scanAllJavaBinaries();
    ENV.JAVA_INSTALLS = installs;
    if (installs.length) {
        // Дефолтным считаем НАИБОЛЕЕ НОВУЮ Java
        installs.sort((a, b) => b.major - a.major);
        const best = installs[0];
        ENV.JAVA_BIN = best.bin;
        ENV.JAVA_AVAILABLE = true;
        ENV.JAVA_VERSION_STR = best.version;
        ENV.JAVA_MAJOR = best.major;
    } else {
        ENV.JAVA_AVAILABLE = false;
        ENV.JAVA_VERSION_STR = '';
        ENV.JAVA_MAJOR = 0;
    }
})();

/**
 * По версии Minecraft выбирает РЕКОМЕНДУЕМЫЙ major Java.
 * Возвращает массив допустимых major (от наиболее предпочтительного).
 */
function requiredJavaMajorsForMc(mcVersion, flavor) {
    const parts = String(mcVersion || '').split('.').map(Number);
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    // Для Forge правила СТРОЖЕ — он часто падает на более новой Java:
    //   1.7.10  → только Java 8
    //   1.8 .. 1.12.2 → только Java 8
    //   1.13 .. 1.16.4 → Java 8 предпочтительно (11 допустимо)
    //   1.16.5 → Java 11 (Java 8 тоже работает)
    //   1.17 .. 1.18.1 → Java 16/17
    //   1.18.2 .. 1.20.4 → Java 17
    //   1.20.5+ → Java 21
    if (flavor === 'forge') {
        if (minor <= 12) return [8];
        if (minor <= 15) return [8, 11];
        if (minor === 16 && patch < 5) return [8, 11];
        if (minor === 16) return [11, 8];
        if (minor === 17) return [17, 16];
        if (minor <= 19) return [17];
        if (minor === 20 && patch < 5) return [17];
        return [21, 17];
    }
    // Paper / Spigot / Bukkit
    if (minor <= 16) return [11, 8, 17];
    if (minor === 17) return [17, 16, 21];
    if (minor <= 19) return [17, 21];
    if (minor === 20 && patch < 5) return [17, 21];
    return [21, 17];
}

/**
 * Выбирает физический путь до java для конкретного MC/flavor.
 * Возвращает { bin, major, version } или null.
 */
function pickJavaForServer(server) {
    const wanted = requiredJavaMajorsForMc(server.mc_version || server.mcVersion, server.flavor);
    if (!ENV.JAVA_INSTALLS || !ENV.JAVA_INSTALLS.length) return null;
    for (const want of wanted) {
        const m = ENV.JAVA_INSTALLS.find((j) => j.major === want);
        if (m) return m;
    }
    // Допускаем «близкий» вариант: для java-8 запроса берём 11 если есть;
    // для 17 запроса берём 21 и наоборот.
    const allMajors = ENV.JAVA_INSTALLS.map((j) => j.major).sort((a, b) => a - b);
    const want = wanted[0];
    const nearest = allMajors.reduce((best, cur) =>
        Math.abs(cur - want) < Math.abs((best ?? 999) - want) ? cur : best, null);
    return ENV.JAVA_INSTALLS.find((j) => j.major === nearest) || null;
}

/**
 * Автоустановка отсутствующей Java. Стратегия:
 *   1) Если есть apt-get и root — пробуем apt-пакеты (Temurin репо приоритетнее,
 *      т.к. на Ubuntu 22.04+ нет openjdk-8 в дефолтных репах).
 *   2) Если apt не сработал — скачиваем статический tarball Adoptium Temurin
 *      и распаковываем в /opt/java/temurin-<major>. Это работает на любом
 *      Linux-glibc-хосте без sudo (пишем в /opt — нужны права; иначе ~/.local/java).
 */
let _aptUpdated = false;
async function _aptUpdateOnce(sudo) {
    if (_aptUpdated) return;
    try {
        await runCmdSimple([...sudo, 'apt-get', 'update', '-y'], 60_000);
        _aptUpdated = true;
    } catch (e) {
        log.warn('apt-get update failed:', e.message.slice(0, 200));
    }
}

/**
 * Добавляет официальный Adoptium APT-репозиторий, чтобы можно было ставить
 * пакеты temurin-{8,11,17,21}-jdk на Ubuntu/Debian, где штатных openjdk-8 нет.
 */
async function _ensureAdoptiumRepo(sudo) {
    const listFile = '/etc/apt/sources.list.d/adoptium.list';
    if (fs.existsSync(listFile)) return true;
    try {
        // Распознаём кодовое имя дистрибутива (jammy, focal, bookworm…)
        let codename = 'jammy';
        try {
            const r = spawnSync('bash', ['-lc', '. /etc/os-release && echo $VERSION_CODENAME'],
                { stdio: ['ignore', 'pipe', 'ignore'] });
            const v = (r.stdout || '').toString().trim();
            if (v) codename = v;
        } catch {}
        await runCmdSimple([...sudo, 'bash', '-lc',
            'install -d -m 0755 /etc/apt/keyrings && ' +
            'curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public ' +
            '| gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg'
        ], 60_000);
        await runCmdSimple([...sudo, 'bash', '-lc',
            `echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb ${codename} main" > ${listFile}`
        ], 15_000);
        _aptUpdated = false; // нужно обновить индекс
        await _aptUpdateOnce(sudo);
        return true;
    } catch (e) {
        log.warn('ensureAdoptiumRepo failed:', e.message.slice(0, 200));
        return false;
    }
}

/**
 * Скачивает Adoptium Temurin tarball и распаковывает в /opt/java/temurin-<major>.
 * Возвращает путь до bin/java или null.
 */
async function _installTemurinTarball(major) {
    try {
        const arch = (() => {
            const a = os.arch();
            if (a === 'x64' || a === 'amd64') return 'x64';
            if (a === 'arm64' || a === 'aarch64') return 'aarch64';
            return 'x64';
        })();
        const baseDirCandidates = ['/opt/java', path.join(os.homedir(), '.local', 'java')];
        let baseDir = null;
        for (const d of baseDirCandidates) {
            try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); baseDir = d; break; }
            catch {}
        }
        if (!baseDir) { log.warn('installTemurinTarball: нет директории с правами записи'); return null; }
        const installDir = path.join(baseDir, `temurin-${major}`);
        if (fs.existsSync(path.join(installDir, 'bin', 'java'))) {
            return path.join(installDir, 'bin', 'java');
        }
        await fsp.mkdir(installDir, { recursive: true });
        const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jdk/hotspot/normal/eclipse?project=jdk`;
        const tarPath = path.join(os.tmpdir(), `jdk-${major}-${Date.now()}.tar.gz`);
        log.info(`installTemurinTarball: качаю Temurin ${major} (${arch})…`);
        await downloadToFile(url, tarPath);
        await runCmdSimple(['tar', '-xzf', tarPath, '-C', installDir, '--strip-components=1'], 180_000);
        try { fs.unlinkSync(tarPath); } catch {}
        const javaBin = path.join(installDir, 'bin', 'java');
        if (fs.existsSync(javaBin)) {
            log.info(`installTemurinTarball: Java ${major} установлена в ${installDir}`);
            return javaBin;
        }
        return null;
    } catch (e) {
        log.warn(`installTemurinTarball(${major}) failed:`, e.message.slice(0, 200));
        return null;
    }
}

async function autoInstallJava(major) {
    if (process.platform !== 'linux') return null;
    // Проверяем привилегии
    const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
    const canSudo = isRoot || !!process.env.ALLOW_SUDO_INSTALL;
    const sudo = isRoot ? [] : ['sudo', '-n'];

    log.info(`autoInstallJava: устанавливаю Java ${major}…`);

    // ──── ВЕТКА 1: apt-get (Temurin репо приоритетнее) ────
    if (canSudo && fs.existsSync('/usr/bin/apt-get')) {
        await _aptUpdateOnce(sudo);
        // Сначала пробуем Adoptium Temurin (более стабильно, особенно для Java 8 на jammy)
        await _ensureAdoptiumRepo(sudo);
        const candidatesApt = [
            `temurin-${major}-jdk`,
            `openjdk-${major}-jdk-headless`,
            `openjdk-${major}-jdk`,
            `openjdk-${major}-jre-headless`,
            `openjdk-${major}-jre`,
        ];
        for (const pkg of candidatesApt) {
            try {
                await runCmdSimple([...sudo, 'apt-get', 'install', '-y', '--no-install-recommends', pkg], 300_000);
                log.info(`autoInstallJava: установлен пакет ${pkg}`);
                ENV.JAVA_INSTALLS = scanAllJavaBinaries();
                const m = (ENV.JAVA_INSTALLS || []).find((j) => j.major === major);
                if (m) return m;
                break;
            } catch (e) {
                log.warn(`apt install ${pkg} не удался: ${e.message.slice(0, 200)}`);
            }
        }
    } else {
        log.warn(`autoInstallJava: нет apt-get или прав sudo — пропускаем apt-ветку`);
    }

    // ──── ВЕТКА 2: Прямой tarball Adoptium ────
    const javaBin = await _installTemurinTarball(major);
    if (javaBin) {
        // Пересканируем и регистрируем
        ENV.JAVA_INSTALLS = scanAllJavaBinaries();
        // На случай если scan ещё не подхватил — добавим вручную:
        if (!ENV.JAVA_INSTALLS.find((j) => j.bin === javaBin)) {
            const info = tryJavaBinary(javaBin);
            if (info) ENV.JAVA_INSTALLS.push({ bin: info.bin, major, version: info.version });
        }
        const match = ENV.JAVA_INSTALLS.find((j) => j.major === major);
        if (match) return match;
    }

    return null;
}

/** Простой запуск команды с таймаутом — используется до объявления runCmd. */
function runCmdSimple(argv, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = argv;
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '', out = '';
        const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, timeoutMs);
        p.stdout.on('data', (d) => (out += d.toString()));
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('error', (e) => { clearTimeout(to); reject(e); });
        p.on('close', (code) => {
            clearTimeout(to);
            if (code === 0) resolve(out);
            else reject(new Error(`${cmd} exit ${code}: ${(err || out).slice(0, 200)}`));
        });
    });
}

/**
 * Гарантирует доступность java нужного major; если не найдено — пробует поставить.
 * Возвращает { bin, major, version } или null.
 */
async function ensureJavaForServer(server) {
    let pick = pickJavaForServer(server);
    if (pick) return pick;
    const wanted = requiredJavaMajorsForMc(server.mc_version || server.mcVersion, server.flavor);
    for (const major of wanted) {
        const inst = await autoInstallJava(major);
        if (inst) return inst;
    }
    return pickJavaForServer(server); // последняя попытка (если apt-get что-то поставил)
}

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

/**
 * Гарантирует наличие JDK (javac + jar) для компиляции плагинов.
 * Если javac нет — автоматически пытается установить openjdk-17-jdk (или 21).
 * Работает только на Linux под root (или с ALLOW_SUDO_INSTALL).
 */
async function ensureJavacAvailable() {
    if (ENV.JAVAC_BIN) return ENV.JAVAC_BIN;
    if (process.platform !== 'linux') return null;
    log.info('ensureJavacAvailable: устанавливаю JDK для компиляции плагинов…');
    // Пробуем версии 21 → 17 — используем общий autoInstallJava
    // (он уже умеет apt + Adoptium tarball fallback).
    for (const major of [21, 17]) {
        const inst = await autoInstallJava(major);
        if (inst) {
            ENV.JAVAC_BIN = resolveJavacBin();
            if (ENV.JAVAC_BIN) {
                log.info('ensureJavacAvailable: javac найден →', ENV.JAVAC_BIN);
                return ENV.JAVAC_BIN;
            }
            // Сиблинг javac рядом с java
            const sibling = path.join(path.dirname(inst.bin), 'javac');
            if (fs.existsSync(sibling)) {
                ENV.JAVAC_BIN = sibling;
                log.info('ensureJavacAvailable: javac найден (sibling) →', sibling);
                return sibling;
            }
        }
    }
    return ENV.JAVAC_BIN || null;
}

/**
 * При старте ставит все нужные Java-версии (8/17/21), если их нет. Идёт в фоне,
 * выводит прогресс в лог. Результат попадает в ENV.JAVA_INSTALLS.
 */
async function ensureAllJavaVersions() {
    if (process.platform !== 'linux') return;
    const wanted = [8, 17, 21];
    const have = new Set((ENV.JAVA_INSTALLS || []).map((j) => j.major));
    const todo = wanted.filter((m) => !have.has(m));
    if (!todo.length) {
        log.info('ensureAllJavaVersions: все Java-версии уже установлены:', [...have].sort().join(', '));
        return;
    }
    log.info('ensureAllJavaVersions: буду установлены:', todo.join(', '));
    for (const major of todo) {
        try {
            const inst = await autoInstallJava(major);
            if (inst) log.info(`ensureAllJavaVersions: ✅ Java ${major} установлена`);
            else      log.warn(`ensureAllJavaVersions: ⚠️ Java ${major} не удалось установить`);
        } catch (e) {
            log.warn(`ensureAllJavaVersions(${major}) error:`, e.message.slice(0, 200));
        }
    }
    // Обновляем дефолт (наиболее новая Java)
    const all = ENV.JAVA_INSTALLS || [];
    if (all.length) {
        all.sort((a, b) => b.major - a.major);
        ENV.JAVA_BIN = all[0].bin;
        ENV.JAVA_AVAILABLE = true;
        ENV.JAVA_VERSION_STR = all[0].version;
        ENV.JAVA_MAJOR = all[0].major;
        if (!ENV.JAVAC_BIN) ENV.JAVAC_BIN = resolveJavacBin();
    }
}

/**
 * Устанавливает базовые OS-утилиты (unzip/tar/curl/wget/file), если их нет.
 * Без этих инструментов распаковка архивов / Forge-инсталлер / загрузка будут падать.
 */
async function ensureSystemTools() {
    if (process.platform !== 'linux') return;
    const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
    const canSudo = isRoot || !!process.env.ALLOW_SUDO_INSTALL;
    if (!canSudo || !fs.existsSync('/usr/bin/apt-get')) return;
    const sudo = isRoot ? [] : ['sudo', '-n'];
    const need = [];
    const tools = [
        { bin: 'unzip', pkg: 'unzip' },
        { bin: 'tar',   pkg: 'tar' },
        { bin: 'curl',  pkg: 'curl' },
        { bin: 'wget',  pkg: 'wget' },
        { bin: 'gpg',   pkg: 'gnupg' },
    ];
    for (const t of tools) {
        try {
            const r = spawnSync('which', [t.bin], { stdio: ['ignore', 'pipe', 'ignore'] });
            if (r.status !== 0) need.push(t.pkg);
        } catch { need.push(t.pkg); }
    }
    if (!need.length) return;
    log.info('ensureSystemTools: ставлю:', need.join(', '));
    await _aptUpdateOnce(sudo);
    try {
        await runCmdSimple([...sudo, 'apt-get', 'install', '-y', '--no-install-recommends', ...need], 180_000);
    } catch (e) {
        log.warn('ensureSystemTools: apt-get install failed:', e.message.slice(0, 200));
    }
}

// =====================================================================
// PREMIUM EMOJI MAP (из списка пользователя)
// Используется:
//   - pe(emoji) → <tg-emoji emoji-id="...">emoji</tg-emoji> для сообщений (HTML)
//   - btn(text, cb, emoji) → InlineKeyboardButton с icon_custom_emoji_id
// =====================================================================
const PREMIUM_EMOJI = {
    '⚙️': '5870982283724328568', '⚙': '5870982283724328568',
    '👤': '5870994129244131212',
    '👥': '5870772616305839506',
    '👤✅': '5891207662678317861',
    '👤❌': '5893192487324880883',
    '📁': '5870528606328852614',
    '🙂': '5870764288364252592',
    '📈': '5870930636742595124',
    '📊': '5870921681735781843',
    '🏘': '5873147866364514353', '🏘️': '5873147866364514353',
    '🔒': '6037249452824072506',
    '🔓': '6037496202990194718',
    '📣': '6039422865189638057',
    '✅': '5870633910337015697',
    '❌': '5870657884844462243',
    '✖️': '5870657884844462243', '✖': '5870657884844462243',
    '🖋': '5870676941614354370', '🖋️': '5870676941614354370',
    '🗑': '5870875489362513438', '🗑️': '5870875489362513438',
    '📰': '5893057118545646106',
    '📎': '6039451237743595514',
    '🔗': '5769289093221454192',
    'ℹ️': '6028435952299413210', 'ℹ': '6028435952299413210',
    '🤖': '6030400221232501136',
    '👁': '6037397706505195857', '👁️': '6037397706505195857',
    '⬆️': '5963103826075456248', '⬆': '5963103826075456248',
    '⬇️': '6039802767931871481', '⬇': '6039802767931871481',
    '🔔': '6039486778597970865',
    '🎁': '6032644646587338669',
    '⏰': '5983150113483134607',
    '🎉': '6041731551845159060',
    '✍️': '5870753782874246579', '✍': '5870753782874246579',
    '🖼': '6035128606563241721', '🖼️': '6035128606563241721',
    '📍': '6042011682497106307',
    '👛': '5769126056262898415',
    '📦': '5884479287171485878',
    '👾': '5260752406890711732',
    '📅': '5890937706803894250',
    '🏷': '5886285355279193209', '🏷️': '5886285355279193209',
    '🕓': '5775896410780079073',
    '📦📱': '5778672437122045013',
    '🖌': '6050679691004612757', '🖌️': '6050679691004612757',
    '🔡': '5771851822897566479',
    '↔️': '5778479949572738874', '↔': '5778479949572738874',
    '🪙': '5904462880941545555',
    '🪙⬆': '5890848474563352982',
    '🏧': '5879814368572478751',
    '🔨': '5940433880585605708',
    '🔄': '5345906554510012647',
    '◁': '5773130869376315812',
    // Дополнительные соответствия (берём ближайшие):
    '⚠️': '5870982283724328568', '⚠': '5870982283724328568',  // warning → settings gear
    '🔥': '6041731551845159060',  // fire → ура
    '🚀': '5963103826075456248',  // rocket → отправить
    '📜': '5870528606328852614',  // scroll → файл
    '📝': '5870676941614354370',  // memo → карандаш
    '💬': '5893057118545646106',
    '🌐': '5769289093221454192',  // глобус → ссылка
    '▶️': '5963103826075456248', '▶': '5963103826075456248',
    '🛑': '5870657884844462243',  // stop → крестик
    '🖥': '5870982283724328568', '🖥️': '5870982283724328568',
    '✨': '6041731551845159060',
    '🆕': '5870676941614354370',  // NEW → карандаш
    '➡️': '5963103826075456248', '➡': '5963103826075456248',
    '⬅️': '5773130869376315812', '⬅': '5773130869376315812',
    '⚛️': '5870982283724328568', '⚛': '5870982283724328568', '⛙': '5870982283724328568', '⛙️': '5870982283724328568',
    '🧠': '5870921681735781843',  // мозг → статистика
    '➕': '5870633910337015697',
    '➖': '5870657884844462243',
};

function emojiId(emoji) {
    if (!emoji) return null;
    // Прямое совпадение
    if (PREMIUM_EMOJI[emoji]) return PREMIUM_EMOJI[emoji];
    // Без variation selector
    const stripped = emoji.replace(/\uFE0F/g, '');
    if (PREMIUM_EMOJI[stripped]) return PREMIUM_EMOJI[stripped];
    return null;
}

/** Premium emoji wrapper для HTML-сообщений. pe('✅') → '<tg-emoji ...>✅</tg-emoji>'. */
function pe(emoji) {
    const id = emojiId(emoji);
    if (!id) return emoji;
    return `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
}

/**
 * Inline-кнопка с премиум-эмодзи. Любые обычные эмодзи в начале text сбрасываются,
 * вместо них пробрасывается поле icon_custom_emoji_id.
 */
function btn(rawText, callbackData) {
    // Вырезаем ведущий эмодзи + возможные variation-selectorы
    const m = String(rawText).match(/^(\s*)([\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF][\p{Extended_Pictographic}\uFE0F\u200D]*)\s*(.*)$/u);
    let cleanText = rawText;
    let emoji = null;
    if (m) {
        emoji = m[2];
        cleanText = m[3] || rawText;
    }
    const id = emoji ? emojiId(emoji) : null;
    const out = { text: cleanText.trim() || rawText, callback_data: callbackData };
    if (id) out.icon_custom_emoji_id = id;
    return out;
}

/** Обёртка для инлайн-клавиатуры, работает как Markup.inlineKeyboard, но из raw-объектов. */
function premiumKeyboard(rows) {
    return { reply_markup: { inline_keyboard: rows } };
}

/**
 * url-кнопка с премиум-эмодзи.
 */
function btnUrl(rawText, url) {
    const m = String(rawText).match(/^(\s*)([\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF][\p{Extended_Pictographic}\uFE0F\u200D]*)\s*(.*)$/u);
    let cleanText = rawText;
    let emoji = null;
    if (m) { emoji = m[2]; cleanText = m[3] || rawText; }
    const id = emoji ? emojiId(emoji) : null;
    const out = { text: cleanText.trim() || rawText, url };
    if (id) out.icon_custom_emoji_id = id;
    return out;
}

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
/**
 * Разрешает URL vanilla Minecraft server.jar для любой версии через Mojang
 * piston-meta. Нужно для legacy Forge (≤1.12.2), чей installer не всегда
 * скачивает minecraft_server.<ver>.jar сам.
 */
async function resolveVanillaServerJarUrl(mcVersion) {
    try {
        const idx = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
        const r = await request(idx, { headersTimeout: 8000, bodyTimeout: 15000, maxRedirections: 5 });
        if (r.statusCode !== 200) { r.body.dump?.(); return null; }
        const json = await r.body.json();
        const v = (json.versions || []).find((x) => x.id === mcVersion);
        if (!v) return null;
        const r2 = await request(v.url, { headersTimeout: 8000, bodyTimeout: 15000, maxRedirections: 5 });
        if (r2.statusCode !== 200) { r2.body.dump?.(); return null; }
        const meta = await r2.body.json();
        return meta?.downloads?.server?.url || null;
    } catch (e) {
        log.warn('resolveVanillaServerJarUrl failed:', e.message.slice(0, 200));
        return null;
    }
}

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
        // Пересканируем все Java-инсталляции
        ENV.JAVA_INSTALLS = scanAllJavaBinaries();
        if (ENV.JAVA_INSTALLS.length) {
            const best = ENV.JAVA_INSTALLS.sort((a, b) => b.major - a.major)[0];
            ENV.JAVA_BIN = best.bin;
            ENV.JAVA_AVAILABLE = true;
            ENV.JAVA_VERSION_STR = best.version;
            ENV.JAVA_MAJOR = best.major;
            log.info('Java re-detected at runtime:', ENV.JAVA_BIN);
        } else {
            ENV.JAVA_AVAILABLE = false;
            await ctx.reply(
                `${pe('❌')} <b>Java не найдена на этом хосте.</b>\n\n` +
                'Бот не может запустить Minecraft-сервер, потому что в системе ' +
                'отсутствует исполняемый файл <code>java</code>.\n\n' +
                '<b>Что сделать:</b>\n' +
                '• Ubuntu/Debian: <code>sudo apt update &amp;&amp; sudo apt install -y openjdk-21-jre-headless openjdk-8-jre-headless</code>\n' +
                '• Alpine: <code>apk add openjdk21-jre openjdk8-jre</code>\n' +
                '• Docker: <code>eclipse-temurin:21-jre</code> + доп. JDK 8/11/17 для Forge\n\n' +
                `${pe('ℹ')} Переменная <code>JAVA_BIN=/usr/bin/java</code> или <code>JAVA_HOME</code>, затем перезапуск.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
    }

    // ВЫБИРАЕМ ПОДХОДЯЩУЮ версию Java для этого MC/flavor.
    // Это исправляет «ClassCastException AppClassLoader → URLClassLoader» на Forge 1.12.2
    // при запуске под Java 16+ — форж 1.12 требует Java 8.
    let serverJava = pickJavaForServer(server);
    if (!serverJava) {
        // Пытаемся автоустановить нужную Java через apt-get
        const wanted = requiredJavaMajorsForMc(server.mc_version, server.flavor);
        await ctx.reply(
            `${pe('⚙️')} Для <b>${esc(server.flavor)} ${esc(server.mc_version)}</b> нужна Java <b>${wanted[0]}</b>.\n` +
            `Пробую установить автоматически…`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
        serverJava = await ensureJavaForServer(server);
    }
    if (!serverJava) {
        const wanted = requiredJavaMajorsForMc(server.mc_version, server.flavor);
        const have = (ENV.JAVA_INSTALLS || []).map((j) => `Java ${j.major}`).join(', ') || 'ничего';
        await ctx.reply(
            `${pe('❌')} <b>Несовместимая версия Java.</b>\n\n` +
            `Для <b>${esc(server.flavor)} ${esc(server.mc_version)}</b> рекомендуется <b>Java ${wanted[0]}</b>.\n` +
            `Сейчас в системе: ${esc(have)}.\n\n` +
            `<b>Установите нужную Java:</b>\n` +
            `• <code>sudo apt install -y openjdk-${wanted[0]}-jre-headless</code>\n` +
            `• Или вручную: скачайте Adoptium Temurin ${wanted[0]} и укажите путь.`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
    }
    log.info(`Server #${server.id} (${server.flavor} ${server.mc_version}) → Java ${serverJava.major} @ ${serverJava.bin}`);

    await fsp.writeFile(path.join(server.dir, 'eula.txt'), 'eula=true\n');

    // Build command line. Forge (modern) uses an args file (`@unix_args.txt`),
    // everything else uses `-jar <server.jar>`.
    let args;
    let recipe = null;
    try { recipe = server.start_cmd ? JSON.parse(server.start_cmd) : null; } catch { recipe = null; }

    // The actual executable we'll spawn (java by default — but run.sh for modern Forge).
    // ИСПОЛЬЗУЕМ выбранный по MC-версии serverJava, А НЕ глобальный ENV.JAVA_BIN.
    const javaBinForRun = serverJava.bin;
    const javaMajorForRun = serverJava.major;
    let execBin = javaBinForRun;
    let spawnEnv = process.env;

    if (recipe && recipe.mode === 'forge-runsh' && recipe.script) {
        // Modern Forge: delegate to the installer-generated run.sh. It already
        // wires up @user_jvm_args.txt + @libraries/.../unix_args.txt with the right
        // module/path flags. We pass JAVA_HOME so run.sh picks up our managed java.
        const scriptPath = path.join(server.dir, recipe.script);
        if (!fs.existsSync(scriptPath)) {
            await ctx.reply(
                `${pe('❌')} Не найден файл запуска Forge: <code>${esc(recipe.script)}</code>\n` +
                `Попробуйте переустановить сервер.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
        // Ensure +x (Docker volume mounts often strip it).
        try { await fsp.chmod(scriptPath, 0o755); } catch {}
        execBin = '/bin/bash';
        args = [recipe.script, 'nogui'];
        // Point JAVA_HOME at the JDK соответствующей версии, чтобы run.sh использовал именно её
        const javaHome = path.dirname(path.dirname(javaBinForRun));
        spawnEnv = { ...process.env, JAVA_HOME: javaHome, PATH: `${path.dirname(javaBinForRun)}:${process.env.PATH || ''}` };
    } else if (recipe && recipe.mode === 'forge-args' && recipe.argsFile) {
        const argsPath = path.join(server.dir, recipe.argsFile);
        if (!fs.existsSync(argsPath)) {
            await ctx.reply(
                `❌ Не найдён файл запуска Forge: <code>${esc(recipe.argsFile)}</code>\n` +
                `Попробуйте переустановить сервер.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
        // Make sure user_jvm_args.txt exists with our heap settings — modern Forge
        // expects it; without it ModLauncher boots but the Minecraft server never
        // gets enough heap and silently dies right after "Launching target 'forge_server'".
        const userArgsPath = path.join(server.dir, 'user_jvm_args.txt');
        const heapBlock =
            '# Auto-generated by mc-tg-bot — JVM heap & GC\n' +
            `-Xms${ENV.JVM_XMS}\n` +
            `-Xmx${ENV.JVM_XMX}\n` +
            '-XX:+UseG1GC\n';
        try {
            if (fs.existsSync(userArgsPath)) {
                const cur = await fsp.readFile(userArgsPath, 'utf8');
                // Strip any previous -Xms/-Xmx and re-inject current values.
                const cleaned = cur
                    .split('\n')
                    .filter((l) => !/^\s*-(Xm[sx]|XX:\+UseG1GC)/.test(l))
                    .join('\n');
                await fsp.writeFile(userArgsPath, heapBlock + '\n' + cleaned);
            } else {
                await fsp.writeFile(userArgsPath, heapBlock);
            }
        } catch (e) {
            log.warn('Failed to write user_jvm_args.txt:', e.message);
        }
        args = [
            '@user_jvm_args.txt',
            `@${recipe.argsFile}`,
            'nogui',
        ];
    } else {
        const jarRel = recipe?.mode === 'jar' && recipe.jar
            ? recipe.jar
            : path.relative(server.dir, server.jar) || server.jar;
        // Для Java 8 НЕЛЬЗЯ использовать -XX:+UseG1GC без дополнительных флагов (он работает, но оставим просто),
        // а для старых Forge под Java 8 нельзя передавать --add-opens/--add-modules.
        const baseArgs = [
            `-Xms${ENV.JVM_XMS}`,
            `-Xmx${ENV.JVM_XMX}`,
            '-XX:+UseG1GC',
        ];
        // Для Forge 1.12.2 (Java 8) добавляем flags под LaunchWrapper:
        if (server.flavor === 'forge' && javaMajorForRun <= 8) {
            // Старый Forge имеет свой LaunchWrapper main class внутри jar manifest,
            // никаких дополнительных флагов не нужно.
        }
        args = [...baseArgs, '-jar', jarRel, 'nogui'];
    }
    log.info(`Starting server #${server.id} (${server.flavor} ${server.mc_version}) via ${execBin} (Java ${javaMajorForRun}): ${args.join(' ')}`);

    let child;
    try {
        child = spawn(execBin, args, {
            cwd: server.dir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: spawnEnv,
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
        stopRequested: false,   // set when /stop is sent via the panel
        stopReason: null,       // 'user' | 'crash' | 'killed' | …
        flavor: server.flavor,
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
                    const all = await getAllIps().catch(() => null);
                    const ip = all?.forced || all?.public ||
                               all?.ipv4?.find((x) => x.scope === 'public')?.address ||
                               all?.ipv4?.[0]?.address || null;
                    // Give the server a beat to bind the port before pinging.
                    await new Promise((r) => setTimeout(r, 1500));
                    const status = await queryMinecraftStatus('127.0.0.1', port).catch(() => null);

                    // Best-effort: проверяем, доступен ли порт извне.
                    const portOpen = ip ? await isPortOpenPublic(ip, port).catch(() => null) : null;
                    let portLine = '';
                    if (portOpen === true)  portLine = `\n🔓 Порт <code>${port}</code>: <b>открыт извне</b> ✅`;
                    else if (portOpen === false) portLine = `\n🔒 Порт <code>${port}</code>: <b>закрыт извне</b> ❌ — откройте в файрволе хоста/панели VPS или добавьте <code>-p ${port}:${port}/tcp -p ${port}:${port}/udp</code> в docker run`;

                    const uptime = Math.round((Date.now() - state.startedAt) / 1000);
                    const connStr = ip ? `${ip}:${port}` : `??:${port}`;
                    const altBlock = all ? formatAddressBlock(all, port) : '';
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
                        `📍 Рекомендуемый адрес: <code>${esc(connStr)}</code>\n` +
                        `⚙️ Сборка: ${esc(server.flavor)} ${esc(server.mc_version)}` +
                        verLine +
                        playersLine +
                        motdLine +
                        portLine +
                        `\n⏱ Время старта: <b>${uptime}с</b>` +
                        (altBlock ? `\n\n<b>Все адреса хоста:</b>\n${altBlock}` : ''),
                        {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([
                                [btn('🖥 Консоль', `srv:console:${server.id}`)],
                                [btn('📊 Статус', `srv:status:${server.id}`)],
                                [btn('⬅️ К серверу', `srv:open:${server.id}`)],
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

    child.on('exit', async (code, signal) => {
        RUNNING.delete(server.id);
        const tail = tailString(state.log.join(''), 3500);
        const runtimeSec = Math.round((Date.now() - state.startedAt) / 1000);

        // Classify what just happened.
        let trigger;
        if (state.stopRequested) trigger = 'user';
        else if (signal === 'SIGKILL' || signal === 'SIGTERM') trigger = 'killed';
        else if (code === 0) trigger = 'clean';
        else trigger = 'crash';

        const headEmoji = trigger === 'crash' ? '💥' : '🛑';
        const headText  = trigger === 'user'   ? 'остановлен по команде'
                        : trigger === 'killed' ? `прерван сигналом ${esc(signal || '?')}`
                        : trigger === 'crash'  ? 'аварийно завершился'
                        :                         'остановлен';

        await ctx.telegram.sendMessage(
            state.chatId,
            `${headEmoji} Сервер «<b>${esc(server.name)}</b>» ${headText}` +
            ` (код ${esc(code ?? '—')}${signal ? `, сигнал ${esc(signal)}` : ''}).\n` +
            `⏱ Время работы: <b>${runtimeSec}с</b>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});

        // AI post-mortem — ALWAYS run, regardless of exit code, but with a
        // dedicated "shutdown" prompt that asks the model to explain *why* the
        // server stopped (not just whether it started).
        try {
            const verdict = await aiAnalyseShutdown(tail, server, {
                exitCode: code,
                signal,
                trigger,
                runtimeSec,
            });
            await ctx.telegram.sendMessage(
                state.chatId,
                `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>AI: причина остановки сервера:</b>\n${esc(verdict)}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        } catch (e) { log.warn('AI post-mortem failed:', e.message); }
    });

    // Forge boots far slower than Paper/Spigot (mod scanning, library extraction,
    // world gen on first launch). Give it a much larger window before nagging the
    // user — otherwise the AI verdict fires while the server is still booting.
    const bootCheckDelayMs = server.flavor === 'forge' ? 90_000 : 25_000;
    setTimeout(async () => {
        const st = RUNNING.get(server.id);
        if (!st || st.bootDone) return;
        try {
            const verdict = await aiAnalyseStartup(st.bootLogForAI, server);
            ctx.telegram.sendMessage(
                st.chatId,
                `<tg-emoji emoji-id="6030400221232501136">🤖</tg-emoji> <b>AI-диагностика запуска (${Math.round(bootCheckDelayMs / 1000)} сек):</b>\n${esc(verdict)}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        } catch (e) { log.warn('AI boot-check failed:', e.message); }
    }, bootCheckDelayMs);

    await ctx.reply(
        `<tg-emoji emoji-id="5963103826075456248">🚀</tg-emoji> Сервер «<b>${esc(server.name)}</b>» запускается…\n` +
        `Лог появится через несколько секунд.`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [btn('📜 Показать лог', `srv:log:${server.id}`)],
                [btn('🛑 Остановить', `srv:stop:${server.id}`)],
                [btn('⬅️ К серверу', `srv:open:${server.id}`)],
            ]),
        }
    ).catch(() => {});
}

function stopServer(serverId) {
    const st = RUNNING.get(serverId);
    if (!st) return false;
    st.stopRequested = true;   // tell the exit handler this was user-initiated
    st.stopReason = 'user';
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
let _allIpsCache   = { data: null, at: 0 };

// ---------------------------------------------------------------
// IP classification helpers
// ---------------------------------------------------------------
function _isPrivateIPv4(ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // 127.0.0.0/8 (loopback)
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local)
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    return false;
}

function _classifyIPv4(ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return 'invalid';
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 10) return 'private (10/8)';
    if (a === 172 && b >= 16 && b <= 31) return 'private (172.16/12)';
    if (a === 192 && b === 168) return 'private (192.168/16)';
    if (a === 100 && b >= 64 && b <= 127) return 'CGNAT (100.64/10)';
    return 'public';
}

/**
 * Probe one HTTP "what is my IP" service. Returns the trimmed body as string
 * on HTTP 200 + valid IPv4 format. Throws otherwise.
 */
async function _probeIpService(url) {
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
}

/**
 * Returns ALL known addresses for this host. Used by the admin panel and
 * the server-info banner so the user can copy whichever one actually
 * reaches their Minecraft client (LAN, public, IPv6, …).
 *
 * Shape:
 *   {
 *     public:   '203.0.113.5'  | null,           // resolved via 6 HTTP services + DNS race
 *     publicV6: '2a01:…'       | null,           // best-effort IPv6
 *     forced:   '1.2.3.4'      | null,           // ENV.PUBLIC_IP override, if set
 *     hostname: 'mc-host'      | null,           // os.hostname()
 *     ipv4:     [{ iface, address, scope }, …],  // every non-internal IPv4
 *     ipv6:     [{ iface, address, scope }, …],  // every non-internal IPv6
 *   }
 *
 * Result is cached for 10 minutes (HTTP probes only).
 */
async function getAllIps() {
    if (_allIpsCache.data && Date.now() - _allIpsCache.at < 600_000) {
        return _allIpsCache.data;
    }

    const out = {
        public:   null,
        publicV6: null,
        forced:   null,
        hostname: null,
        ipv4:     [],
        ipv6:     [],
    };

    // 0) Manual override — always wins for display purposes
    if (ENV.PUBLIC_IP && /^\d{1,3}(\.\d{1,3}){3}$/.test(ENV.PUBLIC_IP)) {
        out.forced = ENV.PUBLIC_IP;
    }

    // 1) os.hostname()
    try { out.hostname = os.hostname() || null; } catch { /* ignore */ }

    // 2) Local interfaces (every non-internal address, NOT just the first)
    try {
        const nets = os.networkInterfaces();
        for (const [iface, list] of Object.entries(nets)) {
            for (const n of list || []) {
                if (n.internal) continue;
                if (n.family === 'IPv4' || n.family === 4) {
                    out.ipv4.push({ iface, address: n.address, scope: _classifyIPv4(n.address) });
                } else if (n.family === 'IPv6' || n.family === 6) {
                    // Skip link-local fe80:: addresses (need %iface, unusable for MC)
                    if (/^fe80:/i.test(n.address)) continue;
                    out.ipv6.push({ iface, address: n.address, scope: 'public' });
                }
            }
        }
    } catch { /* ignore */ }

    // 3) Public IPv4 — parallel race against several services + DNS fallback
    const httpV4 = [
        'https://api.ipify.org',
        'https://ipv4.icanhazip.com',
        'https://checkip.amazonaws.com',
        'https://api.seeip.org',
        'https://ifconfig.me/ip',
        'https://ipinfo.io/ip',
        'https://api.my-ip.io/ip',
    ];
    try {
        out.public = await Promise.any(httpV4.map((u) => _probeIpService(u)));
    } catch { /* all http failed — try DNS */ }

    if (!out.public) {
        try {
            const Resolver = require('dns').promises.Resolver;
            const r = new Resolver();
            r.setServers(['208.67.222.222', '208.67.220.220']);
            const ips = await r.resolve4('myip.opendns.com');
            if (ips[0] && /^\d{1,3}(\.\d{1,3}){3}$/.test(ips[0])) out.public = ips[0];
        } catch { /* ignore */ }
    }

    // 4) Public IPv6 (best-effort, single service)
    try {
        const { statusCode, body } = await request('https://api6.ipify.org', {
            headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'text/plain' },
            headersTimeout: 4000,
            bodyTimeout: 4000,
        });
        if (statusCode === 200) {
            const txt = (await body.text()).trim();
            if (/^[0-9a-f:]+$/i.test(txt) && txt.includes(':')) out.publicV6 = txt;
        } else { body.dump?.(); }
    } catch { /* ignore */ }

    _allIpsCache = { data: out, at: Date.now() };
    return out;
}

/**
 * Fetch the public IP of the host (single-value helper, kept for backwards
 * compatibility with existing call-sites). Strategy:
 *   0) ENV.PUBLIC_IP — forced override for VPS behind NAT / Docker
 *   1) cached value, if fresh
 *   2) getAllIps().public
 *   3) first PUBLIC IPv4 from local interfaces (not 127.*, not RFC1918, not 169.254.*)
 *   4) first non-internal IPv4 (LAN — last resort)
 */
async function getPublicIp() {
    if (ENV.PUBLIC_IP && /^\d{1,3}(\.\d{1,3}){3}$/.test(ENV.PUBLIC_IP)) {
        return ENV.PUBLIC_IP;
    }
    if (_publicIpCache.ip && Date.now() - _publicIpCache.at < 600_000) {
        return _publicIpCache.ip;
    }

    const all = await getAllIps().catch(() => null);
    if (all?.public) {
        _publicIpCache = { ip: all.public, at: Date.now() };
        return all.public;
    }

    // Try a real public IPv4 from local interfaces first
    const pub = all?.ipv4?.find((x) => x.scope === 'public');
    if (pub) {
        _publicIpCache = { ip: pub.address, at: Date.now() };
        return pub.address;
    }

    // Last resort: any non-internal IPv4 (LAN). We DO NOT cache this — it's
    // very likely wrong for clients outside the LAN.
    const lan = all?.ipv4?.[0];
    if (lan) return lan.address;

    return null;
}

/**
 * Render a multi-line block listing every address by which the server can be
 * reached, plus a clear hint about which one to give to the Minecraft client.
 * Used by /start banner, server-info card and the admin IP panel.
 */
function formatAddressBlock(all, port) {
    const lines = [];
    const portStr = port ? `:${port}` : '';

    if (all.forced) {
        lines.push(`🟢 <b>Публичный (PUBLIC_IP)</b>: <code>${esc(all.forced)}${portStr}</code> — используйте этот`);
    }
    if (all.public && all.public !== all.forced) {
        lines.push(`🌐 <b>Публичный IPv4</b>: <code>${esc(all.public)}${portStr}</code>${all.forced ? '' : ' — используйте этот'}`);
    }
    if (all.publicV6) {
        lines.push(`🛰 <b>Публичный IPv6</b>: <code>[${esc(all.publicV6)}]${portStr}</code>`);
    }

    const publicLan = (all.ipv4 || []).filter((x) => x.scope === 'public' && x.address !== all.public);
    for (const x of publicLan) {
        lines.push(`🌐 <b>IPv4 на интерфейсе ${esc(x.iface)}</b>: <code>${esc(x.address)}${portStr}</code>`);
    }

    const privateLan = (all.ipv4 || []).filter((x) => x.scope !== 'public' && x.scope !== 'loopback');
    for (const x of privateLan) {
        lines.push(`🏠 <b>Локальный (${esc(x.scope)}) ${esc(x.iface)}</b>: <code>${esc(x.address)}${portStr}</code>`);
    }

    if (all.hostname) {
        lines.push(`🖥 <b>Hostname</b>: <code>${esc(all.hostname)}${portStr}</code>`);
    }

    if (!lines.length) lines.push('<i>Не удалось определить ни одного адреса.</i>');
    return lines.join('\n');
}

/**
 * Quickest possible "is this TCP port reachable from the outside Internet" probe.
 * Asks a third-party port-check API. Returns:
 *   true  — port is OPEN from the public Internet
 *   false — port is CLOSED / filtered
 *   null  — couldn't determine (service down, no IP, etc.)
 */
async function isPortOpenPublic(ip, port) {
    if (!ip || !port) return null;
    if (_isPrivateIPv4(ip)) return null; // can't check private IPs from public services
    try {
        const url = `https://ifconfig.co/port/${port}?ip=${ip}`;
        const { statusCode, body } = await request(url, {
            headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/json' },
            headersTimeout: 6000,
            bodyTimeout: 6000,
        });
        if (statusCode !== 200) { body.dump?.(); return null; }
        const txt = await body.text();
        try {
            const j = JSON.parse(txt);
            if (typeof j.reachable === 'boolean') return j.reachable;
        } catch { /* not json */ }
        if (/"reachable"\s*:\s*true/i.test(txt))  return true;
        if (/"reachable"\s*:\s*false/i.test(txt)) return false;
        return null;
    } catch {
        return null;
    }
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

/**
 * Explain WHY the server stopped. Called from the child.on('exit') handler,
 * with full context (exit code, signal, whether the user requested the stop,
 * total uptime). The prompt is intentionally different from aiAnalyseStartup —
 * we want a post-mortem, not a boot diagnostic.
 */
async function aiAnalyseShutdown(logText, server, ctx) {
    const { exitCode, signal, trigger, runtimeSec } = ctx || {};
    const triggerHint = {
        user:   'Пользователь сам нажал «Остановить» в боте (отправлена команда stop).',
        clean:  'Сервер завершился сам с кодом 0 (вероятно, штатное завершение).',
        crash:  'Сервер завершился с НЕнулевым кодом — это похоже на падение/ошибку.',
        killed: 'Процесс был принудительно убит сигналом ОС (SIGTERM/SIGKILL).',
    }[trigger] || '';

    const system = `Ты — эксперт по администрированию Minecraft-серверов
(Paper/Spigot/Bukkit/Forge). Сервер только что ОСТАНОВИЛСЯ.
Твоя задача — на русском, КОРОТКО (3–7 строк), объяснить ПРИЧИНУ остановки.

В ответе обязательно укажи:
1) Главная причина остановки одной фразой (например: «штатная остановка пользователем»,
   «OOM — не хватило памяти», «crash из-за плагина X», «не принят EULA», «порт занят»,
   «несовместимая версия Java», «мод/плагин выбросил исключение в onEnable» и т. п.).
2) Если это краш — какая конкретно ошибка в логе и как её устранить (1–3 пункта).
3) Если штатная остановка — просто подтверди это, без выдуманных проблем.

Не выдумывай факты, опирайся только на лог и метаданные.
Если лог пустой/обрезан — честно скажи «недостаточно данных», и предложи проверить
logs/latest.log на сервере.

ВАЖНО: пиши ОБЫЧНЫМ ТЕКСТОМ, без какого-либо форматирования.
НЕ используй Markdown (**жирный**, *курсив*, \`код\`, # заголовки, списки с -/* ),
НЕ используй HTML-теги (<b>, <i>, <code>, <pre>, …).
Только чистый текст. Эмодзи допустимы.`;

    const user =
        `Сервер: ${server.flavor} ${server.mc_version}\n` +
        `Директория: ${server.dir}\n` +
        `Время работы до остановки: ${runtimeSec ?? '?'} сек\n` +
        `Код выхода: ${exitCode ?? '—'}` + (signal ? `, сигнал: ${signal}` : '') + `\n` +
        `Триггер: ${trigger || 'unknown'} — ${triggerHint}\n\n` +
        `=== ХВОСТ ЛОГА ===\n${logText || '(пусто)'}`;

    return await aiChat({ system, user, maxTokens: 500 });
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
function findJarBin() {
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
}

/**
 * Make sure we have a JAR on disk that contains the Bukkit/Spigot/Paper API
 * classes (org.bukkit.*, etc.), so generated plugins can be compiled against it.
 *
 * Strategy:
 *   1) For Paper: run the paperclip launcher with -Dpaperclip.patchonly=true.
 *      That extracts versions/<mc>/paper-<mc>.jar — the real patched server
 *      with all Bukkit API classes exposed. Compilation against THAT jar works.
 *   2) Fallback for any flavor: download paper-api from repo.papermc.io
 *      (snapshot metadata → real artifact URL), cached under SERVERS_ROOT/_api_cache.
 *   3) Last resort: just hand back whatever jars sit next to the server.jar.
 *
 * Returns an array of classpath entries (jar paths), or [] if nothing usable.
 */
async function ensureBukkitApiJar(server) {
    const out = [];

    // ---- 1) Paperclip extraction (Paper / Folia / very-modern flavors) ----
    if (server.flavor === 'paper' || /paper/i.test(path.basename(server.jar || ''))) {
        const versionsDir = path.join(server.dir, 'versions');
        try {
            // If versions/ already has an extracted jar, reuse it.
            const existing = await findFile(versionsDir, /\.jar$/i, 4);
            if (existing && fs.existsSync(existing)) out.push(existing);
        } catch { /* ignore */ }

        if (!out.length && ENV.JAVA_AVAILABLE && server.jar && fs.existsSync(server.jar)) {
            try {
                // Подбираем Java по MC-версии и для paperclip-распаковки.
                const pj = pickJavaForServer(server) || { bin: ENV.JAVA_BIN };
                log.info(`Paperclip extract for #${server.id}: ${server.jar} (Java ${pj.major || '?'})`);
                await runCmd(
                    pj.bin,
                    ['-Dpaperclip.patchonly=true', '-jar', path.basename(server.jar)],
                    { cwd: server.dir }
                );
                const extracted = await findFile(versionsDir, /\.jar$/i, 4);
                if (extracted) out.push(extracted);
            } catch (e) {
                log.warn('Paperclip extraction failed:', e.message.slice(0, 200));
            }
        }
    }

    // ---- 2) Cached paper-api jar from repo.papermc.io ----
    if (!out.length) {
        const cacheDir = path.join(ENV.SERVERS_ROOT, '_api_cache');
        await fsp.mkdir(cacheDir, { recursive: true });
        const cached = path.join(cacheDir, `paper-api-${server.mc_version}.jar`);
        if (fs.existsSync(cached) && (await fsp.stat(cached)).size > 1024) {
            out.push(cached);
        } else {
            try {
                const metaUrl = `https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/${server.mc_version}-R0.1-SNAPSHOT/maven-metadata.xml`;
                const res = await request(metaUrl, {
                    headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/xml' },
                    headersTimeout: 8000,
                    bodyTimeout: 15000,
                    maxRedirections: 5,
                });
                if (res.statusCode === 200) {
                    const xml = await res.body.text();
                    // Extract any <snapshotVersion>…<extension>jar</extension>…<value>X</value> pair.
                    let value = null;
                    const blocks = xml.split('<snapshotVersion>');
                    for (const blk of blocks) {
                        if (/<extension>jar<\/extension>/i.test(blk) &&
                            !/<classifier>/i.test(blk)) {
                            const m = blk.match(/<value>([^<]+)<\/value>/i);
                            if (m) { value = m[1]; break; }
                        }
                    }
                    if (value) {
                        const jarUrl = `https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/${server.mc_version}-R0.1-SNAPSHOT/paper-api-${value}.jar`;
                        log.info(`Downloading paper-api for ${server.mc_version}: ${jarUrl}`);
                        await downloadToFile(jarUrl, cached);
                        if ((await fsp.stat(cached)).size > 1024) out.push(cached);
                    }
                } else {
                    res.body.dump?.();
                }
            } catch (e) {
                log.warn('paper-api fetch failed:', e.message.slice(0, 200));
            }
        }
    }

    // ---- 2b) spigot-api fallback (работает для старых версий 1.8–1.16 и по дефолту для Spigot/Bukkit) ----
    if (!out.length) {
        const cacheDir = path.join(ENV.SERVERS_ROOT, '_api_cache');
        await fsp.mkdir(cacheDir, { recursive: true });
        const cached = path.join(cacheDir, `spigot-api-${server.mc_version}.jar`);
        if (fs.existsSync(cached) && (await fsp.stat(cached)).size > 1024) {
            out.push(cached);
        } else {
            // hub.spigotmc.org публикует spigot-api по адресу:
            //   https://hub.spigotmc.org/nexus/content/repositories/snapshots/org/spigotmc/spigot-api/<MC>-R0.1-SNAPSHOT/
            try {
                const metaUrl = `https://hub.spigotmc.org/nexus/content/repositories/snapshots/org/spigotmc/spigot-api/${server.mc_version}-R0.1-SNAPSHOT/maven-metadata.xml`;
                const res = await request(metaUrl, {
                    headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/xml' },
                    headersTimeout: 8000, bodyTimeout: 15000, maxRedirections: 5,
                });
                if (res.statusCode === 200) {
                    const xml = await res.body.text();
                    let value = null;
                    const blocks = xml.split('<snapshotVersion>');
                    for (const blk of blocks) {
                        if (/<extension>jar<\/extension>/i.test(blk) && !/<classifier>/i.test(blk)) {
                            const m = blk.match(/<value>([^<]+)<\/value>/i);
                            if (m) { value = m[1]; break; }
                        }
                    }
                    if (value) {
                        const jarUrl = `https://hub.spigotmc.org/nexus/content/repositories/snapshots/org/spigotmc/spigot-api/${server.mc_version}-R0.1-SNAPSHOT/spigot-api-${value}.jar`;
                        log.info(`Downloading spigot-api for ${server.mc_version}: ${jarUrl}`);
                        await downloadToFile(jarUrl, cached);
                        if ((await fsp.stat(cached)).size > 1024) out.push(cached);
                    }
                } else {
                    res.body.dump?.();
                }
            } catch (e) {
                log.warn('spigot-api fetch failed:', e.message.slice(0, 200));
            }
        }
    }

    // ---- 2c) Bukkit API fallback (покрывает самые старые версии — 1.7.10, 1.8.x и т.д.) ----
    if (!out.length) {
        const cacheDir = path.join(ENV.SERVERS_ROOT, '_api_cache');
        await fsp.mkdir(cacheDir, { recursive: true });
        const cached = path.join(cacheDir, `bukkit-${server.mc_version}.jar`);
        if (fs.existsSync(cached) && (await fsp.stat(cached)).size > 1024) {
            out.push(cached);
        } else {
            try {
                const metaUrl = `https://hub.spigotmc.org/nexus/content/repositories/snapshots/org/bukkit/bukkit/${server.mc_version}-R0.1-SNAPSHOT/maven-metadata.xml`;
                const res = await request(metaUrl, {
                    headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/xml' },
                    headersTimeout: 8000, bodyTimeout: 15000, maxRedirections: 5,
                });
                if (res.statusCode === 200) {
                    const xml = await res.body.text();
                    let value = null;
                    const blocks = xml.split('<snapshotVersion>');
                    for (const blk of blocks) {
                        if (/<extension>jar<\/extension>/i.test(blk) && !/<classifier>/i.test(blk)) {
                            const m = blk.match(/<value>([^<]+)<\/value>/i);
                            if (m) { value = m[1]; break; }
                        }
                    }
                    if (value) {
                        const jarUrl = `https://hub.spigotmc.org/nexus/content/repositories/snapshots/org/bukkit/bukkit/${server.mc_version}-R0.1-SNAPSHOT/bukkit-${value}.jar`;
                        log.info(`Downloading bukkit-api for ${server.mc_version}: ${jarUrl}`);
                        await downloadToFile(jarUrl, cached);
                        if ((await fsp.stat(cached)).size > 1024) out.push(cached);
                    }
                } else {
                    res.body.dump?.();
                }
            } catch (e) {
                log.warn('bukkit-api fetch failed:', e.message.slice(0, 200));
            }
        }
    }

    // ---- 2d) Резерв: берём ЛАТЕЙШИЙ paper-api (подходит для компиляции 99% плагинов) ----
    if (!out.length) {
        const cacheDir = path.join(ENV.SERVERS_ROOT, '_api_cache');
        await fsp.mkdir(cacheDir, { recursive: true });
        const cached = path.join(cacheDir, `paper-api-latest.jar`);
        if (fs.existsSync(cached) && (await fsp.stat(cached)).size > 1024) {
            out.push(cached);
        } else {
            try {
                // Находим последнюю версию paper-api в maven-metadata
                const idx = 'https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/maven-metadata.xml';
                const res = await request(idx, {
                    headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/xml' },
                    headersTimeout: 8000, bodyTimeout: 15000, maxRedirections: 5,
                });
                if (res.statusCode === 200) {
                    const xml = await res.body.text();
                    const m = xml.match(/<latest>([^<]+)<\/latest>/i);
                    const latest = m ? m[1] : null;
                    if (latest) {
                        const metaUrl2 = `https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/${latest}/maven-metadata.xml`;
                        const r2 = await request(metaUrl2, {
                            headers: { 'User-Agent': ENV.PAPER_UA, Accept: 'application/xml' },
                            headersTimeout: 8000, bodyTimeout: 15000, maxRedirections: 5,
                        });
                        if (r2.statusCode === 200) {
                            const xml2 = await r2.body.text();
                            let value = null;
                            const blocks = xml2.split('<snapshotVersion>');
                            for (const blk of blocks) {
                                if (/<extension>jar<\/extension>/i.test(blk) && !/<classifier>/i.test(blk)) {
                                    const mm = blk.match(/<value>([^<]+)<\/value>/i);
                                    if (mm) { value = mm[1]; break; }
                                }
                            }
                            if (value) {
                                const jarUrl = `https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/${latest}/paper-api-${value}.jar`;
                                log.info(`Downloading FALLBACK latest paper-api: ${jarUrl}`);
                                await downloadToFile(jarUrl, cached);
                                if ((await fsp.stat(cached)).size > 1024) out.push(cached);
                            }
                        } else { r2.body.dump?.(); }
                    }
                } else { res.body.dump?.(); }
            } catch (e) {
                log.warn('latest paper-api fetch failed:', e.message.slice(0, 200));
            }
        }
    }

    // ---- 3) Last-resort: any jars sitting next to server.jar ----
    if (!out.length) {
        try {
            const sibling = (await fsp.readdir(server.dir))
                .filter((f) => /\.jar$/i.test(f))
                .map((f) => path.join(server.dir, f));
            for (const j of sibling) out.push(j);
        } catch { /* ignore */ }
    }

    return out;
}

/**
 * Нормализует plugin.yml: гарантирует наличие обязательных полей
 * name / main / version / api-version, выводит имя main класса из .java.
 */
async function normalizePluginYml(ymlPath, javaFile, fallbackName) {
    let yml = '';
    try { yml = await fsp.readFile(ymlPath, 'utf8'); } catch { yml = ''; }
    const javaSrc = await fsp.readFile(javaFile, 'utf8').catch(() => '');
    // Находим класс в .java
    const classM = javaSrc.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const className = classM ? classM[1] : fallbackName;
    const pkgM = javaSrc.match(/^\s*package\s+([\w.]+)\s*;/m);
    const fqcn = pkgM ? `${pkgM[1]}.${className}` : className;

    const has = (k) => new RegExp(`^${k}\\s*:`, 'm').test(yml);
    if (!has('name'))         yml = `name: ${className}\n${yml}`;
    if (!has('main'))         yml = `${yml}\nmain: ${fqcn}\n`;
    if (!has('version'))      yml = `${yml}\nversion: 1.0.0\n`;
    if (!has('api-version'))  yml = `${yml}\napi-version: '1.13'\n`;
    await fsp.writeFile(ymlPath, yml.trim() + '\n');
    return { className, fqcn };
}

async function tryCompileJavaPlugin({ javaFile, pluginYmlPath, outDir, pluginName, server }) {
    if (!ENV.JAVAC_BIN) {
        // Последняя попытка автоустановки
        try { await ensureJavacAvailable(); } catch {}
        if (!ENV.JAVAC_BIN) return { ok: false, reason: 'javac не установлен (автоустановка не удалась)' };
    }
    const jarBin = findJarBin();
    if (!jarBin) return { ok: false, reason: 'утилита jar не найдена (нужен JDK, а не JRE)' };

    const buildDir = path.join(outDir, '_build');
    await fsp.mkdir(buildDir, { recursive: true });

    // Доводим plugin.yml до минимально валидного вида
    try { await normalizePluginYml(pluginYmlPath, javaFile, pluginName); }
    catch (e) { log.warn('normalizePluginYml warn:', e.message); }

    // Resolve a real Bukkit/Paper API classpath (download/extract if needed).
    let classpathEntries = [];
    try {
        classpathEntries = server ? await ensureBukkitApiJar(server) : [];
    } catch (e) {
        log.warn('ensureBukkitApiJar failed:', e.message);
    }
    if (!classpathEntries.length) {
        log.warn('tryCompileJavaPlugin: classpath пуст — компиляция Bukkit плагинов невозможна без API jar.');
    }
    const classpath = classpathEntries.join(path.delimiter);

    // Подбираем bytecode level в зависимости от MC версии:
    //   ≤ 1.16  → Java 8 (target 1.8) — старые сервера не прочтут новее
    //   1.17 .. 1.20.4 → Java 17
    //   1.20.5+ → Java 21
    let targetMajor = 17;
    const mc = String(server?.mc_version || '').split('.').map(Number);
    const mcMinor = mc[1] || 0, mcPatch = mc[2] || 0;
    if (mcMinor <= 16) targetMajor = 8;
    else if (mcMinor <= 19) targetMajor = 17;
    else if (mcMinor === 20 && mcPatch < 5) targetMajor = 17;
    else targetMajor = 21;

    const javacArgs = ['-d', buildDir, '-proc:none', '-Xlint:none', '-nowarn', '-encoding', 'UTF-8'];
    // Пробуем `--release N`; если хост JDK старье — падаём на -source/-target.
    let useRelease = true;
    try {
        const probe = spawnSync(ENV.JAVAC_BIN, ['--release', String(targetMajor), '-version'],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        if (probe.status !== 0) useRelease = false;
    } catch { useRelease = false; }
    if (useRelease) {
        javacArgs.push('--release', String(targetMajor));
    } else {
        const sv = targetMajor === 8 ? '1.8' : String(targetMajor);
        javacArgs.push('-source', sv, '-target', sv);
    }

    if (classpath) javacArgs.push('-cp', classpath);
    javacArgs.push(javaFile);

    try {
        await runCmd(ENV.JAVAC_BIN, javacArgs);
    } catch (e) {
        log.warn('javac failed:', e.message.slice(0, 600));
        // Попытка retry без --release (на случай проблем с javac, который врёт про probe)
        if (useRelease) {
            try {
                const args2 = javacArgs.filter((a, i, arr) => a !== '--release' && arr[i - 1] !== '--release');
                args2.splice(args2.indexOf(javaFile), 0, '-source', '1.8', '-target', '1.8');
                await runCmd(ENV.JAVAC_BIN, args2);
            } catch (e2) {
                return { ok: false, reason: 'javac: ' + e2.message.split('\n').slice(0, 5).join(' ').slice(0, 350) };
            }
        } else {
            return { ok: false, reason: 'javac: ' + e.message.split('\n').slice(0, 5).join(' ').slice(0, 350) };
        }
    }

    // Copy plugin.yml into build dir root
    try {
        await fsp.copyFile(pluginYmlPath, path.join(buildDir, 'plugin.yml'));
    } catch (e) {
        log.warn('copy plugin.yml failed:', e.message);
        return { ok: false, reason: 'не удалось скопировать plugin.yml: ' + e.message };
    }

    const jarPath = path.join(outDir, `${pluginName}.jar`);
    try {
        await runCmd(jarBin, ['cf', jarPath, '-C', buildDir, '.']);
    } catch (e) {
        log.warn('jar cf failed:', e.message);
        return { ok: false, reason: 'jar cf: ' + e.message };
    }
    // Cleanup intermediate build dir
    await fsp.rm(buildDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, jarPath };
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
        [btn('🆕 Новый сервер', 'srv:new')],
        [btn('📂 Мои серверы', 'srv:list')],
        [btn('📦 Загрузить файл / плагин', 'srv:upload')],
        [btn('✨ AI: сгенерировать плагин / скрипт', 'srv:aigen')],
    ];
    if (adm) rows.push([btn('⚙️ Админ-панель', 'adm:open')]);
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
            [btn('Paper (рекомендуется)', 'new:flavor:paper')],
            [btn('Spigot', 'new:flavor:spigot')],
            [btn('Bukkit', 'new:flavor:bukkit')],
            [btn('Forge (моды)', 'new:flavor:forge')],
            [btn('⬅️ В меню', 'menu:main')],
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
            Markup.inlineKeyboard([[btn('⬅️ В меню', 'menu:main')]])
        );
    }
    if (!versions.length) {
        return safeEdit(ctx, '❌ Список версий пуст.',
            Markup.inlineKeyboard([[btn('⬅️ В меню', 'menu:main')]]));
    }
    ctx.session.wizard.versions = versions;
    return renderVersionPage(ctx, 0);
});

async function renderVersionPage(ctx, page) {
    const all = ctx.session.wizard?.versions || [];
    if (!all.length) {
        return safeEdit(ctx, 'Сессия истекла. Нажмите /start.',
            Markup.inlineKeyboard([[btn('⬅️ В меню', 'menu:main')]]));
    }
    const flavor = ctx.session.wizard.flavor;
    const perPage = 12;
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const slice = all.slice(safePage * perPage, (safePage + 1) * perPage);
    const buttons = slice.map((v) => [btn(v, `new:ver:${v}`)]);
    const nav = [];
    if (safePage > 0) nav.push(btn('⬅️', `new:page:${safePage - 1}`));
    nav.push(btn(`${safePage + 1}/${totalPages}`, 'noop'));
    if (safePage < totalPages - 1) nav.push(btn('➡️', `new:page:${safePage + 1}`));
    buttons.push(nav);
    buttons.push([btn('⬅️ Назад', 'srv:new')]);

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
            Markup.inlineKeyboard([[btn('⬅️ В меню', 'menu:main')]]));
    }
    return renderVersionPage(ctx, Number(ctx.match[1]));
});

bot.action('noop', async (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.action(/^new:ver:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!ctx.session.wizard?.flavor) {
        return safeEdit(ctx, 'Сессия истекла. Нажмите /start.',
            Markup.inlineKeyboard([[btn('⬅️ В меню', 'menu:main')]]));
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
        Markup.inlineKeyboard([[btn('⬅️ Назад', `new:flavor:${ctx.session.wizard.flavor}`)]])
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
                    `${pe('⚙️')} Устанавливаю Forge (может занять 1-2 минуты)…`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
                if (!ENV.JAVA_AVAILABLE) throw new Error('Java не найдена — установка Forge невозможна.');

                // Выбираем ПРАВИЛЬНУЮ Java для установщика (для 1.12.2 — Java 8 обязательно!)
                // installer.jar и server-jar должны запускаться одной и той же Java.
                const fakeSrv = { flavor: 'forge', mc_version: w.mcVersion, mcVersion: w.mcVersion };
                let installerJava = pickJavaForServer(fakeSrv);
                if (!installerJava) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, dlMsg.message_id, undefined,
                        `${pe('⚙️')} Устанавливаю нужную Java для Forge через apt-get…`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                    installerJava = await ensureJavaForServer(fakeSrv);
                }
                if (!installerJava) {
                    const wanted = requiredJavaMajorsForMc(w.mcVersion, 'forge');
                    throw new Error(
                        `Для Forge ${w.mcVersion} нужна Java ${wanted[0]}, но она не найдена. ` +
                        `Установите: sudo apt install openjdk-${wanted[0]}-jre-headless`
                    );
                }
                log.info(`Forge installer for ${w.mcVersion} → Java ${installerJava.major}`);

                // Pre-accept EULA so the installer / first launch doesn't trip on it.
                await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=true\n').catch(() => {});

                // The Forge installer can be chatty and slow. Pipe a timeout-aware run
                // and surface stderr in the error message if it fails.
                // Для старых Forge (≤1.12.2) инсталлер не всегда сам скачивает
                // minecraft_server.<ver>.jar (сервер Mojang) — предварительно
                // положим его в папку, чтобы инсталлер видел всё необходимое.
                try {
                    const mcVerParts = String(w.mcVersion).split('.').map(Number);
                    const isLegacyForge = (mcVerParts[1] || 0) <= 12;
                    if (isLegacyForge) {
                        try {
                            const vanillaUrl = await resolveVanillaServerJarUrl(w.mcVersion);
                            if (vanillaUrl) {
                                const vanillaPath = path.join(dir, `minecraft_server.${w.mcVersion}.jar`);
                                if (!fs.existsSync(vanillaPath)) {
                                    log.info(`Forge legacy: предварительно качаю vanilla server ${w.mcVersion}`);
                                    await downloadToFile(vanillaUrl, vanillaPath);
                                }
                            }
                        } catch (e) {
                            log.warn('Legacy Forge: не удалось предварительно загрузить vanilla server.jar:', e.message.slice(0, 200));
                        }
                    }
                    await runCmd(
                        installerJava.bin,
                        ['-Xmx1G', '-jar', downloadPath, '--installServer'],
                        { cwd: dir }
                    );
                } catch (e) {
                    throw new Error('Forge installer завершился с ошибкой (Java ' + installerJava.major + '): ' + e.message.slice(0, 400));
                }

                // Locate launch entrypoint after install. Preference order:
                //   1) run.sh   — official launcher from the installer (1.17+),
                //                  it knows about user_jvm_args.txt + the right @args file
                //   2) unix_args.txt — fall back to invoking java with @argsFile directly
                //   3) old forge-*-universal.jar / forge-*.jar (pre-1.17)
                const entries = await fsp.readdir(dir);
                const runSh = entries.find((f) => f === 'run.sh' || f === 'run.bat');
                const argsTxt = await findFile(dir, /unix_args\.txt$/i, 6);

                if (runSh && runSh === 'run.sh') {
                    // Make sure it's executable inside Docker volumes (umask often kills +x).
                    try { await fsp.chmod(path.join(dir, runSh), 0o755); } catch {}

                    // Make sure a sane user_jvm_args.txt exists with our heap settings.
                    const userArgsPath = path.join(dir, 'user_jvm_args.txt');
                    const heapBlock =
                        '# Auto-generated by mc-tg-bot — JVM heap & GC\n' +
                        `-Xms${ENV.JVM_XMS}\n` +
                        `-Xmx${ENV.JVM_XMX}\n` +
                        '-XX:+UseG1GC\n';
                    try {
                        if (fs.existsSync(userArgsPath)) {
                            // Keep existing comments/flags, but prepend our heap block once.
                            const cur = await fsp.readFile(userArgsPath, 'utf8');
                            if (!/-Xmx/.test(cur)) {
                                await fsp.writeFile(userArgsPath, heapBlock + '\n' + cur);
                            }
                        } else {
                            await fsp.writeFile(userArgsPath, heapBlock);
                        }
                    } catch {}

                    startCmdRecipe = { mode: 'forge-runsh', script: runSh };
                    jarPath = path.join(dir, runSh); // stored for reference
                } else if (argsTxt) {
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

                // Delete the installer jar — it's no longer needed and confuses some users.
                await fsp.rm(downloadPath, { force: true }).catch(() => {});
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
        //
        // CRITICAL: явно пишем `server-ip=` (пусто → эквивалентно 0.0.0.0).
        // Это заставляет MC-сервер слушать ВСЕ интерфейсы, включая публичный.
        // Если сервер свяжется только с 127.0.0.1, клиенты извне видят "server not found".
        const bindHost = process.env.BIND_HOST || ''; // пусто = 0.0.0.0
        await writeServerProperty(dir, 'server-ip',    bindHost).catch(() => {});
        await writeServerProperty(dir, 'server-port',  port).catch(() => {});
        await writeServerProperty(dir, 'query.port',   port).catch(() => {});
        await writeServerProperty(dir, 'max-players',  w.slots).catch(() => {});
        await writeServerProperty(dir, 'motd',         `${w.motd} §8— ${ENV.BRAND_MOTD}`).catch(() => {});
        await writeServerProperty(dir, 'online-mode',  'true').catch(() => {});
        await writeServerProperty(dir, 'enable-status','true').catch(() => {});
        await writeServerProperty(dir, 'enable-query', 'true').catch(() => {});
        await writeServerProperty(dir, 'prevent-proxy-connections', 'false').catch(() => {});

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
                    [btn('▶️ Запустить', `srv:start:${srv.id}`)],
                    [btn('📂 К списку серверов', 'srv:list')],
                    [btn('⬅️ В меню', 'menu:main')],
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
        return [btn(`${live}#${s.id} ${s.name} (${s.flavor} ${s.mc_version})`, `srv:open:${s.id}`)];
    });
    rows.push([btn('⬅️ В меню', 'menu:main')]);
    return safeEdit(ctx, '📂 Ваши серверы:', Markup.inlineKeyboard(rows));
});

bot.action(/^srv:open:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ServersRepo.byId(Number(ctx.match[1]));
    if (!s) {
        return safeEdit(ctx, 'Сервер не найден.',
            Markup.inlineKeyboard([[btn('⬅️ К списку', 'srv:list')]]));
    }
    if (!isAdmin(ctx.from.id) && s.owner_id !== ctx.from.id) {
        return safeEdit(ctx, '🚫 Это не ваш сервер.',
            Markup.inlineKeyboard([[btn('⬅️ К списку', 'srv:list')]]));
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
                ? [btn('🛑 Остановить', `srv:stop:${s.id}`),
                   btn('🖥 Консоль', `srv:console:${s.id}`)]
                : [btn('▶️ Запустить', `srv:start:${s.id}`)],
            [btn('📊 Статус / онлайн', `srv:status:${s.id}`)],
            [btn('📦 Загрузить файл', `srv:upfor:${s.id}`)],
            [btn('📁 Файловый менеджер', `fm:browse:${s.id}:`)],
            [btn('📜 Лог', `srv:log:${s.id}`)],
            [btn('🗑 Удалить', `srv:delask:${s.id}`)],
            [btn('⬅️ К списку', 'srv:list')],
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
                    [btn('🔄 Обновить', `srv:console:${server.id}`),
                     btn('❌ Выйти', `srv:consoff:${server.id}`)],
                    [btn('🛑 Остановить сервер', `srv:stop:${server.id}`)],
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
                [btn('▶️ Запустить', `srv:start:${id}`)],
                [btn('⬅️ К серверу', `srv:open:${id}`)],
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
                [btn('🔄 Обновить', `srv:console:${id}`),
                 btn('❌ Выйти', `srv:consoff:${id}`)],
                [btn('🛑 Остановить сервер', `srv:stop:${id}`)],
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
        Markup.inlineKeyboard([[btn('⬅️ К серверу', `srv:open:${s?.id || id}`)]])
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
    const all  = await getAllIps().catch(() => null);
    const ip   = all?.forced || all?.public ||
                 all?.ipv4?.find((x) => x.scope === 'public')?.address ||
                 all?.ipv4?.[0]?.address || null;
    const portOpen = ip ? await isPortOpenPublic(ip, port).catch(() => null) : null;
    let portLine = '';
    if (portOpen === true)  portLine = `\n🔓 Порт: <b>открыт извне</b> ✅`;
    else if (portOpen === false) portLine = `\n🔒 Порт: <b>закрыт извне</b> ❌ (проверьте firewall/port-mapping)`;

    let body = `⛙️ <b>${esc(s.name)}</b> — ${esc(s.flavor)} ${esc(s.mc_version)}\n` +
               `📍 <code>${esc(ip ? ip + ':' + port : '??:' + port)}</code>${portLine}\n` +
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

    if (all) body += `\n\n<b>Альтернативные адреса:</b>\n${formatAddressBlock(all, port)}`;

    return safeEdit(ctx, body,
        Markup.inlineKeyboard([
            [btn('🔄 Обновить', `srv:status:${id}`)],
            [btn('⬅️ К серверу', `srv:open:${id}`)],
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
            Markup.inlineKeyboard([[btn('⬅️ К серверу', `srv:open:${id}`)]]));
    }

    let stat;
    try { stat = await fsp.stat(absPath); } catch {
        return safeEdit(ctx, 'Путь не найден.',
            Markup.inlineKeyboard([[btn('⬅️ К серверу', `srv:open:${id}`)]]));
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
                        [btn('🗑 Удалить файл', `fm:del:${id}:${encodeRelPath(relPath)}`)],
                        [btn('⬅️ Назад', `fm:browse:${id}:${encodeRelPath(parentRel)}`)],
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
                [btn('🗑 Удалить файл', `fm:del:${id}:${encodeRelPath(relPath)}`)],
                [btn('⬅️ Назад', `fm:browse:${id}:${encodeRelPath(parentRel)}`)],
            ])
        );
    }

    // It's a directory — list contents
    let entries;
    try {
        entries = await listDir(absPath);
    } catch (e) {
        return safeEdit(ctx, `Ошибка чтения директории: ${esc(e.message)}`,
            Markup.inlineKeyboard([[btn('⬅️ К серверу', `srv:open:${id}`)]]));
    }

    const rows = entries.map((e) => {
        const childRel = relPath ? `${relPath}/${e.name}` : e.name;
        const icon = e.isDir ? '📂' : '📄';
        return [btn(`${icon} ${e.name}`, `fm:browse:${id}:${encodeRelPath(childRel)}`)];
    });

    // Back button
    const isRoot = !relPath || relPath === '';
    if (!isRoot) {
        const parentRel = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '';
        rows.push([btn('⬅️ Вверх', `fm:browse:${id}:${encodeRelPath(parentRel)}`)]);
    }
    rows.push([btn('⬅️ К серверу', `srv:open:${id}`)]);

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
            [btn('🗑 Да, удалить', `fm:delok:${id}:${encodeRelPath(relPath)}`)],
            [btn('⬅️ Отмена', `fm:browse:${id}:${encodeRelPath(parentRel)}`)],
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
        Markup.inlineKeyboard([[btn('📁 Вернуться', `fm:browse:${id}:${encodeRelPath(parentRel)}`)]])
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
            [btn('🗑 Да, удалить', `srv:del:${id}`)],
            [btn('⬅️ Нет, назад', `srv:open:${id}`)],
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
        btn(`#${s.id} ${s.name}`, `srv:upfor:${s.id}`),
    ]);
    rows.push([btn('⬅️ В меню', 'menu:main')]);
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
        Markup.inlineKeyboard([[btn('⬅️ К серверу', `srv:open:${id}`)]])
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
        btn(`#${s.id} ${s.name}`, `srv:aigenfor:${s.id}`),
    ]);
    rows.push([btn('⬅️ В меню', 'menu:main')]);
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
        Markup.inlineKeyboard([[btn('⬅️ Отмена', `srv:open:${id}`)]])
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
            // АВТОУСТАНОВКА JDK если javac нет (вместо того чтобы просто сообщить об ошибке)
            if (!ENV.JAVAC_BIN) {
                try {
                    const wait2 = await ctx.reply(
                        `${pe('⚙️')} javac не найден — устанавливаю JDK для компиляции…`,
                        { parse_mode: 'HTML' }
                    );
                    await ensureJavacAvailable();
                    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait2.message_id); } catch {}
                } catch (e) {
                    log.warn('ensureJavacAvailable error:', e.message);
                }
            }

            if (ENV.JAVAC_BIN) {
                // АВТОУСТАНОВКА в /plugins — создаём папку и кладём собранный jar туда
                const pluginsDir = path.join(server.dir, 'plugins');
                await fsp.mkdir(pluginsDir, { recursive: true });
                const compileRes = await tryCompileJavaPlugin({
                    javaFile,
                    pluginYmlPath: ymlFile,
                    outDir: pluginsDir,
                    pluginName: result.name,
                    server,
                });
                if (compileRes && compileRes.ok) {
                    extraNote = `\n${pe('✅')} Плагин скомпилирован и установлен: <code>plugins/${esc(path.basename(compileRes.jarPath))}</code>` +
                        `\nПерезапустите сервер для загрузки.`;
                } else {
                    const why = compileRes && compileRes.reason ? compileRes.reason : 'неизвестная ошибка';
                    extraNote = `\n${pe('⚠️')} Авто-компиляция не удалась: <code>${esc(why.slice(0, 250))}</code>\n` +
                        `Исходники сохранены в <code>${esc(descriptionPath)}</code> — соберите вручную ` +
                        `(<code>javac</code> + <code>jar</code>).`;
                }
            } else {
                extraNote = `\n${pe('⚠️')} <b>javac</b> не найден и автоустановка не удалась. Исходники в ` +
                    `<code>${esc(descriptionPath)}</code>.\nУстановите JDK вручную: ` +
                    `<code>sudo apt install -y openjdk-21-jdk-headless</code>.`;
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
                [btn('▶️ Запустить сервер', `srv:start:${server.id}`)],
                [btn('⬅️ К серверу', `srv:open:${server.id}`)],
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
                        [btn('⬅️ К серверу', `srv:open:${server.id}`)],
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
                        [btn('⬅️ К серверу', `srv:open:${server.id}`)],
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
        [btn('➕ Выдать доступ', 'adm:grant')],
        [btn('➖ Отозвать доступ', 'adm:revoke')],
        [btn('👥 Список пользователей', 'adm:list')],
        [btn(`🧠 Модель AI (${getSetting('ai_model')})`, 'adm:model')],
        [btn('🌐 Публичный IP', 'adm:ip')],
        [btn('📊 Нагрузка VPS', 'adm:vps')],
        [btn('☕ Java / JDK', 'adm:java')],
        [btn('⬅️ В меню', 'menu:main')],
    ]);
}

// ---------------------------------------------------------------
// VPS / system stats helpers (for admin panel & ops debugging)
// ---------------------------------------------------------------
function _humanBytes(n) {
    if (!Number.isFinite(n)) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function _humanUptime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400); sec %= 86400;
    const h = Math.floor(sec / 3600);  sec %= 3600;
    const m = Math.floor(sec / 60);    sec %= 60;
    const parts = [];
    if (d) parts.push(`${d}д`);
    if (h) parts.push(`${h}ч`);
    if (m) parts.push(`${m}м`);
    if (!parts.length) parts.push(`${sec}с`);
    return parts.join(' ');
}
function _cpuSnapshot() {
    const cpus = os.cpus() || [];
    let total = 0, idle = 0;
    for (const c of cpus) {
        for (const k of Object.keys(c.times)) total += c.times[k];
        idle += c.times.idle;
    }
    return { total, idle, count: cpus.length, model: cpus[0]?.model || 'unknown' };
}
async function measureCpuUsage(ms = 700) {
    const a = _cpuSnapshot();
    await new Promise((r) => setTimeout(r, ms));
    const b = _cpuSnapshot();
    const dt = b.total - a.total;
    const di = b.idle - a.idle;
    if (dt <= 0) return { percent: 0, count: a.count, model: a.model };
    const percent = Math.max(0, Math.min(100, 100 * (1 - di / dt)));
    return { percent, count: a.count, model: a.model };
}
async function diskUsage(targetPath) {
    try {
        const { out } = await runCmd('df', ['-Pk', targetPath]);
        const lines = out.trim().split('\n');
        if (lines.length < 2) return null;
        const cols = lines[lines.length - 1].split(/\s+/);
        // FS  1K-blocks  Used  Available  Use%  Mountpoint
        const total = parseInt(cols[1], 10) * 1024;
        const used  = parseInt(cols[2], 10) * 1024;
        const avail = parseInt(cols[3], 10) * 1024;
        return { total, used, avail, mount: cols[5] || targetPath };
    } catch { return null; }
}
async function processChildStats(pid) {
    // Linux: /proc/<pid>/status и /proc/<pid>/stat — RSS и CPU%
    try {
        const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
        const m = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
        const rss = m ? parseInt(m[1], 10) * 1024 : 0;
        return { rss };
    } catch { return null; }
}
async function collectVpsStats() {
    const cpu = await measureCpuUsage(700);
    const load = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = totalMem ? (usedMem / totalMem) * 100 : 0;
    const procMem = process.memoryUsage();
    const sysUptime = os.uptime();
    const procUptime = process.uptime();
    const disk = await diskUsage(ENV.SERVERS_ROOT);
    const diskDb = await diskUsage(path.dirname(ENV.DB_PATH));
    const node = process.version;
    const platform = `${os.type()} ${os.release()} (${os.arch()})`;
    const hostname = os.hostname();

    // Running servers + their RAM
    const running = [];
    for (const [sid, st] of RUNNING) {
        const srv = ServersRepo.byId(sid);
        if (!srv) continue;
        const ps = st.child && st.child.pid ? await processChildStats(st.child.pid) : null;
        running.push({
            id: sid,
            name: srv.name,
            flavor: srv.flavor,
            mc: srv.mc_version,
            uptime: Math.floor((Date.now() - (st.startedAt || Date.now())) / 1000),
            rss: ps?.rss || 0,
        });
    }
    return {
        cpu, load, totalMem, freeMem, usedMem, memPct, procMem,
        sysUptime, procUptime, disk, diskDb, node, platform, hostname, running,
    };
}
function _bar(pct, width = 12) {
    const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function formatVpsStats(s) {
    const lines = [];
    lines.push(`<b>📊 Нагрузка VPS</b>`);
    lines.push('');
    lines.push(`<b>🖥️ Хост:</b> <code>${esc(s.hostname)}</code>`);
    lines.push(`<b>⚙️ ОС:</b> <code>${esc(s.platform)}</code>`);
    lines.push(`<b>🟢 Node.js:</b> <code>${esc(s.node)}</code>`);
    lines.push(`<b>⏱ Uptime Системы:</b> ${esc(_humanUptime(s.sysUptime))}`);
    lines.push(`<b>⏱ Uptime Бота:</b> ${esc(_humanUptime(s.procUptime))}`);
    lines.push('');
    lines.push(`<b>🔥 CPU:</b> <code>${s.cpu.percent.toFixed(1)}%</code> [${_bar(s.cpu.percent)}]`);
    lines.push(`   ⤷ Ядер: <b>${s.cpu.count}</b>  •  <i>${esc((s.cpu.model || '').slice(0, 40))}</i>`);
    lines.push(`   ⤷ LoadAvg: <code>${s.load.map((x) => x.toFixed(2)).join(' / ')}</code>`);
    lines.push('');
    lines.push(`<b>🧠 RAM:</b> <code>${_humanBytes(s.usedMem)}</code> / <code>${_humanBytes(s.totalMem)}</code> (${s.memPct.toFixed(1)}%) [${_bar(s.memPct)}]`);
    lines.push(`   ⤷ Свободно: <code>${_humanBytes(s.freeMem)}</code>`);
    lines.push(`   ⤷ Бот RSS: <code>${_humanBytes(s.procMem.rss)}</code> | Heap: <code>${_humanBytes(s.procMem.heapUsed)}</code>/<code>${_humanBytes(s.procMem.heapTotal)}</code>`);
    if (s.disk) {
        const dPct = (s.disk.used / s.disk.total) * 100;
        lines.push('');
        lines.push(`<b>💾 Диск (${esc(s.disk.mount)}):</b> <code>${_humanBytes(s.disk.used)}</code> / <code>${_humanBytes(s.disk.total)}</code> (${dPct.toFixed(1)}%) [${_bar(dPct)}]`);
        lines.push(`   ⤷ Свободно: <code>${_humanBytes(s.disk.avail)}</code>`);
    }
    if (s.diskDb && (!s.disk || s.diskDb.mount !== s.disk.mount)) {
        const dPct = (s.diskDb.used / s.diskDb.total) * 100;
        lines.push(`<b>💾 Диск (${esc(s.diskDb.mount)} — DB):</b> ${_humanBytes(s.diskDb.used)} / ${_humanBytes(s.diskDb.total)} (${dPct.toFixed(1)}%)`);
    }
    lines.push('');
    lines.push(`<b>🟩 Серверы Minecraft:</b> запущено ${s.running.length}`);
    if (s.running.length) {
        for (const r of s.running) {
            lines.push(`   • <b>${esc(r.name)}</b> <i>(${esc(r.flavor)} ${esc(r.mc)})</i>: RAM <code>${_humanBytes(r.rss)}</code>, uptime ${_humanUptime(r.uptime)}`);
        }
    }
    lines.push('');
    lines.push(`<b>☕ Java:</b> ${(ENV.JAVA_INSTALLS || []).map((j) => `<code>${j.major}</code>`).join(', ') || '<i>нет</i>'}`);
    return lines.join('\n');
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
        Markup.inlineKeyboard([[btn('⬅️ Отмена', 'adm:open')]])
    );
});

bot.action('adm:revoke', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminWait = { action: 'revoke' };
    return safeEdit(ctx,
        '➖ Введите <b>@username</b> или числовой Telegram ID пользователя ' +
        'для <b>отзыва</b> доступа:',
        Markup.inlineKeyboard([[btn('⬅️ Отмена', 'adm:open')]])
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
        Markup.inlineKeyboard([[btn('⬅️ Назад', 'adm:open')]])
    );
});

async function renderAdminIpPanel(ctx) {
    await safeEdit(ctx, '<tg-emoji emoji-id="6028435952299413210">ℹ</tg-emoji> Определяю все адреса хоста…');
    const all = await getAllIps().catch(() => null);
    const servers = ServersRepo.listAll();

    const addrBlock = all ? formatAddressBlock(all, null) : '<i>Не удалось определить адреса.</i>';
    const bestIp = all?.forced || all?.public ||
                   all?.ipv4?.find((x) => x.scope === 'public')?.address ||
                   all?.ipv4?.[0]?.address || null;

    // Per-server reachability check — in parallel, but cap at 6 servers
    // to avoid hammering the third-party port-check service.
    const srvSubset = servers.slice(0, 6);
    const srvChecks = await Promise.all(srvSubset.map(async (s) => {
        const port = readServerPort(s.dir, s.port || 25565);
        const open = bestIp ? await isPortOpenPublic(bestIp, port).catch(() => null) : null;
        const live = RUNNING.has(s.id) ? '🟢' : '⚪';
        let portStatus;
        if (open === true)  portStatus = '✅ открыт извне';
        else if (open === false) portStatus = '❌ закрыт / файрвол';
        else portStatus = '❔ проверка не удалась';
        return `${live} <b>${esc(s.name)}</b>: <code>${bestIp ? bestIp + ':' + port : '??:' + port}</code> — ${portStatus}`;
    }));
    const overflow = servers.length > srvSubset.length
        ? `\n<i>…и ещё ${servers.length - srvSubset.length} серверов (проверка портов ограничена)</i>` : '';
    const srvLines = srvChecks.join('\n') || '<i>Серверов нет</i>';

    // Diagnostic hint based on what we found
    const hints = [];
    if (!all?.public && !all?.forced) {
        hints.push('⚠️ <b>Публичный IP не определён.</b> Скорее всего хост без интернета или за строгим файрволом. Задайте вручную через ENV: <code>PUBLIC_IP=...</code>');
    }
    if (all?.public && _isPrivateIPv4(all.public)) {
        hints.push('⚠️ Публичный IP попал в частный диапазон — вероятно, вы за NAT/CGNAT. Попросите хостинг выдать выделенный IPv4.');
    }
    if (srvChecks.some((l) => l.includes('закрыт'))) {
        hints.push('ℹ️ Порт закрыт извне — откройте его в панели хостинга (Firewall / Port forwarding) или пробросьте в Docker: <code>-p &lt;port&gt;:&lt;port&gt;/tcp -p &lt;port&gt;:&lt;port&gt;/udp</code>');
    }
    if (!hints.length && (all?.public || all?.forced)) {
        hints.push('✅ IP определён. Если игроки не могут подключиться — проверьте файрвол хоста и порт-маппинг Docker.');
    }

    return safeEdit(ctx,
        `<tg-emoji emoji-id="6042011682497106307">📍</tg-emoji> <b>Адреса хоста:</b>\n${addrBlock}\n\n` +
        `<b>Серверы (лучший IP + проверка порта):</b>\n${srvLines}${overflow}\n\n` +
        hints.join('\n'),
        Markup.inlineKeyboard([
            [btn('🔄 Обновить (сброс кэша)', 'adm:ip:refresh')],
            [btn('⬅️ Назад', 'adm:open')],
        ])
    );
}

bot.action('adm:ip', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    return renderAdminIpPanel(ctx);
});

// Force-refresh: drop both caches and re-run the panel
bot.action('adm:ip:refresh', async (ctx) => {
    await ctx.answerCbQuery('Кэш IP сброшен, обновляю…').catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    _publicIpCache = { ip: null, at: 0 };
    _allIpsCache   = { data: null, at: 0 };
    return renderAdminIpPanel(ctx);
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
            Markup.inlineKeyboard([[btn('⬅️ Назад', 'adm:open')]])
        );
    }
    const slice = models.slice(0, 30);
    const buttons = slice.map((m) => [
        btn(`${m === cur ? '✅ ' : ''}${m}`, `adm:setmodel:${m}`),
    ]);
    buttons.push([btn('⬅️ Назад', 'adm:open')]);
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

bot.action('adm:vps', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    await safeEdit(ctx, '📊 Собираю статистику VPS…');
    try {
        const stats = await collectVpsStats();
        return safeEdit(ctx, formatVpsStats(stats), Markup.inlineKeyboard([
            [btn('🔄 Обновить', 'adm:vps')],
            [btn('⬅️ Назад', 'adm:open')],
        ]));
    } catch (e) {
        return safeEdit(ctx,
            `⚠️ Ошибка сбора статистики: <code>${esc(e.message)}</code>`,
            Markup.inlineKeyboard([[btn('⬅️ Назад', 'adm:open')]])
        );
    }
});

bot.action('adm:java', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    const installs = ENV.JAVA_INSTALLS || [];
    let txt = '<b>☕ Доступные Java-версии</b>\n\n';
    if (installs.length) {
        for (const j of installs) {
            txt += `• <b>Java ${j.major}</b>: <code>${esc(j.bin)}</code>\n   <i>${esc(j.version)}</i>\n`;
        }
    } else {
        txt += '<i>Ни одной версии Java не найдено!</i>\n';
    }
    txt += '\n<b>javac:</b> ' + (ENV.JAVAC_BIN ? `<code>${esc(ENV.JAVAC_BIN)}</code>` : '<i>нет</i>');
    txt += '\n<b>Дефолтный java:</b> ' + (ENV.JAVA_BIN ? `<code>${esc(ENV.JAVA_BIN)}</code>` : '<i>нет</i>');
    txt += '\n\n<i>Рекомендуемые: Java 8 (Forge 1.7-1.12), Java 17 (1.17-1.20.4), Java 21 (1.20.5+).</i>';
    return safeEdit(ctx, txt, Markup.inlineKeyboard([
        [btn('➕ Доставить Java 8',  'adm:javainstall:8')],
        [btn('➕ Доставить Java 17', 'adm:javainstall:17')],
        [btn('➕ Доставить Java 21', 'adm:javainstall:21')],
        [btn('🔄 Обновить список', 'adm:java')],
        [btn('⬅️ Назад', 'adm:open')],
    ]));
});

bot.action(/^adm:javainstall:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx.from.id)) return;
    const major = parseInt(ctx.match[1], 10);
    await safeEdit(ctx, `☕ Устанавливаю Java ${major}… Это может занять 1-3 минуты.`);
    try {
        const inst = await autoInstallJava(major);
        if (inst) {
            return safeEdit(ctx,
                `<tg-emoji emoji-id="5870633910337015697">✅</tg-emoji> Java ${major} установлена: <code>${esc(inst.bin)}</code>`,
                Markup.inlineKeyboard([[btn('⬅️ К Java', 'adm:java')]])
            );
        } else {
            return safeEdit(ctx,
                `❌ Не удалось установить Java ${major}. Смотрите логи бота.`,
                Markup.inlineKeyboard([[btn('⬅️ К Java', 'adm:java')]])
            );
        }
    } catch (e) {
        return safeEdit(ctx,
            `❌ Ошибка: <code>${esc(e.message)}</code>`,
            Markup.inlineKeyboard([[btn('⬅️ К Java', 'adm:java')]])
        );
    }
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

bot.launch().then(async () => {
    log.info('🤖 Bot started. Admin ID:', ENV.ADMIN_ID);
    log.info('   Default model:', getSetting('ai_model'));
    log.info('   Servers root:', ENV.SERVERS_ROOT);
    if (ENV.JAVA_AVAILABLE) {
        log.info('   Java (default):', ENV.JAVA_BIN, '|', ENV.JAVA_VERSION_STR);
        const list = (ENV.JAVA_INSTALLS || [])
            .map((j) => `Java ${j.major} @ ${j.bin}`).join('; ');
        if (list) log.info('   Все Java-инсталляции:', list);
    } else {
        log.warn('   ⚠️  Java НЕ НАЙДЕНА! Серверы не смогут запускаться.');
        log.warn('   Установите OpenJDK 8 (для Forge 1.12.2), 17 и 21 — или укажите JAVA_BIN в .env');
    }
    log.info('   javac:', ENV.JAVAC_BIN || '<not found>');
    // ─── АВТОУСТАНОВКА ВСЕГО НУЖНОГО ПРИ СТАРТЕ (в фоне) ───
    // 1) Базовые OS-утилиты (unzip / tar / curl / wget / gpg)
    ensureSystemTools().catch((e) => log.warn('ensureSystemTools error:', e.message));
    // 2) Все Java-версии (8 / 17 / 21) — чтобы Forge 1.12.2 работал
    //    сразу, и Paper 1.17+ тоже.
    ensureAllJavaVersions().catch((e) => log.warn('ensureAllJavaVersions error:', e.message));
    // 3) javac (для AI-генерации плагинов)
    if (!ENV.JAVAC_BIN) {
        ensureJavacAvailable().then((jc) => {
            if (jc) log.info('   javac установлен автоматически:', jc);
        }).catch((e) => log.warn('Авто-установка javac не удалась:', e.message));
    }
}).catch((e) => {
    log.error('Failed to launch bot:', e);
    process.exit(1);
});
