# ─────────────────────────────────────────────────────────────────────
# mc-tg-bot — Minecraft Server Telegram Bot
# Multi-JDK runtime so we can launch ANY Minecraft version out of the box:
#   • Java  8  → Forge 1.7.x .. 1.12.2, legacy Bukkit/Spigot
#   • Java 17  → Paper/Spigot 1.17 .. 1.20.4, Forge 1.18 .. 1.20.4
#   • Java 21  → Paper/Spigot/Forge 1.20.5+ AND default for the bot itself
#                + javac/jar for the AI plugin generator
# ─────────────────────────────────────────────────────────────────────
#
# Stage 1: build native node addons (better-sqlite3 needs gcc/g++/python3)
# ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jdk-jammy AS builder

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
        python3 make g++ \
        unzip tar \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────
# Stage 2: runtime — Temurin 21 JDK + side-by-side Temurin 8 / 17
# ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jdk-jammy

# Tools needed by the bot at runtime
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl wget ca-certificates gnupg \
        unzip tar xz-utils zip \
        procps net-tools iproute2 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────────────
# Install Temurin 8 + 17 side-by-side under /opt/java/temurin-{8,17}
# Adoptium provides static tarballs that work on every glibc-based distro.
# This avoids the "openjdk-8-jre-headless: no installation candidate"
# problem on Ubuntu 22.04 (jammy), where OpenJDK 8 was dropped.
# ─────────────────────────────────────────────────────────────────────
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64) ARCH=x64 ;; \
        arm64) ARCH=aarch64 ;; \
        *)     ARCH=x64 ;; \
    esac; \
    mkdir -p /opt/java; \
    # Java 8  (Temurin 8u422)
    curl -fsSL -o /tmp/jdk8.tar.gz \
        "https://api.adoptium.net/v3/binary/latest/8/ga/linux/${ARCH}/jdk/hotspot/normal/eclipse?project=jdk"; \
    mkdir -p /opt/java/temurin-8; \
    tar -xzf /tmp/jdk8.tar.gz -C /opt/java/temurin-8 --strip-components=1; \
    rm -f /tmp/jdk8.tar.gz; \
    /opt/java/temurin-8/bin/java -version; \
    # Java 17 (Temurin 17 LTS)
    curl -fsSL -o /tmp/jdk17.tar.gz \
        "https://api.adoptium.net/v3/binary/latest/17/ga/linux/${ARCH}/jdk/hotspot/normal/eclipse?project=jdk"; \
    mkdir -p /opt/java/temurin-17; \
    tar -xzf /tmp/jdk17.tar.gz -C /opt/java/temurin-17 --strip-components=1; \
    rm -f /tmp/jdk17.tar.gz; \
    /opt/java/temurin-17/bin/java -version

# Register every JDK with `update-alternatives` so `which java` works
# AND so the bot's /usr/lib/jvm/* scan picks them all up.
RUN mkdir -p /usr/lib/jvm && \
    ln -sfn /opt/java/temurin-8  /usr/lib/jvm/temurin-8-jdk && \
    ln -sfn /opt/java/temurin-17 /usr/lib/jvm/temurin-17-jdk && \
    ln -sfn /opt/java/openjdk    /usr/lib/jvm/temurin-21-jdk && \
    update-alternatives --install /usr/bin/java   java   /opt/java/temurin-8/bin/java   1080 && \
    update-alternatives --install /usr/bin/javac  javac  /opt/java/temurin-8/bin/javac  1080 && \
    update-alternatives --install /usr/bin/java   java   /opt/java/temurin-17/bin/java  1170 && \
    update-alternatives --install /usr/bin/javac  javac  /opt/java/temurin-17/bin/javac 1170 && \
    update-alternatives --install /usr/bin/java   java   /opt/java/openjdk/bin/java     1210 && \
    update-alternatives --install /usr/bin/javac  javac  /opt/java/openjdk/bin/javac    1210 && \
    update-alternatives --set java  /opt/java/openjdk/bin/java && \
    update-alternatives --set javac /opt/java/openjdk/bin/javac

# Sanity-check all three JDKs at build time.
RUN /opt/java/temurin-8/bin/java -version && \
    /opt/java/temurin-17/bin/java -version && \
    java -version && javac -version && jar --version

WORKDIR /app

# Copy compiled node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application
COPY bot.js ./

# Persistent data directories
RUN mkdir -p /data/servers /data/db

# ─────────────────────────────────────────────────────────────────────
# Environment defaults — override via your hosting panel.
# DO NOT create a .env file; all vars come from the host environment.
# ─────────────────────────────────────────────────────────────────────
ENV NODE_ENV=production \
    SERVERS_ROOT=/data/servers \
    DB_PATH=/data/db/bot.db \
    JAVA_BIN=/opt/java/openjdk/bin/java \
    JAVAC_BIN=/opt/java/openjdk/bin/javac \
    JAVA_HOME=/opt/java/openjdk \
    JVM_XMS=512M \
    JVM_XMX=1G \
    MAX_UPLOAD_MB=50 \
    PORT_RANGE_MIN=25600 \
    PORT_RANGE_MAX=26600 \
    ALLOW_SUDO_INSTALL=1

# Required env vars (set in hosting panel, NOT in a file):
#   BOT_TOKEN        — Telegram bot token
#   ADMIN_ID         — Telegram user ID of the admin
#   ONLYSQ_API_KEY   — OnlySQ / OpenAI-compatible API key
# Optional:
#   ONLYSQ_BASE_URL, ONLYSQ_DEFAULT_MODEL, JVM_XMS, JVM_XMX, MAX_UPLOAD_MB,
#   PORT_RANGE_MIN, PORT_RANGE_MAX, PUBLIC_IP (force-override)

VOLUME ["/data/servers", "/data/db"]

# Expose the auto-allocated port range so the hosting panel can map it.
EXPOSE 25600-26600/tcp 25600-26600/udp

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

CMD ["node", "bot.js"]
