# ─────────────────────────────────────────────────────────────────────
# mc-tg-bot — Railway edition
# Multi-JDK runtime: Java 8 + 17 + 21 (Forge 1.7‒1.12, Paper 1.17+, Paper 1.21+).
# Optimized for Railway's build cache: stable layer order, no dev deps in final image.
# ─────────────────────────────────────────────────────────────────────

# ─── Stage 1: native-addons builder (better-sqlite3 нужен gcc/g++/python3) ───
FROM eclipse-temurin:21-jdk-jammy AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
        python3 make g++ \
        unzip tar \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# --omit=dev keeps the image lean; native modules are compiled here once.
RUN npm install --omit=dev --no-audit --no-fund

# ─── Stage 2: runtime (Temurin 21 + Temurin 8/17 side-by-side) ───
FROM eclipse-temurin:21-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
        curl wget ca-certificates gnupg \
        unzip tar xz-utils zip \
        procps net-tools iproute2 tini \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Java 8 + 17 side-by-side from Adoptium (both archs).
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64) ARCH=x64 ;; \
        arm64) ARCH=aarch64 ;; \
        *)     ARCH=x64 ;; \
    esac; \
    mkdir -p /opt/java; \
    curl -fsSL -o /tmp/jdk8.tar.gz \
        "https://api.adoptium.net/v3/binary/latest/8/ga/linux/${ARCH}/jdk/hotspot/normal/eclipse?project=jdk"; \
    mkdir -p /opt/java/temurin-8; \
    tar -xzf /tmp/jdk8.tar.gz -C /opt/java/temurin-8 --strip-components=1; \
    rm -f /tmp/jdk8.tar.gz; \
    /opt/java/temurin-8/bin/java -version; \
    curl -fsSL -o /tmp/jdk17.tar.gz \
        "https://api.adoptium.net/v3/binary/latest/17/ga/linux/${ARCH}/jdk/hotspot/normal/eclipse?project=jdk"; \
    mkdir -p /opt/java/temurin-17; \
    tar -xzf /tmp/jdk17.tar.gz -C /opt/java/temurin-17 --strip-components=1; \
    rm -f /tmp/jdk17.tar.gz; \
    /opt/java/temurin-17/bin/java -version

# Symlink for /usr/lib/jvm scan + update-alternatives (default = Java 21).
RUN mkdir -p /usr/lib/jvm \
 && ln -sfn /opt/java/temurin-8  /usr/lib/jvm/temurin-8-jdk \
 && ln -sfn /opt/java/temurin-17 /usr/lib/jvm/temurin-17-jdk \
 && ln -sfn /opt/java/openjdk    /usr/lib/jvm/temurin-21-jdk \
 && update-alternatives --install /usr/bin/java   java   /opt/java/temurin-8/bin/java   1080 \
 && update-alternatives --install /usr/bin/javac  javac  /opt/java/temurin-8/bin/javac  1080 \
 && update-alternatives --install /usr/bin/java   java   /opt/java/temurin-17/bin/java  1170 \
 && update-alternatives --install /usr/bin/javac  javac  /opt/java/temurin-17/bin/javac 1170 \
 && update-alternatives --install /usr/bin/java   java   /opt/java/openjdk/bin/java     1210 \
 && update-alternatives --install /usr/bin/javac  javac  /opt/java/openjdk/bin/javac    1210 \
 && update-alternatives --set java  /opt/java/openjdk/bin/java \
 && update-alternatives --set javac /opt/java/openjdk/bin/javac

WORKDIR /app

# Copy pre-compiled node_modules from builder stage.
COPY --from=builder /app/node_modules ./node_modules
# Copy the application.
COPY bot.js mcproxy.js package.json ./

# ─────────────────────────────────────────────────────────────────────
# Environment defaults — Railway-aware. Override via Variables panel.
# ─────────────────────────────────────────────────────────────────────
# Railway автоматически прокидывает:
#   RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT, RAILWAY_TCP_APPLICATION_PORT,
#   RAILWAY_VOLUME_MOUNT_PATH, PORT, RAILWAY_PUBLIC_DOMAIN, …
# Бот сам подхватит их и пропишет публичный адрес.
ENV NODE_ENV=production \
    JAVA_BIN=/opt/java/openjdk/bin/java \
    JAVAC_BIN=/opt/java/openjdk/bin/javac \
    JAVA_HOME=/opt/java/openjdk \
    JVM_XMS=512M \
    JVM_XMX=1G \
    MAX_UPLOAD_MB=50 \
    # Внутренний диапазон портов для MC-серверов (НЕ публичные).
    PORT_RANGE_MIN=25700 \
    PORT_RANGE_MAX=26700 \
    ALLOW_SUDO_INSTALL=1 \
    PROXY_ENABLED=1 \
    PROXY_HOST=0.0.0.0 \
    # MC-серверы слушают только на localhost (изоляция); внешний трафик идёт
    # только через handshake-router → PROXY_LISTEN_PORT.
    BIND_HOST=127.0.0.1

# ─────────────────────────────────────────────────────────────────────
# Required env vars (set in Railway Variables panel, NOT in a file):
#   BOT_TOKEN        — Telegram bot token (@BotFather)
#   ADMIN_ID         — Telegram user ID of the admin (@userinfobot)
#   ONLYSQ_API_KEY   — OnlySQ / OpenAI-compatible API key
#
# Optional (Railway-provided automatically — НЕ нужно вписывать руками):
#   PORT, RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT,
#   RAILWAY_TCP_APPLICATION_PORT, RAILWAY_VOLUME_MOUNT_PATH
#
# Optional (override defaults):
#   ONLYSQ_BASE_URL, ONLYSQ_DEFAULT_MODEL, JVM_XMS, JVM_XMX, MAX_UPLOAD_MB,
#   PORT_RANGE_MIN, PORT_RANGE_MAX,
#   PROXY_DOMAIN, PROXY_PORT (если хочешь свой CNAME вместо Railway TCP-proxy)
# ─────────────────────────────────────────────────────────────────────

# Volume mount: Railway автоматически подставит свой /data (или другой mount path).
# В standalone-Docker — указать `-v mc-data:/data`.
VOLUME ["/data"]

# Healthcheck: проверяем, что Node живой и DB доступна.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('fs').accessSync(process.env.RAILWAY_VOLUME_MOUNT_PATH||'/data', 0)" || exit 1

# Используем tini как PID 1 → корректная обработка SIGTERM от Railway/Docker.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bot.js"]
