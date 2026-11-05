# Chat service image (ghcr.io/app-vitals/agent-chat)
#
# Build from the repository root:  docker build -f chat/Dockerfile .
#
# Run:
#   docker run -e DATABASE_URL_SHIPWRIGHT_CHAT=postgres://... -p 3000:3000 agent-chat

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS deps

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

# --production: devDependencies (semantic-release's nested npm, typescript's native
# tsc) never reach the shipped node_modules. --ignore-scripts: chat's postinstall
# (prisma generate) runs below, after the source is in place; the other
# workspaces' scripts are not needed here.
# typescript is only an optional peer of prisma / @prisma/client, but bun still
# links it (and its native tsc binary) into the store because the lockfile
# carries it; nothing at runtime loads it, so drop it.
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile --production --ignore-scripts; else bun install --production --ignore-scripts; fi \
    && rm -rf node_modules/.bun/typescript@* node_modules/.bun/@typescript+* \
              node_modules/.bun/node_modules/typescript node_modules/.bun/node_modules/@typescript

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS production

# Upgrade apt/libapt-pkg7.0 past the base image's 3.0.3 (Trivy HIGH CVE-2026-109518, fixed in 3.0.4).
RUN apt-get update \
    && apt-get install -y --only-upgrade apt libapt-pkg7.0 \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/chat/node_modules ./chat/node_modules
COPY --from=deps /app/lib/node_modules ./lib/node_modules

# Only what chat needs: its own source and the shared lib it imports.
COPY package.json bunfig.toml tsconfig.json ./
COPY lib ./lib
COPY chat ./chat

# The generated Prisma client is not committed. prisma is a root runtime
# dependency, so run the lockfile-pinned CLI from node_modules (no bunx download).
RUN cd chat && ../node_modules/.bin/prisma generate --schema=prisma/schema.prisma

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
