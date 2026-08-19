# syntax=docker/dockerfile:1

# Image for the deployed API. Stages so the thing that ships carries neither the compiler
# nor the test toolchain: dependencies, build, production dependencies, runtime.
#
# Alpine is safe even though argon2 is a native module — it ships a musl prebuild, so no
# compiler is needed at install time. `openssl` is for Prisma's schema engine, which runs
# the migrations on start.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
WORKDIR /app
# package.json first so `corepack prepare` reads the pinned `packageManager` version.
# Without the pin corepack installs whatever pnpm is current and the lockfile stops being
# a guarantee.
COPY package.json ./
RUN corepack enable && corepack prepare --activate

# Manifests only, so this layer survives every commit that does not change dependencies.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# prisma.config.ts resolves DIRECT_URL eagerly, so `prisma generate` refuses to start
# without it even though generating a client opens no connection. The value below exists
# to satisfy that check and is deliberately unreachable; the real one is injected by the
# platform at run time. It never reaches the runtime stage.
ENV DIRECT_URL=postgresql://unused:unused@127.0.0.1:1/unused
# The Prisma client is generated into src/generated and compiled with everything else,
# which is why it needs no separate copy below.
RUN pnpm db:generate && pnpm build

# A second, independent install rather than pruning the previous stage in place: pruning
# would leave pnpm's symlink farm pointing at packages it had just removed.
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Deliberately NOT built on `base`: no package manager in the image that serves traffic.
# pnpm 11 verifies that node_modules matches the lockfile before running any script, so
# `pnpm start:prod` here would try to reinstall dependencies on every container start —
# needing the network, and failing outright once the process drops to an unprivileged
# user that cannot write to /app. Both binaries below are invoked directly instead.
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Migrations and the Prisma config are runtime inputs, not build artifacts: the container
# runs `prisma migrate deploy` before it starts serving. package.json comes along because
# Node resolves the "type" field from it when loading dist/.
COPY prisma ./prisma
COPY prisma.config.ts package.json ./

# The base image already provides an unprivileged `node` user, and /app stays root-owned
# and read-only to it: nothing here is written at run time.
USER node

EXPOSE 4000
# Migrations first, and the `&&` matters: if they fail the container must exit rather
# than serve traffic against a schema it does not expect.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
