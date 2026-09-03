FROM node:24-alpine
WORKDIR /app

# Install production dependencies (pg) with the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY server.js index.html ./

# SQLite fallback data dir (used only when DATABASE_URL is not set)
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
