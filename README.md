# 🟩 Minecraft Server Telegram Bot

Production-ready Telegram bot для управления Minecraft-серверами (**Bukkit / Spigot / Paper**) с интеграцией нейросетей через **OnlySQ API** (Claude / GPT / Gemini и др.).

## ✨ Возможности

- 🧱 **Установка серверов** Paper / Spigot / Bukkit с автоматическим парсингом доступных версий
- ▶️ **Запуск / остановка** серверов прямо из чата с трансляцией консоли
- 📦 **Загрузка плагинов и карт** по ссылке или прямой загрузкой файла в Telegram
- 🤖 **AI-распаковка** через OnlySQ: нейросеть анализирует архивы и сама решает, куда положить файлы (`plugins/`, `world/`, и т. д.)
- 🩺 **AI-диагностика** запуска: модель анализирует логи и подсказывает, как исправить проблемы
- 🔐 **Контроль доступа**: по умолчанию доступен только админу из `.env`, остальные пользователи добавляются через админ-панель
- ⚙️ **Админ-панель**: выдача/отзыв доступа, выбор активной модели OnlySQ из списка `/v1/models`

## 🚀 Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Установить Java (нужен JDK 17+ для современных версий Minecraft)
sudo apt install -y openjdk-21-jre-headless

# 3. Создать .env
cp .env.example .env
nano .env   # вписать BOT_TOKEN, ADMIN_ID, ONLYSQ_API_KEY

# 4. Запустить
npm start
```

## 🗄 Структура

```
mc-tg-bot/
├── bot.js              # ← весь код в одном файле
├── package.json
├── .env.example
├── data/bot.db         # SQLite (создаётся автоматически)
└── servers/<id>/       # инстансы серверов (создаются автоматически)
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

## 📝 Команды

| Команда | Назначение |
|---|---|
| `/start` | Главное меню |
| `/admin` | Админ-панель (только для админа) |
| `/cancel` | Отмена текущей операции |

Вся остальная работа — через inline-кнопки.
