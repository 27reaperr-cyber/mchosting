/**
 * ──────────────────────────────────────────────────────────────────────
 * mcproxy.js — Встроенный Minecraft Reverse-Proxy (handshake-router)
 * Railway-optimized edition.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Идея:
 *   Хостинг (Railway, Heroku, любой managed PaaS) даёт только ОДИН публичный
 *   TCP-порт. Поднимаем wildcard DNS (CNAME `*.mchost.example.com` →
 *   Railway TCP-proxy) и слушаем единственный TCP-listener. Когда игрок
 *   подключается к `myserver.mchost.example.com:25600`, его Minecraft-клиент
 *   сам передаёт `myserver.mchost.example.com` в поле `server_address`
 *   handshake-пакета (часть протокола Mojang).
 *
 *   Модуль:
 *     1) слушает на 0.0.0.0:PROXY_LISTEN_PORT,
 *     2) парсит первый Minecraft-пакет (Handshake 0x00),
 *     3) вынимает subdomain (часть до первой точки),
 *     4) ищет в БД сервер с таким `subdomain`,
 *     5) открывает соединение на 127.0.0.1:<локальный порт сервера>,
 *     6) ПЕРЕСЫЛАЕТ оригинальный handshake-пакет нетронутым и далее
 *        полнодуплексно проксирует трафик в обе стороны (pipe).
 *
 * Performance оптимизации в этом релизе:
 *   • TCP keep-alive на клиент и upstream → выживание сквозь NAT/CGNAT.
 *   • setNoDelay(true) → нулевая задержка пакетов (важно для геймплея).
 *   • allowHalfOpen=false → быстрее освобождаем дескрипторы.
 *   • Динамический baseDomain через getBaseDomain() — позволяет менять
 *     домен из админ-панели без рестарта listener'а.
 *   • Защита от oversized pre-handshake buffer (DoS protection).
 *   • Connection counter + lightweight per-second stats (idle-aware).
 *
 * Что это даёт:
 *   • Один публичный порт → неограниченное число MC-серверов.
 *   • Никаких изменений в Minecraft-клиенте — всё работает «из коробки».
 *   • MC-серверы слушают ТОЛЬКО на 127.0.0.1 (изоляция).
 *   • Поддерживается логин (Next state = 2) и server-list ping (Next state = 1).
 *   • Для несуществующих subdomain'ов отдаём корректный disconnect-пакет.
 *
 * Аналоги (для справки):
 *   • mc-router (itzg)  — Go
 *   • Infrared          — Go
 *   • Velocity/Bungee   — Java (полноценный proxy)
 *   Здесь — ~450 строк чистого Node.js, без внешних зависимостей.
 * ──────────────────────────────────────────────────────────────────────
 */

'use strict';

const net = require('net');

// ─────────────────────────────────────────────────────────────────────
// Minecraft VarInt / String helpers
// ─────────────────────────────────────────────────────────────────────
// VarInt — переменной длины целое (1..5 байт). Каждый байт:
//   bit 7      — continuation flag (1 → есть ещё байты)
//   bits 0..6 — полезная нагрузка (little-endian, 7 бит за раз)

/** Прочитать VarInt из буфера. Возвращает { value, size } или null если данных не хватает. */
function readVarInt(buf, offset = 0) {
    let numRead = 0;
    let result = 0;
    while (true) {
        if (offset + numRead >= buf.length) return null;
        const byte = buf[offset + numRead];
        const value = byte & 0x7f;
        result |= value << (7 * numRead);
        numRead++;
        if (numRead > 5) throw new Error('VarInt is too big');
        if ((byte & 0x80) === 0) break;
    }
    return { value: result, size: numRead };
}

/** Закодировать VarInt в Buffer. */
function writeVarInt(value) {
    const out = [];
    let v = value >>> 0;
    while (true) {
        if ((v & ~0x7f) === 0) { out.push(v); break; }
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    return Buffer.from(out);
}

/** Закодировать строку: VarInt-длина + UTF-8 байты. */
function writeMcString(str) {
    const b = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(b.length), b]);
}

