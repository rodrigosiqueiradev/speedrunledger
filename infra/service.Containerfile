# Builds one workspace package into a small runtime image. From the repo root:
#   podman build --build-arg PACKAGE=indexer -f infra/service.Containerfile .
FROM docker.io/library/node:22-bookworm-slim AS build
ARG PACKAGE
# Only set by scripts/podman-build.sh when building behind a TLS-intercepting proxy.
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_cafile
RUN npm install -g pnpm@10.28.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@speedrunledger/${PACKAGE}..." build \
 && pnpm --filter "@speedrunledger/${PACKAGE}" deploy --legacy --prod /out

FROM docker.io/library/node:22-bookworm-slim
WORKDIR /app
COPY --from=build /out ./
ENV NODE_ENV=production
USER node
CMD ["node", "--enable-source-maps", "dist/bin.js"]
