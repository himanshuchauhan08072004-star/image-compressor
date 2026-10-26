"""Phase 2: Blur & Redact. Pixel assertions use lossless PNG fixtures and PIL/numpy (independent of the app). Real Chromium only."""
import time
import numpy as np
from PIL import Image, ImageOps
from common import *
from markers import MARKERS
from playwright.sync_api import sync_playwright
PORT = 4198; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT)
SW, SH = 400, 300
ORIG = np.array(Image.open(fx('checker.png')).convert('RGB'))

def arr(path): return np.array(Image.open(path).convert('RGB'))
def sel_rect(p, sw=SW, sh=SH):
    st = p.eval_on_selector('.rd-box.sel', 'e=>[e.style.left,e.style.top,e.style.width,e.style.height]'); f = [float(s.rstrip('%')) for s in st]
    return (round(f[0] * sw / 100), round(f[1] * sh / 100), round(f[2] * sw / 100), round(f[3] * sh / 100))
def outside_equal(a, b, rects):
    m = np.ones(a.shape[:2], bool)
    for x, y, w, h in rects: m[max(0, y):max(0, y) + h, max(0, x):max(0, x) + w] = False
    return a.shape == b.shape and np.array_equal(a[m], b[m])
def color_bbox(a, rgb):
    ys, xs = np.where((a == np.array(rgb)).all(-1)); return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else None
def inside(a, r): x, y, w, h = r; return a[y:y + h, x:x + w]
def add(p): p.click('button:text-is("Add region")'); ready(p)
def mode(p, label): p.click(f'[aria-label="Protection type"] button:text-is("{label}")'); ready(p)
def setval(p, sel, v): p.eval_on_selector(sel, "(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))}", v); ready(p)
def solid(p, hexv): mode(p, 'Solid'); setval(p, '#rd-color', hexv)
def go(p, name, path='/blur', vp=None): load(p, BASE, name, path)
def visual_rect(p, sw, sh):
    c = p.locator('.crop-canvas').bounding_box(); b = p.locator('.rd-box.sel').bounding_box(); k = sw / c['width']
    return ((b['x'] - c['x']) * k, (b['y'] - c['y']) * k, b['width'] * k, b['height'] * k)
