"""UI skrinshotlari va tekshiruv (Playwright): soxta server 8097 portda ishlayotgan bo'lishi kerak.
Ishlatish: python3 scripts/ui_shots.py [out_dir]
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8097'
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/screens')
OUT.mkdir(parents=True, exist_ok=True)


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        page = ctx.new_page()
        errors: list[str] = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(BASE + '/')
        page.wait_for_selector('.login-card')
        page.screenshot(path=str(OUT / 'login.png'))
        page.fill('input[autocomplete=username]', 'admin')
        page.fill('input[type=password]', 'admin123')
        page.click('button.btn.primary.wide')
        page.wait_for_selector('.home-hero')
        page.screenshot(path=str(OUT / 'home.png'))

        # suhbat: reja + vosita + savol
        page.fill('.composer-input', 'Hisobot uchun reja tuz')
        page.keyboard.press('Enter')
        page.wait_for_selector('.todos .todo', timeout=10000)
        page.wait_for_selector('.result-line', timeout=10000)
        page.fill('.composer-input', 'vosita ishlat: papkani ko\'r')
        page.keyboard.press('Enter')
        page.wait_for_selector('.perm-card.pending', timeout=10000)
        page.screenshot(path=str(OUT / 'permission.png'))
        page.click('.perm-card.pending button.btn.primary')
        page.wait_for_selector('.tool-card.done', timeout=10000)
        page.fill('.composer-input', 'savol ber')
        page.keyboard.press('Enter')
        page.wait_for_selector('.q-card.pending', timeout=10000)
        page.click('.q-opt >> nth=0')
        page.screenshot(path=str(OUT / 'question.png'))
        page.click('.q-card.pending button.btn.primary')
        page.wait_for_function("document.querySelectorAll('.result-line').length >= 3", timeout=10000)
        page.fill('.composer-input', 'hisobot yoz')
        page.keyboard.press('Enter')
        page.wait_for_selector('.files .file-row', timeout=10000)
        time.sleep(0.5)
        page.screenshot(path=str(OUT / 'session.png'))
        page.click('.tool-card .tool-head >> nth=0')
        page.screenshot(path=str(OUT / 'session-tool-open.png'))

        # qorong'i mavzu
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.screenshot(path=str(OUT / 'session-dark.png'))
        page.evaluate("document.documentElement.dataset.theme='light'")

        # sahifalar
        for route, name, sel in [('/projects', 'projects', '.cards'), ('/agents', 'agents', '.page-body'), ('/schedules', 'schedules', '.page-body'), ('/settings', 'settings', '.form'), ('/admin', 'admin', '.table'), ('/results', 'results', '.page-body')]:
            page.goto(BASE + '/#' + route)
            page.wait_for_selector(sel)
            time.sleep(0.3)
            page.screenshot(path=str(OUT / f'{name}.png'))

        # mobil
        mobile = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        mp = mobile.new_page()
        mp.goto(BASE + '/')
        mp.fill('input[autocomplete=username]', 'admin')
        mp.fill('input[type=password]', 'admin123')
        mp.click('button.btn.primary.wide')
        mp.wait_for_selector('.home-hero')
        mp.screenshot(path=str(OUT / 'mobile-home.png'))
        mp.click('.recent-item >> nth=0')
        mp.wait_for_selector('.messages')
        time.sleep(0.5)
        mp.screenshot(path=str(OUT / 'mobile-session.png'))
        browser.close()
        if errors:
            print('BRAUZER XATOLARI:')
            for e in errors:
                print(' -', e)
            sys.exit(1)
        print('OK, skrinshotlar:', OUT)


if __name__ == '__main__':
    main()
