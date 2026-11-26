# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app

RUN npm install -g pnpm@10.6.3

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY src ./src

RUN pnpm run build \
  && pnpm prune --prod

FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/server ./server
COPY --from=builder --chown=node:node /app/shared ./shared

RUN mkdir -p /app/data/fish && chown -R node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/tank/view').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./node_modules/.bin/tsx", "server/index.ts"]
