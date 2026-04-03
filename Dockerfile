FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY . .

EXPOSE 3847

CMD ["bun", "main.ts"]
