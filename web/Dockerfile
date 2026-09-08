# Builds the merged mailstr.app frontend (prerendered landing + mail app) and,
# on container run, copies the static dist to /output (bind-mount the directory
# your nginx serves).
#
# Build args (baked into the bundle by Vite):
#   VITE_API_BASE_URL   formstr-backend origin (default https://api.formstr.app)
#   VITE_WS_BASE_URL    formstr-backend websocket origin (default wss://api.formstr.app)
#   VITE_API_CANONICAL_BASE_URL  origin the mail app signs into NIP-98 `u` tags
#   VITE_MAIL_DOMAIN    address domain (default mailstr.app)
#   VITE_MAILS_URL      where the mail UI lives (default /mails)

# Build context is the REPO ROOT, not web/ — the app imports the shared wire
# protocol from nostr-bridge, which must therefore be inside the context.
# docker-compose.yml sets `context: .` with `dockerfile: web/Dockerfile`.

FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@10.15.0 --activate

# Workspace root: the lockfile owns dependency resolution for the whole
# workspace, so it must be in place before the filtered install.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter mailstr-web

COPY web/ web/

# Must land at /nostr-bridge so that ../nostr-bridge/src/protocol resolves
# from the web/ working directory, matching the vite + tsconfig aliases.
COPY nostr-bridge/src/protocol/ /nostr-bridge/src/protocol/

# The protocol sources import nostr-tools (and their .test.ts files import
# vitest). Because they sit at /nostr-bridge — a sibling of /app — TypeScript's
# upward node_modules lookup never reaches /app/node_modules. Point it there so
# these already-installed web deps resolve during `tsc -b`.
RUN ln -s /app/node_modules /nostr-bridge/node_modules

ARG VITE_API_BASE_URL
ARG VITE_WS_BASE_URL
ARG VITE_API_CANONICAL_BASE_URL
ARG VITE_MAIL_DOMAIN
ARG VITE_MAILS_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_WS_BASE_URL=${VITE_WS_BASE_URL} \
    VITE_API_CANONICAL_BASE_URL=${VITE_API_CANONICAL_BASE_URL} \
    VITE_MAIL_DOMAIN=${VITE_MAIL_DOMAIN} \
    VITE_MAILS_URL=${VITE_MAILS_URL}

RUN cd web && pnpm run build

# ── Runtime stage: copy built assets to the mounted nginx directory on start ──
FROM alpine:latest

COPY --from=builder /app/web/dist /build-output

CMD ["sh", "-c", "mkdir -p /output && cp -rT /build-output /output && echo 'Deployed web dist to /output'"]