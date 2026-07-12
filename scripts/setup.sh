#!/bin/bash
# Project setup script for new developers.
# Usage: bash scripts/setup.sh

set -e

echo "=== Project Setup ==="

# Check prerequisites
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 24+ is required"; exit 1; }

echo "Installing server dependencies (dashboard/server)..."
(cd dashboard/server && npm install)

echo "Installing web dependencies (dashboard/web)..."
(cd dashboard/web && npm install)

# Setup environment
if [ -f ".env.example" ] && [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "IMPORTANT: Edit .env with your actual ClickHouse/Bedrock values"
fi

# Setup Claude Code hooks
if [ -f ".claude/hooks/check-doc-sync.sh" ]; then
    chmod +x .claude/hooks/*.sh
    echo "Claude hooks configured"
fi

if [ -d ".git" ]; then
    if [ -f "scripts/install-hooks.sh" ]; then
        bash scripts/install-hooks.sh
    fi
fi

echo "=== Setup Complete ==="
echo "Next steps:"
echo "  1. Edit .env with your ClickHouse connection details"
echo "  2. Read CLAUDE.md for project conventions"
echo "  3. Read docs/onboarding.md for the development workflow"
echo "  4. cd dashboard && docker compose up   # local full stack"
