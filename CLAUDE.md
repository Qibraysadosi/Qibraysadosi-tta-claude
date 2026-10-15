# TTA CLAUDE — Claude Code uchun loyiha qo'llanmasi

Fayllar bilan ishlaydigan agent ilovasi: bitta kod bazasi, ikki qobiq — sayt (Docker, Hostinger VPS, Caddy) va Windows dasturi (Electron).
Dvigatel: `@anthropic-ai/claude-agent-sdk` (Claude Code binari bilan keladi). Hisob: API kalit (Console krediti), claude.ai login ishlatilmaydi.

## Buyruqlar

```
npm ci
npm run build            # tsc (server/tests/shared → dist/) + esbuild (web/src → web/dist)
npm test                 # dist/tests/*.test.js — soxta dvigatel (tests/fake-engine.ts), ~5 s
npm run typecheck        # server + web + desktop
node scripts/serve-fake.mjs 8097   # soxta server, admin/admin123 — UI tekshirish
python3 scripts/ui_shots.py docs/screens   # Playwright skrinshotlar + brauzer xatolarini tekshiradi
npm run desktop          # Electron (xvfb-run bilan headless: TTA_SHOT=/tmp/x.png)
npm run dist:linux       # electron-builder dir (paketlashni tekshirish)
```

## Kod xaritasi

- `shared/protocol.ts` — mijoz ↔ server tiplari (REST javoblari, `ChatEvent`, `LiveEvent`, `ClientMessage`). O'zgartirsangiz ikki tomon ham yangilanadi.
- `server/engine.ts` — SDK qatlami (`SdkEngine.start` → `query()` streaming-input rejimida, `InputQueue`).
- `server/runner.ts` — sessiya jarayoni: SDK xabarlari → `ChatEvent` (JSONL ga yoziladi) / `LiveEvent`; `canUseTool` → `permission_request`; TodoWrite → `todos`; natija fayllari; narx hisobi; idle yopish; `headless` (rejali vazifa).
- `server/service.ts` — foydalanuvchilar, loyihalar, sessiyalar, agentlar, muhit (`envForUser`: CLAUDE_CONFIG_DIR per user, proksi kaliti), tizim prompti.
- `server/api.ts` (REST), `server/ws.ts` (WebSocket), `server/http.ts` (router, cookie, static, CSRF), `server/auth.ts`, `server/store.ts` (JSON to'plamlar + usage.jsonl), `server/files.ts` (xavfsiz yo'l), `server/proxy.ts` (kalit yashirish), `server/scheduler.ts`, `server/config.ts`, `server/app.ts` (yig'ish), `server/main.ts`.
- `web/src/` — Preact + signals: `state.ts` (global holat, oqim yig'ish), `chat.tsx` (xabarlar, vosita/ruxsat/savol/reja kartalari, Composer), `panel.tsx` (o'ng panel), `sidebar.tsx`, `pages.tsx`, `pages2.tsx`, `i18n.ts` (uz/ru), `styles.css` (tokenlar, yorug'/qorong'i).
- `desktop/main.ts` — Electron: server desktop rejimida (token auth), papka tanlash IPC; `desktop/preload.cjs`.
- `Dockerfile`, `docker-compose.yml`, `install.sh` (`site` — Caddy yo'li), `.env.example`; `.github/workflows/desktop.yml` (Windows .exe + testlar); `electron-builder.yml`.

## Qoidalar

1. Interfeys matnlari `web/src/i18n.ts` da (uz + ru) — kodga qattiq yozilmaydi. Server xabarlari o'zbekcha.
2. Maxfiylik: API kalit faqat `config.apiKey` / `data/config.json` / `.env`; subprotsessga proksi kaliti beriladi (`HIDE_API_KEY`). Loglarga, testlarga, commit'ga tushmasin.
3. Yangi SDK hodisasi → `runner.ts` `onMessage` + `shared/protocol.ts` + `state.ts` `handleLive` + render (`chat.tsx`/`panel.tsx`). Saqlanadigan hodisalar `persist=true` bilan.
4. Fayl yo'llari faqat `files.ts` `safeResolve` orqali; foydalanuvchi boshqa foydalanuvchi ma'lumotini ko'rmasligi `service.ts` tekshiruvlarida.
5. Har o'zgarishdan keyin: `npm run typecheck && npm test`; UI o'zgarsa `scripts/ui_shots.py` (brauzer xatosi bo'lsa chiqish kodi 1).
6. Versiya: `VERSION` + `package.json` `version` birga ko'tariladi; `v*` tegi Windows o'rnatuvchisini yig'adi.
7. Brending: "TTA CLAUDE — Powered by Claude"; Anthropic logotipi/Claude Code nomi ishlatilmaydi.
