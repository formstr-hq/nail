FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@10.15.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG CLIENT_BASE_PATH=/mails/
ENV CLIENT_BASE_PATH=${CLIENT_BASE_PATH}
RUN pnpm run build

# ── Runtime stage: copy built assets to the mounted nginx directory on start ──
FROM alpine:latest

COPY --from=builder /app/dist /build-output

CMD ["sh", "-c", "mkdir -p /output && cp -rT /build-output /output && echo 'Deployed landing dist to /output'"]