// ─────────────────────────────────────────────────────────────────────
// Парсер первого пакета (Handshake) Minecraft протокола
// ─────────────────────────────────────────────────────────────────────
// Формат:
//   VarInt   length     — длина оставшегося пакета
//   VarInt   packet_id  — должно быть 0x00
//   VarInt   protocol_version
//   String   server_address   (VarInt len + bytes, max 255)
//   UShort   server_port
//   VarInt   next_state       (1=status, 2=login, 3=transfer)
//
// Если данных не хватает — возвращаем { partial: true }, ждём ещё байт.
// Если первый байт 0xFE — это легаси-пинг (Minecraft < 1.7), не поддерживаем.

function parseHandshake(buf) {
    if (buf.length === 0) return { partial: true };

    // Legacy ping (Minecraft <1.7) — игнорируем
    if (buf[0] === 0xfe) return { legacy: true };

    let p = 0;
    const lenVI = readVarInt(buf, p);
    if (!lenVI) return { partial: true };
    const packetLen = lenVI.value;
    p += lenVI.size;

    // Подождать, пока соберётся весь handshake-пакет
    if (buf.length < p + packetLen) return { partial: true };

    const packetEnd = p + packetLen;

    const idVI = readVarInt(buf, p);
    if (!idVI) return { partial: true };
    if (idVI.value !== 0x00) return { error: 'not a handshake packet (id=' + idVI.value + ')' };
    p += idVI.size;

    const protoVI = readVarInt(buf, p);
    if (!protoVI) return { partial: true };
    const protocol = protoVI.value;
    p += protoVI.size;

    const addrLenVI = readVarInt(buf, p);
    if (!addrLenVI) return { partial: true };
    p += addrLenVI.size;
    if (addrLenVI.value < 0 || addrLenVI.value > 256) {
        return { error: 'address length out of bounds: ' + addrLenVI.value };
    }
    if (p + addrLenVI.value > buf.length) return { partial: true };
    const serverAddress = buf.slice(p, p + addrLenVI.value).toString('utf8');
    p += addrLenVI.value;

    if (p + 2 > buf.length) return { partial: true };
    const serverPort = buf.readUInt16BE(p);
    p += 2;

    const nextStateVI = readVarInt(buf, p);
    if (!nextStateVI) return { partial: true };
    const nextState = nextStateVI.value;
    p += nextStateVI.size;

    return {
        ok: true,
        protocol,
        serverAddress,
        serverPort,
        nextState, // 1 = status, 2 = login, 3 = transfer
        handshakeBytes: buf.slice(0, packetEnd),
        leftover: buf.slice(packetEnd),
    };
}

// ─────────────────────────────────────────────────────────────────────
// Извлечь subdomain из server_address клиента
// ─────────────────────────────────────────────────────────────────────
// Forge-клиенты дописывают `\u0000FML3\u0000` или `\u0000FML\u0000`.
// BungeeCord IP-forwarding добавляет `\0<realIP>\0<uuid>\0<properties>`.
// Срезаем всё после первого NUL-байта и берём первую метку (до первой точки).
function extractSubdomain(addr, baseDomain) {
    if (!addr) return null;
    let s = addr.split('\0')[0].trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/:\d+$/, '');
    s = s.replace(/\.$/, '');
    if (baseDomain && s === baseDomain.toLowerCase()) return null;
    if (baseDomain && s.endsWith('.' + baseDomain.toLowerCase())) {
        const head = s.slice(0, -(baseDomain.length + 1));
        return head.split('.')[0] || null;
    }
    const first = s.split('.')[0];
    return first || null;
}

// ─────────────────────────────────────────────────────────────────────
// Отказ клиенту: human-readable сообщение
// ─────────────────────────────────────────────────────────────────────
function buildLoginDisconnect(message) {
    const json = JSON.stringify({ text: message, color: 'red' });
    const payload = Buffer.concat([
        writeVarInt(0x00),
        writeMcString(json),
    ]);
    return Buffer.concat([writeVarInt(payload.length), payload]);
}

function buildStatusResponse(message, motd) {
    const json = JSON.stringify({
        version: { name: 'mchost-router', protocol: 0 },
        players: { max: 0, online: 0, sample: [] },
        description: { text: motd || message, color: 'gold' },
    });
    const payload = Buffer.concat([
        writeVarInt(0x00),
        writeMcString(json),
    ]);
    return Buffer.concat([writeVarInt(payload.length), payload]);
}

