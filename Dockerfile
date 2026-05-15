# ─────────────────────────────────────────────────────────────────────
# Stage 1: Build — compile native addons (better-sqlite3 needs gcc/g++)
# ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-jammy AS builder

# Install Node.js 20 LTS + build tools
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
        python3 make g++ \
        unzip tar \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json (no lock file required — npm install generates one)
COPY package.json ./

# npm install works with or without package-lock.json
RUN npm install --omit=dev --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────
# Stage 2: Runtime — slim image with Java + Node, no build tools
# ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-jammy

# Install Node.js 20 LTS (runtime only, no gcc/g++)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates \
        unzip tar \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Verify Java is present
RUN java -version

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
    JVM_XMS=512M \
    JVM_XMX=1G \
    MAX_UPLOAD_MB=50

# Required env vars (set in hosting panel, NOT in a file):
#   BOT_TOKEN        — Telegram bot token
#   ADMIN_ID         — Telegram user ID of the admin
#   ONLYSQ_API_KEY   — OnlySQ / OpenAI-compatible API key
# Optional:
#   ONLYSQ_BASE_URL, ONLYSQ_DEFAULT_MODEL, JVM_XMS, JVM_XMX, MAX_UPLOAD_MB

VOLUME ["/data/servers", "/data/db"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

CMD ["node", "bot.js"]
