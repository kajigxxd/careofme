# Бережно 🌿

**Telegram Mini App + бот** для эмоциональной безопасности и ежедневной самопомощи на русском.

Чек-ин настроения · микро-практики (дыхание, CBT, сон) · трекер стресса · AI-коуч · подписка 199–349 ₽.

> Не замена психотерапии. При кризисе: **8-800-2000-122**, **112**.

## Быстрый старт (локально)

```bash
cp .env.example .env
# BOT_TOKEN=... от @BotFather

npm install
npm run dev          # бот + http://localhost:8787
```

В другом терминале — HTTPS для Mini App:

```bash
npm run tunnel
# Скопируй https://….loca.lt → WEBAPP_URL в .env и перезапусти
```

Открой [@berezhno_care_bot](https://t.me/berezhno_care_bot) → `/start` или `/app`.

## Деплой через GitHub (рекомендуется)

Стабильный HTTPS без localtunnel.

### 1. Репозиторий

```bash
git init
git add .
git commit -m "feat: Бережно Mini App + bot"
gh repo create berezhno --public --source=. --push
# или: git remote add origin git@github.com:YOU/berezhno.git && git push -u origin main
```

### 2. Render (бесплатно)

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
2. Подключи GitHub-репозиторий
3. Secrets:
   - `BOT_TOKEN` — обязательно
   - `XAI_API_KEY` — опционально (AI-коуч)
4. После деплоя URL вида `https://berezhno-xxxx.onrender.com` подставится сам (`RENDER_EXTERNAL_URL`)
5. В Telegram: `/start` → **Открыть Бережно**

`render.yaml` уже в репозитории. Free tier «засыпает» — первый запрос ~30–60 с.

### 3. Docker

```bash
docker build -t berezhno .
docker run -p 8787:8787 \
  -e BOT_TOKEN=... \
  -e WEBAPP_URL=https://your-host \
  berezhno
```

## Переменные окружения

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `BOT_TOKEN` | да | @BotFather |
| `WEBAPP_URL` | нет* | HTTPS Mini App (*на Render берётся из `RENDER_EXTERNAL_URL`) |
| `XAI_API_KEY` | нет | SpaceXAI / xAI для коуча |
| `XAI_MODEL` | нет | по умолчанию `grok-4.5` |
| `PORT` | нет | по умолчанию `8787` |
| `DATA_PATH` | нет | JSON store; в prod — `/tmp/berezhno-store.json` |

## Структура

```
src/           # бот + API
webapp/        # Telegram Mini App (UI)
.github/       # CI
Dockerfile
render.yaml    # one-click Render
```

## CI

GitHub Actions (`.github/workflows/ci.yml`): `typecheck` + `build` на каждый push.

## Лицензия

MIT
