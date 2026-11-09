# syntax=docker/dockerfile:1
# Node 22.13+ is required for the built-in node:sqlite module.
# Override NODE_IMAGE to pull from a mirror, e.g. mirror.gcr.io/library/node:22-slim
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_PATH=/data/aurex.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY docker-entrypoint.sh /usr/local/bin/aurex-entrypoint
RUN chmod +x /usr/local/bin/aurex-entrypoint && mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The entrypoint fixes permissions on the mounted data disk, then drops to the "node" user.
ENTRYPOINT ["aurex-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
