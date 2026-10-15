# TTA CLAUDE — sayt rejimi (Node 22 + Python kutubxonalari, agent hujjatlar yarata olishi uchun)
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.base.json tsconfig.server.json tsconfig.web.json ./
COPY shared ./shared
COPY server ./server
COPY tests ./tests
COPY web ./web
COPY scripts ./scripts
COPY VERSION ./
RUN npm run build

FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git ripgrep curl unzip zip jq pandoc \
      fonts-dejavu-core fonts-liberation poppler-utils \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages \
      python-docx openpyxl python-pptx reportlab pypdf pandas matplotlib pillow requests beautifulsoup4 markdown xlsxwriter
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY VERSION ./
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8095 NODE_ENV=production TZ=Asia/Tashkent
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8095
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs "http://127.0.0.1:8095${BASE_PATH:-}/api/app" >/dev/null || exit 1
CMD ["node", "dist/server/main.js"]
