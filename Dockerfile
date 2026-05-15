# ─────────────────────────────────────────────────────────────────────
# Stage 1: Build — install native Node deps (better-sqlite3 needs gcc)
# ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-jammy AS base

# System deps: Node.js 20 LTS + build tools for better-sqlite3
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
        unzip \
        tar \
        python3 \
        make \
        g++ \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Verify java is available (comes from eclipse-temurin base)
RUN java -version

# ─────────────────────────────────────────────────────────────────────
# Stage 2: Install Node deps
# ─────────────────────────────────────────────────────────────────────
WORKDIR /app

# Copy only package files first for layer caching
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev --ignore-scripts=false

# ─────────────────────────────────────────────────────────────────────
# Stage 3: Runtime image
# ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-jammy

# Runtime tools only (no build tools)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        unzip \
        tar \
        nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Re-install Node.js 20 LTS properly in the final stage
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from build stage
COPY --from=base /app/node_modules ./node_modules

# Copy application source
COPY bot.js ./

# Data directories (servers + SQLite db)
RUN mkdir -p /data/servers /data/db

# ─────────────────────────────────────────────────────────────────────
# Environment — all values are injected by the hosting platform.
# DO NOT create a .env file. Set these as environment variables
# in your hosting panel (Railway, Render, VPS, Docker Compose, etc.)
# ─────────────────────────────────────────────────────────────────────
ENV NODE_ENV=production \
    SERVERS_ROOT=/data/servers \
    DB_PATH=/data/db/bot.db \
    JAVA_BIN=/opt/java/openjdk/bin/java \
    JVM_XMS=512M \
    JVM_XMX=1G \
    MAX_UPLOAD_MB=50

# Required at runtime (must be provided by host):
#   BOT_TOKEN, ADMIN_ID, ONLYSQ_API_KEY
# Optional:
#   ONLYSQ_BASE_URL, ONLYSQ_DEFAULT_MODEL, JVM_XMS, JVM_XMX, MAX_UPLOAD_MB

VOLUME ["/data/servers", "/data/db"]

# Healthcheck — make sure the process is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

CMD ["node", "bot.js"]
