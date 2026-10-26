"""Hardening/compat/perf e2e. Run after: npm run build && python3 tests/e2e/make_fixtures.py
Simulations (marked SIM) imitate other engines' behaviour inside Chromium; they are NOT Safari/Firefox runs."""
import os, re, shutil, subprocess, sys, tempfile, time
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FIX = os.path.join(ROOT, 'tests', 'e2e', 'fixtures'); PORT = 4197; BASE = f'http://127.0.0.1:{PORT}'
results = []; tmp = tempfile.mkdtemp()
def check(name, cond, detail=''):
    results.append((bool(cond), name)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if (detail and not cond) else ''), flush=True)
def info(msg): print('     ' + msg, flush=True)
def fx(n): return os.path.join(FIX, n)
def kb(t): m = re.match(r'([\d.]+)\s*(B|KB|MB)', t.strip()); return float(m.group(1)) * {'B': 1, 'KB': 1024, 'MB': 1048576}[m.group(2)]
def txt(p, k): return p.inner_text(f'[data-r="{k}"]').strip()
def ready(p, t=180000):
    p.wait_for_timeout(350); p.wait_for_function("()=>{const l=document.querySelector('[data-r=barLabel]');return l&&l.textContent!=='processing…'}", timeout=t)
def notices(p): return ' | '.join(p.locator('.notice').all_inner_texts())
def load(p, name, path='/'):
    p.goto(BASE + path); p.set_input_files('input[type=file]', fx(name)); p.wait_for_selector('.workbench', timeout=120000); ready(p)
def nav(p, label): p.click(f'#toolNav a:text-is("{label}")'); p.wait_for_timeout(300); p.wait_for_selector('.workbench'); ready(p)
def num(p, sel, v): p.fill(sel, str(v)); ready(p)
def dl(p, name='x'):
    with p.expect_download() as d: p.click('button:text-is("Download result")')
    f = os.path.join(tmp, name + '_' + d.value.suggested_filename); d.value.save_as(f); return Image.open(f).convert('RGB')
def near(px, rgb, tol=40): return all(abs(a - b) <= tol for a, b in zip(px, rgb))
RED, BLUE, WHITE = (255, 0, 0), (0, 0, 255), (255, 255, 255)

