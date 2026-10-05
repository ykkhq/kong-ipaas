# Build context: repository root
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/flow-core/package.json packages/flow-core/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @ipaas/api --omit=dev --no-audit --no-fund
COPY packages/flow-core packages/flow-core
COPY apps/api apps/api
WORKDIR /app/apps/api
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
