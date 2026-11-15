#!/usr/bin/env python3
"""Compare raw Codex turn spans and codex_turns_v1 states in owned, isolated ClickHouse."""
from pathlib import Path
import subprocess
from schema_lifecycle_fixture import SchemaFixture

root = Path(__file__).resolve().parents[1]
with SchemaFixture(root) as fixture:
    subprocess.run(
        ["node", str(root / "scripts/test-codex-turns-schema.mjs"), fixture.name],
        cwd=root, check=True,
    )
