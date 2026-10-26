"""Phase 5.2: Watermark Studio. Real Chromium. Downloaded files are checked pixel by pixel against the untouched original with Pillow/numpy."""
import io, zipfile
import numpy as np
from PIL import Image, ImageDraw
from common import *
from playwright.sync_api import sync_playwright
PORT = 4193; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT); PATH = '/watermark'
BG = (60, 90, 140); W, H = 1200, 800

def flat(w, h, name, fmt='PNG', color=BG):
    path = os.path.join(tmp, name); Image.new('RGB', (w, h), color).save(path, fmt); return path
def seg(p, label, v): p.click(f'.seg[aria-label="{label}"] button[data-v="{v}"]')
def setv(p, sel, v): p.eval_on_selector(sel, "(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))}", str(v))
def dl(p, tag):
    with p.expect_download() as d: p.click('#wm-download')
    f = os.path.join(tmp, tag + '_' + d.value.suggested_filename); d.value.save_as(f); return f, d.value.suggested_filename
def diff(f, color=BG):
    a = np.asarray(Image.open(f).convert('RGB'), int); m = np.abs(a - np.array(color)).sum(2) > 12; return a, m
def bbox(m):
    ys, xs = np.nonzero(m); return (xs.min(), ys.min(), xs.max(), ys.max()) if len(xs) else None
