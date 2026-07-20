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

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG CLIENT_BASE_PATH=/mails/
ARG VITE_BRIDGE_DOMAIN
ENV CLIENT_BASE_PATH=${CLIENT_BASE_PATH} \
    VITE_BRIDGE_DOMAIN=${VITE_BRIDGE_DOMAIN}
RUN pnpm run build

# ── Runtime stage: copy built assets to the mounted nginx directory on start ──
FROM alpine:latest

COPY --from=builder /app/dist /build-output

CMD ["sh", "-c", "mkdir -p /output && cp -rT /build-output /output && echo 'Deployed landing dist to /output'"]
