#!/usr/bin/env bash
# TTA CLAUDE — Hostinger VPS (Ubuntu + Docker + Caddy) ga o'rnatish.
#   bash install.sh                       → .env, docker build, ishga tushirish (127.0.0.1:8095)
#   bash install.sh site [URL]            → Caddy'ga ulash: https://bepulkurs.uz/claude/ (yo'l) yoki https://claude.bepulkurs.uz (subdomen)
#   bash install.sh update                → git pull + qayta yig'ish
set -euo pipefail
cd "$(dirname "$0")"

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"

current() { grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true; }
save() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

site_setup() {
  URL="${1:-https://bepulkurs.uz/claude/}"
  HOST="$(echo "$URL" | sed -E 's#https?://([^/]+).*#\1#')"
  SUBPATH="$(echo "$URL" | sed -E 's#https?://[^/]+##; s#/$##')"
  PORT="$(current PORT)"; PORT="${PORT:-8095}"
  [ -f .env ] || { echo "❌ .env topilmadi — avval: bash install.sh"; exit 1; }
  [ -f "$CADDYFILE" ] || { echo "❌ $CADDYFILE topilmadi (Caddy o'rnatilmagan?)"; exit 1; }

  python3 - "$CADDYFILE" "$HOST" "$SUBPATH" "$PORT" <<'PY'
import re, sys, pathlib
path, host, sub, port = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
text = path.read_text()
if sub:
    if f"handle {sub}*" in text or f"handle {sub}/*" in text:
        print("Caddy: yo'l allaqachon bor")
    else:
        # BASE_PATH ilovaning o'zida ishlanadi — prefiks kesilmaydi (handle, handle_path emas)
        block = f"    handle {sub}* {{\n        reverse_proxy 127.0.0.1:{port}\n    }}\n"
        new, n = re.subn(r"(^[^\n#]*" + re.escape(host) + r"[^\n{]*\{[ \t]*\n)", lambda m: m.group(1) + block, text, count=1, flags=re.M)
        if not n:
            sys.exit(f"❌ Caddyfile ichida {host} bloki topilmadi — qo'lda qo'shing:\n{host} {{\n{block}}}")
        path.write_text(new); print(f"Caddy: {host}{sub} → 127.0.0.1:{port}")
else:
    if re.search(r"^[^\n#]*" + re.escape(host) + r"[^\n{]*\{", text, flags=re.M):
        print("Caddy: domen bloki allaqachon bor")
    else:
        path.write_text(text.rstrip("\n") + f"\n\n{host} {{\n    reverse_proxy 127.0.0.1:{port}\n}}\n")
        print(f"Caddy: {host} bloki qo'shildi (DNS A yozuvi shu serverga qarashi kerak)")
PY
  caddy validate --config "$CADDYFILE" >/dev/null && systemctl reload caddy && echo "Caddy: qayta yuklandi"
  save BASE_PATH "$SUBPATH"
  save PUBLIC_URL "${URL%/}/"
  save COOKIE_SECURE 1
  docker compose up -d --force-recreate
  echo "⏳ Server ishga tushmoqda..."; sleep 8
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "${URL%/}/api/app" || true)"
  echo "🌐 ${URL%/}/ → HTTP $CODE (200 bo'lsa tayyor)"
  [ -f data/ADMIN_PAROL.txt ] && { echo "🔑 Admin kirish ma'lumoti:"; cat data/ADMIN_PAROL.txt; }
}

if [ "${1:-}" = "site" ]; then shift; site_setup "$@"; exit 0; fi
if [ "${1:-}" = "update" ]; then
  git pull --ff-only
  docker compose up -d --build
  echo "✅ Yangilandi"; exit 0
fi

if ! docker compose version >/dev/null 2>&1; then echo "❌ Docker Compose topilmadi. Avval Docker o'rnating."; exit 1; fi
[ -f .env ] || cp .env.example .env

KEY_RE='^sk-ant-[A-Za-z0-9_-]{20,}$'
key="$(current ANTHROPIC_API_KEY)"
if [[ ! "$key" =~ $KEY_RE ]]; then
  read -rsp "Anthropic API kaliti (sk-ant-...; bo'sh qoldirsangiz admin panelidan kiritasiz): " key; echo
  key="${key//[[:space:]]/}"
  if [[ "$key" =~ $KEY_RE ]]; then save ANTHROPIC_API_KEY "$key"; else echo "ℹ️  Kalit keyinroq admin panelida kiritiladi."; fi
fi
chmod 600 .env
mkdir -p data
echo "⏳ Yig'ilmoqda va ishga tushirilmoqda (3–6 daqiqa)..."
docker compose up -d --build
sleep 10
docker compose logs --tail 10
if [ -f data/ADMIN_PAROL.txt ]; then echo "🔑 Admin kirish ma'lumoti:"; cat data/ADMIN_PAROL.txt; fi
echo "✅ Server: http://127.0.0.1:$(current PORT || echo 8095)$(current BASE_PATH)/  — saytga ulash: bash install.sh site https://bepulkurs.uz/claude/"
