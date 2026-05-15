# 🟩 Minecraft Server Telegram Bot

Production-ready Telegram bot для управления Minecraft-серверами (**Bukkit / Spigot / Paper / Forge**) с интеграцией нейросетей через **OnlySQ API** (Claude / GPT / Gemini и др.).

## ✨ Возможности

- 🧱 **Установка серверов** Paper / Spigot / Bukkit / **Forge** с автоматическим парсингом доступных версий
- ▶️ **Запуск / остановка** серверов прямо из чата с трансляцией консоли
- 📦 **Загрузка плагинов и карт** по ссылке или прямой загрузкой файла в Telegram
- 🤖 **AI-распаковка** через OnlySQ: нейросеть анализирует архивы и сама решает, куда положить файлы (`plugins/`, `world/`, и т. д.)
- 🩺 **AI-диагностика** запуска: модель анализирует логи и подсказывает, как исправить проблемы
- 🧠 **AI-генерация плагинов и Skript-скриптов** с автокомпиляцией в `.jar` (paper-api / spigot-api / bukkit-api автоматически подкачиваются из Maven)
- 🔐 **Контроль доступа**: по умолчанию доступен только админу из `.env`, остальные пользователи добавляются через админ-панель
- ⚙️ **Админ-панель**:
  - выдача / отзыв доступа,
  - выбор активной модели OnlySQ из списка `/v1/models`,
  - публичный IP + адреса всех серверов,
  - **📊 нагрузка VPS** (CPU / RAM / диск / uptime / RSS каждого MC-сервера),
  - **☕ менеджер Java**: список найденных JDK и одно-кликовая доустановка Java 8 / 17 / 21
- 🛠 **Автоустановка зависимостей**:
  - При старте бот сам проверяет наличие `unzip`, `tar`, `curl`, `wget`, `gpg`.
  - При создании Forge-сервера 1.12.2 (или любой версии, требующей Java 8) бот **сам ставит Java 8** через apt-репозиторий Adoptium Temurin, а если apt недоступен — скачивает официальный tarball Adoptium и распаковывает в `/opt/java/temurin-8` (или `~/.local/java`).
  - При генерации Java-плагина бот сам ставит JDK, если `javac` отсутствует.
- 🐳 **Docker-образ из коробки с Java 8 / 17 / 21** — никакой конфигурации не требуется.

## 🚀 Быстрый старт (без Docker)

```bash
# 1. Установить зависимости
npm install

# 2. Создать .env
cp .env.example .env
nano .env   # вписать BOT_TOKEN, ADMIN_ID, ONLYSQ_API_KEY

# 3. Запустить — недостающую Java бот доустановит сам (если есть root/sudo)
sudo ALLOW_SUDO_INSTALL=1 npm start
```

## 🐳 Запуск в Docker

```bash
docker build -t mc-tg-bot .
docker run -d --name mc-tg-bot \
    -e BOT_TOKEN=... \
    -e ADMIN_ID=... \
    -e ONLYSQ_API_KEY=... \
    -v mc-data:/data \
    -p 25600-26600:25600-26600/tcp \
    -p 25600-26600:25600-26600/udp \
    mc-tg-bot
```

Образ уже содержит JDK 8 / 17 / 21 + Node.js 20 + всё нужное для Forge.

## 🗄 Структура

```
mc-tg-bot/
├── bot.js              # ← весь код в одном файле
├── package.json
├── Dockerfile          # multi-JDK image (Temurin 8/17/21)
├── .env.example
├── data/bot.db         # SQLite (создаётся автоматически)
└── servers/<id>/       # инстансы серверов
    └── _api_cache/     # кеш paper-api/spigot-api/bukkit jar для компиляции плагинов
```

## 🔐 Получение токенов

| Что | Где взять |
|---|---|
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) |
| `ADMIN_ID` | [@userinfobot](https://t.me/userinfobot) |
| `ONLYSQ_API_KEY` | [my.onlysq.ru](https://my.onlysq.ru/) |

## 📡 Используемые API

- **OnlySQ** — https://docs.onlysq.ru/ (OpenAI-compatible)
- **PaperMC Fill v3** — https://fill.papermc.io/v3/
- **GetBukkit** — https://getbukkit.org/get/
- **MinecraftForge** — https://files.minecraftforge.net + https://maven.minecraftforge.net
- **Mojang piston-meta** — для vanilla `minecraft_server.<ver>.jar`
- **Adoptium Temurin** — https://api.adoptium.net/v3/ (автоустановка Java)
- **Spigot Hub** — https://hub.spigotmc.org/nexus/ (spigot/bukkit API для компиляции плагинов)

## 📝 Команды

| Команда | Назначение |
|---|---|
| `/start` | Главное меню |
| `/admin` | Админ-панель (только для админа) |
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

Если нужной Java нет — бот пытается доставить её сам через apt (Adoptium repo) или, если не получилось, скачивает официальный tarball Adoptium Temurin.

## 🔧 Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BOT_TOKEN` | — (обяз.) | токен Telegram бота |
| `ADMIN_ID` | — (обяз.) | Telegram ID админа |
| `ONLYSQ_API_KEY` | — (обяз.) | ключ OnlySQ |
| `ONLYSQ_BASE_URL` | `https://api.onlysq.ru/ai/openai` | endpoint OnlySQ |
| `ONLYSQ_DEFAULT_MODEL` | `claude-haiku-4-5` | начальная модель AI |
| `SERVERS_ROOT` | `./servers` | корневая папка инстансов |
| `JAVA_BIN` | автоопределение | путь к java |
| `JAVAC_BIN` | автоопределение | путь к javac |
| `JVM_XMS` / `JVM_XMX` | `1G` / `2G` | heap JVM для серверов |
| `MAX_UPLOAD_MB` | `50` | лимит размера загружаемых файлов |
| `PORT_RANGE_MIN` / `PORT_RANGE_MAX` | `25600` / `26600` | диапазон портов для серверов |
| `PUBLIC_IP` | автоопределение | принудительный публичный IP |
| `ALLOW_SUDO_INSTALL` | (пусто) | разрешить бот ставить пакеты через `sudo -n` |
