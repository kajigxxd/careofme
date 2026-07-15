# Deploy on Render via GitHub

1. Push this repo to GitHub.
2. Open [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
3. Connect the GitHub repository `berezhno`.
4. Set secret **BOT_TOKEN** (from @BotFather).
5. Optional: **XAI_API_KEY**.
6. After deploy, copy the service URL (`https://berezhno-xxxx.onrender.com`).
7. In bot chat: `/start` — menu button uses `RENDER_EXTERNAL_URL` automatically.

Free tier may sleep after idle; first open can take ~30–60s.
