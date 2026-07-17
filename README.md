# careofme 

Telegram **Mini App + бот** для эмоциональной безопасности и ежедневной самопомощи на русском.

**Бот:** [@careofme_bot](https://t.me/careofme_bot)  
**Production:** https://careofme-production.up.railway.app  
**GitHub:** https://github.com/kajigxxd/careofme

Чек-ин настроения · микро-практики · трекер чувств · дневник · AI-ментор · подписка 199–349 ₽.

> Не замена психотерапии. Кризис: **8-800-2000-122**, **112**.

## Запуск для пользователя

1. Открой [@careofme_bot](https://t.me/careofme_bot)
2. `/start`
3. **Открыть careofme** (меню или кнопка)

## Стек

- Node.js + TypeScript + grammY
- Express (API + static Mini App + Telegram webhook)
- Railway (production)
- SpaceXAI / xAI (опционально для AI-ментора)

## Локальная разработка

```bash
cp .env.example .env
# BOT_TOKEN=...
npm install
npm run dev
# USE_WEBHOOK=0  (long polling)
```

## Production (Railway)

Уже задеплоено:

```bash
railway login
railway link
railway up
```

Переменные:

| Key | Value |
|-----|--------|
| `BOT_TOKEN` | токен @careofme_bot |
| `NODE_ENV` | `production` |
| `USE_WEBHOOK` | `1` |
| `WEBAPP_URL` | `https://careofme-production.up.railway.app` |
| `XAI_API_KEY` | опционально |
| `DATA_PATH` | `/tmp/careofme-store.json` |

## Лицензия

MIT


## AI-ментор и крипто-оплата

| Env | Где взять |
|-----|-----------|
| `XAI_API_KEY` | https://console.x.ai |
| `CRYPTO_PAY_TOKEN` | @CryptoBot → Crypto Pay → Create App |

Webhook Crypto Pay:
`https://careofme-production.up.railway.app/payments/cryptopay/webhook`

Тарифы: 199 ₽ (Забота) / 349 ₽ (Плюс), fiat RUB → USDT/TON/BTC…
