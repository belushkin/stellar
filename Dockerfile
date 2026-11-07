FROM node:22.12.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=optional

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY .env.example README.md ./

RUN chown node:node /app && mkdir -p /app/data && chown node:node /app/data
ENV STELLAR_DATABASE_PATH=/app/data/stellar-scanner.sqlite

USER node

CMD ["npm", "start"]
