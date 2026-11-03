# Folio — free local-first AI book reader
# Build:  docker build -t folio .                      (core formats)
#         docker build --build-arg WITH_CONVERTERS=1 -t folio .   (adds Calibre + LibreOffice for MOBI/AZW/DOC/PPT/ODT/RTF)
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-slim AS run
ARG WITH_CONVERTERS=0
WORKDIR /app
ENV NODE_ENV=production BOOKREADER_DATA_DIR=/data PORT=3100 HOSTNAME=0.0.0.0
RUN if [ "$WITH_CONVERTERS" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends calibre libreoffice-writer libreoffice-impress && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./
VOLUME /data
EXPOSE 3100
CMD ["npx", "next", "start", "-p", "3100"]
