#!/usr/bin/env python3
"""Check tracked project Markdown: English policy, local links, fences, and instruction bridges."""

import argparse
import html
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

HANGUL = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]")
LINK = re.compile(r"!?\[[^\]]*\]\(([^)\n]+)\)")


def visible_lines(text, errors, path):
    result = []
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        match = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
        if match:
            marker, suffix = match.groups()
            if fence:
                if marker[0] == fence[0] and len(marker) >= len(fence) and not suffix.strip():
                    fence = None
            else:
                fence = marker
                if not suffix.strip():
                    errors.append(f"{path}:{number}: code fence needs a language")
            continue
        if not fence:
            result.append(line)
    if fence:
        errors.append(f"{path}: unclosed code fence")
    return result


def anchors(text):
    values = set(re.findall(r"""<(?:a|[hH][1-6])\s+[^>]*(?:id|name)=["']([^"']+)["']""", text))
    seen = {}
    for line in visible_lines(text, [], ""):
        match = re.match(r"^#{1,6}\s+(.+?)(?:\s+#+)?$", line)
        if not match:
            continue
        title = html.unescape(re.sub(r"<[^>]+>", "", match.group(1))).lower()
        slug = re.sub(r"[^\w\- ]", "", title).replace(" ", "-")
        index = seen.get(slug, 0)
        seen[slug] = index + 1
        values.add(slug if index == 0 else f"{slug}-{index}")
    return values


def check(root, files):
    root = Path(root).resolve()
    errors = []
    checked_links = 0
    total_bytes = 0
    for relative in files:
        path = root / relative
        text = path.read_text(encoding="utf-8")
        total_bytes += len(text.encode("utf-8"))
        if HANGUL.search(text):
            errors.append(f"{relative}: documentation must use English")
        lines = visible_lines(text, errors, relative)
        plain = "\n".join(lines)
        targets = [match.group(1).strip().split()[0].strip("<>") for match in LINK.finditer(plain)]
        targets += re.findall(r"""<a\s+[^>]*href=["']([^"']+)["']""", plain)
        for target in targets:
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc:
                continue
            destination = (path.parent / unquote(parsed.path)).resolve() if parsed.path else path.resolve()
            if destination != root and root not in destination.parents:
                errors.append(f"{relative}: link leaves repository: {target}")
                continue
            checked_links += 1
            if not destination.exists():
                errors.append(f"{relative}: missing link target: {target}")
                continue
            if parsed.fragment and destination.suffix.lower() == ".md":
                if unquote(parsed.fragment) not in anchors(destination.read_text(encoding="utf-8")):
                    errors.append(f"{relative}: missing anchor: {target}")
        if path.name == "CLAUDE.md":
            meaningful = [line.strip() for line in text.splitlines() if line.strip()]
            if meaningful and meaningful[0].startswith("# "):
                meaningful = meaningful[1:]
            if meaningful != ["@AGENTS.md"] or not path.with_name("AGENTS.md").is_file():
                errors.append(f"{relative}: expected a thin import of adjacent AGENTS.md")
        if path.name == "AGENTS.md" and len(text.encode("utf-8")) > 6_000:
            errors.append(f"{relative}: agent guidance exceeds 6,000-byte budget")
    return errors, {"files": len(files), "bytes": total_bytes, "local_links": checked_links}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    files = subprocess.check_output(
        ["git", "-C", str(args.root), "ls-files", "*.md"], text=True
    ).splitlines()
    errors, summary = check(args.root, files)
    print(f"Documentation: {summary['files']} files, {summary['bytes']} UTF-8 bytes, {summary['local_links']} local links")
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        sys.exit(1)
    print("Documentation checks passed")


if __name__ == "__main__":
    main()
