# Lap by Lap – konténer-image (Northflank / bármely Docker-host)
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# A /data-ra tartós volume kerül (tokenek, gyorsítótár, fotók, könyvek).
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
