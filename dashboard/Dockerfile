# linux/arm64 대상 — m8g.xlarge(Graviton) 노드에서 실행. `docker buildx build --platform linux/arm64`로 빌드.
# 베이스를 태그가 아니라 다이제스트로 고정한다 — 같은 태그가 재발행되면 같은 커밋이 다른 런타임을
# 만든다. 아래 값은 멀티아치 이미지 인덱스(OCI image index)의 다이제스트라 amd64에서도 그대로
# 빌드된다(실측 2026-09-02: linux/amd64 + linux/arm64/v8 매니페스트 포함). 태그는 사람이 읽기
# 위한 것이고 실제 선택은 다이제스트가 한다.
# 재해결: docker buildx imagetools inspect node:24-alpine
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS web-build
WORKDIR /app/web
# 락파일 COPY에 `*`를 붙이지 않는다(선택적으로 만들지 않는다) + npm install이 아니라 npm ci:
# 락파일이 없거나 낡으면 빌드가 semver 범위를 그 시점 최신으로 다시 풀어, 같은 커밋의 두 빌드가
# 서로 다른 의존성 트리를 실을 수 있다. 락파일이 없으면 즉석에서 해결하는 게 아니라 빌드가 깨져야 한다.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS server
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server
COPY server/ ./server/
COPY --from=web-build /app/web/dist ./web/dist

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
