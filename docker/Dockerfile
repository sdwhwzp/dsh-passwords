# syntax=docker/dockerfile:1
FROM node:24-slim

WORKDIR /opt/dsh-passwords

COPY package.json package-lock.json tsconfig.json cordis.yml ./
RUN npm ci --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY .env.example README.md README_en.md LICENSE ./
RUN npm run build \
  && npm prune --omit=dev

COPY docker/docker-entrypoint.sh /usr/local/bin/dsh-passwords-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/dsh-passwords-entrypoint \
  && chmod 755 /usr/local/bin/dsh-passwords-entrypoint \
  && mkdir -p /data/dsh-passwords \
  && chown -R node:node /data

ENV DSH_PASSWORDS_ENV_FILE=/data/dsh-passwords/.env
ENV DSH_PASSWORDS_RUNTIME=docker
ENV MCP_DB_PATH=/data/dsh-passwords/platform.db
ENV MCP_GATEWAY_AUTO_TLS=0
ENV MCP_GATEWAY_HOST=0.0.0.0
ENV MCP_GATEWAY_PORT=3088
ENV MCP_GATEWAY_UPSTREAM=http://127.0.0.1:3080
ENV MCP_DSH_RESTART_SERVICE=

USER node
EXPOSE 3088
ENTRYPOINT ["dsh-passwords-entrypoint"]
CMD ["node", "dist/cli.js", "serve-gateway"]
