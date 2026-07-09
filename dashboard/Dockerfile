# linux/arm64 대상 — m8g.xlarge(Graviton) 노드에서 실행. `docker buildx build --platform linux/arm64`로 빌드.
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:24-alpine AS server
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN npm install --prefix server --omit=dev
COPY server/ ./server/
COPY --from=web-build /app/web/dist ./web/dist

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
