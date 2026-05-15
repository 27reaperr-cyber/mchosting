/**
 * ──────────────────────────────────────────────────────────────────────
 * mcproxy.js — Встроенный Minecraft Reverse-Proxy (handshake-router)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Идея:
 *   Хостинг блокирует все порты, кроме ОДНОГО публичного (например 25600).
 *   Поднимаем wildcard DNS `*.mchost.bothost.tech` → IP сервера и
 *   запускаем единственный TCP-listener на :25600. Когда игрок подключается
 *   к `myserver.mchost.bothost.tech:25600`, его Minecraft-клиент сам
 *   передаёт строку `myserver.mchost.bothost.tech` в поле `server_address`
 *   handshake-пакета (это часть протокола, Mojang спецификация).
 *
 *   Этот модуль:
 *     1) слушает на 0.0.0.0:PROXY_PORT,
 *     2) парсит первый Minecraft-пакет (Handshake 0x00, https://wiki.vg/Protocol#Handshaking),
 *     3) вынимает subdomain (часть до первой точки),
 *     4) ищет в БД сервер с таким `subdomain`,
 *     5) открывает соединение на 127.0.0.1:<локальный порт сервера>,
 *     6) ПЕРЕСЫЛАЕТ оригинальный handshake-пакет нетронутым и далее
 *        полнодуплексно проксирует трафик в обе стороны (pipe).
 *
 * Что это даёт:
 *   • Один публичный порт → бесконечное число MC-серверов.
 *   • Никаких изменений в Minecraft-клиенте — всё работает «из коробки».
 *   • Сами MC-серверы слушают ТОЛЬКО на 127.0.0.1, наружу не торчат
 *     (BIND_HOST=127.0.0.1) — это даёт изоляцию и безопасность.
 *   • Поддерживается и обычный логин (Next state = 2) и server-list ping
 *     (Next state = 1) — игроки увидят онлайн/MOTD прямо в списке серверов.
 *   • Для несуществующих subdomain'ов отдаём корректный disconnect-пакет
 *     с понятным сообщением (на русском), вместо обрыва соединения.
 *
 * Аналоги (для справки):
 *   • mc-router  (itzg)  — Go
 *   • Infrared          — Go
 *   • Velocity / Bungee — Java (но это уже полноценный proxy, не просто роутер)
 *   Здесь — ~400 строк чистого Node.js, без внешних зависимостей.
 * ──────────────────────────────────────────────────────────────────────
 */

'use strict';

const net = require('net');

// ─────────────────────────────────────────────────────────────────────
// Minecraft VarInt / String helpers
// ─────────────────────────────────────────────────────────────────────
// VarInt — это переменной длины целое (1..5 байт). Каждый байт:
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
    let v = value >>> 0; // как беззнаковое 32
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

    // Legacy ping (Minecraft <1.7) — игнорируем, отвечать не на чем
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

    // Весь handshake-пакет = первые `packetEnd` байт буфера.
    return {
        ok: true,
        protocol,
        serverAddress,
        serverPort,
        nextState, // 1 = status (ping в списке серверов), 2 = login, 3 = transfer
        handshakeBytes: buf.slice(0, packetEnd),
        leftover: buf.slice(packetEnd), // то, что клиент уже успел доотправить (LoginStart / Request)
    };
}

// ─────────────────────────────────────────────────────────────────────
// Извлечь subdomain из server_address клиента
// ─────────────────────────────────────────────────────────────────────
// Forge-клиенты дописывают к адресу `\u0000FML3\u0000` или `\u0000FML\u0000`.
// BungeeCord IP-forwarding добавляет `\0<realIP>\0<uuid>\0<properties>`.
// Срезаем всё после первого NUL-байта и берём первую метку (до первой точки).
function extractSubdomain(addr, baseDomain) {
    if (!addr) return null;
    // Срезать BungeeCord / Forge маркеры
    let s = addr.split('\0')[0].trim().toLowerCase();
    if (!s) return null;

    // Срезать порт, если клиент почему-то записал его в адресе
    s = s.replace(/:\d+$/, '');

    // Срезать завершающую точку (FQDN-нотация)
    s = s.replace(/\.$/, '');

    // Если адрес === base домен — нет subdomain
    if (baseDomain && s === baseDomain.toLowerCase()) return null;

    // Если адрес заканчивается на base — берём первую метку
    if (baseDomain && s.endsWith('.' + baseDomain.toLowerCase())) {
        const head = s.slice(0, -(baseDomain.length + 1));
        // На случай вложенных меток (e.g. `foo.bar.mchost...`) — берём ПЕРВУЮ
        return head.split('.')[0] || null;
    }

    // Не наш домен — но всё равно берём первую метку как fallback
    // (на случай если игрок ввёл просто `myserver` или ip-адрес был с subdomain)
    const first = s.split('.')[0];
    return first || null;
}

