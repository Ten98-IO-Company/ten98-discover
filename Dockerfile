# Digests verified in the local foundation build; update with a tested dependency refresh.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
# Fixed pnpm for build tooling only.
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build \
 && pnpm prune --prod

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Runtime needs only: build output, server TS sources (Node 24 native type
# stripping, server files only / no JSX), SQL migrations, manifest, pruned deps.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/src/server ./src/server
COPY --from=build --chown=node:node /app/migrations ./migrations
RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node
EXPOSE 3000
# No installs at startup; no image HEALTHCHECK (Compose defines them).
CMD ["node", ".output/server/index.mjs"]
