# Build context: repository root
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/flow-core/package.json packages/flow-core/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @ipaas/web --no-audit --no-fund
COPY packages/flow-core packages/flow-core
COPY apps/web apps/web
RUN npm run build --workspace @ipaas/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
