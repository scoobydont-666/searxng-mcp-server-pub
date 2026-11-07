# OCI build; use rootless Buildah or another approved OCI builder, then K3s/containerd.
# Registry index resolved 2026-11-06. Updating it is a reviewed dependency change.
ARG NODE_IMAGE=docker.io/library/node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
USER 1000:1000
EXPOSE 8527 8528
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
