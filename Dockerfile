# syntax=docker/dockerfile:1

# Build the dashboard only when asked. Dockerfile has no conditionals, so the
# choice is made by aliasing a stage name: BuildKit builds only the stage that
# `dashboard-build` actually resolves to, which means WITH_DASHBOARD=false skips
# the expensive builds entirely rather than building and discarding them.
#
# This is not about image size — the compiled dashboard is ~1 MB. It is about
# memory: `bun run build` for the webapp is the step that OOMs on a small host.
# Measured: the full build fails at 512 MB and succeeds at 256 MB without it.
#
# This ARG must stay above the first FROM: declared after one, it becomes
# stage-scoped and cannot be interpolated into a FROM line.
ARG WITH_DASHBOARD=false

FROM oven/bun:1 AS base
WORKDIR /app

# --- dashboard: enabled ---
FROM base AS dashboard-build-true
COPY dashboard/package.json dashboard/bun.lock* ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile
COPY dashboard/ dashboard/
RUN cd dashboard && bun run build

FROM base AS webapp-build-true
COPY dashboard/webapp/package.json dashboard/webapp/bun.lock* ./dashboard/webapp/
RUN cd dashboard/webapp && bun install --frozen-lockfile
COPY dashboard/webapp/ dashboard/webapp/
RUN cd dashboard/webapp && bun run build

# --- dashboard: disabled — empty dirs so the COPY below still resolves ---
FROM base AS dashboard-build-false
RUN mkdir -p /app/dashboard/dist

FROM base AS webapp-build-false
RUN mkdir -p /app/dashboard/webapp/dist

# --- select ---
FROM dashboard-build-${WITH_DASHBOARD} AS dashboard-build
FROM webapp-build-${WITH_DASHBOARD} AS webapp-build

# --- production ---
FROM base AS production

# System deps (root).
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Hand /app and the bun cache to the runtime user *before* anything large is
# written, then drop privileges. Everything below is created already-owned, so
# no recursive chown is ever needed.
#
# The previous `RUN … chown -R bun /app` cost 905 MB — a third of the image —
# because chown -R rewrites every file it touches into a new layer, duplicating
# everything copied above it.
RUN mkdir -p /app /app/downloads /home/bun/.cache && \
    chown bun:bun /app /app/downloads /home/bun/.cache
USER bun

# Backend dependencies.
COPY --chown=bun:bun package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Backend source.
#
# This also brings in `piper/piper/` — the local TTS runtime (52 MB: piper
# binary, ONNX Runtime, espeak-ng, phonemizer). That is deliberate: the runtime
# is platform-matched to this image and a user has no other way to obtain it.
# `piper/voices/` is excluded in .dockerignore — voices are a per-user choice
# downloaded at setup and bind-mounted, not 181 MB shipped to everyone.
# Keep both facts in mind before narrowing this COPY.
COPY --chown=bun:bun . .

# Dashboard build output (empty dirs when WITH_DASHBOARD=false).
COPY --from=dashboard-build --chown=bun:bun /app/dashboard/dist dashboard/dist
COPY --from=webapp-build --chown=bun:bun /app/dashboard/webapp/dist dashboard/webapp/dist

EXPOSE 3847

CMD ["bun", "main.ts"]