// ─────────────────────────────────────────────────────────────────────
// Отправить клиенту человекочитаемый отказ
// ─────────────────────────────────────────────────────────────────────
// Для state=2 (login) — пакет Disconnect (0x00 в Login-состоянии) с JSON Chat.
// Для state=1 (status) — Response (0x00) с JSON server-list-ping, чтобы
// игрок увидел в списке серверов «бренд» с сообщением «сервер не найден».

function buildLoginDisconnect(message) {
    // JSON chat component
    const json = JSON.stringify({ text: message, color: 'red' });
    const payload = Buffer.concat([
        writeVarInt(0x00),         // packet id (login Disconnect)
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
        writeVarInt(0x00),         // status Response
        writeMcString(json),
    ]);
    return Buffer.concat([writeVarInt(payload.length), payload]);
}

// ─────────────────────────────────────────────────────────────────────
// Основной сервер: класс MinecraftReverseProxy
// ─────────────────────────────────────────────────────────────────────
//
// Использование:
//   const proxy = new MinecraftReverseProxy({
//       listenHost: '0.0.0.0',
//       listenPort: 25600,
//       baseDomain: 'mchost.bothost.tech',
//       resolveBackend: (subdomain, serverAddress) => { host, port } | null,
//       log: console,
//   });
//   await proxy.start();
//
// resolveBackend — callback, который по subdomain'у должен вернуть локальный
// endpoint (или null, если такого нет). Бот подключает сюда поиск в БД.

class MinecraftReverseProxy {
    constructor(opts) {
        this.listenHost = opts.listenHost || '0.0.0.0';
        this.listenPort = Number(opts.listenPort) || 25600;
        this.baseDomain = (opts.baseDomain || '').toLowerCase();
        this.resolveBackend = opts.resolveBackend;
        this.log = opts.log || console;
        this.handshakeTimeoutMs = opts.handshakeTimeoutMs || 5000;
        this.idleTimeoutMs = opts.idleTimeoutMs || 0; // 0 = выкл; MC шлёт keepalive
        this.server = null;

        // Метрики (доступны через getStats)
        this.stats = {
            totalConnections: 0,
            activeConnections: 0,
            statusPings: 0,
            logins: 0,
            rejectedUnknown: 0,
            rejectedBadHandshake: 0,
            backendFailures: 0,
        };
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer({ allowHalfOpen: false }, (s) => this._onClient(s));
            this.server.on('error', (e) => {
                this.log.error?.(`[mcproxy] listen error: ${e.message}`);
                reject(e);
            });
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
            // Игроки часто рвут соединение — это норма, не спамим в логи.
            this.log.debug?.(`${tag} client error: ${e.message}`);
        });
        client.once('close', () => {
            clearTimeout(handshakeTimer);
            cleanup();
        });

        client.on('data', (chunk) => {
            if (resolved) return; // уже передали данные бэкенду через pipe
            buf = Buffer.concat([buf, chunk]);

            // Защита: не даём клиенту переполнить буфер до handshake.
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
                // Minecraft <1.7 — старый протокол. Современные клиенты сюда не попадают.
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

            const sub = extractSubdomain(h.serverAddress, this.baseDomain);
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
                        ? `🚫 Сервер "${sub}" не найден на mchost.\nПроверь адрес в Telegram-боте.`
                        : `🚫 Укажи поддомен сервера, например:\nmyserver.${this.baseDomain || 'mchost.bothost.tech'}:${this.listenPort}`
                );
                return;
            }

            // Открываем соединение с бэкендом и пересылаем handshake + leftover.
            this._connectBackend(client, backend, h, tag);
        });
    }

    _rejectClient(client, nextState, message) {
        try {
            if (nextState === 1) {
                // status: отвечаем Response + ждём Ping(0x01) и отбиваем его обратно
                client.write(buildStatusResponse(message, message));
                // Просто закроем после небольшой паузы — большинство клиентов
                // успеют отрисовать MOTD «не найден».
                setTimeout(() => { try { client.end(); } catch {} }, 200);
            } else {
                // login (или transfer): чистый Disconnect с JSON Chat
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
            // Передаём первый пакет нетронутым + всё, что клиент уже доотправил
            // (например LoginStart). Это критично — нельзя терять байты.
            upstream.write(handshake.handshakeBytes);
            if (handshake.leftover && handshake.leftover.length) {
                upstream.write(handshake.leftover);
            }
            // Полнодуплексная перекачка трафика.
            client.pipe(upstream, { end: true });
            upstream.pipe(client, { end: true });
        });

        upstream.setNoDelay(true);
        client.setNoDelay(true);

        const closeBoth = () => {
            try { client.destroy(); } catch {}
            try { upstream.destroy(); } catch {}
        };

        upstream.on('error', (e) => {
            this.stats.backendFailures++;
            this.log.warn?.(`${tag} upstream ${backendHost}:${backendPort} error: ${e.message}`);
            // Сервер не запущен / упал — расскажем игроку
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
    // экспортируем для тестов / отладки
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
