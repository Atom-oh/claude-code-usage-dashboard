"""Repository policy budgets, not measured CLI or model maxima.

The 512000-byte / 12000-line guard was introduced in commit 4e2dc91 without
a recorded sizing experiment. Retain the existing guard until a separately
validated budget change; do not derive tokens from these UTF-8 byte counts.
Evidence and update rules: docs/reference/pr-review-headless-limits.md.
"""

MAX_DIFF_BYTES = 512000
MAX_DIFF_LINES = 12000
MAX_FULL_REQUEST_BYTES = 640000
MAX_REQUEST_BYTES = 120000
MAX_KIRO_DIFF_BYTES = 95000
MAX_KIRO_DIFF_LINES = 3000
MAX_SUMMARY_BYTES = 64000


def needs_summary(raw, framed_bytes):
    return (len(raw) > MAX_KIRO_DIFF_BYTES
            or len(raw.splitlines()) > MAX_KIRO_DIFF_LINES
            or framed_bytes >= MAX_REQUEST_BYTES)


if __name__ == "__main__":
    print(MAX_DIFF_LINES, MAX_DIFF_BYTES)
