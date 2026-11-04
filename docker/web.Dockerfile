# React frontend: built with Node, served by an unprivileged nginx that forwards /api to the backend.
FROM node:24.3.0-bookworm-slim@sha256:8225b1806c6e37dced949224b5c0d8278a2fe593967288620e0af69b2cbc4539 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace apps/web
COPY apps/web apps/web
RUN npm run build --workspace apps/web

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
