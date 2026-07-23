# GW2 crafting-ROI bot. Bun runtime (pg is pure-JS, no native build).
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY data ./data
USER bun
ENTRYPOINT ["bun", "run", "src/index.ts"]
