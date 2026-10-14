#!/usr/bin/env python3
"""Prepare a private Collector config that clears log bodies before export."""
import argparse
import copy
import os
from pathlib import Path

PROCESSOR = "transform/clear_log_body"
DEFINITION = {
    "error_mode": "propagate",
    "log_statements": [{"context": "log", "statements": ['set(body, "")']}],
}


def scrub_log_bodies(config):
    if not isinstance(config, dict):
        raise ValueError("Collector configuration must be a mapping")
    result = copy.deepcopy(config)
    pipelines = result.get("service", {}).get("pipelines", {})
    logs = [pipeline for name, pipeline in pipelines.items()
            if name == "logs" or name.startswith("logs/")]
    if not logs:
        raise ValueError("No log pipeline found")
    processors = result.setdefault("processors", {})
    if PROCESSOR in processors and processors[PROCESSOR] != DEFINITION:
        raise ValueError("Existing body processor has a different definition")
    processors[PROCESSOR] = copy.deepcopy(DEFINITION)
    for pipeline in logs:
        chain = pipeline.setdefault("processors", [])
        if PROCESSOR not in chain:
            chain.insert(chain.index("batch") if "batch" in chain else len(chain), PROCESSOR)
    return result


def main():
    import yaml

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True,
                        help="New private file; never overwrites the running config.")
    args = parser.parse_args()
    with args.input.open() as source:
        result = scrub_log_bodies(yaml.safe_load(source))
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        yaml.safe_dump(result, output, sort_keys=False)


if __name__ == "__main__":
    main()
