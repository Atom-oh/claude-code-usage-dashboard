# Minimal OCB distribution for the central OTLP receiver (linux/arm64 only).
ARG GO_IMAGE=public.ecr.aws/docker/library/golang:1.26-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab

FROM ${GO_IMAGE} AS build
# The pinned image already carries the CA bundle (ca-certificates-bundle-20261020-r0), so the
# shipped bundle comes from the digest alone; no unpinned apk add.
RUN go install go.opentelemetry.io/collector/cmd/builder@v0.163.0
WORKDIR /src
COPY manifest.yaml .
RUN CGO_ENABLED=0 builder --config manifest.yaml

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chmod=755 /src/_build/otelcol-ccdash-receiver /otelcol-ccdash-receiver
USER 10001:10001
EXPOSE 4318 13133
ENTRYPOINT ["/otelcol-ccdash-receiver"]
CMD ["--config=/etc/otelcol/config.yaml"]
