"""Phase 5.3: Smart Enhancement. Real Chromium. Downloaded files are checked pixel by pixel with Pillow/numpy."""
import numpy as np
from PIL import Image
from common import *
from playwright.sync_api import sync_playwright
PORT = 4194; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT); PATH = '/enhance'
W, H = 800, 500

def save(arr, name, fmt='PNG'):
    path = os.path.join(tmp, name); Image.fromarray(arr.astype('uint8')).save(path, fmt); return path
def setv(p, sel, v): p.eval_on_selector(sel, "(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))}", str(v))
def seg(p, label, v): p.click(f'.seg[aria-label="{label}"] button[data-v="{v}"]')
def dl(p, tag):
    with p.expect_download() as d: p.click('#en-download')
    f = os.path.join(tmp, tag + '_' + d.value.suggested_filename); d.value.save_as(f); return f, d.value.suggested_filename
def arr(f): return np.asarray(Image.open(f).convert('RGB'), float)
def wait_idle(p): p.wait_for_timeout(250)

dull = np.zeros((H, W, 3)); dull[:] = (np.linspace(80, 170, W))[None, :, None]            # tones only 80..170
mid = np.full((H, W, 3), (100, 150, 200.))
rng = np.random.default_rng(5); noisy = np.clip(np.where(np.arange(W)[None, :, None] < W // 2, 70., 190.) + rng.normal(0, 14, (H, W, 3)), 0, 255)
edge = np.zeros((H, W, 3)); edge[:, W // 2:] = 150; edge[:] += 50
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    p.goto(BASE + '/'); check('Smart Enhancement is in the nav and on the home cards', 'Smart Enhancement' in p.locator('#toolNav a').all_text_contents() and 'Smart Enhancement' in ' '.join(p.locator('.task-card').all_inner_texts()))
    p.click('#toolNav a:text-is("Smart Enhancement")'); p.wait_for_selector('.dropzone'); check('route /enhance shows the dropzone first', p.url.endswith(PATH))
    src = save(mid, 'mid.png'); p.set_input_files('input[type=file]', src); p.wait_for_selector('#en-download', timeout=60000)
    check('workspace opens with file info; shared Before/After panel not mounted', '800 × 500 px' in p.inner_text('.sig-file-meta') and p.locator('button:text-is("Download result")').count() == 0)
    check('no changes yet: note says so', 'No changes yet' in p.inner_text('#en-notes'))
    f, name = dl(p, 'same'); check('untouched settings: file equals the original pixel for pixel, name <name>-enhanced.png', name == 'mid-enhanced.png' and (arr(f) == mid).all(), name)

    setv(p, '#en-brightness', 40); f, _ = dl(p, 'bri'); a = arr(f); check('brightness +40 lifts every channel by about 51 (±2)', abs(a[10, 10, 0] - 151) <= 2 and abs(a[10, 10, 2] - 251) <= 2, str(a[10, 10]))
    setv(p, '#en-brightness', -40); f, _ = dl(p, 'dark'); a = arr(f); check('brightness -40 darkens (100 → ~49)', abs(a[10, 10, 0] - 49) <= 2, str(a[10, 10]))
    setv(p, '#en-brightness', 0); setv(p, '#en-saturation', -100); f, _ = dl(p, 'grey'); a = arr(f); check('colour -100 gives grey (R=G=B within 1)', np.abs(a[10, 10] - a[10, 10].mean()).max() <= 1.5, str(a[10, 10]))
    setv(p, '#en-saturation', 0); setv(p, '#en-warmth', 60); f, _ = dl(p, 'warm'); a = arr(f); check('warmth +60 raises red, lowers blue, keeps green', a[10, 10, 0] > 100 + 10 and a[10, 10, 2] < 200 - 10 and a[10, 10, 1] == 150, str(a[10, 10]))
    p.click('#en-reset'); setv(p, '#en-contrast', 50); f, _ = dl(p, 'con'); a = arr(f); check('contrast: dark channel darker, light channel lighter', a[10, 10, 0] < 100 and a[10, 10, 2] > 200, str(a[10, 10]))
    check('output has same dimensions as the input (no resize)', Image.open(f).size == (W, H))

    # ---- auto levels
    p.click('#en-reset'); p.set_input_files('input[type=file]', save(dull, 'dull.png')); p.wait_for_selector('#en-download'); wait_idle(p)
    p.click('.chip[data-key=auto]'); wait_idle(p); check('Auto fix preset is pressed and Auto levels ticked', p.get_attribute('.chip[data-key=auto]', 'aria-pressed') == 'true' and p.is_checked('#en-auto'))
    f, _ = dl(p, 'auto'); a = arr(f)[..., 0]; check('auto fix stretches the dull picture (80..170 → min ≤ 30, max ≥ 225)', a.min() <= 30 and a.max() >= 225, f'{a.min()} {a.max()}')
    check('auto fix keeps left-to-right order of tones (monotonic)', (np.diff(a[0]) >= -1).all())
    p.click('#en-reset'); setv(p, '#en-contrast', 0); p.set_input_files('input[type=file]', save(mid, 'mid2.png')); p.wait_for_selector('#en-download'); wait_idle(p)
    p.check('#en-auto'); wait_idle(p); check('auto levels on a flat-toned picture says there is nothing to stretch', 'nothing to stretch' in p.inner_text('#en-notes'), p.inner_text('#en-notes'))

    # ---- noise reduction and sharpen
    p.click('#en-reset'); p.set_input_files('input[type=file]', save(noisy, 'noisy.png')); p.wait_for_selector('#en-download'); wait_idle(p)
    o = arr(save(noisy, 'noisy_ref.png'))
    setv(p, '#en-denoise', 70); f, _ = dl(p, 'dn'); a = arr(f); flat0, flat1 = o[:, 50:300].std(), a[:, 50:300].std()
    check('noise reduction cuts grain in flat areas by more than half', flat1 < flat0 * 0.5, f'{flat0:.1f} -> {flat1:.1f}')
    check('noise reduction keeps the hard edge (left ≈70, right ≈190)', abs(a[:, 100:300].mean() - 70) < 6 and abs(a[:, 500:700].mean() - 190) < 6 and a[:, W // 2 + 12:W // 2 + 40].mean() - a[:, W // 2 - 40:W // 2 - 12].mean() > 105)
    p.click('#en-reset'); p.set_input_files('input[type=file]', save(edge, 'edge.png')); p.wait_for_selector('#en-download'); wait_idle(p)
    setv(p, '#en-sharpen', 80); f, _ = dl(p, 'sh'); a = arr(f)[..., 0]
    check('sharpen: bright side brighter and dark side darker next to the edge, flat areas untouched', a[:, W // 2 + 1].mean() > 200 + 2 and a[:, W // 2 - 2].mean() < 50 - 2 and a[:, 50].std() == 0 and abs(a[0, 50] - 50) < 1.5, f'{a[0, W//2+1]} {a[0, W//2-2]} {a[0,50]}')
    setv(p, '#en-sharpen', 90); wait_idle(p); check('strong sharpening shows the halo warning', 'halos' in p.inner_text('#en-notes'))

    # ---- views, formats, alpha
    p.click('#en-reset'); setv(p, '#en-brightness', 30); seg(p, 'Preview', 'compare'); wait_idle(p)
    check('compare view shows the divider and slider', p.is_visible('.sig-divider') and p.is_visible('.sig-compare'))
    seg(p, 'Preview', 'before'); check('original view hides the enhanced layer', not p.is_visible('canvas[aria-label="Enhanced preview"]') and p.is_visible('canvas[aria-label="Original picture"]'))
    seg(p, 'Preview', 'after'); seg(p, 'Output format', 'jpeg'); f, name = dl(p, 'jpg'); check('JPG output is a real JPEG named .jpg', name == 'edge-enhanced.jpg' and Image.open(f).format == 'JPEG', name)
    seg(p, 'Output format', 'webp'); f, name = dl(p, 'wp'); check('WEBP output is a real WEBP', Image.open(f).format == 'WEBP' and name.endswith('.webp'))
    rgba = np.zeros((200, 300, 4), 'uint8'); rgba[..., :3] = (90, 120, 150); rgba[:, :100, 3] = 0; rgba[:, 100:, 3] = 255
    pa = os.path.join(tmp, 'alpha.png'); Image.fromarray(rgba, 'RGBA').save(pa); p.set_input_files('input[type=file]', pa); p.wait_for_selector('#en-download'); wait_idle(p)
    setv(p, '#en-brightness', 40); seg(p, 'Output format', 'png'); f, _ = dl(p, 'al'); im = Image.open(f).convert('RGBA'); a = np.asarray(im)
    check('transparent PNG keeps its transparency and the opaque part is brightened', (a[:, :100, 3] == 0).all() and (a[:, 100:, 3] == 255).all() and a[50, 200, 0] > 100)

    # ---- large image, status, navigation, mobile
    big = np.full((3000, 4000, 3), 120, 'uint8'); big[:, 2000:] = 160; pb = save(big, 'big.jpg', 'JPEG'); p.set_input_files('input[type=file]', pb); p.wait_for_selector('#en-download'); wait_idle(p)
    setv(p, '#en-contrast', 20); setv(p, '#en-sharpen', 40); setv(p, '#en-denoise', 30); t0 = time.time(); f, _ = dl(p, 'big'); sec = time.time() - t0
    check('12 MP photo exports at full size with all filters on', Image.open(f).size == (4000, 3000) and 'Saved big-enhanced.jpg' in p.inner_text('#en-status') and '4000 × 3000' in p.inner_text('#en-status'), p.inner_text('#en-status')); info(f'12 MP export with sharpen+denoise+contrast: {sec:.1f} s (headless Chromium, this machine)')
    ms = int(p.get_attribute('#en-notes', 'data-ms')); info(f'preview repaint (1400 px, all filters): {ms} ms'); check('preview repaint stays under 2 s even with every filter on', ms < 2000, str(ms))
    p.click('#toolNav a:text-is("Resize")'); p.wait_for_selector('.workbench:not(.own-view)'); ready(p); check('leaving Smart Enhancement resumes the shared pipeline (Resize renders a result)', p.locator('button:text-is("Download result")').count() == 1)
    mp = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True).new_page(); mp.goto(BASE + PATH); mp.set_input_files('input[type=file]', src); mp.wait_for_selector('#en-download', timeout=60000)
    check('mobile 390 px: no horizontal overflow, preview fits', mp.evaluate('document.documentElement.scrollWidth') <= 391 and 200 < mp.eval_on_selector('.sig-stage', 'e=>e.getBoundingClientRect().width') <= 390, str(mp.evaluate('document.documentElement.scrollWidth')))
    check('no console errors or page errors during the whole run', not errors, ' | '.join(errors[:3]))
    b.close()
finally:
    srv.terminate()
finish()
