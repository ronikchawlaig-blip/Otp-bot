# Telegram Device Manager

Telegram bot for Firebase device scanning, device selection, live event monitoring, and PostgreSQL-backed state.

## Railway deployment

Create a Railway service from this repository. Railway will use `railway.json` to build and run the API server.

Set these Railway variables:

- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `NEON_DATABASE_URL` — PostgreSQL connection string
- `ADMIN_TELEGRAM_ID` — optional admin Telegram numeric ID
- `FIREBASE_SCAN_INTERVAL_MS` — optional monitor interval, default `15000`
- `DEVICE_PAGE_SIZE` — optional device page size, default `8`

The service uses Railway's `PORT` automatically. The Telegram bot uses long polling, so keep the service running continuously.

## Local commands

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
```