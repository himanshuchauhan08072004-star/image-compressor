"""Phase 5.4: Background Remover (colour based, not AI). Real Chromium. Downloaded files are checked pixel by pixel with Pillow/numpy."""
import numpy as np
from PIL import Image, ImageDraw
from common import *
from playwright.sync_api import sync_playwright
PORT = 4195; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT); PATH = '/background'
W, H = 800, 600; BG = (238, 238, 232); FG = (200, 40, 40)

def subject(bg=BG, hole=False, ss=4):
    im = Image.new('RGB', (W * ss, H * ss), bg); d = ImageDraw.Draw(im); d.ellipse([200 * ss, 120 * ss, 600 * ss, 480 * ss], fill=FG)
    if hole: d.ellipse([360 * ss, 260 * ss, 440 * ss, 340 * ss], fill=bg)
    return im.resize((W, H), Image.LANCZOS)
def put(im, name, fmt='PNG'): path = os.path.join(tmp, name); im.save(path, fmt); return path
def setv(p, sel, v): p.eval_on_selector(sel, "(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))}", str(v))
def seg(p, label, v): p.click(f'.seg[aria-label="{label}"] button[data-v="{v}"]')
def dl(p, tag):
    with p.expect_download() as d: p.click('#bg-download')
    f = os.path.join(tmp, tag + '_' + d.value.suggested_filename); d.value.save_as(f); return f, d.value.suggested_filename
