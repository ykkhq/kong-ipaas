# Build context: repository root
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/edi-gateway/package.json apps/edi-gateway/
RUN npm ci --workspace @ipaas/edi-gateway --omit=dev --no-audit --no-fund
COPY apps/edi-gateway apps/edi-gateway
WORKDIR /app/apps/edi-gateway
ENV NODE_ENV=production
# 4100 admin/internal API, 4080 AS2, 2222 SFTP
EXPOSE 4100 4080 2222
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
