FROM oven/bun:1 AS base
WORKDIR /app

# Stage 1: Build dashboard
FROM base AS dashboard-build
COPY dashboard/package.json dashboard/bun.lock* ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile
COPY dashboard/ dashboard/
RUN cd dashboard && bun run build

# Stage 1b: Build webapp
FROM base AS webapp-build
COPY dashboard/webapp/package.json dashboard/webapp/bun.lock* ./dashboard/webapp/
RUN cd dashboard/webapp && bun install --frozen-lockfile
COPY dashboard/webapp/ dashboard/webapp/
RUN cd dashboard/webapp && bun run build

# Stage 2: Production
FROM base AS production

ARG KESHA_INSTALL_TTS=false

# Install system deps: git, curl, espeak-ng (required by kesha-engine for ASR + TTS)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates espeak-ng && \
    rm -rf /var/lib/apt/lists/*

# Install kesha-engine binary (linux-x64 only — darwin handled at runtime)
RUN curl -fsSL -o /usr/local/bin/kesha-engine \
      "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.1.3/kesha-engine-linux-x64" && \
    chmod +x /usr/local/bin/kesha-engine

# Bake kesha models BEFORE source copy so this layer is cached across code changes.
# TTS models (~390MB, Kokoro EN + Piper RU) only when KESHA_INSTALL_TTS=true.
RUN mkdir -p /home/bun/.cache && \
    HOME=/home/bun /usr/local/bin/kesha-engine install \
      $([ "$KESHA_INSTALL_TTS" = "true" ] && echo "--tts" || true)

# Install backend dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy backend source
COPY . .

# Copy dashboard build output from stage 1
COPY --from=dashboard-build /app/dashboard/dist dashboard/dist

# Copy webapp build output from stage 1b
COPY --from=webapp-build /app/dashboard/webapp/dist dashboard/webapp/dist

# Ensure downloads dir exists and set permissions
RUN mkdir -p /app/downloads && chown -R bun /app /home/bun/.cache
USER bun

EXPOSE 3847

CMD ["bun", "main.ts"]