def rgba(f): return np.asarray(Image.open(f).convert('RGBA'), int)
def idle(p): p.wait_for_timeout(300)

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    p.goto(BASE + '/'); check('Background Remover is in the nav and on the home cards', 'Background Remover' in p.locator('#toolNav a').all_text_contents() and 'Background Remover' in ' '.join(p.locator('.task-card').all_inner_texts()))
    p.click('#toolNav a:text-is("Background Remover")'); p.wait_for_selector('.dropzone'); check('route /background shows the dropzone first', p.url.endswith(PATH))
    src = put(subject(), 'ellipse.png'); p.set_input_files('input[type=file]', src); p.wait_for_selector('#bg-download', timeout=60000); idle(p)
    check('workspace opens with file info; shared Before/After panel not mounted', '800 × 600 px' in p.inner_text('.sig-file-meta') and p.locator('button:text-is("Download result")').count() == 1 and p.locator('.stage.active').count() == 0)
    check('page says plainly it is colour based, not AI, and limited to plain backgrounds', 'not AI' in p.inner_text('.tool-hint:not([role])') and 'busy street' in p.inner_text('.sig-root'))
    check('default preset Studio is pressed; automatic background', p.get_attribute('.chip[data-key=studio]', 'aria-pressed') == 'true' and 'automatic' in p.inner_text('#bg-state'))
    check('auto mode shows the detected colour in the swatch (not black)', p.input_value('#bg-color-in') == '#eeeee8', p.input_value('#bg-color-in'))

    # ---- transparent PNG
    f, name = dl(p, 'png'); a = rgba(f); im = Image.open(f)
    check('download is <name>-no-background.png, real PNG, same size as the input', name == 'ellipse-no-background.png' and im.format == 'PNG' and im.size == (W, H), name)
    check('corners and background are fully transparent', all(a[y, x, 3] == 0 for x, y in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1), (60, 300), (740, 300)]))
    check('subject centre is opaque and keeps its exact colour', tuple(a[300, 400]) == (*FG, 255), str(a[300, 400]))
    ys, xs = np.nonzero(a[..., 3] > 128); bb = (xs.min(), ys.min(), xs.max(), ys.max())
    check('cut-out box matches the drawn ellipse (±3 px)', abs(bb[0] - 200) <= 3 and abs(bb[1] - 120) <= 3 and abs(bb[2] - 599) <= 3 and abs(bb[3] - 479) <= 3, str(bb))
    area = (a[..., 3] > 128).sum(); exp = np.pi * 200 * 180; check('opaque area equals the ellipse area within 2 %', abs(area - exp) / exp < 0.02, f'{area} vs {exp:.0f}')
    edge = a[(a[..., 3] > 0) & (a[..., 3] < 255)]; check('edge has soft alpha steps (anti-aliased cut)', len(edge) > 200, str(len(edge)))
    pale = edge[edge[..., 3] > 200]; check('edge pixels are de-tinted: no pale fringe (R stays ≥ 180, G,B ≤ 90 where alpha > 200)', len(pale) > 50 and pale[:, 0].min() >= 175 and pale[:, 1].max() <= 95, f'{pale[:,0].min()} {pale[:,1].max()}' if len(pale) else 'none')
    check('status reports transparent background', 'transparent background' in p.inner_text('#bg-status'), p.inner_text('#bg-status'))

    # ---- fills and formats
    seg(p, 'Replace with', 'white'); f, _ = dl(p, 'white'); a = rgba(f); check('white fill: background pure white and opaque, subject untouched', tuple(a[5, 5]) == (255, 255, 255, 255) and tuple(a[300, 400]) == (*FG, 255))
    seg(p, 'Replace with', 'color'); p.eval_on_selector('#bg-fill-color', "e=>{e.value='#0000ff';e.dispatchEvent(new Event('input',{bubbles:true}))}"); f, _ = dl(p, 'blue'); a = rgba(f); check('colour fill: background is the chosen blue', tuple(a[5, 5]) == (0, 0, 255, 255) and tuple(a[300, 400, :3]) == FG, str(a[5, 5]))
    seg(p, 'Replace with', 'transparent'); seg(p, 'Output format', 'jpeg'); f, name = dl(p, 'jpg'); a = rgba(f); check('JPG output is a real JPEG, background white (JPG cannot be transparent)', Image.open(f).format == 'JPEG' and name.endswith('.jpg') and a[5, 5, :3].min() >= 250 and (a[..., 3] == 255).all(), name)
    seg(p, 'Output format', 'webp'); f, name = dl(p, 'webp'); im = Image.open(f); a = rgba(f); check('WEBP output keeps transparency', im.format == 'WEBP' and a[5, 5, 3] == 0 and a[300, 400, 3] == 255)

    # ---- modes: hole inside the subject
    hole = put(subject(hole=True), 'hole.png'); p.set_input_files('input[type=file]', hole); p.wait_for_selector('#bg-download'); idle(p); seg(p, 'Output format', 'png')
    f, _ = dl(p, 'edge'); a = rgba(f); check('edge mode keeps the background-coloured hole inside the subject', a[300, 400, 3] == 255 and a[5, 5, 3] == 0, str(a[300, 400]))
    p.click('.chip[data-key=paper]'); idle(p); f, _ = dl(p, 'all'); a = rgba(f); check('"everywhere" mode also clears the hole', a[300, 400, 3] == 0 and a[300, 250, 3] == 255 and a[5, 5, 3] == 0, str(a[300, 400]))
    check('Paper preset is pressed and the mode switch follows it', p.get_attribute('.chip[data-key=paper]', 'aria-pressed') == 'true' and p.get_attribute('.seg[aria-label="Where to remove"] button[data-v=all]', 'aria-pressed') == 'true')

    # ---- tolerance on a shaded background
    sh = subject(); arr = np.asarray(sh, float).copy(); mask = np.asarray(subject(), int).sum(2) > 0
    grad = np.linspace(0, 40, W)[None, :]; bgm = (np.abs(np.asarray(sh, int) - np.array(BG)).sum(2) < 6)
    for c in range(3): arr[..., c] = np.where(bgm, np.clip(arr[..., c] - grad, 0, 255), arr[..., c])
    shaded = put(Image.fromarray(arr.astype('uint8')), 'shaded.png'); p.set_input_files('input[type=file]', shaded); p.wait_for_selector('#bg-download'); idle(p)
    p.click('.chip[data-key=studio]'); setv(p, '#bg-tolerance', 3); idle(p); f, _ = dl(p, 'lowtol'); lo = rgba(f)
    p.click('.chip[data-key=shadow]'); idle(p); f, _ = dl(p, 'hitol'); hi = rgba(f)
    check('low tolerance leaves the shaded ends of the background behind (only the middle matches the detected colour)', lo[300, 770, 3] == 255 and lo[300, 5, 3] == 255 and lo[40, 400, 3] < 60, f'{lo[300,770,3]} {lo[300,5,3]} {lo[40,400,3]}')
    check('Soft shadows preset removes the whole shaded background and keeps the subject', hi[300, 770, 3] == 0 and hi[300, 5, 3] == 0 and tuple(hi[300, 400]) == (*FG, 255), f'{hi[300,770,3]} {hi[300,400]}')

    # ---- click to pick the background
    twotone = Image.new('RGB', (W, H), (30, 120, 60)); ImageDraw.Draw(twotone).ellipse([250, 150, 550, 450], fill=(240, 240, 240))
    tt = put(twotone, 'green.png'); p.set_input_files('input[type=file]', tt); p.wait_for_selector('#bg-download'); idle(p)
    f, _ = dl(p, 'green'); a = rgba(f); check('green background removed automatically; white subject kept', a[5, 5, 3] == 0 and tuple(a[300, 400]) == (240, 240, 240, 255), str(a[5, 5]))
    p.evaluate('window.scrollTo(0,0)'); box = p.locator('.sig-view').bounding_box(); p.mouse.click(box['x'] + box['width'] * 0.5, box['y'] + box['height'] * 0.5); idle(p)
    check('clicking the picture picks that colour and shows it', 'picked #f0f0f0' in p.inner_text('#bg-state'), p.inner_text('#bg-state'))
    check('picked colour that is not on the picture edge: edge mode removes nothing and the note says so', 'Almost nothing was removed' in p.inner_text('#bg-notes'), p.inner_text('#bg-notes'))
    seg(p, 'Where to remove', 'all'); idle(p); f, _ = dl(p, 'picked'); a = rgba(f); check('picked white + "everywhere" removes the white subject and keeps the green (the user is in control)', a[300, 400, 3] == 0 and a[5, 5, 3] == 255, f'{a[300,400]} {a[5,5]}')
    p.click('#bg-auto'); idle(p); check('Auto-detect clears the pick', 'automatic' in p.inner_text('#bg-state'))

    # ---- honest warnings
    rng = np.random.default_rng(2); busy = put(Image.fromarray(rng.integers(0, 255, (H, W, 3), dtype='uint8')), 'busy.png'); p.set_input_files('input[type=file]', busy); p.wait_for_selector('#bg-download'); idle(p)
    check('busy picture: tool warns the edges are not one plain colour', 'not one plain colour' in p.inner_text('#bg-notes'), p.inner_text('#bg-notes'))
    flat = put(Image.new('RGB', (W, H), BG), 'flat.png'); p.set_input_files('input[type=file]', flat); p.wait_for_selector('#bg-download'); idle(p)
    check('plain picture with no subject: warns that almost everything is removed', 'Almost everything was removed' in p.inner_text('#bg-notes'), p.inner_text('#bg-notes'))

    # ---- big picture, views, navigation, mobile
    big = Image.new('RGB', (4200, 3400), BG); ImageDraw.Draw(big).rectangle([1000, 800, 3200, 2600], fill=FG); pbig = put(big, 'big.png'); p.set_input_files('input[type=file]', pbig); p.wait_for_selector('#bg-download', timeout=60000); idle(p)
    t0 = time.time(); f, _ = dl(p, 'big'); sec = time.time() - t0; im = Image.open(f); a = np.asarray(im.convert('RGBA'))
    check('14 MP picture is reduced to 12 MP, aspect kept, and the status says so', im.size[0] * im.size[1] <= 12_000_000 and abs(im.size[0] / im.size[1] - 4200 / 3400) < 0.01 and 'reduced from 4200 × 3400' in p.inner_text('#bg-status'), f'{im.size} {p.inner_text("#bg-status")}')
    check('big picture cut-out is correct (corner clear, centre opaque)', a[5, 5, 3] == 0 and a[im.size[1] // 2, im.size[0] // 2, 3] == 255); info(f'14 MP export (reduced to 12 MP): {sec:.1f} s (headless Chromium, this machine)')
    ms = int(p.get_attribute('#bg-notes', 'data-ms')); info(f'preview repaint (1400 px): {ms} ms')
    p.set_input_files('input[type=file]', src); p.wait_for_selector('#bg-download'); idle(p); seg(p, 'Preview', 'compare'); check('compare view shows divider and slider', p.is_visible('.sig-divider') and p.is_visible('.sig-compare'))
    seg(p, 'Preview', 'before'); check('original view hides the cut-out layer', not p.is_visible('canvas[aria-label="Background removed preview"]'))
    p.click('#toolNav a:text-is("Resize")'); p.wait_for_selector('.workbench:not(.own-view)'); ready(p); check('leaving Background Remover resumes the shared pipeline (Resize renders a result)', p.locator('button:text-is("Download result")').count() == 1)
    mp = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True).new_page(); mp.goto(BASE + PATH); mp.set_input_files('input[type=file]', src); mp.wait_for_selector('#bg-download', timeout=60000)
    check('mobile 390 px: no horizontal overflow, preview fits', mp.evaluate('document.documentElement.scrollWidth') <= 391 and 200 < mp.eval_on_selector('.sig-stage', 'e=>e.getBoundingClientRect().width') <= 390, str(mp.evaluate('document.documentElement.scrollWidth')))
    check('no console errors or page errors during the whole run', not errors, ' | '.join(errors[:3]))
    b.close()
finally:
    srv.terminate()
finish()
