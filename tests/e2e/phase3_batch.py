"""Phase 3: Batch Processing. Real Chromium. ZIPs and outputs are verified independently (Python zipfile, PIL, raw byte search)."""
import hashlib, io, shutil, time, zipfile
import numpy as np
from PIL import Image, ImageOps
from common import *
from markers import MARKERS
from playwright.sync_api import sync_playwright
PORT = 4193; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT)

def mk(sub, name, src):
    d = os.path.join(tmp, sub); os.makedirs(d, exist_ok=True); p_ = os.path.join(d, name); shutil.copy(fx(src), p_); return p_
def F(*names): return [fx(n) for n in names]
def sha(b): return hashlib.sha256(b).hexdigest()
def leaks(b): return [m for m in MARKERS if m.encode() in b]
def rows(p): return p.locator('.batch-item')
def row(p, name): return p.locator('.batch-item', has_text=name).first
def rtext(p, name): return row(p, name).text_content()      # includes text inside collapsed <details>
def count_status(p, s): return p.locator(f'.batch-item[data-status="{s}"]').count()
def seg(p, group, label): p.click(f'[aria-label="{group}"] button:text-is("{label}")')
def put(p, paths, wait_rows=None):
    p.set_input_files('.batch input[type=file]', paths)
    p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b && !b.textContent.includes('Reading')}", timeout=60000)
    p.wait_for_function("(n)=>document.querySelectorAll('.batch-item').length===n", arg=wait_rows if wait_rows is not None else len(paths), timeout=60000) if (wait_rows is not None or True) else None
def fresh(p, vp=None):
    p.goto(BASE + '/batch'); p.wait_for_selector('.batch .dropzone')
def reset_opts(p):
    seg(p, 'Batch resize', 'Off'); seg(p, 'Batch format', 'Keep'); seg(p, 'Batch compress', 'Quality')
    if p.is_checked('#bstrip'): p.uncheck('#bstrip')
    if p.is_checked('#bup'): p.uncheck('#bup')
def run(p, timeout=240000):
    p.click('#bprocess')
    p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b && b.textContent!=='Processing…' && /processed/.test(document.querySelector('#bstatus').textContent)}", timeout=timeout)
def get_zip(p, name):
    with p.expect_download() as d: p.click('#bzip')
    f = os.path.join(tmp, name + '.zip'); d.value.save_as(f); return f, d.value.suggested_filename
