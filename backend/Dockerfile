FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
