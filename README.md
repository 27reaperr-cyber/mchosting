# 🟩 Minecraft Server Telegram Bot — Railway Edition

Production-ready Telegram bot для управления Minecraft-серверами (**Bukkit / Spigot / Paper / Forge**) с интеграцией нейросетей через **OnlySQ API** (Claude / GPT / Gemini и др.). Оптимизирован под деплой на [Railway](https://railway.com/).

## ✨ Что нового в Railway Edition (v2.0)

- 🚂 **Auto-detect Railway** — автоматически подхватывает `RAILWAY_TCP_PROXY_DOMAIN`, `RAILWAY_TCP_PROXY_PORT`, `RAILWAY_VOLUME_MOUNT_PATH`. Никаких ручных настроек.
- 🌐 **Смена домена прямо из админ-панели** — кнопка «Сменить домен» меняет публичный адрес без рестарта контейнера. Значение хранится в SQLite и переживает редеплои.
- 🔌 **Auto-open ports** — кнопка «Авто-открыть порты» в админ-панели:
  - На Railway: проверяет, что TCP-proxy включён, и автоматически прописывает его в настройки.
  - На self-host: открывает порт через `ufw`/`iptables`.
- 💾 **Persistent volume support** — `SERVERS_ROOT` и `DB_PATH` автоматически уезжают в `RAILWAY_VOLUME_MOUNT_PATH`.
- ⚡ **Performance tuning**:
  - SQLite: `synchronous=NORMAL`, `mmap_size=64MB`, `cache_size=20MB`, `busy_timeout=5s`.
  - mcproxy: TCP keep-alive + `setNoDelay(true)` на клиента и upstream → нулевая задержка пакетов, выживание сквозь NAT.
  - Telegraf: `dropPendingUpdates`, фильтр `allowedUpdates` → быстрее запуск.
  - Tini как PID 1 → корректная обработка SIGTERM от Railway.

## 🎯 Архитектура (зачем нужен реверс-прокси)

Railway даёт **только один публичный TCP-порт** на сервис. Этого хватит — наш встроенный handshake-router маршрутизирует трафик по поддоменам:

```
Игрок: myserver.shuttle.proxy.rlwy.net:15140
                       │
                       ▼
        Railway TCP Proxy (один порт)
                       │
                       ▼   (внутри контейнера)
        mcproxy.js handshake-router :PORT
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   127.0.0.1:25701 127.0.0.1:25702 127.0.0.1:25703
   (MC server #1)  (MC server #2)  (MC server #3)
```

Router читает поле `server_address` из первого пакета протокола Minecraft и роутит на нужный локальный порт. Сами MC-серверы слушают **только на 127.0.0.1** (изоляция).

## 🚀 Быстрый старт на Railway

### 1. Создайте проект

```bash
git clone <this-repo> mc-tg-bot
cd mc-tg-bot
railway init    # или импортируйте репозиторий через UI Railway
```

### 2. Создайте Volume (persistent storage)

В Railway UI → правый клик на канвасе → **New** → **Volume** → подключите к сервису.
Mount path: **`/data`**. Бот сам туда положит `bot.db` и папку `servers/`.

### 3. Включите TCP Proxy

В Railway UI → **Service** → **Settings** → **Networking** → **TCP Proxy** → **Enable**.
Internal port: оставьте `PORT` (Railway проставит сам).
Railway выдаст вам публичный адрес вида `shuttle.proxy.rlwy.net:15140`.

### 4. Добавьте переменные окружения

В Railway UI → **Service** → **Variables**:

| Переменная | Где взять |
|---|---|
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) |
| `ADMIN_ID` | [@userinfobot](https://t.me/userinfobot) |
| `ONLYSQ_API_KEY` | [my.onlysq.ru](https://my.onlysq.ru/) |

`RAILWAY_TCP_PROXY_DOMAIN`, `RAILWAY_TCP_PROXY_PORT`, `RAILWAY_VOLUME_MOUNT_PATH`, `PORT` — **Railway проставит автоматически**, вписывать не нужно.

### 5. Deploy

```bash
railway up
```

После деплоя:
1. Откройте бота в Telegram → `/start` → `/admin` → 🌐 **Сменить домен** → 🚂 **Авто (Railway TCP-proxy)**. (Бот сам подхватит Railway-домен при первом старте, кнопка нужна только если вы перенастроили TCP-proxy после старта.)
2. Создавайте серверы, выдавайте друзьям адреса вида `myserver.shuttle.proxy.rlwy.net:15140`.

## 🌐 Свой домен (опционально)

Хотите давать игрокам красивый адрес `myserver.mchost.example.com:25600` вместо `*.proxy.rlwy.net`?

1. В Railway: ваш TCP-proxy = `shuttle.proxy.rlwy.net:15140`.
2. В DNS-провайдере создайте **CNAME**:
   - Name: `*.mchost.example.com`
   - Target: `shuttle.proxy.rlwy.net` (без порта!)
3. В Telegram-боте: `/admin` → 🌐 **Сменить домен** → введите `mchost.example.com:15140` (домен с тем же портом, что выдал Railway).
4. ⚠️ **Cloudflare**: проксирование должно быть **отключено** (серое облачко).

## 🐳 Self-host (Docker / VPS)

Если деплоите вне Railway (свой VPS, k8s, etc.) — всё тоже работает:

```bash
docker build -t mc-tg-bot .
docker run -d --name mc-tg-bot \
    -e BOT_TOKEN=... \
    -e ADMIN_ID=... \
    -e ONLYSQ_API_KEY=... \
    -e PROXY_DOMAIN=mc.example.com \
    -e PROXY_PORT=25600 \
    -v mc-data:/data \
    -p 25600:25600/tcp \
    mc-tg-bot
```

Откройте только один порт на VPS — этого достаточно:
```bash
sudo ufw allow 25600/tcp
```

(Или в боте: `/admin` → 🔌 **Авто-открыть порты** — сделает это автоматически.)

## ✨ Возможности (полный список)

- 🧱 Установка серверов Paper / Spigot / Bukkit / Forge с автопарсингом версий
- ▶️ Запуск / остановка прямо из чата с трансляцией консоли
- 📦 Загрузка плагинов и карт по ссылке или прямой загрузкой в Telegram
- 🤖 **AI-распаковка** через OnlySQ: нейросеть решает, куда положить файлы
- 🩺 **AI-диагностика** запуска: модель анализирует логи и подсказывает фиксы
- 🧠 **AI-генерация плагинов и Skript-скриптов** с автокомпиляцией в `.jar`
- 🔐 Контроль доступа: админ из `.env`, остальные через админ-панель
- ⚙️ Админ-панель:
  - выдача / отзыв доступа
  - выбор активной модели OnlySQ
  - публичный IP + адреса всех серверов
  - 🌐 **смена домена реверс-прокси** ← NEW
  - 🔌 **авто-открытие портов** ← NEW
  - 🚂 **Railway статус** ← NEW
  - 📊 нагрузка VPS (CPU / RAM / диск / uptime / RSS каждого MC)
  - 🖥 интерактивная VPS-консоль
  - 🔒 firewall (ufw / iptables) — открыть/закрыть порт
  - ☕ менеджер Java: список найденных JDK + установка Java 8 / 17 / 21
- 🐳 Docker-образ из коробки с Java 8 / 17 / 21

## 📝 Команды

| Команда | Назначение |
|---|---|
| `/start` | Главное меню |
| `/admin` | Админ-панель (только для админа из `ADMIN_ID`) |
| `/myaddr` | Быстрый вывод адресов своих серверов |
| `/java` | Диагностика Java |
| `/cancel` | Отмена текущей операции |

Вся остальная работа — через inline-кнопки.

## 🧩 Поддержка версий Java (важно для Forge)

| Версия Minecraft | Сборка | Рекомендуемая Java |
|---|---|---|
| 1.7.x – 1.12.2 | **Forge** | **Java 8** (обязательно!) |
| 1.13 – 1.16.4 | Forge / Paper / Spigot | Java 8 / 11 |
| 1.16.5 | Forge / Paper | Java 11 |
| 1.17 – 1.20.4 | любая | Java 17 |
| 1.20.5+ | любая | Java 21 |

В Docker-образе всё установлено заранее. На self-host без Docker — бот сам пытается доустановить через `apt` или скачать tarball Adoptium.

## 🔧 Все переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BOT_TOKEN` | — (обяз.) | токен Telegram бота |
| `ADMIN_ID` | — (обяз.) | Telegram ID админа |
| `ONLYSQ_API_KEY` | — (обяз.) | ключ OnlySQ |
| `ONLYSQ_BASE_URL` | `https://api.onlysq.ru/ai/openai` | endpoint OnlySQ |
| `ONLYSQ_DEFAULT_MODEL` | `claude-haiku-4-5` | начальная модель AI |
| `SERVERS_ROOT` | `$RAILWAY_VOLUME_MOUNT_PATH/servers` или `./servers` | папка инстансов |
| `DB_PATH` | `$RAILWAY_VOLUME_MOUNT_PATH/bot.db` или `./data/bot.db` | путь к SQLite |
| `JAVA_BIN` / `JAVAC_BIN` | автоопределение | пути к java/javac |
| `JVM_XMS` / `JVM_XMX` | `512M` / `1G` | heap JVM для серверов |
| `MAX_UPLOAD_MB` | `50` | лимит размера загружаемых файлов |
| `PORT_RANGE_MIN` / `PORT_RANGE_MAX` | `25700` / `26700` | внутренний диапазон портов MC |
| `PROXY_ENABLED` | `1` | вкл/выкл реверс-прокси |
| `PROXY_DOMAIN` | `RAILWAY_TCP_PROXY_DOMAIN` или `mchost.bothost.tech` | публичный домен |
| `PROXY_PORT` | `RAILWAY_TCP_PROXY_PORT` или `25600` | публичный порт |
| `PROXY_LISTEN_PORT` | `RAILWAY_TCP_APPLICATION_PORT` / `PORT` или `PROXY_PORT` | внутренний порт listener'а |
| `PROXY_HOST` | `0.0.0.0` | интерфейс listener'а |
| `BIND_HOST` | `127.0.0.1` | интерфейс MC-серверов |
| `PUBLIC_IP` | автоопределение | принудительный публичный IP |
| `ALLOW_SUDO_INSTALL` | `1` (в Docker) | разрешить ставить пакеты через `sudo -n` |

## 📡 Используемые API

- **OnlySQ** — https://docs.onlysq.ru/ (OpenAI-compatible)
- **PaperMC Fill v3** — https://fill.papermc.io/v3/
- **GetBukkit** — https://getbukkit.org/get/
- **MinecraftForge** — https://files.minecraftforge.net + https://maven.minecraftforge.net
- **Mojang piston-meta** — vanilla server jars
- **Adoptium Temurin** — https://api.adoptium.net/v3/ (автоустановка Java)
- **Spigot Hub** — https://hub.spigotmc.org/nexus/ (компиляция плагинов)

## 🐛 Troubleshooting

**"❌ Сервер «X» не найден на mchost"** — игрок ввёл неверный поддомен, либо у вас в админке стоит старый домен. `/admin` → 🌐 Сменить домен.

**"🔒 Порт XXX: закрыт извне"** на Railway — TCP-proxy не активирован. Service → Settings → Networking → Enable TCP Proxy.

**"Java НЕ НАЙДЕНА"** — на self-host без Docker. `/admin` → ☕ Java / JDK → выберите версию.

**Сервер не запускается, exit code 1** — `/admin` → 📊 Нагрузка VPS — посмотрите RAM. Минимум 1 GB для Paper, 2-3 GB для Forge с модами.

## 📂 Структура проекта

```
mc-tg-bot/
├── bot.js              # весь код бота
├── mcproxy.js          # встроенный Minecraft handshake-router
├── package.json
├── Dockerfile          # multi-JDK image (Temurin 8/17/21)
├── railway.json        # Railway service config
├── railway.toml        # Railway config-as-code (альтернатива)
├── .env.example
├── .dockerignore
├── .gitignore
└── README.md
```

## 📜 License

MIT
