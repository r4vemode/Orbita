# Refresh the digest in a reviewed release and rerun the deployment checks.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ORBITA_DATA_DIR=/var/lib/orbita
WORKDIR /app

# The server uses only Node built-ins. Browser QA dependencies and the personal
# local-admin installer are deliberately absent from the runtime image.
COPY --chown=node:node package.json package-lock.json server.mjs ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node fixtures/ ./fixtures/
COPY --chown=node:node scripts/preflight.mjs scripts/manage-access.mjs scripts/backup.mjs ./scripts/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
