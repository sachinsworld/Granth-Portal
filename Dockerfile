FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# Installs the optional MongoDB driver. Safe to skip: the app also runs on SQLite without it.
RUN npm install --omit=dev --no-audit --no-fund || true
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
