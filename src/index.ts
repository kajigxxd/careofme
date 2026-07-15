import "dotenv/config";
import { Bot } from "grammy";
import { registerHandlers } from "./features/handlers";
import { startHttpServer } from "./server/http";
import { resolvePort, resolveWebAppUrl } from "./config";

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error(
    "❌ Не задан BOT_TOKEN.\n" +
      "Задайте secret BOT_TOKEN (GitHub Actions / Render / .env)."
  );
  process.exit(1);
}

const bot = new Bot(token);

bot.catch((err) => {
  console.error("Bot error:", err.error ?? err);
});

registerHandlers(bot);

async function configureMenuButton(webappUrl?: string) {
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
      console.log("📱 Menu Button: commands (нужен WEBAPP_URL / RENDER_EXTERNAL_URL)");
    }
  } catch (e) {
    console.warn("Menu button setup failed:", e);
  }
}

async function main() {
  const port = resolvePort();
  await startHttpServer(port);

  // Drop any leftover webhook so long-polling works after redeploy
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (e) {
    console.warn("deleteWebhook:", e);
  }

  const webappUrl = resolveWebAppUrl();
  await configureMenuButton(webappUrl);

  const me = await bot.api.getMe();
  console.log(`🌿 Бережно: @${me.username}`);
  console.log(
    process.env.XAI_API_KEY
      ? `AI-коуч: SpaceXAI (${process.env.XAI_MODEL || "grok-4.5"})`
      : "AI-коуч: fallback (добавьте XAI_API_KEY)"
  );
  if (webappUrl) console.log(`Mini App: ${webappUrl}`);
  else console.warn("⚠ WEBAPP_URL не задан — Mini App кнопка неактивна");

  // Avoid crash loops on getUpdates conflict: stop other instances first
  await bot.start({
    onStart: () => console.log("Long polling…"),
    drop_pending_updates: false,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
