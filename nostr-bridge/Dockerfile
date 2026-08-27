FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10 --quiet
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10 --quiet
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=build /app/dist ./dist
# Polls the app-level receive-path health (real gift-wrap round-trip), not just
# a TCP connect to LMTP — the LMTP port stays open even when every relay socket
# is dead. The watchdog inside the process does the actual self-healing (exit →
# restart); this check only surfaces status to orchestrators.
HEALTHCHECK --interval=60s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://localhost:2510/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
