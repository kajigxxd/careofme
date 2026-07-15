#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! gh auth status >/dev/null 2>&1; then
  echo "Сначала войди в GitHub:"
  echo "  gh auth login --web"
  exit 1
fi

NAME="${1:-berezhno}"
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$NAME" --public --source=. --remote=origin --push
else
  git push -u origin main
fi

echo "✅ Repo: $(gh repo view --json url -q .url)"
echo "Дальше: Render Blueprint → secrets BOT_TOKEN → deploy"
