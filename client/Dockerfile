# Builds the mailstr.app mail client and, on container run, copies the static
# dist to /output (bind-mount the directory your nginx serves).
#
# Build args (baked into the bundle by Vite):
#   VITE_BRIDGE_DOMAIN  outbound bridge domain (default mailstr.app)
#   CLIENT_BASE_PATH    where the mail UI is served from (default /mails/)

FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@10.15.0 --activate

# Build context is the REPO ROOT, not client/ — the client imports the shared
# wire protocol from nostr-bridge, which must therefore be inside the context.
# docker-compose.yml sets `context: .` with `dockerfile: client/Dockerfile`.
COPY client/package.json client/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY client/ ./

# Must land at /nostr-bridge so that ../nostr-bridge/src/protocol resolves
# from the /app working directory, matching the vite + tsconfig aliases.
COPY nostr-bridge/src/protocol/ /nostr-bridge/src/protocol/

ARG CLIENT_BASE_PATH=/mails/
ARG VITE_BRIDGE_DOMAIN
ENV CLIENT_BASE_PATH=${CLIENT_BASE_PATH} \
    VITE_BRIDGE_DOMAIN=${VITE_BRIDGE_DOMAIN}
RUN pnpm run build

# ── Runtime stage: copy built assets to the mounted nginx directory on start ──
FROM alpine:latest

COPY --from=builder /app/dist /build-output

CMD ["sh", "-c", "mkdir -p /output && cp -rT /build-output /output && echo 'Deployed landing dist to /output'"]
