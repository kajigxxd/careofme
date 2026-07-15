#!/usr/bin/env bash
# Локальный запуск: бот + Mini App + HTTPS-туннель (localtunnel)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Создай .env из .env.example (нужен BOT_TOKEN)"
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

PORT="${PORT:-8787}"
export PORT

# stop previous local listeners on port (best-effort)
if command -v lsof >/dev/null; then
  PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "${PIDS:-}" ]]; then
    echo "Освобождаю порт $PORT…"
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    sleep 1
  fi
fi

npm run build

# Start app in background
node dist/index.js &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true' EXIT

sleep 2
if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "Сервер не поднялся на :$PORT"
  exit 1
fi

echo "Запускаю localtunnel…"
# Parse URL from localtunnel output
URL=""
while IFS= read -r line; do
  echo "$line"
  if [[ "$line" =~ https://[a-zA-Z0-9.-]+\.loca\.lt ]]; then
    URL="${BASH_REMATCH[0]}"
    break
  fi
done < <(npx --yes localtunnel --port "$PORT" 2>&1 & LT_PID=$!; wait $LT_PID)

# Fallback: run lt in background and scrape log
if [[ -z "$URL" ]]; then
  LOG=$(mktemp)
  npx --yes localtunnel --port "$PORT" >"$LOG" 2>&1 &
  LT_PID=$!
  trap 'kill $APP_PID $LT_PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    if grep -Eo 'https://[a-zA-Z0-9.-]+\.loca\.lt' "$LOG" >/dev/null 2>&1; then
      URL=$(grep -Eo 'https://[a-zA-Z0-9.-]+\.loca\.lt' "$LOG" | head -1)
      break
    fi
    sleep 1
  done
fi

if [[ -z "${URL:-}" ]]; then
  echo "Не удалось получить URL туннеля. Приложение локально: http://127.0.0.1:${PORT}"
  wait
  exit 0
fi

echo ""
echo "✅ Mini App HTTPS: $URL"
# Update menu button via Bot API
if [[ -n "${BOT_TOKEN:-}" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton" \
    -H 'Content-Type: application/json' \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Открыть Бережно\",\"web_app\":{\"url\":\"${URL}\"}}}" \
    >/dev/null || true
  echo "Menu button обновлён."
fi
echo "Открой @berezhno_care_bot → /app"
wait