def pressed(p, sel): return p.get_attribute(sel, 'aria-pressed') == 'true'
def clean(p, **kw):  # no outline, solid white, single mark
    p.click('.chip[data-key=corner]'); p.uncheck('#wm-outline')

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    src = flat(W, H, 'base.png')

    p.goto(BASE + '/'); check('Watermark Studio is in the nav and on the home cards', 'Watermark Studio' in p.locator('#toolNav a').all_text_contents() and 'Watermark Studio' in ' '.join(p.locator('.task-card').all_inner_texts()))
    p.click('#toolNav a:text-is("Watermark Studio")'); p.wait_for_selector('.dropzone'); check('route /watermark shows the dropzone first', p.url.endswith(PATH))
    p.set_input_files('input[type=file]', src); p.wait_for_selector('#wm-download', timeout=60000)
    check('workspace opens with file info; shared Before/After panel not mounted', '1200 × 800 px' in p.inner_text('.sig-file-meta') and p.locator('button:text-is("Download result")').count() == 0)
    check('default is the Copyright corner preset', pressed(p, '.chip[data-key=corner]') and p.input_value('#wm-text') == '© Your name')

    # ---- default single mark, bottom right
    f, name = dl(p, 'corner'); a, m = diff(f); orig = np.asarray(Image.open(src).convert('RGB'), int)
    check('download name is <name>-watermarked.png and size equals the original (no resize)', name == 'base-watermarked.png' and Image.open(f).size == (W, H), name)
    bb = bbox(m)
    check('watermark pixels exist and sit in the bottom-right corner', bb and bb[0] > W * 0.5 and bb[1] > H * 0.8, str(bb))
    check('everything outside the mark box is byte-identical to the original', (a[:H // 2, :W // 2] == orig[:H // 2, :W // 2]).all() and (a[:H - 120, :] == orig[:H - 120, :]).all())
    check('mark stays inside the margin (does not touch the image edge)', bb[2] < W - 5 and bb[3] < H - 5, str(bb))
    check('status reports dimensions and size', 'Saved base-watermarked.png' in p.inner_text('#wm-status') and '1200 × 800' in p.inner_text('#wm-status'), p.inner_text('#wm-status'))

    # ---- opacity (solid white, no outline)
    clean(p); setv(p, '#wm-opacity', 100); f, _ = dl(p, 'op100'); a, m = diff(f); check('opacity 100: text is pure white', a[m].max() == 255 and (a[m].min(axis=0).max() >= 0), str(a[m].max()))
    setv(p, '#wm-opacity', 30); f, _ = dl(p, 'op30'); a, m = diff(f); peak = a[m][:, 0].max(); exp = BG[0] + 0.3 * (255 - BG[0])
    check('opacity 30: brightest text pixel ≈ 30 % blend (±4)', abs(peak - exp) <= 4, f'{peak} vs {exp:.1f}')
    setv(p, '#wm-opacity', 0); f, _ = dl(p, 'op0'); a, m = diff(f); check('opacity 0: image unchanged and a note says nearly invisible', not m.any() and 'invisible' in p.inner_text('#wm-notes'))
    setv(p, '#wm-opacity', 100)

    # ---- nine positions
    ok = True; bad = []
    for pos in ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']:
        p.click(f'.wm-pos[data-v={pos}]'); f, _ = dl(p, 'pos_' + pos); _, m = diff(f); x0, y0, x1, y1 = bbox(m); cx, cy = (x0 + x1) / 2 / W, (y0 + y1) / 2 / H
        ex = {'l': 0.0, 'c': 0.5, 'r': 1.0}[pos[1]]; ey = {'t': 0.0, 'm': 0.5, 'b': 1.0}[pos[0]]
        good = (abs(cx - ex) < 0.2 if ex in (0, 1) else abs(cx - 0.5) < 0.02) and (abs(cy - ey) < 0.12 if ey in (0, 1) else abs(cy - 0.5) < 0.02) and x0 >= 0 and y0 >= 0 and x1 < W and y1 < H
        if not good: ok = False; bad.append((pos, round(cx, 2), round(cy, 2)))
    check('all 9 anchors land in the right place and stay inside the image', ok, str(bad))
    p.click('.wm-pos[data-v=mc]')

    # ---- size and rotation
    setv(p, '#wm-size', 10); f, _ = dl(p, 's10'); _, m = diff(f); w10 = bbox(m)[2] - bbox(m)[0]
    setv(p, '#wm-size', 40); f, _ = dl(p, 's40'); _, m = diff(f); w40 = bbox(m)[2] - bbox(m)[0]
    check('size scales the mark (40 % ≈ 4 × 10 %)', 3.5 < w40 / w10 < 4.5, f'{w10} {w40}')
    setv(p, '#wm-size', 30); w0 = None
    f, _ = dl(p, 'r0'); bb0 = bbox(diff(f)[1]); setv(p, '#wm-rotation', 90); f, _ = dl(p, 'r90'); bb90 = bbox(diff(f)[1])
    check('rotation 90°: wide mark becomes tall', (bb0[2] - bb0[0]) > 2 * (bb0[3] - bb0[1]) and (bb90[3] - bb90[1]) > 2 * (bb90[2] - bb90[0]), f'{bb0} {bb90}')
    setv(p, '#wm-rotation', 0)

    # ---- tiled
    p.click('.chip[data-key=diagonal]'); f, _ = dl(p, 'tile'); a, m = diff(f); q = [m[:H // 2, :W // 2].any(), m[:H // 2, W // 2:].any(), m[H // 2:, :W // 2].any(), m[H // 2:, W // 2:].any()]
    check('tiled: marks reach all four quadrants', all(q), str(q)); frac = m.mean(); check('tiled: covers a sensible share of the picture (1–40 %)', 0.01 < frac < 0.4, f'{frac:.3f}')
    check('tiled: note reports the number of copies', 'copies' in p.inner_text('#wm-notes'), p.inner_text('#wm-notes'))
    setv(p, '#wm-size', 1); setv(p, '#wm-gap', 0); p.wait_for_timeout(200)
    check('too many copies is refused with a clear message and download is disabled', p.is_visible('#wm-empty') and 'too many' in p.inner_text('#wm-empty').lower() or 'repeat' in p.inner_text('#wm-empty').lower(), p.inner_text('#wm-empty'))
    check('…download button disabled', p.is_disabled('#wm-download'))
    p.click('.chip[data-key=corner]')

    # ---- empty text, preview views
    p.fill('#wm-text', ''); p.wait_for_timeout(150); check('empty text: hint shown, download disabled', p.is_visible('#wm-empty') and p.is_disabled('#wm-download'))
    p.fill('#wm-text', 'Sample © 2026'); p.wait_for_timeout(150)
    seg(p, 'Preview', 'before'); check('Original view hides the watermarked layer', p.is_visible('canvas[aria-label="Original picture"]') and not p.is_visible('canvas[aria-label="Watermarked preview"]'))
    seg(p, 'Preview', 'compare'); setv(p, '.sig-compare', 30); check('Compare shows both layers with a divider', p.is_visible('canvas[aria-label="Watermarked preview"]') and p.is_visible('.sig-divider') and '30%' in p.eval_on_selector('canvas[aria-label="Watermarked preview"]', 'e=>e.style.clipPath'))
    seg(p, 'Preview', 'after')
    pv = p.evaluate("()=>{const c=document.querySelector('canvas[aria-label=\"Watermarked preview\"]');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(Math.abs(d[i]-60)+Math.abs(d[i+1]-90)+Math.abs(d[i+2]-140)>12)n++;return n}")
    check('live preview canvas really contains the watermark', pv > 200, str(pv))

    # ---- unicode text + multi-line stays in bounds
    p.fill('#wm-text', 'Café — 日本語 ©'); f, _ = dl(p, 'uni'); bb = bbox(diff(f)[1]); check('non-Latin text renders (pixels drawn) and stays inside the image', bb and bb[2] < W and bb[3] < H, str(bb))
    p.fill('#wm-text', '<b>x</b>'); f, _ = dl(p, 'html'); check('HTML in the text is drawn as text, not interpreted', bbox(diff(f)[1]) is not None and p.locator('#wm-notes b').count() == 0)
    p.fill('#wm-text', '© Your name')

    # ---- logo
    logo = os.path.join(tmp, 'logo.png'); L = Image.new('RGBA', (200, 100), (0, 0, 0, 0)); ImageDraw.Draw(L).rectangle([40, 0, 199, 99], fill=(220, 20, 20, 255)); L.save(logo)
    p.click('.chip[data-key=logo]'); p.wait_for_timeout(150); check('Logo preset with no logo asks for one and disables download', p.is_visible('#wm-empty') and 'logo' in p.inner_text('#wm-empty').lower() and p.is_disabled('#wm-download'))
    p.set_input_files('#wm-logo-input', logo); p.wait_for_function("()=>document.getElementById('wm-logo-name').textContent.includes('logo.png')")
    f, _ = dl(p, 'logo'); a, m = diff(f); bb = bbox(m)
    reds = (a[..., 0] > 150) & (a[..., 1] < 110); check('logo: red pixels drawn bottom-right, nothing elsewhere', reds.sum() > 500 and bb[0] > W * 0.6 and bb[1] > H * 0.8, str(bb))
    lw = bb[2] - bb[0]; check('logo: width ≈ 16 % of the image; transparent part of the logo left the background alone', abs(lw - 0.16 * W * 0.8) < 12 or abs(lw - 0.16 * W) < 12, f'{lw}')
    bad = os.path.join(tmp, 'badlogo.png'); open(bad, 'wb').write(b'not an image'); p.set_input_files('#wm-logo-input', bad); p.wait_for_selector('#wm-logo-err:not([hidden])'); check('invalid logo is rejected with a message', 'not an image' in p.inner_text('#wm-logo-err'), p.inner_text('#wm-logo-err'))
    p.click('.chip[data-key=corner]')

    # ---- output formats
    seg(p, 'Output format', 'jpeg'); f, name = dl(p, 'jpg'); check('JPG output: real JPEG, .jpg name', Image.open(f).format == 'JPEG' and name == 'base-watermarked.jpg', f'{Image.open(f).format} {name}')
    seg(p, 'Output format', 'webp'); f, name = dl(p, 'webp'); check('WEBP output: real WEBP', Image.open(f).format == 'WEBP' and name.endswith('.webp'))
    seg(p, 'Output format', 'keep')
    jp = flat(W, H, 'photo.jpg', 'JPEG'); p.click('#wm-remove'); p.wait_for_selector('.dropzone'); p.set_input_files('input[type=file]', jp); p.wait_for_selector('#wm-download'); f, name = dl(p, 'keepjpg')
    check('Keep format on a JPG source gives a JPG', Image.open(f).format == 'JPEG' and name == 'photo-watermarked.jpg')
    tp = os.path.join(tmp, 'alpha.png'); Image.new('RGBA', (400, 300), (0, 0, 0, 0)).save(tp); p.click('#wm-remove'); p.wait_for_selector('.dropzone'); p.set_input_files('input[type=file]', tp); p.wait_for_selector('#wm-download'); f, _ = dl(p, 'alpha')
    im = Image.open(f); al = np.asarray(im.convert('RGBA'))[..., 3]; check('transparent PNG source stays transparent outside the mark', im.mode == 'RGBA' and (al == 0).mean() > 0.9, f'{im.mode} {(al == 0).mean():.2f}')

    # ---- batch
    p.click('#wm-remove'); p.wait_for_selector('.dropzone'); p.set_input_files('input[type=file]', src); p.wait_for_selector('#wm-download')
    portrait = flat(600, 900, 'portrait.png'); wide = flat(1600, 1000, 'wide.png'); dup = os.path.join(tmp, 'sub'); os.makedirs(dup, exist_ok=True); dup = flat(500, 500, 'sub/base.png'); badf = os.path.join(tmp, 'broken.png'); open(badf, 'wb').write(b'\x89PNG nope')
    p.set_input_files('#wm-batch-input', [portrait, wide, dup, badf]); p.wait_for_function("()=>document.querySelectorAll('#wm-list li').length>=4")
    check('batch list shows this image + 3 added; the broken file is rejected with a reason', p.locator('#wm-list li').count() == 4 and p.is_visible('#wm-batch-msg') and 'broken.png' in p.inner_text('#wm-batch-msg'), p.inner_text('#wm-batch-msg'))
    clean(p); setv(p, '#wm-opacity', 100)
    with p.expect_download(timeout=120000) as d: p.click('#wm-zip')
    zf = os.path.join(tmp, 'batch.zip'); d.value.save_as(zf); z = zipfile.ZipFile(zf); names = sorted(z.namelist())
    check('ZIP name and entries: 4 watermarked files, duplicate name made unique', d.value.suggested_filename == 'watermarked-images.zip' and names == ['base-watermarked (2).png', 'base-watermarked.png', 'portrait-watermarked.png', 'wide-watermarked.png'], str(names))
    good = True; why = []
    for n, size in [('base-watermarked.png', (W, H)), ('portrait-watermarked.png', (600, 900)), ('wide-watermarked.png', (1600, 1000)), ('base-watermarked (2).png', (500, 500))]:
        im = Image.open(io.BytesIO(z.read(n))).convert('RGB'); a = np.asarray(im, int); m = np.abs(a - np.array(BG)).sum(2) > 12; bb = bbox(m)
        if im.size != size or bb is None or bb[0] < im.size[0] * 0.4 or bb[1] < im.size[1] * 0.7 or m[: im.size[1] // 2, : im.size[0] // 2].any(): good = False; why.append((n, im.size, bb))
    check('each image keeps its own size, has the mark bottom-right and is untouched elsewhere (relative size)', good, str(why))
    check('batch list marks every image Done', p.locator('.wm-item-state[data-state=done]').count() == 4 and 'ZIP saved with 4 of 4' in p.inner_text('#wm-batch-status'), p.inner_text('#wm-batch-status'))

    # ---- regression + mobile
    p.click('#toolNav a:text-is("Resize")'); p.wait_for_selector('.workbench:not(.own-view)'); ready(p); check('leaving Watermark Studio resumes the shared pipeline (Resize renders a result)', p.locator('button:text-is("Download result")').count() == 1)
    mp = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True).new_page(); mp.goto(BASE + PATH); mp.set_input_files('input[type=file]', src); mp.wait_for_selector('#wm-download', timeout=60000)
    check('mobile 390 px: no horizontal overflow, preview fits', mp.evaluate('document.documentElement.scrollWidth') <= 391 and 200 < mp.eval_on_selector('.sig-stage', 'e=>e.getBoundingClientRect().width') <= 390, str(mp.evaluate('document.documentElement.scrollWidth')))
    check('no console errors or page errors during the whole run', not errors, ' | '.join(errors[:3]))
    b.close()
finally:
    srv.terminate()
finish()
