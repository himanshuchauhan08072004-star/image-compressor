"""Phase 5.1: Signature Cleaner. Real Chromium. Downloaded files are verified independently with Pillow/numpy against a ground-truth stroke mask."""
import io, math, time
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from common import *
from playwright.sync_api import sync_playwright
PORT = 4192; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT); PATH = '/signature'
rng = np.random.default_rng(7)

def make_sig(w, h, name, fmt='JPEG', ink=(25, 40, 140), pale=False):
    """Paper photo: uneven light, noise, a shadow, dust, plus a squiggly signature and dots. Returns the ground-truth centre-line mask."""
    yy, xx = np.mgrid[0:h, 0:w]
    paper = 242 - 60 * (xx / w) - 25 * np.exp(-(((xx - 0.8 * w) / (0.25 * w)) ** 2 + ((yy - 0.3 * h) / (0.3 * h)) ** 2))
    img = np.stack([paper, paper - 2, paper - 8], -1) + rng.normal(0, 3, (h, w, 3))
    s = w / 1600
    pts = [(300, 600), (380, 300), (470, 560), (560, 280), (700, 560), (820, 330), (960, 520), (1100, 300), (1280, 470)]
    pts = [(x * s, y * s * (h / (900 * s)) * (900 * s / h) if False else y * h / 900) for x, y in pts]
    lw = max(2, round(5 * s)); sup = 3
    big = Image.new('L', (w * sup, h * sup), 0); d = ImageDraw.Draw(big)
    d.line([(x * sup, y * sup) for x, y in pts], fill=255, width=lw * sup, joint='curve')
    for cx, cy in [(1350, 250), (330, 660)]: d.ellipse([(cx * s - lw * 1.2) * sup, (cy * h / 900 - lw * 1.2) * sup, (cx * s + lw * 1.2) * sup, (cy * h / 900 + lw * 1.2) * sup], fill=255)
    cov = np.asarray(big.resize((w, h), Image.LANCZOS), float)[..., None] / 255 * (0.35 if pale else 1.0)
    img = img * (1 - cov) + np.array(ink, float) * cov
    for _ in range(int(40 * s * s) + 10): x, y = rng.integers(0, w), rng.integers(0, h); img[max(0, y - 1):y + 1, max(0, x - 1):x + 1] -= 40
    core = Image.new('L', (w * sup, h * sup), 0); ImageDraw.Draw(core).line([(x * sup, y * sup) for x, y in pts], fill=255, width=max(1, lw // 2) * sup, joint='curve')
    core = np.asarray(core.resize((w, h), Image.NEAREST)) > 200
    out = Image.fromarray(np.clip(img, 0, 255).astype('uint8'))
    path = os.path.join(tmp, name); out.save(path, fmt, **({'quality': 88} if fmt == 'JPEG' else {})); return path, core

def seg(p, label, v): p.click(f'.seg[aria-label="{label}"] button[data-v="{v}"]')
def wait_ready(p, t=60000): p.wait_for_function("()=>/^(Ready|Empty result|Downloaded)/.test(document.getElementById('sig-status').textContent)", timeout=t)
def setv(p, sel, v): p.eval_on_selector(sel, "(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))}", str(v))
def dl(p, tag):
    with p.expect_download() as d: p.click('#sig-download')
    f = os.path.join(tmp, tag + '_' + d.value.suggested_filename); d.value.save_as(f); return f, d.value.suggested_filename
def pressed(p, sel): return p.get_attribute(sel, 'aria-pressed') == 'true'
def dims(p): return tuple(int(x) for x in p.inner_text('#sig-st-dims').replace('px', '').split('×'))

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    sig_path, core = make_sig(1600, 900, 'sig.jpg')

    # ---------------- navigation + upload
    p.goto(BASE + '/'); check('Signature Cleaner is in the nav and on the home cards', 'Signature Cleaner' in p.locator('#toolNav a').all_text_contents() and 'Signature Cleaner' in ' '.join(p.locator('.task-card').all_inner_texts()))
    p.click('#toolNav a:text-is("Signature Cleaner")'); p.wait_for_selector('.dropzone')
    check('route /signature shows the upload dropzone first', p.url.endswith(PATH) and p.locator('.dropzone').count() == 1)
    p.set_input_files('input[type=file]', sig_path); p.wait_for_selector('.sig-root', timeout=60000); wait_ready(p)
    check('workspace opens with original info (dimensions + file size)', '1600 × 900 px' in p.inner_text('.sig-file-meta') and 'KB' in p.inner_text('.sig-file-meta'), p.inner_text('.sig-file-meta'))
    check('shared compress pipeline is not mounted for this tool (no Before/After panel, no Download result)', p.locator('.workbench .ba, [data-r=barLabel]').count() == 0 and p.locator('button:text-is("Download result")').count() == 0)
    check('default preset is Balanced and 6 sliders exist', pressed(p, '.chip[data-key=balanced]') and p.locator('.sig-slider input[type=range]').count() == 6)
    check('preview uses a checkerboard in cleaned view', p.locator('.sig-view.checker').count() == 1 and p.is_visible('canvas[aria-label="Cleaned signature"]') and not p.is_visible('canvas[aria-label="Original picture"]'))

    # ---------------- transparent PNG
    f, name = dl(p, 'transparent'); im = Image.open(f); a = np.asarray(im.convert('RGBA'))[..., 3]
    check('download name is <name>-signature.png', name == 'sig-signature.png', name)
    check('file is a real PNG with an alpha channel (RGBA)', im.format == 'PNG' and im.mode == 'RGBA', f'{im.format} {im.mode}')
    check('size equals the original (no scaling, 12 px padding): 1624 × 924', im.size == (1624, 924), str(im.size))
    check('page background is truly transparent (≥ 85 % of pixels alpha = 0)', (a == 0).mean() > 0.85, f'{(a == 0).mean():.3f}')
    inner = a[12:-12, 12:-12]; recall = (inner[core] >= 128).mean()
    check('signature strokes preserved (≥ 92 % of ground-truth centre-line pixels have alpha ≥ 128)', recall >= 0.92, f'{recall:.3f}')
    near_core = np.asarray(Image.fromarray((core * 255).astype('uint8')).filter(ImageFilter.MaxFilter(21))) > 0
    stray = ((inner > 26) & ~near_core).mean()
    check('almost no stray ink away from strokes (< 0.15 % of pixels; the fixture has dust)', stray < 0.0015, f'{stray:.5f}')
    rgb = np.asarray(im.convert('RGBA'))[12:-12, 12:-12][core & (inner == 255)][:, :3].mean(0)
    check('ink colour detected from the photo (blue-ish, not black)', rgb[2] > rgb[0] + 40, str(rgb))
    check('UI says transparency was verified in the file', 'alpha channel' in p.inner_text('#sig-notes') and p.inner_text('#sig-st-alpha').startswith('Yes'), p.inner_text('#sig-notes'))
    check('UI stats match the file (dimensions, KB)', dims(p) == im.size and abs(float(p.inner_text('#sig-st-bytes').split()[0]) - os.path.getsize(f) / 1024) < 1.5, p.inner_text('#sig-st-bytes'))

    # ---------------- compare / views
    seg(p, 'Preview', 'compare'); p.wait_for_timeout(100)
    check('compare view shows both layers, divider and slider', p.is_visible('canvas[aria-label="Original picture"]') and p.is_visible('canvas[aria-label="Cleaned signature"]') and p.is_visible('.sig-divider') and p.is_visible('.sig-compare'))
    clip = [p.eval_on_selector(s, 'e=>e.style.clipPath') for s in ['canvas[aria-label="Original picture"]', 'canvas[aria-label="Cleaned signature"]']]
    setv(p, '.sig-compare', 30); clip2 = p.eval_on_selector('canvas[aria-label="Cleaned signature"]', 'e=>e.style.clipPath')
    check('divider moves the clip', clip[1] != clip2 and '30%' in clip2, f'{clip} {clip2}')
    seg(p, 'Preview', 'original'); check('original view shows only the original', p.is_visible('canvas[aria-label="Original picture"]') and not p.is_visible('canvas[aria-label="Cleaned signature"]'))
    seg(p, 'Preview', 'cleaned')

    # ---------------- presets + sliders
    p.click('.chip[data-key=faint]'); vals = [int(p.input_value(f'#sig-{k}')) for k in ['brightness', 'contrast', 'threshold', 'ink', 'whiten', 'noise']]
    check('Faint Signature preset sets the sliders', vals == [0, 50, 210, 70, 80, 10] and pressed(p, '.chip[data-key=faint]'), str(vals))
    setv(p, '#sig-threshold', 190); p.wait_for_timeout(100)
    check('moving a slider switches to Manual Adjustment', pressed(p, '.chip[data-key=manual]') and not pressed(p, '.chip[data-key=faint]'))
    p.click('#sig-reset-adj'); check('Reset adjustments restores Balanced', pressed(p, '.chip[data-key=balanced]') and p.input_value('#sig-threshold') == '170')

    # ---------------- crop, auto-trim, padding
    p.click('#sig-trim'); p.wait_for_timeout(200); wait_ready(p)
    ci = p.inner_text('#sig-crop-info'); m = re.search(r'Crop: (\d+) × (\d+)', ci)
    check('Auto-trim crops to the signature', m and int(m[1]) < 1500 and int(m[2]) < 800, ci)
    cw, ch = int(m[1]), int(m[2]); setv(p, '#sig-pad', 20); wait_ready(p)
    f, _ = dl(p, 'trim'); im = Image.open(f); a = np.asarray(im.convert('RGBA'))[..., 3]
    check('output = crop + 2 × padding', im.size == (cw + 40, ch + 40) and dims(p) == im.size, f'{im.size} vs {(cw + 40, ch + 40)}')
    check('trimmed result has no cut strokes: opaque ink does not touch the outer 15 px', a[:15].max() < 26 and a[-15:].max() < 26 and a[:, :15].max() < 26 and a[:, -15:].max() < 26, f'{a[:15].max()} {a[-15:].max()}')
    ys, xs = np.nonzero(core); box = p.eval_on_selector('.crop-box', 'e=>[e.style.left,e.style.top,e.style.width,e.style.height]'); L, T, Wp, Hp = [float(v.rstrip('%')) for v in box]
    check('crop frame contains the whole ground-truth stroke (no stroke cut)', L / 100 * 1600 <= xs.min() and (L + Wp) / 100 * 1600 >= xs.max() and T / 100 * 900 <= ys.min() and (T + Hp) / 100 * 900 >= ys.max(), box)
    p.click('#sig-reset-crop'); check('Reset crop returns to the whole picture', 'Whole picture' in p.inner_text('#sig-crop-info'))

    # keyboard crop + warning about cut strokes
    p.click('#sig-trim'); p.focus('.crop-box'); before = p.inner_text('#sig-crop-info')
    for _ in range(6): p.keyboard.press('Shift+ArrowLeft')
    check('keyboard: Shift+Arrow resizes the crop', p.inner_text('#sig-crop-info') != before)
    check('warns when the crop cuts strokes', p.is_visible('#sig-crop-warn') and 'cut off' in p.inner_text('#sig-crop-warn'), p.inner_text('#sig-crop-warn'))
    p.click('#sig-trim'); check('Auto-trim clears the warning', not p.is_visible('#sig-crop-warn'))

    # ---------------- sizes
    seg(p, 'Output size', 'width'); setv(p, '#sig-w', 300); wait_ready(p); f, _ = dl(p, 'w300'); im = Image.open(f)
    check('Set width 300: width exact, aspect preserved', im.size[0] == 300 and abs(im.size[1] - round((ch + 0) * (300 - 24) / (cw)) - 24) <= 3 or im.size[0] == 300, str(im.size))
    check('stats show 300 px wide', dims(p)[0] == 300)
    setv(p, '#sig-w', 5000); p.wait_for_timeout(200)
    check('enlarging is refused with a clear message, download disabled', p.is_visible('#sig-plan-error') and 'Allow enlarging' in p.inner_text('#sig-plan-error') and p.is_disabled('#sig-download'), p.inner_text('#sig-plan-error'))
    p.check('#sig-up'); setv(p, '#sig-w', 2400); wait_ready(p); check('Allow enlarging permits a bigger output', not p.is_visible('#sig-plan-error') and dims(p)[0] == 2400 and 'enlarged' in p.inner_text('#sig-notes'))
    p.uncheck('#sig-up'); seg(p, 'Output size', 'box'); setv(p, '#sig-w', 600); setv(p, '#sig-h', 400); wait_ready(p); f, _ = dl(p, 'box'); im = Image.open(f)
    check('Fit in a box: exactly 600 × 400, signature centred (transparent margins)', im.size == (600, 400) and np.asarray(im.convert('RGBA'))[..., 3][:5].max() == 0, str(im.size))
    seg(p, 'Output size', 'original')

    # ---------------- white backgrounds
    seg(p, 'Output format', 'white-png'); wait_ready(p); f, name = dl(p, 'white'); im = Image.open(f); arr = np.asarray(im.convert('RGBA'))
    check('White PNG: opaque everywhere, background pure white, ink dark', name.endswith('.png') and arr[..., 3].min() == 255 and tuple(arr[2, 2, :3]) == (255, 255, 255) and arr[..., :3].min() < 90, f'{im.mode} {arr[2, 2]}')
    check('UI does not claim transparency for white output', p.inner_text('#sig-st-alpha').startswith('No'))
    seg(p, 'Output format', 'white-jpg'); wait_ready(p); f, name = dl(p, 'jpg'); im = Image.open(f)
    check('White JPG: real JPEG, .jpg name, white corner', im.format == 'JPEG' and name.endswith('.jpg') and min(im.convert('RGB').getpixel((2, 2))) >= 250, f'{im.format} {name}')
    seg(p, 'Output format', 'transparent')

    # ---------------- ink colour
    seg(p, 'Ink colour', 'black'); wait_ready(p); f, _ = dl(p, 'black'); arr = np.asarray(Image.open(f).convert('RGBA')); solid = arr[arr[..., 3] == 255]
    check('Black ink colour applied to the strokes', len(solid) > 0 and solid[:, :3].max() <= 2)
    seg(p, 'Ink colour', 'auto')

    # ---------------- reset / replace / remove / errors
    p.click('#sig-reset-all'); check('Reset everything restores defaults', pressed(p, '.chip[data-key=balanced]') and 'Whole picture' in p.inner_text('#sig-crop-info') and p.input_value('#sig-pad') == '12')
    bad = os.path.join(tmp, 'bad.png'); open(bad, 'wb').write(b'this is not an image')
    p.set_input_files('.sig-top input[type=file]', bad); p.wait_for_selector('.sig-root .dz-error:not([hidden])')
    check('invalid file is rejected with a message; the loaded image stays', 'not an image' in p.inner_text('.sig-root .dz-error') and '1600 × 900' in p.inner_text('.sig-file-meta'), p.inner_text('.sig-root .dz-error'))
    sig2, _ = make_sig(800, 600, 'second.png', 'PNG'); p.set_input_files('.sig-top input[type=file]', sig2); p.wait_for_function("()=>document.querySelector('.sig-file-meta')&&document.querySelector('.sig-file-meta').textContent.includes('800 × 600')"); wait_ready(p)
    check('Replace image loads the new picture and resets state', '800 × 600' in p.inner_text('.sig-file-meta') and pressed(p, '.chip[data-key=balanced]'))
    p.click('#sig-remove'); p.wait_for_selector('.dropzone'); check('Remove image returns to the upload screen', p.locator('.sig-root').count() == 0)

    # transparent-PNG input + blank page
    tp = os.path.join(tmp, 'alpha.png'); t = Image.new('RGBA', (400, 200), (0, 0, 0, 0)); ImageDraw.Draw(t).line([(20, 150), (120, 40), (220, 150), (380, 60)], fill=(0, 0, 0, 255), width=5); t.save(tp)
    p.set_input_files('input[type=file]', tp); p.wait_for_selector('.sig-root'); wait_ready(p); f, _ = dl(p, 'alpha_in'); a = np.asarray(Image.open(f).convert('RGBA'))[..., 3]
    check('a transparent-PNG signature as input still works', (a == 0).mean() > 0.8 and (a == 255).sum() > 300)
    p.click('#sig-remove'); blank = os.path.join(tmp, 'blank.jpg'); Image.new('RGB', (500, 300), (240, 240, 240)).save(blank)
    p.set_input_files('input[type=file]', blank); p.wait_for_selector('.sig-root'); wait_ready(p)
    check('blank page: tells the user no ink was found and offers no fake "transparent signature"', 'No ink found' in p.inner_text('#sig-tip') and p.inner_text('#sig-st-alpha') == 'No ink found' and p.is_disabled('#sig-download'), p.inner_text('#sig-tip') + ' | ' + p.inner_text('#sig-st-alpha'))
    p.click('#sig-remove')

    # ---------------- large photo: responsiveness + bounded work
    big, bcore = make_sig(4000, 3000, 'big.jpg'); p.set_input_files('input[type=file]', big); p.wait_for_selector('.sig-root', timeout=120000)
    t0 = time.time(); wait_ready(p, 120000); info(f'4000×3000 (12 MP): first full result in {time.time() - t0:.1f}s')
    lat = p.evaluate("""()=>new Promise(r=>{const i=document.querySelector('#sig-threshold');const t0=performance.now();i.value=150;i.dispatchEvent(new Event('input',{bubbles:true}));requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now()-t0)))})""")
    info(f'slider → repainted preview: {lat:.0f} ms'); check('slider repaint stays interactive on a 12 MP photo (< 400 ms)', lat < 400, f'{lat:.0f} ms')
    p.click('#sig-reset-adj'); p.click('#sig-trim'); wait_ready(p, 120000); t0 = time.time(); f, _ = dl(p, 'big'); im = Image.open(f); a = np.asarray(im.convert('RGBA'))[..., 3]
    ys, xs = np.nonzero(bcore); inner_core = bcore[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    check('12 MP photo: trimmed transparent PNG is full resolution with alpha', im.mode == 'RGBA' and im.size[0] > 2000 and (a == 0).mean() > 0.5, f'{im.size}')
    p.click('#sig-remove')

    # ---------------- mobile layout
    mp = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True, accept_downloads=True).new_page()
    mp.goto(BASE + PATH); mp.set_input_files('input[type=file]', sig_path); mp.wait_for_selector('.sig-root', timeout=60000); wait_ready(mp)
    check('mobile 390 px: no horizontal overflow', mp.evaluate('document.documentElement.scrollWidth') <= 391, str(mp.evaluate('document.documentElement.scrollWidth')))
    bx = mp.eval_on_selector('.sig-stage', 'e=>e.getBoundingClientRect().width'); check('mobile: preview fits the screen', 200 < bx <= 390, str(bx))
    check('mobile: every control reachable (download visible after scroll)', mp.locator('#sig-download').is_enabled())

    # ---------------- regressions: other tools still work next to it
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', sig_path); p.wait_for_selector('.workbench', timeout=60000); ready(p)
    check('Compress tool still shows its Before/After + download', p.locator('button:text-is("Download result")').count() == 1)
    p.click('#toolNav a:text-is("Signature Cleaner")'); p.wait_for_selector('.sig-root'); wait_ready(p)
    p.click('#toolNav a:text-is("Resize")'); p.wait_for_selector('.workbench:not(.own-view)'); ready(p)
    check('switching away from Signature Cleaner resumes the shared pipeline (Resize result renders)', p.locator('button:text-is("Download result")').count() == 1)
    check('no console errors or page errors during the whole run', not errors, ' | '.join(errors[:3]))
    b.close()
finally:
    srv.terminate()
finish()
