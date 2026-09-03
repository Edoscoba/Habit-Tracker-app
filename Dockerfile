FROM node:24-alpine
WORKDIR /app
COPY package.json server.js index.html ./
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
