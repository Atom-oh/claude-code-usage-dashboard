"""Trusted UTF-8 review budgets, independent of model token windows."""

MAX_DIFF_BYTES = 512000
MAX_DIFF_LINES = 12000
MAX_CONTEXT_BYTES = 24000
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