def thumbs_ready(p, n, t=60000): p.wait_for_function("(n)=>document.querySelectorAll('.bi-thumb canvas').length>=n", arg=n, timeout=t)
def fmt_of(data): return Image.open(io.BytesIO(data)).format
INIT = """
window.__urls={created:0,revoked:0}; const _c=URL.createObjectURL.bind(URL), _r=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=function(b){window.__urls.created++;return _c(b)}; URL.revokeObjectURL=function(u){window.__urls.revoked++;return _r(u)};
window.__dec={now:0,max:0}; const _cib=window.createImageBitmap.bind(window);
window.createImageBitmap=function(...a){window.__dec.now++;window.__dec.max=Math.max(window.__dec.max,window.__dec.now);const pr=_cib(...a);const fin=()=>{window.__dec.now--};pr.then(fin,fin);return pr};
window.__maxProc=0; window.__gap=0;
addEventListener('DOMContentLoaded',()=>{ new MutationObserver(()=>{const n=document.querySelectorAll('.batch-item[data-status=processing]').length; if(n>window.__maxProc)window.__maxProc=n}).observe(document.body,{subtree:true,attributes:true,childList:true,attributeFilter:['data-status']});
 let last=performance.now(); (function tick(t){ const g=t-last; if(g>window.__gap && window.__track) window.__gap=g; last=t; requestAnimationFrame(tick)})(last)});
"""

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); ctx.add_init_script(INIT); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))

    # ---------------- empty state + navigation
    p.goto(BASE + '/'); check('Batch Processing is in the nav and on the home cards', 'Batch Processing' in p.locator('#toolNav a').all_text_contents() and p.locator('.task-card:has-text("Batch")').count() == 1)
    p.click('#toolNav a:text-is("Batch Processing")'); p.wait_for_selector('.batch .dropzone')
    check('empty state: hero, dropzone, empty message, limits text, Process disabled', p.locator('h1').count() == 1 and 'No images yet' in p.inner_text('.batch-empty') and '50 images' in p.inner_text('.batch-limits') and '500 MB' in p.inner_text('.batch-limits') and '100 MB each' in p.inner_text('.batch-limits') and p.is_disabled('#bprocess'), p.inner_text('.batch-limits'))
    check('the file input accepts several files and only image types', p.get_attribute('.batch input[type=file]', 'multiple') is not None and 'image/webp' in p.get_attribute('.batch input[type=file]', 'accept'))

    # ---------------- multi upload, per-file validation, rejected list
    good = F('photo.jpg', 'alpha.png', 'alpha.webp', 'meta.jpg', 'checker.png', 'tiny.jpg'); badf = F('fake.jpg', 'anim.gif', 'empty.jpg', 'huge.png')
    p.set_input_files('.batch input[type=file]', good[:3] + badf[:2] + good[3:] + badf[2:]); p.wait_for_function("()=>document.querySelectorAll('.batch-item').length===6", timeout=60000); thumbs_ready(p, 6)
    check('all 6 valid files queued even though 4 invalid files were in the same selection', rows(p).count() == 6)
    rj = p.inner_text('.batch-rejected')
    check('each invalid file is reported by name with a reason; valid ones are not discarded', all(n in rj for n in ['fake.jpg', 'anim.gif', 'empty.jpg', 'huge.png']) and '4 files were not added' in rj, rj)
    check('rejection reasons are specific (megapixel, empty, animated/unsupported)', 'megapixel' in rj and 'empty' in rj.lower() and ('nimated' in rj or 'not supported' in rj), rj)
    r1 = row(p, 'photo.jpg').inner_text()
    check('row shows format, dimensions and file size', 'JPG' in r1 and '3000 × 2000' in r1 and 'MB' in r1, r1)
    check('EXIF-rotated JPEG shows the upright size (300 × 400)', '300 × 400' in row(p, 'meta.jpg').inner_text(), row(p, 'meta.jpg').inner_text())
    check('PNG / WEBP rows show their format and size', 'PNG' in row(p, 'alpha.png').inner_text() and '800 × 600' in row(p, 'alpha.png').inner_text() and 'WEBP' in row(p, 'alpha.webp').inner_text())
    check('every row has a real thumbnail (canvas) and the queue keeps upload order', p.locator('.bi-thumb canvas').count() == 6 and [t.split('\n')[0] for t in rows(p).all_inner_texts()][:3] == ['photo.jpg', 'alpha.png', 'alpha.webp'])
    check('total size/count shown', '6 of 50 images' in p.inner_text('#btotals'), p.inner_text('#btotals'))
    p.click('.rejected-x, .batch-rejected button:text-is("Dismiss")'); check('rejected list can be dismissed', not p.is_visible('.batch-rejected'))
    p.click('[aria-label="Remove tiny.jpg"]'); check('remove ONE image', rows(p).count() == 5 and row(p, 'tiny.jpg').count() == 0 and '5 of 50' in p.inner_text('#btotals'))
    p.click('#bclear'); check('Clear all empties the queue and shows the empty state', rows(p).count() == 0 and p.is_visible('.batch-empty') and p.is_disabled('#bprocess') and p.locator('.bi-thumb canvas').count() == 0)

    # ---------------- limits
    many = [mk('many', f'img{i:02d}.jpg', 'tiny.jpg') for i in range(53)]
    p.set_input_files('.batch input[type=file]', many); p.wait_for_function("()=>document.querySelectorAll('.batch-item').length===50", timeout=90000)
    p.wait_for_function("()=>!document.querySelector('#bprocess').textContent.includes('Reading')", timeout=60000)
    check('51+ files: exactly 50 accepted, the rest reported with the limit', rows(p).count() == 50 and '3 files were not added' in p.inner_text('.batch-rejected') and 'at most 50' in p.inner_text('.batch-rejected'), p.inner_text('.batch-rejected')[:200])
    p.click('#bclear')
    big = []
    for i in range(7):
        f = os.path.join(tmp, f'sparse{i}.jpg'); open(f, 'wb').write(open(fx('tiny.jpg'), 'rb').read()); os.truncate(f, 95 * 1024 * 1024 if i < 6 else 100 * 1024 * 1024 + 1); big.append(f)
    p.set_input_files('.batch input[type=file]', big); p.wait_for_selector('.batch-rejected:not(.hidden)', timeout=120000); p.wait_for_function("()=>!document.querySelector('#bprocess').textContent.includes('Reading')", timeout=120000)
    rj = p.inner_text('.batch-rejected')
    check('combined size cap (500 MB) enforced per file; the 100 MB per-file limit still applies', rows(p).count() == 5 and 'at most' not in rj and '500 MB' in rj and 'over 100 MB' in rj, f'{rows(p).count()} {rj[:300]}')
    p.click('#bclear'); p.wait_for_timeout(300)

    # ---------------- validation of options
    fresh(p); put(p, F('tiny.jpg', 'checker.png')); seg(p, 'Batch compress', 'Off')
    check('nothing selected to do -> clear message and Process disabled', 'at least one' in p.inner_text('.batch-settings .dz-error') and p.is_disabled('#bprocess'))
    seg(p, 'Batch resize', 'Fit box'); p.fill('#bw', ''); check('Fit box without a width -> message, Process disabled', 'width' in p.inner_text('.batch-settings .dz-error').lower() and p.is_disabled('#bprocess'))
    seg(p, 'Batch resize', 'Off'); seg(p, 'Batch compress', 'Target size'); p.fill('#btarget', '0'); check('target 0 KB -> message', 'target' in p.inner_text('.batch-settings .dz-error').lower() and p.is_disabled('#bprocess'))

    # ---------------- convert to WEBP + resize width + quality, ZIP
    fresh(p); put(p, F('photo.jpg', 'alpha.png', 'alpha.webp', 'checker.png', 'meta.jpg', 'tiny.jpg')); reset_opts(p)
    seg(p, 'Batch resize', 'Width'); p.fill('#bw', '800'); seg(p, 'Batch format', 'WEBP'); p.eval_on_selector('#bquality', "(e)=>{e.value=60;e.dispatchEvent(new Event('input',{bubbles:true}))}")
    check('button says how many images will be processed', 'Process 6 images' == p.inner_text('#bprocess').strip(), p.inner_text('#bprocess'))
    p.evaluate('window.__track=true'); t0 = time.time(); run(p); dt = time.time() - t0; p.evaluate('window.__track=false')
    check('all 6 completed; progress says 6 of 6 processed; no failures', count_status(p, 'done') == 6 and '6 of 6 processed' in p.inner_text('#bstatus') and count_status(p, 'failed') == 0, p.inner_text('#bstatus')); info(f'6 images (3000×2000 JPEG among them) processed in {dt:.1f}s; longest frame gap {p.evaluate("window.__gap"):.0f} ms')
    check('result line shows output format, size and the output file name', 'WEBP' in row(p, 'photo.jpg').inner_text() and 'photo-edited.webp' in row(p, 'photo.jpg').inner_text(), row(p, 'photo.jpg').inner_text())
    check('Download ZIP button states the number of files', p.inner_text('#bzip').strip() == 'Download ZIP (6 files)', p.inner_text('#bzip'))
    zf, zname = get_zip(p, 'z1'); z = zipfile.ZipFile(zf); names = z.namelist()
    check('ZIP is named shrinkit-batch.zip; valid; CRCs pass (Python testzip)', zname == 'shrinkit-batch.zip' and z.testzip() is None, str(z.testzip()))
    check('ZIP holds exactly the 6 outputs, unique names, correct extension, NO originals', len(names) == 6 and len({n.lower() for n in names}) == 6 and all(n.endswith('.webp') for n in names) and not any('originals' in n for n in names), str(names))
    check('every entry is stored (no compression) and really a WEBP image', all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()) and all(fmt_of(z.read(n)) == 'WEBP' for n in names))
    ph = Image.open(io.BytesIO(z.read('photo-edited.webp'))); check('photo resized to width 800 keeping proportions (800 × 533)', ph.size == (800, 533), str(ph.size))
    check('images already ≤ 800 px wide keep their size (not enlarged)', Image.open(io.BytesIO(z.read('alpha-edited.webp'))).size[0] == 800 and Image.open(io.BytesIO(z.read('tiny-edited.webp'))).size == (200, 200) and Image.open(io.BytesIO(z.read('checker-edited.webp'))).size == (400, 300))
    check('EXIF-rotated JPEG came out upright (300 × 400)', Image.open(io.BytesIO(z.read('meta-edited.webp'))).size == (300, 400))
    check('transparency survives PNG -> WEBP (corner alpha 0)', Image.open(io.BytesIO(z.read('alpha-edited.webp'))).convert('RGBA').getpixel((5, 5))[3] == 0 or Image.open(io.BytesIO(z.read('alpha-edited (2).webp'))).convert('RGBA').getpixel((5, 5))[3] == 0)
    check('same-base-name inputs (alpha.png + alpha.webp) did not overwrite each other', 'alpha-edited.webp' in names and 'alpha-edited (2).webp' in names, str(names))
    check('"kept its size" is explained in Details', 'size was kept' in rtext(p, 'tiny.jpg'))
    with p.expect_download() as d: row(p, 'photo.jpg').locator('.bi-dl').click()
    f1 = os.path.join(tmp, 'single_' + d.value.suggested_filename); d.value.save_as(f1)
    check('single download: right name, real WEBP, 800 px wide', d.value.suggested_filename == 'photo-edited.webp' and Image.open(f1).format == 'WEBP' and Image.open(f1).size[0] == 800, d.value.suggested_filename)
    check('single download is byte-identical to the file inside the ZIP', open(f1, 'rb').read() == z.read('photo-edited.webp'))
    p.fill('#bw', '600'); check('changing options after a run shows a "options changed" note', p.is_visible('.batch .tool-hint:has-text("Options changed")') and p.inner_text('#bprocess').strip().startswith('Process'))

    # ---------------- keep format: extensions + MIME follow the real output
    fresh(p); put(p, F('photo.jpg', 'checker.png', 'alpha.webp')); reset_opts(p); run(p); zf, _ = get_zip(p, 'z2'); z = zipfile.ZipFile(zf)
    check('format Keep: .jpg stays JPEG, .png stays PNG, .webp stays WEBP (names and real bytes agree)', sorted(z.namelist()) == ['alpha-compressed.webp', 'checker-compressed.png', 'photo-compressed.jpg'] and [fmt_of(z.read(n)) for n in sorted(z.namelist())] == ['WEBP', 'PNG', 'JPEG'], str(z.namelist()))
    check('PNG stays lossless (pixel-identical to the source)', np.array_equal(np.array(Image.open(io.BytesIO(z.read('checker-compressed.png'))).convert('RGB')), np.array(Image.open(fx('checker.png')).convert('RGB'))))
    check('quality 70: JPEG output is smaller than its source', len(z.read('photo-compressed.jpg')) < os.path.getsize(fx('photo.jpg')))

    # ---------------- duplicates
    fresh(p); dp = [mk('a', 'dup.jpg', 'tiny.jpg'), mk('b', 'dup.jpg', 'checker.png'), mk('c', 'DUP.JPG', 'alpha.png'), mk('d', 'dup.png', 'meta.png')]
    put(p, dp); reset_opts(p); seg(p, 'Batch format', 'JPG'); seg(p, 'Batch compress', 'Off'); run(p); zf, _ = get_zip(p, 'z3'); z = zipfile.ZipFile(zf); names = z.namelist()
    check('4 inputs named dup/dup/DUP/dup -> 4 distinct names (case-insensitive), nothing overwritten', len(names) == 4 and len({n.lower() for n in names}) == 4 and names[0] == 'dup-converted.jpg' and names[1] == 'dup-converted (2).jpg' and names[2] == 'DUP-converted (3).jpg' and names[3] == 'dup-converted (4).jpg', str(names))
    check('each name holds the right picture (queue order: 200², 400×300, 800×600, 300×200)', [Image.open(io.BytesIO(z.read(n))).size for n in names] == [(200, 200), (400, 300), (800, 600), (300, 200)], str([Image.open(io.BytesIO(z.read(n))).size for n in names]))
    check('single-download names match the ZIP names', [rows(p).nth(i).locator('.bi-result').inner_text().split('·')[-1].strip() for i in range(4)] == names, str([rows(p).nth(i).locator('.bi-result').inner_text() for i in range(4)]))

    # ---------------- target size
    fresh(p); put(p, [mk('t', 't1.jpg', 'photo.jpg'), mk('t', 't2.jpg', 'meta_big.jpg'), mk('t', 't3.png', 'checker.png')]); reset_opts(p); seg(p, 'Batch compress', 'Target size'); p.click('.batch .chip:text-is("100 KB")'); run(p)
    zf, _ = get_zip(p, 'z4'); z = zipfile.ZipFile(zf); sizes = {n: len(z.read(n)) for n in z.namelist()}
    check('target 100 KB: both JPEGs end at or under 100 KB (+5%)', sizes['t1-compressed.jpg'] <= 105 * 1024 and sizes['t2-compressed.jpg'] <= 105 * 1024, str(sizes))
    check('target on a PNG: saved losslessly and the row explains why', fmt_of(z.read('t3-compressed.png')) == 'PNG' and 'PNG is lossless' in rtext(p, 't3.png'), rtext(p, 't3.png'))

    # ---------------- remove metadata
    fresh(p); put(p, F('meta.jpg', 'meta.png', 'meta.webp', 'meta_rot.png')); reset_opts(p); seg(p, 'Batch compress', 'Off'); p.check('#bstrip'); run(p); zf, _ = get_zip(p, 'z5'); z = zipfile.ZipFile(zf); names = sorted(z.namelist())
    check('metadata only: outputs named -clean and no planted marker survives in ANY file (raw byte search)', all(n.endswith(('-clean.jpg', '-clean.png', '-clean.webp')) for n in names) and all(leaks(z.read(n)) == [] for n in names), str([(n, leaks(z.read(n))) for n in names]))
    check('lossless outputs: pixel-identical to the inputs (JPEG, PNG, WEBP)', all(np.array_equal(np.array(Image.open(io.BytesIO(z.read(o))).convert('RGB')), np.array(Image.open(fx(i)).convert('RGB'))) for o, i in [('meta-clean.jpg', 'meta.jpg'), ('meta-clean.png', 'meta.png'), ('meta-clean.webp', 'meta.webp')]), str(names))
    check('no GPS block left (PIL)', all(not Image.open(io.BytesIO(z.read(n))).getexif().get_ifd(0x8825) for n in names))
    ex = Image.open(io.BytesIO(z.read('meta-clean.jpg'))).getexif(); check('JPEG rotation flag kept (still upright)', ex.get(0x0112) == 6)
    rot = [n for n in names if n.startswith('meta_rot')][0]; refimg = ImageOps.exif_transpose(Image.open(fx('meta_rot.png'))).convert('RGB'); o = Image.open(io.BytesIO(z.read(rot))).convert('RGB')
    check('PNG with a rotation flag: rebuilt instead, upright, still clean; the row explains', o.size == refimg.size and np.array_equal(np.array(o), np.array(refimg)) and 'rotation flag' in rtext(p, 'meta_rot.png'), rtext(p, 'meta_rot.png'))
    check('the row says what was checked and does not claim all metadata is gone', 'Checked the new file for' in rtext(p, 'meta.jpg') and not re.search(r'all metadata|everything|completely', rtext(p, 'meta.jpg'), re.I))
    p.check('#borig'); zf, _ = get_zip(p, 'z5b'); z = zipfile.ZipFile(zf); on = [n for n in z.namelist() if n.startswith('originals/')]
    check('"include originals" (explicit opt-in): originals/ folder with the 4 untouched source files', len(on) == 4 and len(z.namelist()) == 8 and sorted(sha(z.read(n)) for n in on) == sorted(sha(open(fx(n), 'rb').read()) for n in ['meta.jpg', 'meta.png', 'meta.webp', 'meta_rot.png']), str(z.namelist()))
    p.uncheck('#borig')
    seg(p, 'Batch compress', 'Quality'); p.click('#bprocess'); p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b && b.textContent!=='Processing…' && /processed/.test(document.querySelector('#bstatus').textContent)}", timeout=120000)
    zf, _ = get_zip(p, 'z5c'); z = zipfile.ZipFile(zf)
    check('metadata + compress (rebuild path): still no marker in any output', all(leaks(z.read(n)) == [] for n in z.namelist()) and all(not Image.open(io.BytesIO(z.read(n))).getexif().get_ifd(0x8825) for n in z.namelist()))

    # ---------------- nothing to change -> original copied, said so
    fresh(p); put(p, F('photo.jpg', 'tiny.jpg')); reset_opts(p); seg(p, 'Batch resize', 'Width'); p.fill('#bw', '5000'); seg(p, 'Batch compress', 'Off'); run(p); zf, _ = get_zip(p, 'z6'); z = zipfile.ZipFile(zf)
    check('already smaller than the requested width: originals copied unchanged and the row says so', sha(z.read('photo-resized.jpg')) == sha(open(fx('photo.jpg'), 'rb').read()) and 'Nothing to change' in rtext(p, 'photo.jpg'), rtext(p, 'photo.jpg'))

    # ---------------- failure isolation / partial failure
    fresh(p); put(p, F('photo.jpg', 'tiny.jpg', 'checker.png')); reset_opts(p); seg(p, 'Batch resize', 'Width'); p.fill('#bw', '6500'); p.check('#bup'); run(p)
    check('one image fails (output over the 40 MP limit) while the others succeed', count_status(p, 'failed') == 1 and count_status(p, 'done') == 2 and row(p, 'tiny.jpg').get_attribute('data-status') == 'failed', p.inner_text('#bstatus'))
    check('failed row shows the real reason', 'limit' in row(p, 'tiny.jpg').locator('.bi-error').inner_text().lower() and 'MP' in row(p, 'tiny.jpg').locator('.bi-error').inner_text(), row(p, 'tiny.jpg').locator('.bi-error').inner_text())
    fb = p.inner_text('.batch-fail')
    check('partial-failure message: only successes are included, names the failed image', 'only the 2 images that worked' in fb and 'tiny.jpg' in fb and '2 of 3 processed' in p.inner_text('#bstatus'), fb)
    zf, _ = get_zip(p, 'z7'); z = zipfile.ZipFile(zf); check('ZIP contains the 2 successes and nothing for the failure', len(z.namelist()) == 2 and not any('tiny' in n for n in z.namelist()) and z.testzip() is None, str(z.namelist()))
    p.click('[aria-label="Remove tiny.jpg"]'); check('failed image can be removed and the rest stays downloadable', rows(p).count() == 2 and p.is_visible('#bzip'))
    fresh(p); put(p, F('tiny.jpg')); reset_opts(p); seg(p, 'Batch resize', 'Width'); p.fill('#bw', '6500'); p.check('#bup'); run(p)
    check('all-failed batch: clear message, no ZIP button', 'nothing to download' in p.inner_text('.batch-fail') and not p.is_visible('#bzip'), p.inner_text('.batch-fail'))

    # ---------------- bounded concurrency + cancel
    fresh(p); cp = [mk('cc', f'p{i:02d}.jpg', 'photo.jpg') for i in range(8)]; put(p, cp); reset_opts(p); thumbs_ready(p, 8, 90000)
    p.evaluate('window.__maxProc=0; window.__dec.max=0; window.__track=true; window.__gap=0'); run(p); mp = p.evaluate('window.__maxProc'); md = p.evaluate('window.__dec.max'); gap = p.evaluate('window.__gap'); p.evaluate('window.__track=false')
    check(f'at most 2 images are ever "Processing" at once (observed max {mp}), and at least one was', 1 <= mp <= 2, str(mp))
    check(f'at most 2 images were ever being decoded at the same time (observed {md})', md <= 2, str(md)); info(f'8 × 6 MP photos; longest gap between animation frames while processing: {gap:.0f} ms')
    check('8 of 8 processed', '8 of 8 processed' in p.inner_text('#bstatus') and count_status(p, 'done') == 8)
    fresh(p); cp = [mk('cc2', f'q{i:02d}.jpg', 'photo.jpg') for i in range(20)]; put(p, cp); reset_opts(p); seg(p, 'Batch compress', 'Target size'); p.click('.batch .chip:text-is("100 KB")'); thumbs_ready(p, 20, 120000)
    p.click('#bprocess'); p.wait_for_function("()=>document.querySelectorAll('.batch-item[data-status=done]').length>=2", timeout=60000); check('while running: Cancel is shown, Process/Clear/remove are disabled, honest cancel text', p.is_visible('#bcancel') and p.is_disabled('#bprocess') and p.is_disabled('#bclear') and p.is_disabled('[aria-label="Remove q19.jpg"]') and 'already being processed may still finish' in p.inner_text('.batch'))
    p.click('#bcancel'); p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b && b.textContent!=='Processing…'}", timeout=60000)
    d_, c_, f_ = count_status(p, 'done'), count_status(p, 'cancelled'), count_status(p, 'failed')
    check(f'cancel: pending images are NOT processed (done {d_}, cancelled {c_}, failed {f_}); nothing left processing/queued', c_ >= 10 and d_ + c_ + f_ == 20 and f_ == 0 and count_status(p, 'processing') == 0 and count_status(p, 'queued') == 0)
    check('cancelled rows are labelled; Cancel button gone; status line says how many finished', not p.is_visible('#bcancel') and 'cancelled' in p.inner_text('#bstatus') and 'cancelled' in p.inner_text('.batch-fail'), p.inner_text('#bstatus'))
    zf, _ = get_zip(p, 'z8'); z = zipfile.ZipFile(zf); check('ZIP after cancel holds only the finished images', len(z.namelist()) == d_ and z.testzip() is None, f'{len(z.namelist())} vs {d_}')
    p.click('#bprocess'); p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b && b.textContent!=='Processing…' && /20 of 20/.test(document.querySelector('#bstatus').textContent)}", timeout=240000)
    check('Process again after a cancel completes the whole queue', count_status(p, 'done') == 20)

    # ---------------- leaving mid-run + resource hygiene (one page load, so the URL counters are meaningful)
    fresh(p); put(p, F('photo.jpg', 'tiny.jpg')); reset_opts(p); run(p); get_zip(p, 'zh')
    with p.expect_download() as d: row(p, 'photo.jpg').locator('.bi-dl').click()
    p.click('#bclear'); cp = [mk('cc3', f'r{i:02d}.jpg', 'photo.jpg') for i in range(12)]; put(p, cp); reset_opts(p); seg(p, 'Batch compress', 'Target size'); p.click('.batch .chip:text-is("100 KB")'); thumbs_ready(p, 12, 90000); n_err = len(errors)
    p.click('#bprocess'); p.wait_for_selector('.batch-item[data-status="processing"]', timeout=30000); p.click('#toolNav a:text-is("Compress")'); p.wait_for_selector('.dropzone'); p.wait_for_timeout(3000)
    check('leaving the tool mid-run: no errors, work stops quietly', len(errors) == n_err, str(errors[n_err:])[:300]); p.click('#toolNav a:text-is("Batch Processing")'); p.wait_for_selector('.batch .dropzone')
    check('coming back: queue is empty (resources were released)', rows(p).count() == 0 and p.is_visible('.batch-empty'))
    p.wait_for_timeout(5200); u = p.evaluate('window.__urls')
    check(f'every object URL created was revoked (created {u["created"]}, revoked {u["revoked"]})', u['created'] >= 2 and u['created'] == u['revoked'], str(u))

    # ---------------- mobile
    mc = b.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True, has_touch=True, is_mobile=True); mc.add_init_script(INIT); m = mc.new_page(); merr = []; m.on('pageerror', lambda e: merr.append(str(e)))
    m.goto(BASE + '/batch'); m.wait_for_selector('.batch .dropzone'); put(m, F('photo.jpg', 'alpha.png', 'meta.jpg')); reset_opts(m); run(m)
    sw = m.evaluate('document.documentElement.scrollWidth'); check(f'mobile 390 px: page does not scroll sideways (scrollWidth {sw})', sw <= 391, str(sw))
    check('mobile: every row, its Download button and the ZIP button are inside the viewport width', all(r_['x'] >= -1 and r_['x'] + r_['width'] <= 391 for r_ in [m.locator('.batch-item').nth(i).bounding_box() for i in range(3)] + [m.locator('#bzip').bounding_box(), m.locator('.bi-dl').first.bounding_box()]))
    zf, _ = get_zip(m, 'zm'); check('mobile: ZIP downloads and is valid', zipfile.ZipFile(zf).testzip() is None and len(zipfile.ZipFile(zf).namelist()) == 3); check('mobile: no script errors', not merr, str(merr)); mc.close()

    check('no console errors across the whole run', not errors, ' | '.join(errors)[:300])
    ctx.close(); b.close()
finally: srv.terminate()
finish()
