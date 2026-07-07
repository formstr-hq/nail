# Builds the mailstr.app landing page and, on container run, copies the
# static dist to /output (bind-mount the directory your nginx serves).
#
# Build args (baked into the bundle by Vite):
#   VITE_API_BASE_URL   formstr-backend origin (default https://api.formstr.app)
#   VITE_WS_BASE_URL    formstr-backend websocket origin (default wss://api.formstr.app)
#   VITE_MAIL_DOMAIN    address domain (default mailstr.app)
#   VITE_MAILS_URL      where the mail UI lives (default /mails)

FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@10.15.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG VITE_API_BASE_URL
ARG VITE_WS_BASE_URL
ARG VITE_MAIL_DOMAIN
ARG VITE_MAILS_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_WS_BASE_URL=${VITE_WS_BASE_URL} \
    VITE_MAIL_DOMAIN=${VITE_MAIL_DOMAIN} \
    VITE_MAILS_URL=${VITE_MAILS_URL}

RUN pnpm run build

# ── Runtime stage: copy built assets to the mounted nginx directory on start ──
FROM alpine:latest

COPY --from=builder /app/dist /build-output

CMD ["sh", "-c", "mkdir -p /output && cp -rT /build-output /output && echo 'Deployed landing dist to /output'"]
