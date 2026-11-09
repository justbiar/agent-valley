# The console server (app/) as one image. State lives in /data, which docker-compose.yml mounts as a volume.
FROM node:22-slim
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY app/ ./
# The landing page and the city are served by the same server: one site at /, /city and /app.
COPY index.html agent-valley.html /site/
COPY assets /site/assets
ENV HOST=0.0.0.0 PORT=8787 DATA_FILE=/data/state.json NODE_ENV=production SITE_DIR=/site
EXPOSE 8787
CMD ["node", "server.mjs"]