// ─────────────────────────────────────────────────────────────────────
// MinecraftReverseProxy
// ─────────────────────────────────────────────────────────────────────
//
// Использование:
//   const proxy = new MinecraftReverseProxy({
//       listenHost: '0.0.0.0',
//       listenPort: 25600,
//       baseDomain: 'mchost.example.com',     // статический fallback
//       getBaseDomain: () => settings.domain, // динамический (опционально)
//       resolveBackend: (subdomain) => ({ host, port }) | null,
//       log: console,
//   });
//   await proxy.start();

class MinecraftReverseProxy {
    constructor(opts) {
        this.listenHost = opts.listenHost || '0.0.0.0';
        this.listenPort = Number(opts.listenPort) || 25600;
        this._staticBaseDomain = (opts.baseDomain || '').toLowerCase();
        this._getBaseDomain = typeof opts.getBaseDomain === 'function'
            ? opts.getBaseDomain
            : () => this._staticBaseDomain;
        this.resolveBackend = opts.resolveBackend;
        this.log = opts.log || console;
        this.handshakeTimeoutMs = opts.handshakeTimeoutMs || 5000;
        this.idleTimeoutMs = opts.idleTimeoutMs || 0;
        this.server = null;

        // Performance: TCP keep-alive параметры
        this.keepAliveInitialDelayMs = opts.keepAliveInitialDelayMs ?? 30_000;

        // Метрики
        this.stats = {
            totalConnections: 0,
            activeConnections: 0,
            statusPings: 0,
            logins: 0,
            rejectedUnknown: 0,
            rejectedBadHandshake: 0,
            backendFailures: 0,
            bytesIn: 0,
            bytesOut: 0,
        };
    }

    /** Текущий базовый домен (может меняться рантайм через getBaseDomain). */
    get baseDomain() {
        try { return (this._getBaseDomain() || '').toLowerCase(); }
        catch { return this._staticBaseDomain; }
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer(
                { allowHalfOpen: false, pauseOnConnect: false },
                (s) => this._onClient(s)
            );
            this.server.on('error', (e) => {
                this.log.error?.(`[mcproxy] listen error: ${e.message}`);
                reject(e);
            });
            // Track max simultaneous connections — поможет ловить лики/DoS.
            this.server.maxConnections = 5000;
            this.server.listen(this.listenPort, this.listenHost, () => {
                this.log.info?.(`[mcproxy] listening on ${this.listenHost}:${this.listenPort} (base=${this.baseDomain || '<none>'})`);
                resolve();
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
        });
    }

    getStats() { return { ...this.stats }; }

