# Admin service image (ghcr.io/app-vitals/agent-admin)
#
# Build from the repository root:  docker build -f admin/Dockerfile .

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS deps

WORKDIR /app

COPY package.json bunfig.toml bun.lock* ./
COPY admin/package.json ./admin/
COPY admin/prisma ./admin/prisma/
COPY admin/prisma.config.ts ./admin/
COPY runtime/package.json ./runtime/
COPY lib/package.json ./lib/
COPY patches/ ./patches/

# --production: devDependencies (semantic-release's nested npm, typescript's native
# tsc) never reach the shipped node_modules.
# typescript is only an optional peer of prisma / @prisma/client, but bun still
# links it (and its native tsc binary) into the store because the lockfile
# carries it; nothing at runtime loads it, so drop it.
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile --production; else bun install --production; fi \
    && rm -rf node_modules/.bun/typescript@* node_modules/.bun/@typescript+* \
              node_modules/.bun/node_modules/typescript node_modules/.bun/node_modules/@typescript

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS production

# Upgrade apt/libapt-pkg7.0 past the base image's 3.0.3 (Trivy HIGH CVE-2026-109518, fixed in 3.0.4).
RUN apt-get update \
    && apt-get install -y --only-upgrade apt libapt-pkg7.0 \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/admin/node_modules ./admin/node_modules
COPY --from=deps /app/lib/node_modules ./lib/node_modules

# .dockerignore keeps node_modules, .git and build output out of the context.
COPY . .

# The generated Prisma client is not committed. prisma is a root runtime
# dependency, so run the lockfile-pinned CLI from node_modules (no bunx download).
RUN cd admin && ../node_modules/.bin/prisma generate --schema=prisma/schema

EXPOSE 3000

USER 1000

ENTRYPOINT ["bun", "run", "admin/src/main.ts"]
