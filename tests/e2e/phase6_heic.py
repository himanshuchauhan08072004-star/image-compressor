"""Phase 6: HEIC/HEIF. Real Chromium + REAL HEIC files (tests/fixtures/heic). Outputs verified by Pillow (independent decoder, pillow-heif for the source)."""
import io, shutil, zipfile
import pillow_heif; pillow_heif.register_heif_opener()
from common import *
from playwright.sync_api import sync_playwright
PORT = 4196; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT)
HF = os.path.join(ROOT, 'tests', 'fixtures', 'heic')
def hf(n): return os.path.join(HF, n)
def cp(src, name):
    d = os.path.join(tmp, 'in'); os.makedirs(d, exist_ok=True); p_ = os.path.join(d, name); shutil.copy(src, p_); return p_
def put(p, path, path_url='/convert'):
    p.goto(BASE + path_url); p.set_input_files('input[type=file]', path); p.wait_for_selector('.workbench', timeout=120000); ready(p)
def pick(p, label): p.click(f'.seg[aria-label="Output format"] button:text-is("{label}")'); ready(p)
def px(f): return Image.open(f)
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    # ---- Convert: landscape
    put(p, hf('landscape.heic'))
    check('HEIC opens; Convert shows ORIGINAL HEIC + size', 'HEIC' in p.inner_text('.convert-from') and '64 × 48' in p.inner_text('.convert-from'), p.inner_text('.convert-from'))
    check('before preview renders (not broken)', p.evaluate("()=>{const i=document.querySelector('[data-r=imgBefore]');return i.complete&&i.naturalWidth>0}"))
    ref = Image.open(hf('landscape.heic')).convert('RGB')
    for label, fmt, ext, mime in [('JPG', 'JPEG', 'jpg', 'image/jpeg'), ('PNG', 'PNG', 'png', 'image/png'), ('WEBP', 'WEBP', 'webp', 'image/webp')]:
        pick(p, label); f, name = download(p, 'h_' + ext); im = px(f)
        check(f'HEIC -> {label}: really {fmt}, name {ext}, size 64×48', im.format == fmt and name == f'landscape-converted.{ext}' and im.size == (64, 48), f'{im.format} {name} {im.size}')
        rgb = im.convert('RGB'); check(f'{label}: pixels match independent HEIC decode (top-left green, bottom-right blue)', near(rgb.getpixel((2, 2)), ref.getpixel((2, 2)), 30) and near(rgb.getpixel((62, 46)), ref.getpixel((62, 46)), 30), f'{rgb.getpixel((2,2))} {ref.getpixel((2,2))}')
        check(f'{label}: tool reports HEIC → {label} ({mime})', f'HEIC → {label} ({mime})' in p.inner_text('.convert-to'), p.inner_text('.convert-to'))
    check('Format cell shows HEIC → WEBP', txt(p, 'statFormat') == 'HEIC → WEBP')
    # ---- rotation (real irot box) and EXIF-only tag
    put(p, hf('irot.heic')); pick(p, 'PNG'); f, _ = download(p, 'irot'); im = px(f).convert('RGB'); ref = Image.open(hf('irot.heic')).convert('RGB')
    check('irot HEIC: output upright 48×64, rotation applied ONCE (matches independent decode)', im.size == (48, 64) == ref.size and near(im.getpixel((2, 2)), ref.getpixel((2, 2)), 30) and near(im.getpixel((45, 61)), ref.getpixel((45, 61)), 30), f'{im.size} {ref.size} {im.getpixel((2,2))} {ref.getpixel((2,2))}')
    check('irot: preview dims show 48 × 64', txt(p, 'dimsBefore') == '48 × 64', txt(p, 'dimsBefore'))
    put(p, hf('exif6.heic')); pick(p, 'PNG'); f, _ = download(p, 'exif6'); check('EXIF-only orientation tag in HEIC is not applied again (64×48)', px(f).size == (64, 48), str(px(f).size))
    # ---- alpha
    put(p, hf('alpha.heic')); check('alpha HEIC detected', 'transparency channel' in p.inner_text('.convert-from'))
    pick(p, 'PNG'); f, _ = download(p, 'ha'); check('alpha HEIC -> PNG keeps transparency', px(f).convert('RGBA').getpixel((31, 5))[3] == 0 and px(f).convert('RGBA').getpixel((2, 5))[3] == 255)
    pick(p, 'JPG'); p.eval_on_selector('#bgcolor', "(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))}", '#00ff00'); ready(p)
    f, _ = download(p, 'haj'); im = px(f); check('alpha HEIC -> JPG flattened on chosen colour', im.format == 'JPEG' and near(im.convert('RGB').getpixel((31, 5)), GREEN, 20), str(im.convert('RGB').getpixel((31, 5))))
    # ---- detection by bytes, not name/MIME
    put(p, cp(hf('landscape.heic'), 'photo.jpg')); check('HEIC bytes named .jpg still opens as HEIC', 'HEIC' in p.inner_text('.convert-from'))
    put(p, cp(fx('tiny.jpg'), 'real.heic')); check('JPEG bytes named .heic opens as JPG', 'JPG' in p.inner_text('.convert-from'), p.inner_text('.convert-from'))
    put(p, cp(hf('square.heif'), 'noext')); check('.heif / no extension: detected by bytes', '40 × 40' in p.inner_text('.convert-from'))
    # ---- errors
    def expect_err(path, rx, label):
        p.goto(BASE + '/'); p.set_input_files('input[type=file]', path); p.wait_for_selector('.dz-error:not([hidden])', timeout=60000); t = p.inner_text('.dz-error')
        check(label, re.search(rx, t) is not None and p.locator('.workbench').count() == 0, t)
    bad = os.path.join(tmp, 'in', 'text.heic'); open(bad, 'wb').write(b'hello this is not an image at all' * 10)
    expect_err(bad, 'named like a HEIC', 'text file named .heic: clear error')
    trunc = os.path.join(tmp, 'in', 'trunc.heic'); open(trunc, 'wb').write(open(hf('landscape.heic'), 'rb').read()[:300])
    expect_err(trunc, 'HEIC|damaged', 'truncated HEIC: clear error, no crash')
    ok = cp(hf('landscape.heic'), 'after.heic'); put(p, ok); check('decoder still works after failures', '64 × 48' in p.inner_text('.convert-from'))
    # ---- other tools reuse the same decoded image
    put(p, hf('irot.heic'), '/compress'); pass_ = txt(p, 'dimsBefore'); check('Compress: HEIC works, default output JPG', '48 × 64' == pass_ and 'HEIC → JPG' == txt(p, 'statFormat'), txt(p, 'statFormat'))
    nav(p, 'Resize'); check('Resize tool opens with HEIC', p.locator('.workbench').count() == 1)
    nav(p, 'Remove Metadata'); check('Metadata: lossless disabled with explanation, rebuild used', p.locator('button[data-m=lossless]').is_disabled() and 'HEIC cannot be rewritten' in p.inner_text('.meta-reason'), p.inner_text('.meta-reason'))
    ready(p); f, name = download(p, 'hm'); b_ = open(f, 'rb').read(); check('Metadata rebuild output is a clean real JPG', px(f).format == 'JPEG' and b'Exif' not in b_ and name.endswith('.jpg'), name)
    for tool, sel in [('Smart Enhancement', '.sig-file-meta'), ('Background Remover', '.sig-file-meta')]:
        p.click(f'#toolNav a:text-is("{tool}")'); p.wait_for_timeout(1200); check(f'{tool}: HEIC loaded (file info says HEIC, 48 × 64)', 'HEIC' in p.inner_text(sel) and '48 × 64' in p.inner_text(sel), p.inner_text(sel))
    p.click('#toolNav a:text-is("Smart Enhancement")'); p.wait_for_selector('#en-download'); 
    with p.expect_download() as d: p.click('#en-download')
    f = os.path.join(tmp, 'enh.' + d.value.suggested_filename); d.value.save_as(f); check('Enhance "keep format" on HEIC saves a real JPG', px(f).format == 'JPEG' and f.endswith('.jpg') and px(f).size == (48, 64), f'{px(f).format} {f}')
    # ---- batch
    p.goto(BASE + '/batch'); p.wait_for_selector('.batch .dropzone')
    files = [cp(hf('landscape.heic'), 'IMG_1.heic'), cp(hf('irot.heic'), 'IMG_1.HEIF'), cp(fx('tiny.jpg'), 'IMG_1.jpg'), trunc]
    p.set_input_files('.batch input[type=file]', files); p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b&&!b.textContent.includes('Reading')}", timeout=60000)
    p.wait_for_timeout(500); n_rows = p.locator('.batch-item').count()
    check('batch: valid HEIC/HEIF + JPG queued; truncated HEIC reported separately', n_rows >= 3 and ('trunc.heic' in p.inner_text('.batch') ), f'{n_rows}')
    p.click('[aria-label="Batch format"] button:text-is("PNG")'); p.click('#bprocess')
    p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b&&b.textContent!=='Processing…'&&/processed/.test(document.querySelector('#bstatus').textContent)}", timeout=240000)
    with p.expect_download() as d: p.click('#bzip')
    zf = os.path.join(tmp, 'b.zip'); d.value.save_as(zf); z = zipfile.ZipFile(zf); names = sorted(z.namelist())
    check('batch ZIP: unique names, all PNG (same stem IMG_1 x3)', len(names) == len(set(n.lower() for n in names)) == 3 and all(n.endswith('.png') for n in names), str(names))
    check('batch ZIP entries are genuine PNG with correct sizes', sorted(Image.open(io.BytesIO(z.read(n))).size for n in names if Image.open(io.BytesIO(z.read(n))).format == 'PNG') != [] and all(Image.open(io.BytesIO(z.read(n))).format == 'PNG' for n in names))
    sizes = sorted(Image.open(io.BytesIO(z.read(n))).size for n in names); check('batch: 64×48 and 48×64 preserved', (48, 64) in sizes and (64, 48) in sizes, str(sizes))
    check('no console errors (CSP incl. wasm)', not errors, ' | '.join(errors[:3]))
    b.close()
finally:
  srv.terminate()
finish()
