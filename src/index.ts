import "dotenv/config";
import { Bot, webhookCallback } from "grammy";
import { registerHandlers } from "./features/handlers";
import { createHttpServer, listenHttp } from "./server/http";
import {
  resolvePort,
  resolveWebAppUrl,
  shouldUseWebhook,
  webhookSecretPath,
} from "./config";

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error(
    "❌ Не задан BOT_TOKEN.\n" +
      "Задайте secret BOT_TOKEN (Render / Railway / .env)."
  );
  process.exit(1);
}

const bot = new Bot(token);

bot.catch((err) => {
  console.error("Bot error:", err.error ?? err);
});

registerHandlers(bot);

async function configureProfile(webappUrl?: string) {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Запуск и меню" },
      { command: "app", description: "Открыть приложение" },
      { command: "checkin", description: "Чек-ин настроения" },
      { command: "coach", description: "AI-коуч" },
      { command: "stats", description: "Статистика" },
      { command: "help", description: "Помощь" },
    ]);
  } catch (e) {
    console.warn("setMyCommands:", e);
  }

  try {
    if (webappUrl) {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: "Открыть careofme",
          web_app: { url: webappUrl },
        },
      });
      console.log(`📱 Menu Button → Mini App: ${webappUrl}`);
    } else {
      await bot.api.setChatMenuButton({
        menu_button: { type: "commands" },
      });
      console.log("📱 Menu Button: commands");
    }
  } catch (e) {
    console.warn("Menu button setup failed:", e);
  }

  try {
    await bot.api.setMyName("careofme");
    await bot.api.setMyShortDescription(
      "Ментальное здоровье · 2–3 мин в день · AI-коуч на русском"
    );
    await bot.api.setMyDescription(
      "careofme — ежедневная опора для эмоциональной безопасности. " +
        "Чек-ин, микро-практики, трекер стресса и AI-коуч на русском. " +
        "Не замена терапии. Кризис: 8-800-2000-122, 112."
    );
  } catch (e) {
    console.warn("Profile setup:", e);
  }
}

async function main() {
  const port = resolvePort();
  const app = createHttpServer();
  const webappUrl = resolveWebAppUrl();
  const useWebhook = shouldUseWebhook();

  if (useWebhook && webappUrl) {
    const secret = webhookSecretPath();
    const path = `/telegram/webhook/${secret}`;
    app.post(path, webhookCallback(bot, "express"));
    console.log(`🪝 Webhook route: ${path}`);

    await listenHttp(app, port);

    const webhookUrl = `${webappUrl}${path}`;
    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: [
        "message",
        "callback_query",
        "my_chat_member",
      ],
    });
    console.log(`🪝 setWebhook → ${webhookUrl}`);
  } else {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (e) {
      console.warn("deleteWebhook:", e);
    }
    await listenHttp(app, port);
  }

  await configureProfile(webappUrl);

  const me = await bot.api.getMe();
  console.log(`🌿 careofme: @${me.username}`);
  console.log(
    process.env.XAI_API_KEY
      ? `AI-коуч: SpaceXAI (${process.env.XAI_MODEL || "grok-4.5"})`
      : "AI-коуч: fallback (добавьте XAI_API_KEY)"
  );
  if (webappUrl) console.log(`Mini App: ${webappUrl}`);
  else console.warn("⚠ WEBAPP_URL не задан");

  if (!useWebhook) {
    await bot.start({
      onStart: () => console.log("Long polling…"),
      drop_pending_updates: false,
    });
  } else {
    console.log("Webhook mode — waiting for Telegram updates");
    // Keep process alive (HTTP server already listening)
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
