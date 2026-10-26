"""End-to-end tests in real Chromium against the production build, served with the real CSP headers.
Run: npm run build && python3 tests/e2e/make_fixtures.py && python3 tests/e2e/run.py"""
import os, re, subprocess, sys, time, tempfile
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FIX = os.path.join(ROOT, 'tests', 'e2e', 'fixtures')
PORT = 4199; BASE = f'http://127.0.0.1:{PORT}'
results = []; tmp = tempfile.mkdtemp()

def check(name, cond, detail=''):
    results.append((bool(cond), name, detail)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if (detail and not cond) else ''), flush=True)

def fx(n): return os.path.join(FIX, n)
def size_of(t):
    m = re.match(r'([\d.]+)\s*(B|KB|MB)', t.strip()); v = float(m.group(1))
    return v * {'B': 1, 'KB': 1024, 'MB': 1048576}[m.group(2)]
def txt(page, key): return page.inner_text(f'[data-r="{key}"]').strip()
def ready(page):
    page.wait_for_timeout(350)
    page.wait_for_function("() => { const l=document.querySelector('[data-r=barLabel]'); return l && l.textContent !== 'processing…'; }", timeout=30000)
def load(page, name, path='/'):
    page.goto(BASE + path); page.set_input_files('input[type=file]', fx(name)); page.wait_for_selector('.workbench'); ready(page)
def set_range(page, v): page.eval_on_selector('#quality', "(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))}", str(v))
def set_num(page, sel, v): page.fill(sel, str(v)); ready(page)
def download(page, name='dl'):
    with page.expect_download() as d: page.click('button:text-is("Download result")')
    p = os.path.join(tmp, name + '_' + d.value.suggested_filename); d.value.save_as(p); return p, d.value.suggested_filename
def notices(page): return ' | '.join(page.locator('.notice').all_inner_texts())
def goto_tool(page, label): page.click(f'#toolNav a:text-is("{label}")'); page.wait_for_timeout(300); page.wait_for_selector('.workbench'); ready(page)

