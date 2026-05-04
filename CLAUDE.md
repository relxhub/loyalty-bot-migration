# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Run server (app.js, port 3000 or $PORT)
npm run dev            # Same as start — there is no hot-reload setup
npm run prisma:migrate # Apply schema changes locally (prisma migrate dev)
npm run prisma:generate
npm run prisma:studio
npm run prisma:seed    # Run prisma/seed.js
```

There is no test runner, no linter, and no build step. The only "build" is `prisma generate` which runs automatically via `postinstall`.

To inspect data quickly, prefer `npm run prisma:studio` over writing one-off scripts.

## Architecture

This is a **Telegram-first loyalty + e-commerce platform** running as a single Node.js process. All HTTP, WebSocket, bot webhooks, and cron jobs share the same Express server (`app.js`).

### Two Telegram bots, one process

- **Admin bot** (`ADMIN_BOT_TOKEN`) — uses **webhook** at `/webhook/admin`. Handlers in `src/handlers/admin.handlers.js`. Used by staff for inventory, refunds, coupon management.
- **Order/customer bot** (`ORDER_BOT_TOKEN`) — **no webhook**, only configured to expose the Mini App menu button pointing to `${PUBLIC_URL}/home.html`. Outbound only (sends customer notifications via `notification.service.js`). Handlers exist in `src/handlers/customer.handlers.js` but the bot is not actively listening.

Bot instances are exported from `app.js` so services can call `customerBot.telegram.sendMessage(...)` without circular setup.

### HTTP API

All REST endpoints live in **one file** `src/routes/api.routes.js` (~2,100 lines). Routes are mounted at `/api`. When adding endpoints, follow the existing pattern: most routes start with an `/api/auth`-style telegramId/initData verification block, then a Prisma query, then a JSON response.

The first inline middleware in `app.js` logs every `/api/*` request — keep this in mind when grepping logs.

### Database (Prisma + PostgreSQL on Railway)

Schema in `prisma/schema.prisma`. Key models: `Customer`, `Referral`, `PointTransaction`, `Product`, `Category`, `Coupon`, `Order`, `OrderItem`, `Campaign`, `ShippingAddress`. Customer IDs use a custom format (e.g. `OT99999`) — not auto-incremented.

Don't add migrations without coordinating with the user — the production DB is on Railway and migrations against it require a deploy.

### Frontend

`public/` is plain static HTML served by Express — **not** a SPA. Each page is its own entry:

- `home.html` — landing
- `products.html` — store catalog (split into `products.html` + `products.css` + `products.js` after a refactor)
- `dashboard.html` — membership card / points / coupons
- `referral.html` — referral page (Affiliate Program is reserved for the next phase via a disabled tab)
- `payment.html` — checkout
- `index.html` — auxiliary fallback

All four core pages share a 4-button bottom nav: **หน้าหลัก / เมนูสินค้า / แนะนำเพื่อน / บัตรสมาชิก**. When editing nav, update all four files consistently.

Pages are loaded via the Telegram WebApp SDK (`telegram-web-app.js`). User identity comes from `tg.initData` POSTed to `/api/auth`. Always check `tg.initData` before treating a request as authenticated.

### Real-time updates

`socket.io` is initialized in `app.js` and stored on the express app via `app.set('socketio', io)`. Routes pull it back via `req.app.get('socketio')`. There is currently **only one event** emitted: `product_update` from `PATCH /api/products/:id/status` (admin stock toggle). The `products.html` client listens to it and patches state without re-rendering. Other state (banners/categories/store settings) still relies on a 30-second client poll.

If you add real-time features, follow the same pattern: emit from the API route after mutation, listen on the relevant page.

### Background jobs

`src/jobs/scheduler.js` registers cron jobs (point expiry, daily reports, etc.) using `node-cron`. `src/jobs/monitor.job.js` runs a long-poll comparing DB state and broadcasting changes via socket. Both start from `app.js#startServer`.

### Configuration

`src/config/config.js` exposes `loadConfig()` and `getConfig(key, default)`. Config values are loaded from a DB table (`SystemConfig`) at startup, **not** purely from `.env`. The config cache is loaded once before any other init runs. To add a config knob, seed it via `prisma/seed_system_config.js`.

`.env` holds: `DATABASE_URL`, `ADMIN_BOT_TOKEN`, `ORDER_BOT_TOKEN`, `PUBLIC_URL`, `SUPER_ADMIN_TELEGRAM_ID`, `PORT`.

## Project conventions to respect

- **Repo root has many `fix_*.cjs`, `test_*.js`, `check_*.js` files** — these are the user's throwaway debugging scripts, not part of the app. Don't refactor or import from them. They're untracked but not gitignored, so leave them alone unless asked.
- **Sensitive CSVs** (`CustomerData.csv`, `Admins.csv`, etc.) are gitignored — never read or commit them unprompted.
- **Thai language is the default** for all user-facing text in `public/*.html`. UI copy should be in Thai; comments and identifiers can stay English.
- **The user prefers small, focused commits** with conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `style:`). When the user says "push ให้ฉัน" / "push", they mean commit + `git push origin main` directly (no PR).
- **`public/products.html` is split** into HTML/CSS/JS files. Don't re-inline CSS or JS into the HTML.
