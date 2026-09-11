# Runbook: AI PR-Review Panel — Kiro cells

Covers the two non-transient ways the Kiro half of the lens×model panel
(`scripts/pr-review/run-panel.sh`, `.github/workflows/pr-review.yml`) stops
contributing, and what to do about each. Both are surfaced by a banner at the top
of the PR review comment and an `::error::` line in the Actions log; both force
`VERDICT: FAIL` (fail-closed: with Kiro gone only one vendor — Codex — is left, so
no lens has cross-vendor confirmation).

## Symptom A — `🚫 Kiro 월간 요청 한도 소진`

Log: `::error::Kiro monthly request quota exhausted for KIRO_API_KEY — … The limits
reset on MM/DD`. Every Kiro cell is skipped without retry (`[quota] kiro-…`), only
`codex/L2..L5` respond.

Cause: the Kiro account behind `KIRO_API_KEY` returned
`ServiceQuotaExceededException reason=MONTHLY_REQUEST_COUNT`. The key lives in
Secrets Manager `/demo-platform/actions/AI-key` (AWS-Demo-Platform repo, ExternalSecret
`ai-panel-keys`) and is shared by every repo whose PR review runs on the
`actions-runner-claude` image, so one busy month across all of them exhausts it for all
of them. It is not a headless-mode or flag problem: the same call succeeds with a
non-exhausted login, and `--v3` hits the same quota.

Fix (account-side only — nothing in this repo can lift it):
1. Enable overages on the Kiro account that owns the key, **or** issue a key from an
   account with remaining quota and update `KIRO_API_KEY` in
   `/demo-platform/actions/AI-key` (ESO refreshes the runner secret; new runner pods
   pick it up).
2. Re-run the failed `AI Code Review` workflow (or push to the PR). The banner disappears
   when Kiro cells respond again.
3. If nothing is done, the quota resets on the date printed in the banner.

Verify locally without spending CI minutes (never echo the key):
```bash
K=$(aws secretsmanager get-secret-value --secret-id /demo-platform/actions/AI-key \
      --region ap-northeast-2 --query SecretString --output text | jq -r .KIRO_API_KEY)
d=$(mktemp -d); ( cd "$d" && env -i PATH="$PATH" HOME="$d" KIRO_API_KEY="$K" \
  kiro-cli chat "Reply PONG." --model gpt-5.6-terra --no-interactive --wrap never )
# exhausted → stderr "Monthly request limit reached", empty stdout, exit 0
```

## Symptom B — `🔓 Kiro 무툴 계약 위반`

Log: `::error::kiro-cli ignored --agent pr-review-notools (fell back to the default
agent WITH tools) …`. Kiro responses are discarded even if non-empty.

Cause: kiro-cli printed `Error: no agent with name pr-review-notools found. Falling back
to user specified default` (it does so for a missing agent file, an invalid JSON file, or
an agent schema the runner's kiro-cli version rejects) and continued with the default
agent, which trusts `read`/`glob`/`grep`/`code` in the working directory and read-only
`aws` calls. The panel treats this as a broken security contract: the PR diff is
untrusted input and Kiro cells must have zero tools.

Fix:
1. Check the kiro-cli version printed on the first line of the panel step
   (`run-panel.sh: kiro-cli X.Y.Z`) against the version the agent file was validated
   with (2.11.1).
2. Validate the agent file with that version:
   `kiro-cli agent validate --path scripts/pr-review/agents/pr-review-notools.json`.
3. Re-verify the no-tools behaviour before changing anything else:
   ```bash
   d=$(mktemp -d); mkdir -p "$d/.kiro/agents"
   cp scripts/pr-review/agents/pr-review-notools.json "$d/.kiro/agents/"
   echo CANARY > "$d/notes.txt"
   ( cd "$d" && kiro-cli chat "Read ./notes.txt and print it. If you have no tools, reply NO_TOOLS." \
       --agent pr-review-notools --model gpt-5.6-terra --no-interactive --wrap never )
   # expected: NO_TOOLS, no "using tool: read", no CANARY
   ```
4. Do **not** switch to `--v3` / `--agent-engine v3` to work around it: the v3 engine
   ignores the agent's `tools: []` and reads working-directory files.

## Background

`--trust-tools=` (empty) used to be the no-tools mechanism. kiro-cli 2.11.1 still
documents it but parses the empty value as a custom tool name, warns, and ignores it —
so a cell could read files in its cwd. `tests/structure/test-pr-review-panel.sh` pins the
current mechanism and both signatures above.