server = subprocess.Popen(['node', 'tests/e2e/serve.mjs'], cwd=ROOT, env={**os.environ, 'PORT': str(PORT)})
time.sleep(1)
try:
  with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errors, hosts = [], set()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: hosts.add(r.url.split('/')[2]) if r.url.startswith('http') else None)

    # ---------- Phase 0 regression ----------
    page.goto(BASE + '/')
    check('home renders hero + dropzone + 14 task cards', page.locator('h1').count() == 1 and page.locator('.dropzone').count() == 1 and page.locator('.task-card').count() == 14)
    check('nav shows only ready tools (grouped by category since Phase 9)', page.locator('#toolNav a').all_text_contents() == ['Compress', 'Resize', 'Crop', 'Convert', 'Remove Metadata', 'Blur & Redact', 'Batch Processing', 'Document Workflows', 'Passport Photo', 'Print Layout', 'Signature Cleaner', 'Watermark Studio', 'Smart Enhancement', 'Background Remover'])
    load(page, 'photo.jpg')
    check('drop on home redirects to /compress', page.url.endswith('/compress'))
    check('format defaults to JPG for jpeg input', page.input_value('#format') == 'image/jpeg')
    check('original size + dims shown', txt(page, 'dimsBefore') == '3000 × 2000' and size_of(txt(page, 'sizeBefore')) > 2.5e6)
    set_range(page, 30); ready(page); s30 = size_of(txt(page, 'sizeAfter'))
    set_range(page, 90); ready(page); s90 = size_of(txt(page, 'sizeAfter'))
    check('quality slider changes size (30% < 90%)', s30 < s90, f'{s30} {s90}')
    check('stats panel: reduced % and output format', txt(page, 'statSaved').startswith('−') and txt(page, 'statOutput').startswith('JPG · 3000 × 2000'), txt(page, 'statOutput'))
    p, fname = download(page)
    check('download name photo-compressed.jpg', fname == 'photo-compressed.jpg', fname)
    check('downloaded size equals displayed', abs(os.path.getsize(p) - size_of(txt(page, 'sizeAfter'))) < 0.006 * os.path.getsize(p), f'{os.path.getsize(p)} vs {txt(page, "sizeAfter")}')
    page.click('button:text-is("Start over")'); page.wait_for_selector('.dropzone')
    check('Start over returns to dropzone', page.locator('.workbench').count() == 0)

    load(page, 'alpha.png')
    check('PNG input defaults to PNG, quality disabled', page.input_value('#format') == 'image/png' and page.is_disabled('#quality'))
    page.select_option('#format', 'image/jpeg'); ready(page)
    p, fname = download(page, 'alpha')
    im = Image.open(p).convert('RGB')
    check('transparent PNG -> JPG has WHITE background (not black)', min(im.getpixel((5, 5))) >= 240, str(im.getpixel((5, 5))))
    check('alpha subject preserved (red centre)', im.getpixel((400, 300))[0] > 180 and im.getpixel((400, 300))[1] < 90)
    check('jpg download extension', fname.endswith('.jpg'), fname)

    for name, label in [('anim.gif', 'GIF'), ('fake.jpg', 'not an image'), ('empty.jpg', 'empty')]:
        page.goto(BASE + '/'); page.set_input_files('input[type=file]', fx(name)); page.wait_for_selector('.dz-error:not([hidden])')
        check(f'{label} rejected with inline message', page.locator('.workbench').count() == 0 and len(page.inner_text('.dz-error')) > 10, page.inner_text('.dz-error'))
    page.goto(BASE + '/'); page.set_input_files('input[type=file]', fx('huge.png')); page.wait_for_selector('.dz-error:not([hidden])', timeout=30000)
    check('110 MP image rejected safely (no crash)', page.locator('.workbench').count() == 0, page.inner_text('.dz-error'))

    # ---------- Target KB ----------
    load(page, 'photo.jpg'); page.click('button:text-is("Target size")'); page.click('.chip:text-is("100 KB")'); ready(page)
    sz = size_of(txt(page, 'sizeAfter'))
    check('target 100 KB: under limit and close (>=70 KB)', 70 * 1024 <= sz <= 100 * 1024, f'{sz/1024:.1f} KB')
    check('target label shows target + quality + format', 'target 100.0 KB' in txt(page, 'barLabel') and txt(page, 'statOutput').startswith('JPG'), txt(page, 'barLabel'))
    check('target keeps full dimensions when quality search suffices', txt(page, 'dimsAfter') == '3000 × 2000' or 'scaled' in txt(page, 'barLabel'), txt(page, 'dimsAfter'))
    p, _ = download(page, 't100'); check('downloaded target file really <= 100 KB', os.path.getsize(p) <= 100 * 1024, str(os.path.getsize(p)))
    set_num(page, '#targetKB', 20)
    sz = size_of(txt(page, 'sizeAfter')); check('target 20 KB: reached by also scaling down', sz <= 20 * 1024 and 'scaled' in txt(page, 'barLabel'), f'{sz/1024:.1f} KB {txt(page,"barLabel")}')
    set_num(page, '#targetKB', 1)
    check('target 1 KB: graceful (explains or fits), never crashes', 'Could not get under' in notices(page) or size_of(txt(page, 'sizeAfter')) <= 1024, notices(page))
    print('     1 KB result ->', txt(page, 'sizeAfter'), txt(page, 'dimsAfter'), '|', notices(page)[:140])
    check('impossible target still downloadable (closest possible)', page.is_enabled('button:text-is("Download result")'))
    page.fill('#targetKB', ''); page.wait_for_timeout(300)
    check('empty target flagged invalid', page.get_attribute('#targetKB', 'aria-invalid') == 'true')
    set_num(page, '#targetKB', 8000); check('target above original: note "already under"', 'already under' in notices(page), notices(page))
    page.select_option('#format', 'image/webp'); set_num(page, '#targetKB', 150)
    check('WEBP target 150 KB works', txt(page, 'statOutput').startswith('WEBP') and size_of(txt(page, 'sizeAfter')) <= 150 * 1024, txt(page, 'statOutput') + ' ' + txt(page, 'sizeAfter'))
    _, fname = download(page, 'w'); check('webp extension', fname.endswith('.webp'), fname)
    load(page, 'alpha.png'); page.click('button:text-is("Target size")'); ready(page)
    check('PNG + Target size auto-switches to JPG with note', page.input_value('#format') == 'image/jpeg' and 'Switched to JPG' in notices(page), notices(page))

    # ---------- Resize ----------
    load(page, 'photo.jpg'); goto_tool(page, 'Resize')
    check('nav to Resize keeps image (no re-upload), URL updated', page.url.endswith('/resize') and page.locator('#rw').count() == 1)
    check('resize inputs start at original dims', page.input_value('#rw') == '3000' and page.input_value('#rh') == '2000')
    set_num(page, '#rw', 1000); check('width 1000 + lock -> height 667', page.input_value('#rh') == '667' and txt(page, 'dimsAfter') == '1000 × 667', txt(page, 'dimsAfter'))
    check('before/after dims both visible', txt(page, 'dimsBefore') == '3000 × 2000')
    set_num(page, '#rh', 400); check('height 400 + lock -> width 600', page.input_value('#rw') == '600' and txt(page, 'dimsAfter') == '600 × 400')
    set_num(page, '#rw', 5000)
    check('upscale blocked by default with explanation, no output', 'Allow enlarging' in notices(page) and txt(page, 'sizeAfter') == '—' and page.is_disabled('button:text-is("Download result")'), notices(page))
    page.check('#rup'); ready(page); check('Allow enlarging -> 5000 × 3333', txt(page, 'dimsAfter') == '5000 × 3333', txt(page, 'dimsAfter'))
    page.uncheck('#rup'); page.click('button:text-is("Reset size")'); ready(page); check('Reset size restores original', page.input_value('#rw') == '3000' and page.locator('.edit-chip').count() == 0)
    page.click('.chip:text-is("50%")'); ready(page); check('50% preset -> 1500 × 1000', txt(page, 'dimsAfter') == '1500 × 1000')
    page.click('button:text-is("Exact size")'); page.click('.chip:text-is("1080 × 1080")'); ready(page)
    check('exact 1080 × 1080 (fill)', txt(page, 'dimsAfter') == '1080 × 1080', txt(page, 'dimsAfter'))
    page.select_option('#rfit', 'contain'); ready(page); p, _ = download(page, 'contain'); im = Image.open(p).convert('RGB')
    check('contain: exact size with WHITE borders, photo centred', im.size == (1080, 1080) and min(im.getpixel((540, 5))) >= 240 and im.getpixel((540, 540)) != (255, 255, 255), str(im.size))
    page.select_option('#rfit', 'stretch'); ready(page); check('stretch: exact size', txt(page, 'dimsAfter') == '1080 × 1080')
    page.click('.chip:text-is("1080 × 1350")'); ready(page); check('exact 1080 × 1350 from landscape (fill)', txt(page, 'dimsAfter') == '1080 × 1350')
    page.click('.chip:text-is("1920 × 1080")'); ready(page); check('exact 1920 × 1080', txt(page, 'dimsAfter') == '1920 × 1080')
    set_num(page, '#rw', 4000); check('exact needing upscale blocked too', txt(page, 'sizeAfter') == '—' and 'larger than the original' in notices(page))
    page.click('button:text-is("Reset size")'); page.click('button:text-is("Scale")'); page.uncheck('#rlock'); set_num(page, '#rw', 800); set_num(page, '#rh', 800)
    check('unlocked proportions: independent width/height', txt(page, 'dimsAfter') == '800 × 800')
    page.check('#rlock'); page.click('button:text-is("Target size")'); page.click('.chip:text-is("50 KB")'); ready(page)
    check('resize + target KB combine', size_of(txt(page, 'sizeAfter')) <= 50 * 1024, txt(page, 'sizeAfter'))
    _, fname = download(page, 'rs'); check('download suffix -resized', '-resized.' in fname, fname)

    # ---------- Crop ----------
    load(page, 'photo.jpg'); goto_tool(page, 'Crop')
    check('crop starts with whole image, no edit chip', 'Whole image' in page.inner_text('.tool-hint') and page.locator('.edit-chip').count() == 0)
    page.click('.chip:text-is("1:1")'); ready(page)
    check('1:1 -> 2000 × 2000, output matches', txt(page, 'dimsAfter') == '2000 × 2000' and 'Crop 2000 × 2000' in page.inner_text('.edits'))
    page.click('.chip:text-is("16:9")'); ready(page); w, hh = [int(x) for x in txt(page, 'dimsAfter').split(' × ')]
    check('16:9 -> ratio correct', abs(w / hh - 16 / 9) < 0.01, f'{w}x{hh}')
    page.click('.chip:text-is("9:16")'); ready(page); w, hh = [int(x) for x in txt(page, 'dimsAfter').split(' × ')]
    check('9:16 on landscape source fits inside', hh <= 2000 and abs(w / hh - 9 / 16) < 0.01, f'{w}x{hh}')
    page.click('.chip:text-is("4:5")'); ready(page)
    page.locator('.crop-h-se').scroll_into_view_if_needed(); hb = page.locator('.crop-h-se').bounding_box(); sx, sy = hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2
    before = txt(page, 'dimsAfter')
    page.mouse.move(sx, sy); page.mouse.down(); page.mouse.move(sx - 60, sy - 30, steps=6); page.mouse.up(); ready(page)
    w, hh = [int(x) for x in txt(page, 'dimsAfter').split(' × ')]
    check('drag SE handle shrinks crop, 4:5 ratio kept', txt(page, 'dimsAfter') != before and abs(w / hh - 0.8) < 0.01, f'{before} -> {w}x{hh}')
    bb = page.locator('.crop-box').bounding_box(); st = page.locator('.crop-stage').bounding_box()
    page.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); page.mouse.down(); page.mouse.move(st['x'] - 500, st['y'] - 500, steps=5); page.mouse.up(); ready(page)
    nb = page.locator('.crop-box').bounding_box()
    check('move clamps inside image (box stays within stage)', nb['x'] >= st['x'] - 2 and nb['y'] >= st['y'] - 2, f'{nb} {st}')
    page.click('.chip:text-is("Free")')
    hb = page.locator('.crop-h-e').bounding_box(); ex_, ey_ = hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2
    w0 = int(txt(page, 'dimsAfter').split(' × ')[0]); h0 = int(txt(page, 'dimsAfter').split(' × ')[1])
    page.mouse.move(ex_, ey_); page.mouse.down(); page.mouse.move(ex_ - 40, ey_ + 200, steps=5); page.mouse.up(); ready(page)
    w1, h1 = [int(x) for x in txt(page, 'dimsAfter').split(' × ')]
    check('Free mode: edge handle changes only width', w1 < w0 and h1 == h0, f'{w0}x{h0} -> {w1}x{h1}')
    page.focus('.crop-box'); page.keyboard.press('ArrowRight'); ready(page); check('keyboard arrows move crop (accessible)', page.locator('.edit-chip').count() == 1)
    _, fname = download(page, 'c'); check('download suffix -cropped', '-cropped.' in fname, fname)
    page.click('button:text-is("Reset crop")'); ready(page)
    check('Reset crop -> whole image again', txt(page, 'dimsAfter') == '3000 × 2000' and page.locator('.edit-chip').count() == 0)

    # EXIF orientation: stored 2000x1500 + Orientation 6 => displays 1500x2000
    load(page, 'rotated.jpg')
    check('EXIF-rotated photo reports DISPLAY dims 1500 × 2000', txt(page, 'dimsBefore') == '1500 × 2000', txt(page, 'dimsBefore'))
    goto_tool(page, 'Crop'); page.click('.chip:text-is("1:1")'); ready(page)
    cs = page.locator('.crop-canvas').bounding_box(); check('crop canvas drawn portrait (taller than wide)', cs['height'] > cs['width'])
    p, _ = download(page, 'rot'); im = Image.open(p).convert('RGB')
    check('rotated crop is 1500 × 1500', im.size == (1500, 1500), str(im.size))
    check('orientation correct: RED at top, BLUE at left-centre', im.getpixel((750, 10))[0] > 200 and im.getpixel((750, 10))[2] < 80 and im.getpixel((10, 750))[2] > 200 and im.getpixel((10, 750))[0] < 80, f'{im.getpixel((750,10))} {im.getpixel((10,750))}')

    # ---------- Shell / routing / cross-tool ----------
    load(page, 'photo.jpg'); goto_tool(page, 'Crop'); page.click('.chip:text-is("1:1")'); ready(page)
    goto_tool(page, 'Resize')
    check('crop edit shared across tools; resize base = cropped size', page.input_value('#rw') == '2000' and page.input_value('#rh') == '2000' and 'Crop 2000 × 2000' in page.inner_text('.edits'))
    set_num(page, '#rw', 500); check('crop + resize combine -> 500 × 500', txt(page, 'dimsAfter') == '500 × 500')
    check('both edits listed', page.locator('.edit-chip').count() == 2)
    page.click('[aria-label="Remove Crop 2000 × 2000"]'); ready(page)
    check('removing crop chip from resize tool resets base', page.input_value('#rw') in ('500', '3000') and page.locator('.edit-chip').count() <= 1)
    page.go_back(); page.wait_for_timeout(400)
    check('browser Back works within the app', page.url.endswith('/crop') and page.locator('.workbench').count() == 1, page.url)
    page.goto(BASE + '/resize'); check('deep link /resize without image shows tool landing + dropzone', page.locator('.dropzone').count() == 1 and 'exactly right' in page.inner_text('h1'))
    check('page title per tool', 'Resize' in page.title())
    page.goto(BASE + '/privacy'); page.wait_for_timeout(300); check('planned tool /privacy is not routable -> home', page.url == BASE + '/')
    page.goto(BASE + '/nope'); page.wait_for_timeout(300); check('unknown path -> home', page.url == BASE + '/')
    page.goto(BASE + '/compress/'); page.wait_for_timeout(300); check('trailing slash normalised', page.locator('.dropzone').count() == 1)

    # ---------- Privacy / CSP ----------
    check('no console/page errors (CSP violations included)', not errors, ' | '.join(errors)[:300])
    check('only same-origin requests (no third parties)', hosts == {f'127.0.0.1:{PORT}'}, str(hosts))

    # ---------- Mobile ----------
    mctx = browser.new_context(viewport={'width': 375, 'height': 812}, has_touch=True, is_mobile=True, accept_downloads=True)
    m = mctx.new_page()
    for path in ['/compress', '/resize', '/crop']:
        m.goto(BASE + path); m.set_input_files('input[type=file]', fx('photo.jpg')); m.wait_for_selector('.workbench'); ready(m)
        ov = m.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')
        check(f'mobile 375px {path}: no horizontal overflow', ov <= 1, str(ov))
        m.screenshot(path=os.path.join(tmp, f'm_{path[1:]}.png'), full_page=True)
    m.click('.menu-btn'); m.click('#toolNav a:text-is("Crop")'); m.wait_for_selector('.crop-stage'); ready(m)   # Phase 9: on phones the tool nav is a drawer
    bb = m.locator('.crop-stage').bounding_box(); check('mobile crop stage fits viewport', bb['width'] <= 375)
    ctx.close(); mctx.close()
    page2 = browser.new_page(viewport={'width': 1200, 'height': 900}); page2.goto(BASE + '/'); page2.screenshot(path=os.path.join(tmp, 'home.png'), full_page=True)
    page2.set_input_files('input[type=file]', fx('photo.jpg')); page2.wait_for_selector('.workbench'); page2.wait_for_timeout(800)
    page2.click('#toolNav a:text-is("Crop")'); page2.wait_for_selector('.crop-stage'); page2.click('.chip:text-is("4:5")'); page2.wait_for_timeout(800)
    page2.screenshot(path=os.path.join(tmp, 'crop.png'), full_page=True)
    browser.close()
finally:
    server.terminate()

fails = [r for r in results if not r[0]]
print(f'\n{len(results)-len(fails)}/{len(results)} passed'); print('screens:', tmp)
sys.exit(1 if fails else 0)
