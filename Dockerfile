FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY token-proxy.js db.js index.js voice-stream.js browser-proxy.js ./
COPY scripts/ ./scripts/

# SQLite DB is persisted via volume at /app/data
RUN mkdir -p data

EXPOSE 9800 9801

CMD ["node", "token-proxy.js"]
