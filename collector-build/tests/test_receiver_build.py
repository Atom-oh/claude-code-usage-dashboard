"""Static checks for the minimal OCB receiver distribution."""
import json
import os
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "collector-build"
RELEASE = ROOT / "dashboard/collector/release.json"
CENTRAL = ROOT / "dashboard/collector/generated/central.yaml"

# Module basename -> Collector component type, reused by the binary tests.
COMPONENT_TYPES = {
    "bearertokenauthextension": "bearertokenauth",
    "healthcheckextension": "health_check",
    "otlpreceiver": "otlp",
    "batchprocessor": "batch",
    "memorylimiterprocessor": "memory_limiter",
    "filterprocessor": "filter",
    "resourceprocessor": "resource",
    "transformprocessor": "transform",
    "clickhouseexporter": "clickhouse",
}


def manifest_lines(path):
    return Path(path).read_text().splitlines()


def dist_block(path):
    """Return the scalar keys of the top-level `dist:` block."""
    out, inside = {}, False
    for line in manifest_lines(path):
        if re.match(r"^dist:\s*$", line):
            inside = True
        elif inside and re.match(r"^\S", line):
            break
        elif inside and (m := re.match(r"^\s+([a-z_]+):\s*(.*?)\s*$", line)):
            out[m.group(1)] = m.group(2).strip('"')
    return out


def gomods(path, section=None):
    """Return (module, version) for gomod lines, optionally of one section."""
    out, current = [], None
    for line in manifest_lines(path):
        if m := re.match(r"^([a-z]+):\s*$", line):
            current = m.group(1)
        elif (m := re.match(r"^\s+-\s+gomod:\s+(\S+)\s+(\S+)\s*$", line)) \
                and section in (None, current):
            out.append((m.group(1), m.group(2)))
    return out


def basename(module):
    return module.rsplit("/", 1)[-1]


def central_types():
    """Component types used by central.yaml, without any /name suffix."""
    types, section = set(), None
    for line in CENTRAL.read_text().splitlines():
        if m := re.match(r"^([a-z]+):\s*$", line):
            section = m.group(1)
        elif section in ("extensions", "receivers", "processors", "exporters") \
                and (m := re.match(r"^  ([a-z_]+)(?:/[\w-]+)?:", line)):
            types.add(m.group(1))
        elif section == "service" and (m := re.match(r"^  extensions:\s*\[(.*)\]", line)):
            types.update(x.strip().split("/")[0] for x in m.group(1).split(","))
    return types


class ReceiverBuild(unittest.TestCase):
    manifest = BUILD / "manifest.yaml"

    def test_dist_tracks_release_pin(self):
        dist = dist_block(self.manifest)
        self.assertEqual(dist["version"], json.loads(RELEASE.read_text())["version"])
        self.assertEqual(dist["name"], "otelcol-ccdash-receiver")
        self.assertEqual(dist["build_tags"], "grpcnotrace")

    def test_components_exactly_cover_central_config(self):
        modules = gomods(self.manifest)
        components = [m for m, _ in modules if "/confmap/provider/" not in m]
        types = {COMPONENT_TYPES[basename(m)] for m in components}
        self.assertEqual(len(components), len(types))
        self.assertEqual(types, central_types())
        self.assertEqual(len(types), 9)

    def test_one_component_version_and_exact_providers(self):
        for section in ("extensions", "receivers", "processors", "exporters"):
            for module, version in gomods(self.manifest, section):
                self.assertEqual(version, "v0.163.0", module)
        self.assertEqual(gomods(self.manifest, "providers"), [
            ("go.opentelemetry.io/collector/confmap/provider/envprovider", "v1.69.0"),
            ("go.opentelemetry.io/collector/confmap/provider/fileprovider", "v1.69.0"),
        ])

    @unittest.skipUnless(os.environ.get("CCDASH_UPSTREAM_RECEIVER_MANIFEST"),
                         "set CCDASH_UPSTREAM_RECEIVER_MANIFEST to the upstream manifest")
    def test_matches_upstream_manifest(self):
        upstream = os.environ["CCDASH_UPSTREAM_RECEIVER_MANIFEST"]
        ours = gomods(self.manifest)
        self.assertEqual(len(ours), 11)
        self.assertLessEqual(set(ours), set(gomods(upstream)))
        self.assertEqual(dist_block(upstream)["version"], dist_block(self.manifest)["version"])
        self.assertEqual(dist_block(upstream)["build_tags"], dist_block(self.manifest)["build_tags"])

    def test_dockerfile_pins_and_runs_nonroot(self):
        text = (BUILD / "Dockerfile").read_text()
        self.assertRegex(text, r"(?m)^ARG GO_IMAGE=public\.ecr\.aws/docker/library/golang:1\.26[\w.-]*@sha256:[0-9a-f]{64}$")
        self.assertIn("go install go.opentelemetry.io/collector/cmd/builder@v0.163.0", text)
        froms = re.findall(r"(?m)^FROM\s+(\S+)", text)
        self.assertEqual(froms[-1], "scratch")
        self.assertRegex(text, r"(?m)^USER 10001:10001$")
        self.assertIn('ENTRYPOINT ["/otelcol-ccdash-receiver"]', text)
        for host in ("docker.io", "ghcr.io"):
            self.assertNotIn(host, text)


if __name__ == "__main__":
    unittest.main()
