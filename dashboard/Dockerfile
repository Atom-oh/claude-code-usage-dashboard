# Deploy linux/arm64. This immutable official index resolves Node 24.22.0 on Alpine
# 3.24 (verified 2026-10-18). Refresh the pin through a reviewed release; tags alone
# do not establish which Node/system packages a build uses.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS node-base

FROM node-base AS web-build
WORKDIR /app/web
# 락파일 COPY에 `*`를 붙이지 않는다(선택적으로 만들지 않는다) + npm install이 아니라 npm ci:
# 락파일이 없거나 낡으면 빌드가 semver 범위를 그 시점 최신으로 다시 풀어, 같은 커밋의 두 빌드가
# 서로 다른 의존성 트리를 실을 수 있다. 락파일이 없으면 즉석에서 해결하는 게 아니라 빌드가 깨져야 한다.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node-base AS server-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server
ARG APP_REVISION
ENV APP_REVISION=${APP_REVISION}
LABEL org.opencontainers.image.revision=${APP_REVISION}
COPY server/ ./server/
COPY --from=web-build /app/web/dist ./web/dist

FROM server-deps AS notices-build
COPY --from=web-build /app/web/node_modules ./web/node_modules
COPY --from=web-build /app/web/package-lock.json ./web/package-lock.json
COPY collect-notices.mjs ./
COPY notices/ ./notice-sources/
# Collector reads its adjacent reviewed catalog, not the network.
RUN mv notice-sources notices && node collect-notices.mjs /app /tmp/distribution-notices

FROM server-deps AS runtime
# npm/Yarn are build tools; the production entrypoint only needs Node and locked
# server dependencies. Retain OS software and its metadata for image scanning.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg /usr/local/bin/corepack /root/.npm \
    && test ! -e /usr/local/lib/node_modules/npm \
    && test ! -e /usr/local/bin/npm \
    && test ! -e /usr/local/bin/yarn
COPY --from=notices-build /tmp/distribution-notices ./notices/
COPY APPLICATION_LICENSE ./APPLICATION_LICENSE
ENV PORT=8080
EXPOSE 8080
USER node
# alpine 기본 탑재된 busybox wget으로 /readyz를 그대로 쓴다(실측 2026-09-02: /usr/bin/wget 존재).
# /readyz는 ClickHouse ping 실패와 SIGTERM 드레인에 503을 주므로 컨테이너 레벨 건강 정의와
# 애플리케이션의 readiness 정의가 어긋나지 않는다. 포트를 위 ENV PORT=8080과 같은 리터럴로
# 박아둔 것은 의도다 — PORT를 덮어쓰는 배포가 생기면 이 줄도 같이 바꿔야 한다.
# k8s는 이미지의 HEALTHCHECK를 무시하고 infra/dashboard.tf의 프로브를 쓴다 — 이건 docker run /
# compose로 띄운 컨테이너가 같은 readiness 정의를 갖게 하려는 것이다.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/readyz || exit 1
CMD ["node", "server/index.js"]
