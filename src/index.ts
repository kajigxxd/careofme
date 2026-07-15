import "dotenv/config";
import { Bot, webhookCallback } from "grammy";
import type { Request, Response } from "express";
import { registerHandlers } from "./features/handlers";
import { applyPaidInvoice } from "./payments/activate";
import { createHttpServer, listenHttp } from "./server/http";
import {
  resolvePort,
  resolveWebAppUrl,
  shouldUseWebhook,
  webhookSecretPath,
} from "./config";
import {
  isCryptoPayConfigured,
  verifyCryptoPaySignature,
  type CryptoPayUpdate,
} from "./payments/cryptopay";
import { store } from "./db/store";
import { isAiConfigured } from "./ai/client";

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
    }
  } catch (e) {
    console.warn("Menu button setup failed:", e);
  }

  try {
    await bot.api.setMyName("careofme");
    await bot.api.setMyShortDescription(
      "Тихий уголок в кармане. Пара минут — и можно выдохнуть."
    );
    await bot.api.setMyDescription(
      "careofme — тихое место, куда можно заглянуть между делами.\n\n" +
        "Короткий чек-ин, мягкие практики, трекер стресса и спокойный AI-коуч на русском. " +
        "Без давления и громких обещаний — просто рядом, когда нужно чуть больше ясности.\n\n" +
        "Не замена терапии. Если совсем тяжело: 8-800-2000-122 или 112."
    );
  } catch (e) {
    console.warn("Profile setup:", e);
  }
}

function mountCryptoPayWebhook(
  app: ReturnType<typeof createHttpServer>
) {
  app.post(
    "/payments/cryptopay/webhook",
    async (req: Request, res: Response) => {
      try {
        const raw =
          (req as Request & { rawBody?: string }).rawBody ||
          JSON.stringify(req.body);
        const sig =
          (req.header("crypto-pay-api-signature") as string) ||
          (req.header("Crypto-Pay-API-Signature") as string);

        if (!verifyCryptoPaySignature(raw, sig)) {
          console.warn("CryptoPay webhook: bad signature");
          return res.status(401).json({ ok: false });
        }

        const update = req.body as CryptoPayUpdate;
        if (update.update_type === "invoice_paid" && update.payload) {
          const inv = update.payload;
          const result = applyPaidInvoice({
            invoiceId: inv.invoice_id,
            payload: inv.payload,
            amount: inv.amount,
            asset:
              (inv as { paid_asset?: string }).paid_asset || inv.fiat,
          });
          console.log("CryptoPay paid", inv.invoice_id, result);

          if (result.ok && result.userId) {
            try {
              const u = store.getUser(result.userId);
              await bot.api.sendMessage(
                u?.chatId || result.userId,
                `✅ Оплата получена!\n\nТариф *${
                  result.plan === "plus" ? "Плюс" : "Забота"
                }* активен на 30 дней.\nОткрой /start или приложение careofme.`,
                { parse_mode: "Markdown" }
              );
            } catch (e) {
              console.warn("notify user pay", e);
            }
          }
        }
        res.json({ ok: true });
      } catch (e) {
        console.error("cryptopay webhook", e);
        res.status(500).json({ ok: false });
      }
    }
  );
  console.log("💎 Crypto Pay webhook: /payments/cryptopay/webhook");
}

async function main() {
  const port = resolvePort();
  const app = createHttpServer();
  const webappUrl = resolveWebAppUrl();
  const useWebhook = shouldUseWebhook();

  if (isCryptoPayConfigured()) {
    mountCryptoPayWebhook(app);
  }

  if (useWebhook && webappUrl) {
    const secret = webhookSecretPath();
    const path = `/telegram/webhook/${secret}`;
    app.post(path, webhookCallback(bot, "express"));
    console.log(`🪝 Telegram webhook: ${path}`);

    await listenHttp(app, port);

    await bot.api.setWebhook(`${webappUrl}${path}`, {
      drop_pending_updates: true,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
    });
    console.log(`🪝 setWebhook → ${webappUrl}${path}`);
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
  process.env.BOT_USERNAME = me.username;
  console.log(`🌿 careofme: @${me.username}`);
  console.log(
    isAiConfigured()
      ? `AI-коуч: SpaceXAI (${process.env.XAI_MODEL || "grok-4.5"})`
      : "AI-коуч: fallback (добавьте XAI_API_KEY)"
  );
  console.log(
    isCryptoPayConfigured()
      ? "Оплата: Crypto Pay (@CryptoBot) ✓"
      : "Оплата: CRYPTO_PAY_TOKEN не задан"
  );
  if (webappUrl) {
    console.log(`Mini App: ${webappUrl}`);
    if (isCryptoPayConfigured()) {
      console.log(
        `Crypto webhook URL (вставь в @CryptoBot → Webhooks):\n  ${webappUrl}/payments/cryptopay/webhook`
      );
    }
  }

  if (!useWebhook) {
    await bot.start({
      onStart: () => console.log("Long polling…"),
      drop_pending_updates: false,
    });
  } else {
    console.log("Webhook mode — online");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
