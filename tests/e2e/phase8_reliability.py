"""Phase 8: reliability checks in REAL Chromium (only Chromium: Firefox/Safari/touch are NOT covered).
Covers: tool chunk failing to load, dropzone busy/error state, batch HEIC thumbnails (no second wasm decode), batch ZIP integrity
(Python zipfile), hostile file names, security headers, no network requests to other origins, no console errors."""
import io, shutil, zipfile
import pillow_heif; pillow_heif.register_heif_opener()
from common import *
from playwright.sync_api import sync_playwright
PORT = 4198; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT)
HF = os.path.join(ROOT, 'tests', 'fixtures', 'heic')
def payload(name, data, mime='image/jpeg'): return {'name': name, 'mimeType': mime, 'buffer': data}
def jpeg_bytes(w=64, h=48, color=(200, 30, 30)):
    b = io.BytesIO(); Image.new('RGB', (w, h), color).save(b, 'JPEG', quality=85); return b.getvalue()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True); p = ctx.new_page()
    errors = []; foreign = []
    p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    p.on('request', lambda r: foreign.append(r.url) if not (r.url.startswith(BASE) or r.url.startswith('blob:') or r.url.startswith('data:')) else None)

    # ---- security headers come from vercel.json
    r = p.goto(BASE + '/'); h = {k.lower(): v for k, v in r.headers.items()}
    check('CSP still present and no unsafe-inline / unsafe-eval / remote hosts', "script-src 'self' 'wasm-unsafe-eval'" in h.get('content-security-policy', '') and 'unsafe-inline' not in h['content-security-policy'] and "'unsafe-eval'" not in h['content-security-policy'] and 'http' not in h['content-security-policy'].replace("'self'", ''), h.get('content-security-policy'))
    check('Permissions-Policy denies camera/microphone/geolocation', all(x in h.get('permissions-policy', '') for x in ('camera=()', 'microphone=()', 'geolocation=()')), h.get('permissions-policy'))

    # ---- dropzone: an invalid file shows an understandable message and the busy state is cleared (retry possible)
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', payload('notes.jpg', b'this is not an image at all' * 50))
    p.wait_for_selector('.dz-error:visible', timeout=20000)
    check('invalid file: readable message, no stack/internal text', 'not an image Shrinkit can read' in p.inner_text('.dz-error') and 'Error' not in p.inner_text('.dz-error').replace('Shrinkit', ''), p.inner_text('.dz-error'))
    check('invalid file: busy state cleared (title restored, aria-busy false)', p.get_attribute('.dropzone', 'aria-busy') == 'false' and 'Drop an image here' in p.inner_text('.dz-title'))
    p.set_input_files('input[type=file]', payload('ok.jpg', jpeg_bytes())); p.wait_for_selector('.workbench', timeout=60000)
    check('retry after an invalid file works', p.locator('.workbench').count() == 1)
    # truncated / corrupt JPEG: header fine, pixels broken -> message, previous image kept
    good = jpeg_bytes(300, 200)
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', payload('cut.jpg', good[:len(good) // 3]))
    p.wait_for_timeout(1500)
    shown = (p.locator('.dz-error:visible').all_inner_texts() or [''])[0]; has_wb = p.locator('.workbench').count()
    check('truncated JPEG: either refused with a message or opened; never a stuck page', bool(shown) or has_wb == 1, shown)

    # ---- tool chunk fails to load (offline / stale tab after a deploy): message + Reload, no blank page, other tools still work
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', payload('ok.jpg', jpeg_bytes(400, 300))); p.wait_for_selector('.workbench', timeout=60000)
    p.route('**/assets/resize-*.js', lambda route: route.abort())
    p.click('#toolNav a:text-is("Resize")'); p.wait_for_selector('#reload-tool', timeout=20000)
    check('tool chunk load failure: understandable message + Reload button (no blank page)', 'Could not load Resize' in p.inner_text('[role=alert]') and p.is_visible('#reload-tool'))
    p.unroute('**/assets/resize-*.js'); errors[:] = [e for e in errors if 'ERR_FAILED' not in e]   # that one error is the request this test aborted on purpose
    p.click('#toolNav a:text-is("Compress")'); p.wait_for_selector('.workbench', timeout=30000); ready(p)
    check('after a failed tool load another tool still works (image kept)', p.locator('[data-r=imgBefore]').count() == 1)

    # ---- batch: HEIC row has a placeholder (no wasm decode just for a thumbnail), gets a real thumbnail from its result
    p.goto(BASE + '/batch'); p.wait_for_selector('.batch .dropzone')
    p.set_input_files('.batch input[type=file]', [payload('landscape.heic', open(os.path.join(HF, 'landscape.heic'), 'rb').read(), 'image/heic'), payload('IMG.jpg', jpeg_bytes()), payload('img.JPG', jpeg_bytes(80, 60)), payload('Img.jpg', jpeg_bytes(90, 70))])
    p.wait_for_function("()=>document.querySelectorAll('.batch-item').length===4", timeout=60000)
    p.wait_for_timeout(600)
    heic_row = p.locator('.batch-item', has_text='landscape.heic').first
    check('HEIC row before processing: text placeholder, no decode-for-thumbnail', heic_row.locator('.bi-thumb').inner_text().strip() == 'HEIC' and heic_row.locator('.bi-thumb canvas').count() == 0, heic_row.locator('.bi-thumb').inner_text())
    check('JPG rows get real thumbnails', p.locator('.batch-item', has_text='IMG.jpg').first.locator('.bi-thumb canvas').count() == 1)
    p.click('[aria-label="Batch format"] button:text-is("PNG")'); p.click('#bprocess')
    p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b&&b.textContent!=='Processing…'&&/processed/.test(document.querySelector('#bstatus').textContent)}", timeout=240000)
    p.wait_for_function("()=>document.querySelector('.batch-item .bi-thumb canvas')!==null && [...document.querySelectorAll('.batch-item')].every(r=>r.querySelector('.bi-thumb canvas'))", timeout=20000)
    check('after processing the HEIC row shows a real thumbnail made from its result', heic_row.locator('.bi-thumb canvas').count() == 1)
    with p.expect_download() as d: p.click('#bzip')
    zf = os.path.join(tmp, 'b8.zip'); d.value.save_as(zf); z = zipfile.ZipFile(zf); names = z.namelist()
    check('ZIP integrity (Python zipfile.testzip: CRC of every entry)', z.testzip() is None and len(names) == 4, str(names))
    check('ZIP: duplicate stems differing only by case/extension get unique names', len({n.lower() for n in names}) == 4 and all(n.endswith('.png') for n in names), str(names))
    check('ZIP entries are real PNGs', all(Image.open(io.BytesIO(z.read(n))).format == 'PNG' for n in names))
    check('no ZIP error shown', not p.is_visible('.batch .dz-error'))

    # ---- hostile names: bidi override, path tricks, emoji at the truncation point
    evil = ['photo\u202Egpj.exe.jpg', '..\\..\\evil.jpg', 'a' * 79 + '😀.jpg', 'CON.jpg']
    p.goto(BASE + '/batch'); p.wait_for_selector('.batch .dropzone')
    p.set_input_files('.batch input[type=file]', [payload(n, jpeg_bytes(40 + i, 30)) for i, n in enumerate(evil)])
    p.wait_for_function("()=>document.querySelectorAll('.batch-item').length===4", timeout=60000)
    p.click('[aria-label="Batch format"] button:text-is("PNG")'); p.click('#bprocess')
    p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b&&b.textContent!=='Processing…'&&/processed/.test(document.querySelector('#bstatus').textContent)}", timeout=240000)
    with p.expect_download() as d: p.click('#bzip')
    zf = os.path.join(tmp, 'evil.zip'); d.value.save_as(zf); z = zipfile.ZipFile(zf); names = z.namelist()
    check('hostile names: no bidi override, no path separators, no lone surrogates / U+FFFD in ZIP names', z.testzip() is None and len(names) == 4 and not any(('\u202e' in n) or ('/' in n) or ('\\' in n) or ('\ufffd' in n) or n.startswith('.') for n in names), str(names))
    # ---- the page never talked to another origin
    check('no request left this origin (no uploads, no CDN)', not foreign, str(foreign[:3]))
    check('no console errors (CSP incl. wasm)', not errors, ' | '.join(errors[:3]))
    b.close()
finally:
  srv.terminate()
finish()
