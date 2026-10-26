# Chat service image (ghcr.io/app-vitals/agent-chat)
#
# Build from the repository root:  docker build -f chat/Dockerfile .
#
# Run:
#   docker run -e DATABASE_URL_SHIPWRIGHT_CHAT=postgres://... -p 3000:3000 agent-chat

FROM oven/bun:1-slim AS deps

WORKDIR /app

# Every workspace manifest is needed so the frozen lockfile resolves; only the
# manifests are copied, so runtime/admin source never reaches this image.
COPY package.json bunfig.toml bun.lock* ./
COPY chat/package.json ./chat/
COPY chat/prisma ./chat/prisma/
COPY chat/prisma.config.ts ./chat/
COPY lib/package.json ./lib/
COPY runtime/package.json ./runtime/
COPY admin/package.json ./admin/
COPY patches/ ./patches/

# --ignore-scripts: chat's postinstall (prisma generate) runs below, after the
# source is in place; the other workspaces' scripts are not needed here.
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile --ignore-scripts; else bun install --ignore-scripts; fi

FROM oven/bun:1-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/chat/node_modules ./chat/node_modules
COPY --from=deps /app/lib/node_modules ./lib/node_modules

# Only what chat needs: its own source and the shared lib it imports.
COPY package.json bunfig.toml ./
COPY lib ./lib
COPY chat ./chat

# The generated Prisma client is not committed.
RUN cd chat && bunx prisma generate --schema=prisma/schema.prisma

# Module-resolution guard: bundle every chat source file as its own entry point
# so an unresolvable import (e.g. a missing @app-vitals/agent-lib subpath) fails
# the build itself rather than crash-looping after the image ships. Tests and
# test fakes are not shipped code paths and are skipped.
RUN find chat/src -name "*.ts" ! -name "*.test.ts" ! -name "test-fakes.ts" \
    | xargs bun build --target=bun --outdir=/tmp/module-check \
    && rm -rf /tmp/module-check

EXPOSE 3000

# Numeric UID so the kubelet can verify runAsNonRoot (uid 1000 is the `bun`
# user in the oven/bun base image).
USER 1000

ENTRYPOINT ["bun", "run", "chat/src/main.ts"]