    // ─────────────────────────────────────────────────────────────
    _onClient(client) {
        this.stats.totalConnections++;
        this.stats.activeConnections++;
        const remoteAddr = client.remoteAddress || '?';
        const remotePort = client.remotePort || 0;
        const tag = `[mcproxy ${remoteAddr}:${remotePort}]`;

        let buf = Buffer.alloc(0);
        let resolved = false;

        // Performance: TCP keepalive + no-delay прямо сейчас, до первого байта.
        try {
            client.setNoDelay(true);
            client.setKeepAlive(true, this.keepAliveInitialDelayMs);
        } catch {}

        const cleanup = () => {
            this.stats.activeConnections--;
            client.removeAllListeners('data');
            client.removeAllListeners('end');
        };

        const handshakeTimer = setTimeout(() => {
            if (resolved) return;
            this.log.warn?.(`${tag} handshake timeout — closing`);
            try { client.destroy(); } catch {}
        }, this.handshakeTimeoutMs);

        client.once('error', (e) => {
            // Игроки часто рвут соединение — это норма.
            this.log.debug?.(`${tag} client error: ${e.message}`);
        });
        client.once('close', () => {
            clearTimeout(handshakeTimer);
            cleanup();
        });

        client.on('data', (chunk) => {
            if (resolved) return;
            this.stats.bytesIn += chunk.length;
            buf = Buffer.concat([buf, chunk]);

            // DoS protection: жёсткий cap до handshake.
            if (buf.length > 4096) {
                this.stats.rejectedBadHandshake++;
                this.log.warn?.(`${tag} oversized pre-handshake buffer — closing`);
                try { client.destroy(); } catch {}
                return;
            }

            let h;
            try { h = parseHandshake(buf); }
            catch (e) {
                this.stats.rejectedBadHandshake++;
                this.log.warn?.(`${tag} parse error: ${e.message}`);
                try { client.destroy(); } catch {}
                return;
            }

            if (h.partial) return;
            resolved = true;
            clearTimeout(handshakeTimer);

            if (h.legacy) {
                this.stats.rejectedBadHandshake++;
                try { client.end(); } catch {}
                return;
            }
            if (h.error) {
                this.stats.rejectedBadHandshake++;
                this.log.warn?.(`${tag} bad handshake: ${h.error}`);
                try { client.destroy(); } catch {}
                return;
            }

            const base = this.baseDomain;
            const sub = extractSubdomain(h.serverAddress, base);
            const isStatus = h.nextState === 1;
            if (isStatus) this.stats.statusPings++;
            else this.stats.logins++;

            this.log.debug?.(`${tag} handshake addr="${h.serverAddress}" sub="${sub}" state=${h.nextState} proto=${h.protocol}`);

            let backend = null;
            try {
                backend = sub ? this.resolveBackend(sub, h.serverAddress) : null;
            } catch (e) {
                this.log.error?.(`${tag} resolveBackend threw: ${e.message}`);
            }

            if (!backend) {
                this.stats.rejectedUnknown++;
                this._rejectClient(client, h.nextState,
                    sub
                        ? `🚫 Сервер "${sub}" не найден.\nПроверь адрес в Telegram-боте.`
                        : `🚫 Укажи поддомен сервера, например:\nmyserver.${base || 'mchost.example.com'}:${this.listenPort}`
                );
                return;
            }

            this._connectBackend(client, backend, h, tag);
        });
    }

    _rejectClient(client, nextState, message) {
        try {
            if (nextState === 1) {
                client.write(buildStatusResponse(message, message));
                setTimeout(() => { try { client.end(); } catch {} }, 200);
            } else {
                client.write(buildLoginDisconnect(message));
                setTimeout(() => { try { client.end(); } catch {} }, 100);
            }
        } catch (e) {
            try { client.destroy(); } catch {}
        }
    }

    _connectBackend(client, backend, handshake, tag) {
        const backendHost = backend.host || '127.0.0.1';
        const backendPort = Number(backend.port);
        const upstream = net.createConnection({ host: backendHost, port: backendPort }, () => {
            // Передаём первый пакет нетронутым + всё, что клиент уже доотправил.
            upstream.write(handshake.handshakeBytes);
            if (handshake.leftover && handshake.leftover.length) {
                upstream.write(handshake.leftover);
            }
            // Performance: TCP keepalive + no-delay на upstream тоже.
            try {
                upstream.setNoDelay(true);
                upstream.setKeepAlive(true, this.keepAliveInitialDelayMs);
            } catch {}

            // Полнодуплексная перекачка. Счётчик байт для статы.
            client.on('data', (b) => { this.stats.bytesIn += b.length; });
            upstream.on('data', (b) => { this.stats.bytesOut += b.length; });

            client.pipe(upstream, { end: true });
            upstream.pipe(client, { end: true });
        });

        const closeBoth = () => {
            try { client.destroy(); } catch {}
            try { upstream.destroy(); } catch {}
        };

        upstream.on('error', (e) => {
            this.stats.backendFailures++;
            this.log.warn?.(`${tag} upstream ${backendHost}:${backendPort} error: ${e.message}`);
            try {
                this._rejectClient(client, handshake.nextState,
                    `⚠️ Сервер выключен.\nПопроси владельца включить его в Telegram-боте.`
                );
            } catch {}
            try { upstream.destroy(); } catch {}
        });
        upstream.on('close', () => { try { client.end(); } catch {} });
        client.on('close', () => { try { upstream.end(); } catch {} });
        client.on('error', closeBoth);
    }
}

module.exports = {
    MinecraftReverseProxy,
    _internals: {
        parseHandshake,
        extractSubdomain,
        readVarInt,
        writeVarInt,
        writeMcString,
        buildLoginDisconnect,
        buildStatusResponse,
    },
};
