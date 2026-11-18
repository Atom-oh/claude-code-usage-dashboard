# Receiver build

Minimal OpenTelemetry Collector Builder (OCB) distribution for the central OTLP receiver. It contains only the nine components that `dashboard/collector/generated/central.yaml` uses, plus the `env` and `file` config providers.

- Version rule: `dist.version` equals `dashboard/collector/release.json` `version`. Component modules, providers and `build_tags` are copied verbatim from the upstream `opentelemetry-collector-releases` `distributions/otelcol-contrib/manifest.yaml` at the same tag. Bump them together with `release.json`.
- Image: `linux/arm64` only, runs as `10001:10001`, entrypoint `/otelcol-ccdash-receiver`, default `--config=/etc/otelcol/config.yaml`.
- Build locally: `docker buildx build --platform linux/arm64 -t ccdash-receiver:local collector-build/`
- Tests: `python3 -m unittest discover -s collector-build/tests -p 'test_*.py'`. Set `CCDASH_UPSTREAM_RECEIVER_MANIFEST` to the upstream manifest file to also verify the copied lines.

Production keeps the upstream `opentelemetry-collector-contrib` image until phase 7.
