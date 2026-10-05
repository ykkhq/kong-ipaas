# Build context: repository root
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mocks/package.json apps/mocks/
RUN npm ci --workspace @ipaas/mocks --omit=dev --no-audit --no-fund
COPY apps/mocks apps/mocks
WORKDIR /app/apps/mocks
ENV PORT=4010
EXPOSE 4010
CMD ["node", "src/server.js"]
