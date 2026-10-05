# Build context: repository root
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/db-access/package.json apps/db-access/
RUN npm ci --workspace @ipaas/db-access --omit=dev --no-audit --no-fund
COPY apps/db-access apps/db-access
WORKDIR /app/apps/db-access
ENV NODE_ENV=production PORT=4020
EXPOSE 4020
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4020/health >/dev/null || exit 1
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
