# node 22.23.3-alpine, pinned by index digest (newest 22 LTS alpine past a 7 day cooldown on 2026-10-25)
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
# stdio by default; set MCP_HTTP_PORT and MCP_HTTP_TOKEN for streamable HTTP on /mcp
ENTRYPOINT ["node", "src/index.js"]
