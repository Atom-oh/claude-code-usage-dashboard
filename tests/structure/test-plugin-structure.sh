#!/bin/bash
# --- Manifest validation ---
# Local .claude tooling is gitignored and absent in fresh CI checkouts. Guard its
# reads because this file is sourced under set -euo pipefail.
if [ -d .claude ]; then
    assert_json_valid "settings.json is valid JSON" ".claude/settings.json"
else
    skip "settings.json is valid JSON" ".claude/ is local-only (gitignored)"
fi
assert_json_valid "dashboard/server/package.json is valid JSON" "dashboard/server/package.json"
assert_json_valid "dashboard/web/package.json is valid JSON" "dashboard/web/package.json"
assert_json_valid ".mcp.json is valid JSON" ".mcp.json"

# --- File existence ---
assert_file_exists "Root CLAUDE.md" "CLAUDE.md"
assert_file_exists "Root AGENTS.md" "AGENTS.md"
assert_file_exists "docs/architecture.md" "docs/architecture.md"
assert_file_exists "docs/onboarding.md" "docs/onboarding.md"
assert_file_exists "docs/api-reference.md" "docs/api-reference.md"
assert_file_exists "docs/reference/INDEX.md" "docs/reference/INDEX.md"
assert_file_exists "docs/decisions/.template.md" "docs/decisions/.template.md"
assert_file_exists "docs/runbooks/.template.md" "docs/runbooks/.template.md"
assert_file_exists "docs/runbooks/deploy-production.md" "docs/runbooks/deploy-production.md"
assert_file_exists "README.md" "README.md"
assert_file_exists "CHANGELOG.md" "CHANGELOG.md"
assert_file_exists ".env.example" ".env.example"
assert_file_exists "dashboard/CLAUDE.md" "dashboard/CLAUDE.md"
assert_file_exists "dashboard/server/CLAUDE.md" "dashboard/server/CLAUDE.md"
assert_file_exists "dashboard/web/CLAUDE.md" "dashboard/web/CLAUDE.md"
assert_file_exists "infra/CLAUDE.md" "infra/CLAUDE.md"

# --- Script validation ---
assert_file_executable "setup.sh is executable" "scripts/setup.sh"
assert_bash_syntax "setup.sh valid bash" "scripts/setup.sh"
assert_file_executable "install-hooks.sh is executable" "scripts/install-hooks.sh"
assert_bash_syntax "install-hooks.sh valid bash" "scripts/install-hooks.sh"

# --- Command frontmatter ---
if [ -d .claude ]; then
    for cmd in review test-all deploy; do
        CMD_CONTENT=$(cat ".claude/commands/$cmd.md")
        assert_contains "Command $cmd: has frontmatter" "$CMD_CONTENT" "description:"
        assert_contains "Command $cmd: has allowed-tools" "$CMD_CONTENT" "allowed-tools:"
    done

    # --- Skill files ---
    for skill in code-review refactor release sync-docs; do
        assert_file_exists "Skill $skill: SKILL.md exists" ".claude/skills/$skill/SKILL.md"
    done

    # --- Agent files ---
    for agent in code-reviewer security-auditor; do
        assert_file_exists "Agent $agent: yml exists" ".claude/agents/$agent.yml"
        AGENT_CONTENT=$(cat ".claude/agents/$agent.yml")
        assert_contains "Agent $agent: has name" "$AGENT_CONTENT" "name:"
        assert_contains "Agent $agent: has tools" "$AGENT_CONTENT" "tools:"
    done
else
    skip ".claude/commands/*.md frontmatter" ".claude/ is local-only (gitignored)"
    skip ".claude/skills/*/SKILL.md exist" ".claude/ is local-only (gitignored)"
    skip ".claude/agents/*.yml exist and declare name/tools" ".claude/ is local-only (gitignored)"
fi

# --- One instruction owner per scope; Claude imports the same file ---
for scope in . dashboard dashboard/server dashboard/web infra scripts/pr-review; do
    assert_file_exists "$scope has canonical agent guidance" "$scope/AGENTS.md"
    BRIDGE=$(cat "$scope/CLAUDE.md")
    assert_contains "$scope Claude bridge imports canonical guidance" "$BRIDGE" "@AGENTS.md"
done

# --- Implementation reference docs ---
LAYERS=(infrastructure data api iac frontend ui security agent-llm)
for layer in "${LAYERS[@]}"; do
    assert_file_exists "docs/reference/$layer.md exists" "docs/reference/$layer.md"
done
