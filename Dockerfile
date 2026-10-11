# agentline hub — the relay both teammates connect to. Stores only ciphertext.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV AGENTLINE_HUB_DB=/data/agentline-hub.db NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8787
CMD ["node", "src/cli.mjs", "hub", "--port", "8787", "--host", "0.0.0.0"]
