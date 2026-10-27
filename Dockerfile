# MyTurn - container image for a single long-running Node.js instance (Render Docker web service or a Fly.io Machine).
# Built and rehearsed locally with Docker Desktop 29.8.0 (see DEPLOYMENT.md). Not yet run on Render or Fly.io.
# No dependencies are installed: the app uses only Node built-ins (including node:sqlite, stable from Node 22.13 / 24).
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server ./server
COPY site ./site
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The persistent volume is mounted at /data by the platform (never baked into the image). The entrypoint fixes ownership of the
# mounted directory, then drops root. The app itself refuses to start if /data is missing (it never creates an ephemeral folder).
# EXPOSE is image metadata only. The app binds $PORT: Render injects 10000, fly.toml sets 8080.
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
