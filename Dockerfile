# agentline hub — the relay both teammates connect to. Stores only ciphertext.
# Mount persistent storage at /data (e.g. a Railway or Fly volume); the DB lives there.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV AGENTLINE_HUB_DB=/data/agentline-hub.db NODE_NO_WARNINGS=1
EXPOSE 8787
CMD ["node", "src/cli.mjs", "hub", "--port", "8787", "--host", "0.0.0.0"]