def close(a, b, tol): return all(abs(x - y) <= tol for x, y in zip(a, b))
def var_(a): return float(np.var(a.astype(float)))

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    p.goto(BASE + '/'); check('Blur & Redact is in the nav and on the home cards', 'Blur & Redact' in p.locator('#toolNav a').all_text_contents() and p.locator('.task-card:has-text("Blur")').count() == 1)
    go(p, 'checker.png')
    check('empty state: no regions, picture unchanged, warning always visible', 'No regions yet' in p.inner_text('.tool-hint[role=status]') and 'Check the exported file' in p.inner_text('.rd-warning') and 'Solid' in p.inner_text('.rd-warning'))
    f, name = download(p, 'none'); check('no regions -> output is the original pixels (lossless PNG)', np.array_equal(arr(f), ORIG))
    add(p); R1 = sel_rect(p)
    check('Add region (keyboard-reachable button) makes a centred 120 × 60 region at 140,120', R1 == (140, 120, 120, 60), str(R1))
    check('edits bar shows "1 protected region"', '1 protected region' in p.inner_text('.edits'))
    check('region appears in the keyboard list', p.locator('.rd-list button').count() == 1)

    # ---- solid
    solid(p, '#000000'); f, name = download(p, 's1'); o = arr(f)
    check('SOLID black: every pixel inside is exactly (0,0,0)', (inside(o, R1) == 0).all())
    check('SOLID: pixels outside the region are identical to the original', outside_equal(o, ORIG, [R1]))
    check('download name has the redacted suffix', name == 'checker-redacted.png', name)
    setval(p, '#rd-color', '#ff0000'); f, _ = download(p, 's2'); o = arr(f)
    check('SOLID red: exact (255,0,0) in the region and region bbox is exact', (inside(o, R1) == (255, 0, 0)).all() and color_bbox(o, (255, 0, 0)) == (140, 120, 260, 180), str(color_bbox(o, (255, 0, 0))))
    check('result notes say how many regions and ask to check the file', 'region was' in notices(p) and 'Check the file before sharing' in notices(p), notices(p))

    # ---- pixelate
    mode(p, 'Pixelate'); setval(p, '#rd-strength', '3'); f, _ = download(p, 'px'); o = arr(f); reg = inside(o, R1); cell = 9
    consts = all(len({tuple(c) for c in reg[y:y + cell, x:x + cell].reshape(-1, 3)}) == 1 for y in range(0, 60, cell) for x in range(0, 120, cell))
    check('PIXELATE: every 9 × 9 cell (strength 3, 60 px short side) is a single colour', consts)
    check('PIXELATE: region really changed, and outside is identical', not np.array_equal(reg, inside(ORIG, R1)) and outside_equal(o, ORIG, [R1]))
    check('PIXELATE: no pixel of the original checker pattern survives as pure black+white mix per cell', len({tuple(c) for c in reg.reshape(-1, 3)}) <= 50)
    # ---- blur
    mode(p, 'Blur'); f, _ = download(p, 'bl'); o = arr(f); reg = inside(o, R1)
    check('BLUR: variance inside collapses (< 10% of the sharp checkerboard)', var_(reg) < 0.10 * var_(inside(ORIG, R1)), f'{var_(reg):.0f} vs {var_(inside(ORIG, R1)):.0f}')
    check('BLUR: pixels outside the region identical to the original (no bleed)', outside_equal(o, ORIG, [R1]))
    check('BLUR: no sharp black/white pixels left in the middle of the region', not ((inside(o, (R1[0] + 30, R1[1] + 15, 60, 30)) < 20).any() or (inside(o, (R1[0] + 30, R1[1] + 15, 60, 30)) > 235).any()))

    # ---- multiple regions, keyboard move, list select, delete
    add(p); R2a = sel_rect(p); p.focus('.rd-box.sel')
    for _ in range(20): p.keyboard.press('ArrowDown')
    ready(p); R2 = sel_rect(p)
    check('arrow keys nudge the selected region (4 px steps on a 400 px image)', R2[1] == R2a[1] + 80 and R2[0] == R2a[0], f'{R2a} -> {R2}')
    solid(p, '#00ff00'); p.click('.rd-list button:has-text("Region 1")'); ready(p); solid(p, '#ff0000')
    check('list button selects a region (keyboard alternative to clicking)', sel_rect(p) == R1)
    f, _ = download(p, 'multi'); o = arr(f)
    check('two regions: red and green areas exact, everything else identical', (inside(o, R1) == (255, 0, 0)).all() and (inside(o, R2) == (0, 255, 0)).all() and outside_equal(o, ORIG, [R1, R2]))
    check('edits bar shows "2 protected regions"', '2 protected regions' in p.inner_text('.edits'))
    p.click('.rd-list button:has-text("Region 2")'); p.focus('.rd-box.sel'); p.keyboard.press('Delete'); ready(p)
    f, _ = download(p, 'del1'); o = arr(f)
    check('Delete key removes the selected region: its area is restored to original pixels', p.locator('.rd-box').count() == 1 and outside_equal(o, ORIG, [R1]) and '1 protected region' in p.inner_text('.edits'))
    p.click('.rd-list button:has-text("Region 1")'); p.click('button:text-is("Delete region")'); ready(p); f, _ = download(p, 'del2')
    check('Delete button removes the last region: output equals the original again; chip gone', np.array_equal(arr(f), ORIG) and p.locator('.edit-chip').count() == 0)
    add(p); add(p); p.click('[aria-label^="Remove 2 protected"]'); ready(p); check('edits-bar × removes all regions at once', p.locator('.rd-box').count() == 0)

    # ---- Shift+arrow resize, mouse draw
    add(p); p.focus('.rd-box.sel')
    for _ in range(5): p.keyboard.press('Shift+ArrowRight')
    ready(p); r = sel_rect(p); check('Shift+arrow resizes (width 120 -> 140)', r[2] == 140 and r[3] == 60, str(r))
    p.click('button:text-is("Delete region")'); ready(p)
    p.evaluate('window.scrollTo(0,0)'); c = p.locator('.crop-canvas').bounding_box()
    p.mouse.move(c['x'] + c['width'] * 0.10, c['y'] + c['height'] * 0.10); p.mouse.down(); p.mouse.move(c['x'] + c['width'] * 0.25, c['y'] + c['height'] * 0.2, steps=6)
    p.mouse.move(c['x'] + c['width'] * 0.40, c['y'] + c['height'] * 0.35, steps=6); p.mouse.up(); ready(p)
    check('drawing on the picture with the mouse creates one region', p.locator('.rd-box').count() == 1)
    r = sel_rect(p); check('drawn region matches the drag in source pixels (40,30 -> 160,105, ±3)', close(r, (40, 30, 120, 75), 3), str(r))
    solid(p, '#ff0000'); f, _ = download(p, 'drawn'); o = arr(f)
    check('drawn region: output red box equals the region exactly', color_bbox(o, (255, 0, 0)) == (r[0], r[1], r[0] + r[2], r[1] + r[3]), f'{color_bbox(o, (255, 0, 0))} vs {r}')
    p.evaluate('window.scrollTo(0,0)'); p.mouse.click(c['x'] + c['width'] * 0.9, c['y'] + c['height'] * 0.9); p.wait_for_timeout(200)
    check('clicking empty picture deselects (no region made)', p.locator('.rd-box').count() == 1 and p.locator('.rd-box.sel').count() == 0)

    # ---- alignment across viewports
    for vw, vh in [(1200, 900), (700, 800), (390, 844)]:
        c2 = b.new_context(viewport={'width': vw, 'height': vh}, accept_downloads=True); q = c2.new_page(); go(q, 'checker.png'); add(q); q.focus('.rd-box.sel')
        for _ in range(3): q.keyboard.press('ArrowRight')
        for _ in range(2): q.keyboard.press('ArrowDown')
        ready(q); solid(q, '#ff0000'); rr = sel_rect(q); vr = visual_rect(q, SW, SH); f, _ = download(q, f'vp{vw}'); o = arr(f); bb = color_bbox(o, (255, 0, 0))
        check(f'alignment @ {vw}px: on-screen box == region == exported red box (±1.5 px)', rr == (152, 128, 120, 60) and close(vr, rr, 1.5) and bb == (152, 128, 272, 188), f'{rr} {tuple(round(v, 1) for v in vr)} {bb}')
        c2.close()

    # ---- EXIF-rotated JPEG
    go(p, 'rotated.jpg'); add(p); p.focus('.rd-box.sel')
    for _ in range(6): p.keyboard.press('ArrowRight')
    ready(p); solid(p, '#00ff00'); rr = sel_rect(p, 1500, 2000); vr = visual_rect(p, 1500, 2000); f, _ = download(p, 'rotj'); im = Image.open(f).convert('RGB'); o = np.array(im)
    ys, xs = np.where((o[:, :, 1] > 200) & (o[:, :, 0] < 70) & (o[:, :, 2] < 70)); bb = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    check('EXIF-rotated JPEG: output is upright 1500 × 2000, red top / blue bottom intact', im.size == (1500, 2000) and near(im.getpixel((750, 100)), RED, 12) and near(im.getpixel((750, 1800)), BLUE, 12), str(im.size))
    check('EXIF-rotated JPEG: box on screen == region == green area in the file (±2 px)', close(vr, rr, 2) and close(bb, (rr[0], rr[1], rr[0] + rr[2], rr[1] + rr[3]), 2), f'{rr} {tuple(round(v, 1) for v in vr)} {bb}')

    # ---- with Resize (rounding outward) and Crop
    go(p, 'checker.png', '/resize'); p.fill('#rw', '150'); ready(p); dims = txt(p, 'dimsAfter'); nav(p, 'Blur & Redact'); add(p); solid(p, '#ff0000')
    f, _ = download(p, 'rsz'); o = arr(f); H = int(dims.split('×')[1]); kx, ky = 150 / SW, H / SH
    import math; exp = (math.floor(140 * kx + 1e-6), math.floor(120 * ky + 1e-6), math.ceil(260 * kx - 1e-6), math.ceil(180 * ky - 1e-6))
    check(f'with Resize to 150 × {H}: region rounds OUTWARD in output pixels (bbox {exp})', o.shape[1] == 150 and color_bbox(o, (255, 0, 0)) == exp, f'{color_bbox(o, (255, 0, 0))} vs {exp} {o.shape}')
    p.click('[aria-label^="Remove Resize"]'); ready(p)
    go(p, 'checker.png', '/crop'); p.click('.chip:text-is("1:1")'); ready(p); nav(p, 'Blur & Redact'); add(p); solid(p, '#ff0000'); add(p); p.focus('.rd-box.sel')
    for _ in range(30): p.keyboard.press('ArrowLeft')
    ready(p); solid(p, '#00ff00'); R2 = sel_rect(p); f, _ = download(p, 'crp'); o = arr(f)
    check('with Crop 300 × 300: first region shifts by the crop origin (90,120 -> 210,180)', o.shape[:2] == (300, 300) and color_bbox(o, (255, 0, 0)) == (90, 120, 210, 180), f'{color_bbox(o, (255, 0, 0))} {o.shape}')
    check('with Crop: a region partly outside the crop is clipped to it (left edge 0)', color_bbox(o, (0, 255, 0))[0] == 0 and color_bbox(o, (0, 255, 0))[2] == R2[0] + R2[2] - 50, f'{color_bbox(o, (0, 255, 0))} {R2}')
    p.click('[aria-label^="Remove Crop"]'); ready(p)

    # ---- metadata interplay + file-level cleanliness
    go(p, 'meta.jpg'); add(p); solid(p, '#ff0000'); f, name = download(p, 'metaR'); im = Image.open(f); bts = open(f, 'rb').read()
    check('JPEG with EXIF/GPS/XMP: redacted output has no planted marker and no EXIF/GPS at all', not [m for m in MARKERS if m.encode() in bts] and len(im.getexif().keys()) == 0 and not im.getexif().get_ifd(0x8825), str(list(im.getexif().keys())))
    check('...is upright 300 × 400 with the red cover inside', im.size == (300, 400) and near(im.convert('RGB').getpixel((150, 200)), RED, 45), str(im.size))
    nav(p, 'Remove Metadata'); p.wait_for_selector('.meta-list li')
    check('Remove Metadata with regions: Lossless disabled, reason mentions blur regions', p.is_disabled('[aria-label="Removal method"] button:text-is("Lossless")') and 'blur regions' in p.inner_text('.meta-reason'), p.inner_text('.meta-reason'))
    f, _ = download(p, 'metaR2'); bts = open(f, 'rb').read(); check('...and its rebuilt output is clean and still has the cover', not [m for m in MARKERS if m.encode() in bts] and near(Image.open(f).convert('RGB').getpixel((150, 200)), RED, 45))
    nav(p, 'Blur & Redact'); p.click('[aria-label^="Remove 1 protected"]'); ready(p)

    # ---- target-KB path keeps the cover aligned after scaling
    go(p, 'photo.jpg'); p.click('button:text-is("Target size")'); ready(p); p.click('.chip:text-is("100 KB")'); ready(p); add(p); setval(p, '#rd-strength', '4'); solid(p, '#000000')
    rr = sel_rect(p, 3000, 2000); f, _ = download(p, 'tgt'); im = Image.open(f).convert('RGB'); W, H = im.size; o = np.array(im); fx_, fy_ = W / 3000, H / 2000
    x0, y0, x1, y1 = [int(v) for v in (rr[0] * fx_, rr[1] * fy_, (rr[0] + rr[2]) * fx_, (rr[1] + rr[3]) * fy_)]; mx, my = int((x1 - x0) * 0.06), int((y1 - y0) * 0.06)
    core = o[y0 + my:y1 - my, x0 + mx:x1 - mx]; ring = o[max(0, y0 - int(0.03 * H)):y0 - 2, x0:x1]
    check(f'target 100 KB (output {W} × {H}, {os.path.getsize(f) // 1024} KB): cover is black and at the scaled position', core.max() < 40 and ring.mean() > 40 and os.path.getsize(f) <= 105 * 1024, f'{core.max()} {ring.mean():.0f} {os.path.getsize(f)}')
    p.click('[aria-label^="Remove 1 protected"]'); ready(p)

    # ---- performance + limit
    t0 = time.time(); go(p, 'photo.jpg')
    for _ in range(3): add(p)
    dt = time.time() - t0; f, _ = download(p, 'perf')
    check(f'3 default (blur) regions on a 6 MP photo process quickly ({dt:.1f}s incl. load)', Image.open(f).size == (3000, 2000) and dt < 30, f'{dt:.1f}s')
    go(p, 'checker.png')
    for _ in range(50): p.click('button:text-is("Add region")')
    ready(p); check('50 region cap: Add region disabled at 50, readout says so', p.is_disabled('button:text-is("Add region")') and '50 of 50' in p.inner_text('.tool-hint[role=status]') and '50 protected regions' in p.inner_text('.edits'))
    f, _ = download(p, 'fifty'); check('50 regions still export a valid image of the same size', Image.open(f).size == (SW, SH))
    check('no console errors', not errors, ' | '.join(errors)[:300])
    ctx.close(); b.close()
finally: srv.terminate()
finish()