INSTR = """
window.__enc=[]; window.__blobs={c:0,r:0}; window.__long=[];
const tb=HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob=function(cb,type,q){const w=this.width,h=this.height;return tb.call(this,(b)=>{window.__enc.push({type,w,h,size:b&&b.size});cb(b)},type,q)};
const co=URL.createObjectURL, cr=URL.revokeObjectURL;
URL.createObjectURL=function(x){window.__blobs.c++;return co.call(URL,x)}; URL.revokeObjectURL=function(x){window.__blobs.r++;return cr.call(URL,x)};
try{new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__long.push(Math.round(e.duration)))).observe({entryTypes:['longtask']})}catch(e){}
"""
srv = subprocess.Popen(['node', 'tests/e2e/serve.mjs'], cwd=ROOT, env={**os.environ, 'PORT': str(PORT)}); time.sleep(1)
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    def newpage(init=INSTR, **kw):
        c = b.new_context(viewport=kw.pop('viewport', {'width': 1200, 'height': 900}), accept_downloads=True, **kw)
        if init: c.add_init_script(init)
        return c, c.new_page()

    # ================= 1. IMAGE SAFETY =================
    c, p = newpage()
    def reject(name):
        p.goto(BASE + '/'); t = time.time(); p.set_input_files('input[type=file]', fx(name))
        p.wait_for_selector('.dz-error:not([hidden])', timeout=60000); return time.time() - t, p.inner_text('.dz-error'), p.locator('.workbench').count()
    dt, msg, wb = reject('huge.png'); check('110 MP PNG rejected BEFORE decoding (fast, says megapixels)', dt < 0.9 and 'megapixel' in msg and not wb, f'{dt:.2f}s {msg}'); info(f'huge.png rejected in {dt:.2f}s (was 1.14s with full decode)')
    for n in ['lie.png', 'lie.jpg']:
        dt, msg, wb = reject(n); check(f'header claiming 60000x60000 ({n}) rejected up front with size message', 'megapixel' in msg and not wb, msg)
    dt, msg, wb = reject('trunc.jpg'); check('truncated JPEG rejected cleanly', not wb and len(msg) > 10, msg)
    dt, msg, wb = reject('anim.webp'); check('animated WEBP rejected with clear message', 'Animated' in msg and not wb, msg)
    dt, msg, wb = reject('fake.jpg'); check('random bytes named .jpg rejected (magic bytes, not extension)', not wb)
    for n in ['prog.jpg', 'bigmeta.jpg']:
        load(p, n); check(f'{n} (progressive / 190 KB of metadata before frame header) loads with correct dims', txt(p, 'dimsBefore') == '1200 × 800', txt(p, 'dimsBefore'))
    load(p, 'rotated.jpg'); check('EXIF orientation 6: dims read as upright 1500 × 2000', txt(p, 'dimsBefore') == '1500 × 2000')
    # race: slow 24MP decode started first, tiny chosen last
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', fx('photo24.jpg')); p.set_input_files('input[type=file]', fx('tiny.jpg')); p.wait_for_timeout(4000)
    check('RACE: last chosen file wins over slower earlier decode', p.locator('.workbench').count() == 1 and txt(p, 'dimsBefore') == '200 × 200', txt(p, 'dimsBefore') if p.locator('.workbench').count() else 'none')
    # drop outside the dropzone
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', fx('tiny.jpg')); p.wait_for_selector('.workbench')
    r = p.evaluate("""()=>{const mk=(files)=>{const dt=new DataTransfer(); if(files) dt.items.add(new File(['x'],'a.jpg',{type:'image/jpeg'})); else dt.setData('text/plain','hi'); return dt};
      const f=mk(true), t=mk(false); const out={};
      for(const type of ['dragover','drop']){ out['file_'+type]=!document.body.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:f})); out['text_'+type]=!document.body.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:t})); }
      return out}""")
    check('file dropped outside dropzone is neutralised (no navigation away)', r['file_dragover'] and r['file_drop'], str(r))
    check('non-file drags (text) are left alone', not r['text_dragover'] and not r['text_drop'], str(r))
    # XSS filename
    xs = '/tmp/"><img src=x onerror=window.__xss=1>.jpg'; shutil.copy(fx('tiny.jpg'), xs)
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', xs); p.wait_for_selector('.workbench'); ready(p)
    check('hostile filename is inert (no injected element, no script)', p.locator('img[src="x"]').count() == 0 and not p.evaluate('window.__xss === 1'))
    c.close()

    # ================= 2. PIXEL-EXACT CROP / RESIZE =================
    c, p = newpage(None)
    load(p, 'quad.png'); nav(p, 'Crop')   # 2000x1000: left half red, right half blue; PNG in -> PNG out (lossless)
    check('quad.png: output defaults to lossless PNG', p.input_value('#format') == 'image/png')
    p.click('.chip:text-is("1:1")'); ready(p); im = dl(p, 'q11')
    check('crop 1:1 centred on landscape = 1000 × 1000', im.size == (1000, 1000), str(im.size))
    check('crop 1:1 pixels: red | blue split exactly in the middle (source x=500..1500)', near(im.getpixel((10, 500)), RED, 2) and near(im.getpixel((498, 500)), RED, 2) and near(im.getpixel((502, 500)), BLUE, 2) and near(im.getpixel((990, 500)), BLUE, 2))
    p.evaluate('window.scrollTo(0,0)'); p.wait_for_timeout(200)   # the Download click scrolled the page; keep the box on screen
    bb = p.locator('.crop-box').bounding_box(); st = p.locator('.crop-stage').bounding_box()
    p.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); p.mouse.down(); p.mouse.move(2, bb['y'] + bb['height'] / 2, steps=6); p.mouse.up(); ready(p); im = dl(p, 'qL')
    check('dragging crop box to far LEFT outputs only red', im.size == (1000, 1000) and near(im.getpixel((5, 5)), RED, 2) and near(im.getpixel((995, 995)), RED, 2), f'{im.size} {im.getpixel((5,5))} {im.getpixel((995,995))} chip={p.inner_text(".edits")!r}')
    p.evaluate('window.scrollTo(0,0)'); p.wait_for_timeout(200)
    bb = p.locator('.crop-box').bounding_box()
    p.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); p.mouse.down(); p.mouse.move(1198, bb['y'] + bb['height'] / 2, steps=6); p.mouse.up(); ready(p); im = dl(p, 'qR')
    check('dragging crop box to far RIGHT outputs only blue', near(im.getpixel((5, 5)), BLUE, 2) and near(im.getpixel((995, 995)), BLUE, 2), f'{im.getpixel((5,5))} {im.getpixel((995,995))}')
    nav(p, 'Resize'); p.click('button:text-is("Reset size")'); p.click('.edit-chip button'); ready(p)   # clear crop
    num(p, '#rw', 1000); im = dl(p, 'sc')
    check('scale 1000 wide (locked) -> 1000 × 500, split in middle', im.size == (1000, 500) and near(im.getpixel((490, 250)), RED, 2) and near(im.getpixel((510, 250)), BLUE, 2), str(im.size))
    p.click('button:text-is("Exact size")'); p.click('.chip:text-is("400 × 400")'); ready(p); num(p, '#rw', 500); num(p, '#rh', 500)
    im = dl(p, 'fill')
    check('exact 500x500 FILL crops sides evenly (centre split)', im.size == (500, 500) and near(im.getpixel((240, 250)), RED, 2) and near(im.getpixel((260, 250)), BLUE, 2) and near(im.getpixel((5, 5)), RED, 2))
    p.select_option('#rfit', 'contain'); ready(p); im = dl(p, 'contain')
    check('exact 500x500 CONTAIN: white bars top/bottom, whole image visible', im.size == (500, 500) and near(im.getpixel((250, 20)), WHITE, 2) and near(im.getpixel((250, 480)), WHITE, 2) and near(im.getpixel((100, 250)), RED, 2) and near(im.getpixel((400, 250)), BLUE, 2) and near(im.getpixel((5, 250)), RED, 2))
    p.select_option('#rfit', 'stretch'); ready(p); im = dl(p, 'stretch')
    check('exact 500x500 STRETCH: whole image squeezed (split at 250)', near(im.getpixel((240, 250)), RED, 2) and near(im.getpixel((260, 250)), BLUE, 2))
    # portrait
    load(p, 'portrait_quad.png', '/resize'); check('portrait dims 1500 × 2000', txt(p, 'dimsBefore') == '1500 × 2000')
    num(p, '#rw', 750); check('portrait lock: width 750 -> height 1000', p.input_value('#rh') == '1000' and txt(p, 'dimsAfter') == '750 × 1000')
    num(p, '#rh', 500); check('portrait lock: height 500 -> width 375', p.input_value('#rw') == '375')
    p.click('button:text-is("Exact size")'); p.click('.chip:text-is("400 × 400")'); ready(p); num(p, '#rw', 600); num(p, '#rh', 600); im = dl(p, 'pfill')
    check('portrait -> 600x600 FILL keeps the middle (red/blue boundary at row 300)', im.size == (600, 600) and near(im.getpixel((300, 290)), RED, 2) and near(im.getpixel((300, 310)), BLUE, 2), str(im.size))
    nav(p, 'Crop'); p.click('[aria-label^="Remove Resize"]'); ready(p); p.click('.chip:text-is("4:5")'); ready(p); im = dl(p, 'p45')
    check('portrait crop 4:5 = full width 1500 × 1875', im.size == (1500, 1875), str(im.size))
    check('portrait crop 4:5 pixels: top red, bottom blue, boundary ~row 937', near(im.getpixel((10, 900)), RED, 2) and near(im.getpixel((10, 980)), BLUE, 2))
    p.click('.chip:text-is("16:9")'); ready(p); im = dl(p, 'p169'); check('portrait crop 16:9 = 1500 × 844', im.size == (1500, 844) or im.size == (1500, 843), str(im.size))
    load(p, 'rotated.jpg', '/resize'); num(p, '#rw', 750); im = dl(p, 'rotres')
    check('EXIF-rotated photo resized upright: 750 × 1000, red on top, blue below', im.size == (750, 1000) and near(im.getpixel((375, 100)), RED, 60) and near(im.getpixel((375, 800)), BLUE, 60), str(im.size))
    # never upscale
    load(p, 'tiny.jpg', '/resize'); check('Allow enlarging is OFF by default', not p.is_checked('#rup'))
    num(p, '#rw', 400); check('tiny 200px -> 400 blocked, no output', 'Allow enlarging' in notices(p) and txt(p, 'sizeAfter') == '—')
    p.click('.chip:text-is("50%")'); ready(p); check('50% preset never upscales (100 × 100)', txt(p, 'dimsAfter') == '100 × 100')
    p.click('button:text-is("Exact size")'); p.click('.chip:text-is("1080 × 1080")'); ready(p); check('exact 1080 from 200px blocked by default', txt(p, 'sizeAfter') == '—')
    p.check('#rup'); ready(p); check('explicit Allow enlarging -> exact 1080 × 1080 produced', txt(p, 'dimsAfter') == '1080 × 1080')
    c.close()

    # ================= 3. LARGE PHOTOS / LIMITS =================
    c, p = newpage()
    p.goto(BASE + '/'); p.set_input_files('input[type=file]', fx('photo50.jpg')); p.wait_for_selector('.workbench'); ready(p)
    m = notices(p)
    check('48.9 MP photo in Compress: blocked with ACTIONABLE message (size, limit, Resize)', '8160 × 6120' in m and '40 MP' in m and 'Resize' in m and 'smaller dimensions' not in m, m)
    check('blocked state has no download', p.is_disabled('button:text-is("Download result")'))
    nav(p, 'Resize'); t = time.time(); p.click('.chip:text-is("50%")'); ready(p); dt = time.time() - t
    check('recovery: Resize 50% of 48.9 MP -> 4080 × 3060 works', txt(p, 'dimsAfter') == '4080 × 3060', txt(p, 'dimsAfter')); info(f'48.9 MP -> 50% encode: {dt:.1f}s wall (headless desktop)')
    nav(p, 'Crop'); p.click('[aria-label^="Remove Resize"]'); ready(p); p.click('.chip:text-is("1:1")'); ready(p); check('recovery: Crop 1:1 of 48.9 MP -> 6120 × 6120 (37.5 MP, under the limit) works', txt(p, 'dimsAfter') == '6120 × 6120', txt(p, 'dimsAfter'))
    c.close()

    # ================= 4. COMPAT SIMULATIONS (Chromium imitating other engines) =================
    c, p = newpage(INSTR + "const t2=HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob=function(cb,type,q){ if(type==='image/webp') type='image/png'; return t2.call(this,cb,type,q)};")
    load(p, 'photo24.jpg'); p.click('button:text-is("Target size")'); ready(p); p.evaluate('window.__enc.length=0'); t = time.time(); p.select_option('#format', 'image/webp'); ready(p); dt = time.time() - t
    n = p.evaluate('window.__enc.length')
    check('SIM no-WEBP-encoder browser: falls back to JPG fast with explanation', p.input_value('#format') == 'image/jpeg' and 'not supported by this browser' in notices(p), notices(p))
    check('SIM no-WEBP-encoder: no wasted PNG encodes (was 12 on 24 MP)', all(e['type'] != 'image/webp' or e['w'] > 1 for e in p.evaluate('window.__enc')) and n <= 9, f'{n} encodes'); info(f'fallback took {dt:.1f}s with {n} encodes')
    c.close()
    c, p = newpage("const cib=window.createImageBitmap; window.createImageBitmap=function(s,o){ if(o&&o.imageOrientation==='from-image') return Promise.reject(new TypeError('invalid enum')); return cib.apply(window,arguments)};")
    load(p, 'rotated.jpg'); check('SIM engine rejecting imageOrientation enum: image still loads upright', txt(p, 'dimsBefore') == '1500 × 2000', txt(p, 'dimsBefore'))
    c.close()
    rot_size = os.path.getsize(fx('rotated.jpg'))
    c, p = newpage(f"""const cib=window.createImageBitmap; window.createImageBitmap=async function(s,o){{ const bm=await cib.call(window,s);
      if(!(s instanceof Blob)||s.size!=={rot_size}) return bm;             // imitate an engine that ignores EXIF: hand back STORED pixels (rotated 90 CCW)
      const c=document.createElement('canvas'); c.width=bm.height; c.height=bm.width; const x=c.getContext('2d'); x.translate(0,bm.width); x.rotate(-Math.PI/2); x.drawImage(bm,0,0); return cib.call(window,c) }};""")
    load(p, 'rotated.jpg'); check('SIM engine ignoring EXIF orientation: app corrects it (dims 1500 × 2000)', txt(p, 'dimsBefore') == '1500 × 2000', txt(p, 'dimsBefore'))
    nav(p, 'Crop'); p.click('.chip:text-is("1:1")'); ready(p); im = dl(p, 'simrot')
    check('SIM engine ignoring EXIF: pixels upright (red top, blue left-centre)', near(im.getpixel((750, 10)), RED, 70) and near(im.getpixel((10, 750)), BLUE, 70), f'{im.getpixel((750,10))} {im.getpixel((10,750))}')
    c.close()
    c, p = newpage("const gi=CanvasRenderingContext2D.prototype.getImageData; CanvasRenderingContext2D.prototype.getImageData=function(...a){ if(this.canvas.width*this.canvas.height>16777216) return new ImageData(1,1); return gi.apply(this,a)};")
    load(p, 'photo24.jpg'); m = notices(p)
    check('SIM engine whose big canvases silently render blank: refuses instead of exporting a blank file', 'cannot process an image this large' in m and p.is_disabled('button:text-is("Download result")'), m)
    load(p, 'photo.jpg'); check('SIM: normal-size photo unaffected', p.is_enabled('button:text-is("Download result")'))
    c.close()

    # ================= 5. TOUCH (real touch events through CDP) =================
    c, p = newpage(None, viewport={'width': 390, 'height': 700}, has_touch=True, is_mobile=True)
    load(p, 'photo.jpg', '/crop'); p.wait_for_selector('.crop-stage'); cdp = c.new_cdp_session(p)
    def swipe(x, y, dy, steps=12):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        for i in range(1, steps + 1):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y + dy * i / steps}]}); time.sleep(0.016)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); p.wait_for_timeout(700)
    def scrolled(x, y):
        p.evaluate('window.scrollTo(0,0)'); p.wait_for_timeout(150); swipe(x, y, -250); return p.evaluate('window.scrollY')
    st = p.locator('.crop-stage').bounding_box()
    check('touch swipe on the nav scrolls the page (control)', scrolled(30, 90) > 100)
    sy = scrolled(st['x'] + st['width'] / 2, st['y'] + st['height'] / 2)
    check('touch swipe over the WHOLE-image crop box scrolls the page (no scroll trap)', sy > 100, f'scrollY {sy}')
    p.click('.chip:text-is("1:1")'); ready(p); bx = p.locator('.crop-box').bounding_box(); st = p.locator('.crop-stage').bounding_box()
    sy = scrolled(bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2)
    check('swiping a PARTIAL crop box drags it instead of scrolling', sy < 20, f'scrollY {sy}')
    sy = scrolled(st['x'] + 8, st['y'] + st['height'] / 2)
    check('swiping the dimmed area outside a partial box scrolls the page', sy > 100, f'scrollY {sy}')
    p.evaluate('window.scrollTo(0,0)'); p.wait_for_timeout(200); hb = p.locator('.crop-h-se').bounding_box(); sx, sy2 = hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2
    before = txt(p, 'dimsAfter')
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': sx, 'y': sy2}]})
    for i in range(1, 7): cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': sx - 8 * i, 'y': sy2 - 8 * i}]})
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); ready(p)
    check('touch-dragging a crop handle resizes the crop', txt(p, 'dimsAfter') != before, f'{before} -> {txt(p, "dimsAfter")}')
    c.close()

    # ================= 6. TARGET-KB PERFORMANCE =================
    print('     target-KB measurements (headless desktop Chromium, noisy synthetic photos = pessimistic):')
    for name, hint in [('photo.jpg', 'orig 3.0 MB, 6 MP'), ('photo24.jpg', 'orig 10 MB, 24 MP')]:
        for tkb in [300, 100, 20, 1]:
            c, p = newpage(); load(p, name); p.evaluate('window.__enc.length=0; window.__long.length=0')
            p.click('button:text-is("Target size")'); t = time.time(); p.fill('#targetKB', str(tkb)); ready(p); dt = time.time() - t
            enc = [e for e in p.evaluate('window.__enc') if e['w'] > 1]; lng = p.evaluate('window.__long'); sz = kb(txt(p, 'sizeAfter')); base_w = 3000 if name == 'photo.jpg' else 6000
            full = sum(1 for e in enc if e['w'] == base_w)
            info(f'{name} -> {tkb:>3} KB: {len(enc)} encodes ({full} full-size), {dt:.1f}s, longest long task {max(lng) if lng else 0} ms, got {sz/1024:.1f} KB at {txt(p, "dimsAfter")}')
            reached = 'Could not get under' not in notices(p)
            check(f'{name} target {tkb} KB: reached={reached} and under target' if reached else f'{name} target {tkb} KB: unreachable handled gracefully', (sz <= tkb * 1024 + 1) if reached else p.is_enabled('button:text-is("Download result")'))
            check(f'{name} target {tkb} KB: bounded work (<= 10 encodes, <= 2 full-size)', len(enc) <= 10 and full <= 2, f'{len(enc)} / {full}')
            if reached and tkb >= 20: check(f'{name} target {tkb} KB: not wastefully small (>= 50% of target)', sz >= tkb * 1024 * 0.5, f'{sz/1024:.1f} KB')
            if name == 'photo24.jpg' and tkb <= 100: check('24 MP -> tiny target skips full-size encoding entirely', full == 0, f'{full} full-size')
            if name == 'photo24.jpg': check('24 MP: no single long task over 600 ms (headless desktop)', (max(lng) if lng else 0) < 600, str(lng))
            c.close()
    c, p = newpage(); load(p, 'tiny.jpg'); p.click('button:text-is("Target size")'); num(p, '#targetKB', 1)
    check('200 px image, 1 KB target: explained, still downloadable', ('Could not get under' in notices(p) or kb(txt(p, 'sizeAfter')) <= 1024) and p.is_enabled('button:text-is("Download result")'), notices(p)); c.close()

    # ================= 7. RESOURCE HYGIENE =================
    c, p = newpage(); load(p, 'photo.jpg')
    for q in range(20, 95, 4):
        p.eval_on_selector('#quality', "(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))}", str(q)); p.wait_for_timeout(160)
    ready(p); bl = p.evaluate('window.__blobs'); check('no blob-URL leak after 19 quality changes (live <= 3)', bl['c'] - bl['r'] <= 3, str(bl))
    p.fill('#quality', '70') if False else None
    for v in ['1', '10', '100', '1000']:
        pass
    p.click('button:text-is("Target size")')
    for v in ['5', '50', '500', '300']: p.fill('#targetKB', v); p.wait_for_timeout(40)
    ready(p); check('rapid target typing: only the final value is applied', abs(kb(txt(p, 'sizeAfter')) - 300 * 1024) < 300 * 1024 * 0.5 and 'target 300.0 KB' in txt(p, 'barLabel'), txt(p, 'barLabel'))
    p.click('button:text-is("Start over")'); p.wait_for_timeout(300); bl = p.evaluate('window.__blobs'); check('Start over releases every blob URL', bl['c'] == bl['r'], str(bl))
    c.close()
    b.close()
finally:
    srv.terminate()

fails = [r for r in results if not r[0]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
for f in fails: print('FAILED:', f[1])
sys.exit(1 if fails else 0)
