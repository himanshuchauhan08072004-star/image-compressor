"""Phase 9: shell, theme, search, directory, upload zone, mobile menu. Real Chromium against dist/ with the real CSP."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import *
from playwright.sync_api import sync_playwright
PORT = 4219; BASE = f'http://127.0.0.1:{PORT}'

def main():
    srv = start_server(PORT)
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(); errors = []
            def watch(pg):
                pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); pg.on('pageerror', lambda e: errors.append(str(e)))
            # ---- theme: no flash, persistence, system preference
            c = b.new_context(color_scheme='light'); p = c.new_page(); watch(p)
            p.goto(BASE + '/'); check('no stored choice + light system -> light theme', p.get_attribute('html', 'data-theme') == 'light')
            p.click('.theme-btn'); check('toggle -> dark', p.get_attribute('html', 'data-theme') == 'dark')
            p.reload(); check('choice persists across reload', p.get_attribute('html', 'data-theme') == 'dark')
            bg_dark = p.evaluate("getComputedStyle(document.body).backgroundColor"); p.click('.theme-btn')
            check('theme changes the real page background', bg_dark != p.evaluate("getComputedStyle(document.body).backgroundColor"))
            check('theme button label reflects the next action', 'dark' in p.get_attribute('.theme-btn', 'aria-label').lower())
            c.close()
            c = b.new_context(color_scheme='dark'); p = c.new_page(); watch(p); p.goto(BASE + '/')
            check('dark system -> dark theme at first paint', p.get_attribute('html', 'data-theme') == 'dark'); c.close()
            # ---- home
            c = b.new_context(viewport={'width': 1280, 'height': 900}); p = c.new_page(); watch(p); p.goto(BASE + '/'); p.wait_for_timeout(1500)
            check('home: one h1, one dropzone, 14 tool cards', p.locator('h1').count() == 1 and p.locator('.dropzone').count() == 1 and p.locator('.task-card').count() == 14)
            check('home: every card links to a real route', all(h.startswith('/') for h in p.eval_on_selector_all('.task-card', 'els=>els.map(e=>e.getAttribute("href"))')))
            demo = p.locator('.demo-tag').all_text_contents()
            check('hero demo shows two REAL encoded sizes (Q95 bigger than Q25)', len(demo) == 2 and 'KB' in demo[0] and 'KB' in demo[1], str(demo))
            sizes = [float(t.split('·')[1].split()[0]) for t in demo] if len(demo) == 2 else [0, 1]
            check('Q95 blob larger than Q25 blob', sizes[0] > sizes[1], str(sizes))
            p.eval_on_selector('.demo-range', "(e)=>{e.value=80;e.dispatchEvent(new Event('input',{bubbles:true}))}")
            check('compare slider moves the divider', p.evaluate("getComputedStyle(document.querySelector('.demo-handle')).left") != '0px')
            heads = p.eval_on_selector_all('h1,h2,h3,h4', 'els=>els.map(e=>+e.tagName[1])'); skip = any(b2 - a > 1 for a, b2 in zip(heads, heads[1:]))
            check('home: heading levels never skip downward', not skip, str(heads))
            # invalid file feedback on the real upload zone
            p.set_input_files('input[type=file]', fx('fake.jpg')); p.wait_for_selector('.dz-error:not([hidden])')
            check('invalid file -> readable inline error, zone usable again', len(p.inner_text('.dz-error')) > 10 and p.get_attribute('.dropzone', 'aria-busy') == 'false')
            p.set_input_files('input[type=file]', fx('photo.jpg')); p.wait_for_selector('.workbench'); ready(p)
            check('upload from home opens the real Compress workspace', p.url.endswith('/compress') and p.locator('button:text-is("Download result")').count() == 1)
            check('tool page: breadcrumb + one h1', p.locator('.crumbs').count() == 1 and p.locator('h1').count() == 1)
            f, name = download(p, 'p9'); check('download still produces a real file', os.path.getsize(f) > 1000, name)
            # drag state
            p.goto(BASE + '/'); p.dispatch_event('.dropzone', 'dragenter', {'dataTransfer': p.evaluate_handle('()=>new DataTransfer()')})
            check('drag over shows drop feedback', 'drag' in p.get_attribute('.dropzone', 'class') and 'Release' in p.inner_text('.dz-title'))
            # ---- search palette
            p.goto(BASE + '/'); p.keyboard.press('/'); p.wait_for_selector('dialog.palette[open]')
            check('"/" opens search, input focused', p.evaluate("document.activeElement.id") == 'palette-input')
            p.keyboard.type('passp'); p.wait_for_timeout(100)
            check('search returns real tool', p.locator('.pal-item').count() >= 1 and 'Passport' in p.inner_text('.pal-item'))
            p.keyboard.press('Enter'); p.wait_for_timeout(400)
            check('Enter navigates to the tool route', p.url.endswith('/photo/passport') and p.locator('dialog.palette[open]').count() == 0)
            p.keyboard.press('Control+k'); p.wait_for_selector('dialog.palette[open]'); p.keyboard.type('zzzqq')
            check('search with no match shows a helpful empty state', 'No tool matches' in p.inner_text('.pal-empty'))
            p.keyboard.press('Escape'); p.wait_for_timeout(200)
            check('Esc closes search', p.locator('dialog.palette[open]').count() == 0)
            # ---- directory
            p.goto(BASE + '/tools'); check('/tools lists 14 tools', p.locator('.task-card').count() == 14)
            p.click('.chip[data-group="privacy"]'); check('category filter -> 2 privacy tools, pressed state', p.locator('.task-card').count() == 2 and p.get_attribute('.chip[data-group="privacy"]', 'aria-pressed') == 'true')
            p.click('.chip[data-group="all"]'); p.fill('#tools-q', 'heic')
            check('search "heic" finds Convert', p.locator('.task-card').count() >= 1 and 'Convert' in ' '.join(p.locator('.task-card h2').all_text_contents()))
            p.fill('#tools-q', 'qqqzzz')
            check('no results -> empty state with working clear button', p.locator('.empty').count() == 1)
            p.click('.empty button:text-is("Clear search")'); check('clear restores all tools', p.locator('.task-card').count() == 14 and p.input_value('#tools-q') == '')
            p.click('.task-card:has-text("Print Layout")'); p.wait_for_selector('.batch .dropzone, .workbench'); check('card opens the real tool', p.url.endswith('/print'))
            # home category link preselects directory filter
            p.goto(BASE + '/'); p.click('a[data-cat="documents"]'); p.wait_for_selector('.filters')
            check('home category link opens directory filtered', p.locator('.task-card').count() == 2 and p.get_attribute('.chip[data-group="documents"]', 'aria-pressed') == 'true')
            # keyboard: skip link + focus visible
            p.goto(BASE + '/'); p.keyboard.press('Tab'); check('first Tab stop is the skip link', p.evaluate("document.activeElement.className") == 'skip-link')
            # unknown route
            p.goto(BASE + '/nope'); p.wait_for_timeout(300); check('unknown route falls back to home', p.url.rstrip('/').endswith(str(PORT)))
            c.close()
            # ---- mobile
            c = b.new_context(viewport={'width': 375, 'height': 800}, has_touch=True); p = c.new_page(); watch(p)
            for path in ['/', '/tools', '/print', '/workflows']:
                p.goto(BASE + path); p.wait_for_timeout(700)
                check(f'mobile 375 {path}: no horizontal overflow', p.evaluate('document.documentElement.scrollWidth - innerWidth') <= 1)
            p.goto(BASE + '/'); check('mobile: tool nav hidden until menu opens', not p.locator('#toolNav').is_visible())
            p.click('.menu-btn'); check('menu opens, aria-expanded true', p.is_visible('#toolNav') and p.get_attribute('.menu-btn', 'aria-expanded') == 'true')
            p.click('#toolNav a:text-is("Resize")'); p.wait_for_timeout(400)
            check('menu link navigates and closes the menu', p.url.endswith('/resize') and not p.is_visible('#toolNav'))
            tap = p.eval_on_selector_all('.menu-btn,.theme-btn,.search-btn', 'els=>els.map(e=>Math.min(e.getBoundingClientRect().width,e.getBoundingClientRect().height))')
            check('header controls are at least 40px (touch)', all(x >= 40 for x in tap), str(tap)); c.close()
            # ---- reduced motion
            c = b.new_context(reduced_motion='reduce'); p = c.new_page(); p.goto(BASE + '/')
            dur = p.evaluate("getComputedStyle(document.querySelector('.task-card')).transitionDuration")
            check('prefers-reduced-motion collapses transitions', dur.startswith('0.001') or dur.startswith('1e-'), dur); c.close()
            # ---- network: nothing but this origin
            c = b.new_context(); p = c.new_page(); watch(p); reqs = []; p.on('request', lambda r: reqs.append(r.url))
            p.goto(BASE + '/'); p.wait_for_timeout(1500); p.goto(BASE + '/tools')
            check('only same-origin requests (blob/data excluded)', all(u.startswith(BASE) or u.startswith(('blob:', 'data:')) for u in reqs), str([u for u in reqs if not u.startswith(BASE)][:3]))
            check('no console errors across the checks', not errors, str(errors[:3])); c.close(); b.close()
    finally: srv.kill()
    finish()
main()
