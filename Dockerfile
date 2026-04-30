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

# Install system deps: git, curl, ca-certificates.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install backend dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy backend source
COPY . .

# Copy dashboard build output from stage 1
COPY --from=dashboard-build /app/dashboard/dist dashboard/dist

# Copy webapp build output from stage 1b
COPY --from=webapp-build /app/dashboard/webapp/dist dashboard/webapp/dist

# Ensure downloads dir + bun cache dir exist and set permissions
RUN mkdir -p /app/downloads /home/bun/.cache && chown -R bun /app /home/bun/.cache
USER bun

EXPOSE 3847

CMD ["bun", "main.ts"]
