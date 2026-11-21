FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY database ./database
COPY scripts/docker-entrypoint.js scripts/preparar-aplicacao.js ./scripts/

ENV LISTEN_HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000
CMD ["node", "scripts/docker-entrypoint.js"]
