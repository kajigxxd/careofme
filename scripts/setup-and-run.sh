#!/usr/bin/env bash
# Настройка «Бережно»: сохраняет BOT_TOKEN и запускает бота
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"

echo "🌿 Бережно — настройка"
echo ""
echo "Сейчас в Telegram Lite откроется @BotFather."
echo "Сделай по шагам:"
echo "  1) Отправь: /newbot"
echo "  2) Имя: Бережно"
echo "  3) Username: например berezhno_care_bot (должен оканчиваться на bot)"
echo "  4) Скопируй токен вида 123456:ABC-DEF..."
echo ""

open -a "Telegram Lite" "https://t.me/BotFather" 2>/dev/null || open "https://t.me/BotFather"

# Диалог macOS для вставки токена
TOKEN="$(osascript <<'APPLESCRIPT'
try
  set dialogResult to display dialog "Вставь токен бота от @BotFather (формат 123456:AA...)" default answer "" with title "Бережно — BOT_TOKEN" buttons {"Отмена", "Сохранить"} default button "Сохранить" with icon note
  if button returned of dialogResult is "Отмена" then return ""
  return text returned of dialogResult
on error
  return ""
end try
APPLESCRIPT
)"

TOKEN="$(echo "$TOKEN" | tr -d '[:space:]')"

if [[ -z "$TOKEN" ]]; then
  echo "Токен не введён. Запусти скрипт снова после создания бота."
  exit 1
fi

if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "Похоже, токен в странном формате. Сохраняю как есть — проверь, если бот не стартует."
fi

# Сохраняем / обновляем .env
if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^BOT_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    # portable sed
    grep -v '^BOT_TOKEN=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  echo "BOT_TOKEN=$TOKEN" >> "$ENV_FILE"
else
  cp "$ROOT/.env.example" "$ENV_FILE"
  # rewrite BOT_TOKEN line
  {
    echo "BOT_TOKEN=$TOKEN"
    grep -v '^BOT_TOKEN=' "$ROOT/.env.example" | grep -v '^#' | grep -v '^$' || true
  } > "$ENV_FILE"
  # Keep comments from example too
  cat > "$ENV_FILE" <<EOF
# Сгенерировано scripts/setup-and-run.sh
BOT_TOKEN=$TOKEN

# SpaceXAI / xAI — для AI-коуча (https://console.x.ai)
XAI_API_KEY=

# Модель
XAI_MODEL=grok-4.5

DATA_PATH=./data/store.json
EOF
fi

echo "✅ Токен сохранён в .env"
echo "Запускаю бота…"
echo ""

if [[ ! -d node_modules ]]; then
  npm install
fi

npm run dev
