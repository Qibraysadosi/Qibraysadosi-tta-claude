# TTA CLAUDE

Fayllar bilan ishlaydigan agent — **sayt** (Hostinger VPS, xodimlar bilan birga) va **Windows dasturi** (kompyuterdagi papkalar bilan). Ichida Anthropic'ning [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (Claude Code'ning dvigateli) ishlaydi; to'lov — Console'dagi API kredit orqali. *Powered by Claude.*

Nimalar bor:

- 💬 Oqimli suhbat, markdown, kod bloklari, fayl biriktirish (rasm, PDF, docx, xlsx…), nusxa tugmalari
- 🛠 Agent vositalari: fayl o'qish/yozish/tahrir, buyruqlar (Bash), internet qidiruvi, sahifa o'qish, yordamchi agentlar
- 🔐 Ruxsat rejimlari: **Avto** (xavfli amallarni klassifikator tekshiradi), **Tahrir**, **Qo'lda**, **Reja** (avval reja, keyin tasdiq), admin uchun **To'liq**
- ❓ Agent savollari (variantli), reja tasdiqlash kartasi, ruxsat so'rovlari (bir marta / doim / rad etish + izoh)
- 📋 O'ng panel: **Jarayon** (qadamlar), **Natijalar** (yaratilgan fayllar — yuklab olish/ochish), **Agentlar** (yordamchilar), **Sessiyada ishlatilgan** (yuklamalar, qidiruv, tokenlar, narx, kontekst)
- 📁 Loyihalar (papkalar): fayl brauzeri, yuklash, `CLAUDE.md` ko'rsatmalari; desktopda kompyuterdagi istalgan papka
- 🤖 Maxsus agentlar: o'z ko'rsatmasi, vositalari, modeli; suhbatni agent nomidan boshlash yoki yordamchi sifatida chaqirilish
- ⏰ Rejali vazifalar: har kuni / haftada / har N daqiqa / bir marta — alohida suhbatda, byudjet chegarasi bilan
- 👥 Ko'p foydalanuvchi: admin + xodimlar, har kimning o'z papkalari va suhbatlari, oylik limit, foydalanish hisoboti
- 🌐 O'zbek / Rus interfeysi, yorug' / qorong'i mavzu, telefonga moslashgan
- 🔑 API kalit agent subprotsessiga ko'rinmaydi (lokal proksi orqali), maxfiy o'zgaruvchilar uzatilmaydi

## 1. Sayt (Hostinger VPS)

Talablar: Ubuntu, Docker + Docker Compose, Caddy (bepulkurs.uz allaqachon Caddy orqali ishlaydi).

```bash
cd /root
git clone https://github.com/Qibraysadosi/Qibraysadosi-tta-claude.git
cd tta-claude
bash install.sh                                  # kalitni so'raydi (yoki keyin admin panelida), docker build, ishga tushadi
bash install.sh site https://bepulkurs.uz/claude/   # Caddy'ga yo'l qo'shadi va qayta ishga tushiradi
```

- Birinchi admin: login `admin`, parol `data/ADMIN_PAROL.txt` faylida (birinchi kirishda o'zgartiring).
- Subdomen kerak bo'lsa: DNS'da `claude.bepulkurs.uz` → server IP, keyin `bash install.sh site https://claude.bepulkurs.uz`.
- Yangilash: `bash install.sh update`. Loglar: `docker compose logs -f`.
- Ma'lumotlar `data/` papkasida (foydalanuvchilar, loyihalar, suhbatlar, agent transkriptlari). Zaxira — shu papkani nusxalash.

Xodim qo'shish: **Boshqaruv → Foydalanuvchi qo'shish** (login, vaqtinchalik parol, oylik limit). Har xodim o'z "Ish papkasi"da ishlaydi; serverdagi boshqa papkalarga faqat admin loyiha sifatida ulanadi.

## 2. Windows dasturi

Tayyor o'rnatuvchi: GitHub → **Releases** → `TTA-CLAUDE-Setup-<versiya>.exe` (GitHub Actions `v*` tegi push qilinganda yig'adi; qo'lda: Actions → Desktop → Run workflow → artefakt).

O'rnatgach dastur API kalitni so'raydi (console.anthropic.com → API keys). Keyin **Loyihalar → Kompyuterdan papka tanlash** — agent shu papkadagi fayllar bilan ishlaydi. Ma'lumotlar `%APPDATA%\TTA CLAUDE\data` da.

Dasturni o'zingiz yig'ish (Windows'da): `npm ci && npm run dist:win` → `release/`.

## 3. Ishlab chiqish

```bash
npm ci
npm run build          # server (tsc) + web (esbuild)
npm test               # soxta dvigatel bilan 23 ta test
RUN_REAL=1 node --test dist/tests/real-engine.test.js   # haqiqiy Claude Code binari + soxta Anthropic API (kalit kerak emas)
npm run typecheck
node scripts/serve-fake.mjs 8097    # soxta dvigatel bilan UI (admin / admin123)
python3 scripts/ui_shots.py         # Playwright skrinshotlari (docs/screens)
ANTHROPIC_API_KEY=sk-ant-... ADMIN_PASSWORD=parol npm start   # haqiqiy dvigatel, http://127.0.0.1:8095
npm run desktop        # Electron (lokal)
```

Kod xaritasi: `server/` (Node, Agent SDK ustida: `engine.ts`, `runner.ts`, `service.ts`, `api.ts`, `ws.ts`, `proxy.ts`, `scheduler.ts`), `web/src/` (Preact SPA: `chat.tsx`, `panel.tsx`, `sidebar.tsx`, `pages*.tsx`, `i18n.ts`), `desktop/` (Electron), `shared/protocol.ts` (umumiy tiplar), `tests/` (soxta dvigatel + testlar).

## Brending

Ilova Anthropic mahsuloti emas; ichida Claude modellari ishlaydi («Powered by Claude»). Nomni `.env` dagi `APP_NAME` yoki admin panelidan o'zgartirish mumkin.
