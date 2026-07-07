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
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('net').connect(2400,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
