FROM node:20-alpine
WORKDIR /app
COPY package.json server.js index.html ./
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
