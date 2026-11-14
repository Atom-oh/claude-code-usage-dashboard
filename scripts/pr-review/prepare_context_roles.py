#!/usr/bin/env python3
"""Reuse the project's immutable, bounded context builder for specialist roles."""

import hashlib
import importlib.util
from pathlib import Path
import subprocess


def prepare(head, base, paths, diff):
    root = Path(__file__).resolve().parents[2]
    file = Path(__file__).with_name("build-prompts.py")
    expected = subprocess.check_output(
        ["git", "-C", str(root), "show", f"{base}:scripts/pr-review/build-prompts.py"]
    )
    if file.is_symlink() or file.read_bytes() != expected:
        raise ValueError("Context builder differs from the trusted base")
    spec = importlib.util.spec_from_file_location("project_base_context", file)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    selected = builder.relevant_guides(paths)
    context, manifest = builder.render_context(builder.Snapshot(root, base), selected)
    # Validate candidate guide size/type without promoting its text to instructions.
    builder.render_context(builder.Snapshot(root, head), selected)
    # No context or template budget here: role_review.py bounds each framed request.
    return context, {
        "builder": "scripts/pr-review/build-prompts.py",
        "builder_sha256": hashlib.sha256(expected).hexdigest(),
        **manifest,
    }
