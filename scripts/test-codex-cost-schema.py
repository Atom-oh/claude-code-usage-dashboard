#!/usr/bin/env python3
"""Run cost-schema parity against an owned, network-isolated ClickHouse 24.8."""
from pathlib import Path
import subprocess
from schema_lifecycle_fixture import SchemaFixture

root = Path(__file__).resolve().parents[1]
with SchemaFixture(root) as fixture:
    subprocess.run(
        ["node", str(root / "scripts/test-codex-cost-schema.mjs"), fixture.name],
        cwd=root, check=True,
    )
