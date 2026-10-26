"""Phase 2: Remove Metadata. Outputs are verified independently (raw byte search for planted markers, PIL, own chunk walkers),
never by the app's own parser. Real Chromium only."""
import struct, time
import numpy as np
from PIL import Image, ImageOps
from common import *
from markers import MARKERS
from playwright.sync_api import sync_playwright
PORT = 4196; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT)

def leaks(path): b = open(path, 'rb').read(); return [m for m in MARKERS if m.encode() in b]
def planted(name): b = open(fx(name), 'rb').read(); return [m for m in MARKERS if m.encode() in b]
def arr(path): return np.array(Image.open(path).convert('RGB'))
def png_chunks(path):
    b = open(path, 'rb').read(); pos = 8; out = []
    while pos < len(b):
        n = struct.unpack('>I', b[pos:pos + 4])[0]; t = b[pos + 4:pos + 8].decode('latin1'); out.append(t); pos += 12 + n
        if t == 'IEND': break
    return out, len(b) - pos
def webp_chunks(path):
    b = open(path, 'rb').read(); total = 8 + struct.unpack('<I', b[4:8])[0]; pos = 12; out = []
    while pos < total:
        n = struct.unpack('<I', b[pos + 4:pos + 8])[0]; out.append(b[pos:pos + 4].decode('latin1')); pos += 8 + n + (n & 1)
    return out, len(b) - total
def jpeg_markers(path):
    b = open(path, 'rb').read(); pos = 2; out = []
    while pos + 4 <= len(b):
        m = b[pos + 1]; n = struct.unpack('>H', b[pos + 2:pos + 4])[0]; out.append((m, b[pos + 4:pos + 4 + 12]))
        if m == 0xda: break
        pos += 2 + n
    return out
def meta_pressed(p, label): return p.get_attribute(f'[aria-label="Removal method"] button:text-is("{label}")', 'aria-pressed') == 'true'
def method(p, label): p.click(f'[aria-label="Removal method"] button:text-is("{label}")'); ready(p)
KEEP_PNG = {'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'pHYs', 'cICP', 'iCCP'}

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))
    for n in ['meta.jpg', 'meta.png', 'meta.webp', 'meta_big.jpg']: check(f'fixture {n} really contains planted markers (test is meaningful)', len(planted(n)) >= 8, str(planted(n)))

    # ---------- JPEG, rotated, full metadata ----------
    load(p, BASE, 'meta.jpg', '/remove-metadata'); p.wait_for_selector('.meta-list li')
    shown = p.locator('.meta-list li').all_text_contents()
    check('"Found in this file" lists GPS, camera, date, serial, author, software, XMP, comment, trailing data, colour profile',
          all(any(w in t for t in shown) for w in ['GPS', 'Camera', 'Date', 'serial', 'Author', 'software', 'XMP', 'Comments', 'after the end', 'Colour profile']), ' | '.join(shown))
    check('GPS item is highlighted', p.locator('.meta-list li.meta-gps').count() == 1)
    check('Lossless is the pressed default and Rebuild is available', meta_pressed(p, 'Lossless') and not meta_pressed(p, 'Rebuild image'))
    check('limitations are visible (picture content, file name, PNG/WEBP rotation)', all(w in p.inner_text('.meta-limits') for w in ['not picture content', 'file name', 'rotation flag']))
    check('lossless: format / quality / target controls are disabled and explained', p.is_disabled('#format') and p.is_disabled('#quality') and p.is_visible('.lock-note') and 'original format and quality' in p.inner_text('.lock-note'))
    f, name = download(p, 'mj'); im = Image.open(f); ex = im.getexif()
    check('JPEG lossless: name is meta-clean.jpg and file is a real JPEG', name == 'meta-clean.jpg' and im.format == 'JPEG', f'{name} {im.format}')
    check('JPEG lossless: NO planted marker survives (raw byte search)', leaks(f) == [], str(leaks(f)))
    check('JPEG lossless: PIL finds no GPS block and no EXIF tags other than Orientation', not ex.get_ifd(0x8825) and set(ex.keys()) <= {0x0112}, str(list(ex.keys())))
    check('JPEG lossless: orientation kept (6) so it still shows upright 300 × 400', ex.get(0x0112) == 6 and ImageOps.exif_transpose(im).size == (300, 400), f'{ex.get(0x0112)} {ImageOps.exif_transpose(im).size}')
    up = ImageOps.exif_transpose(im).convert('RGB'); check('JPEG lossless: displays upright (red top, blue bottom)', near(up.getpixel((150, 10)), RED, 12) and near(up.getpixel((290, 390)), BLUE, 12), f'{up.getpixel((150, 10))} {up.getpixel((290, 390))}')
    check('JPEG lossless: decoded picture identical to the original (pixel-exact)', np.array_equal(arr(fx('meta.jpg')), arr(f)))
    check('JPEG lossless: no comment segments and no XMP segment', not any(m == 0xfe for m, _ in jpeg_markers(f)) and not any(m == 0xe1 and d.startswith(b'http') for m, d in jpeg_markers(f)))
    check('JPEG lossless: colour profile kept by default', b'ICC_PROFILE' in open(f, 'rb').read())
    nt = notices(p)
    check('notes: what was removed + "Checked the new file for" + none found + rotation flag + colour profile', 'Removed from the file' in nt and 'GPS location' in nt and 'Checked the new file for' in nt and 'None found' in nt and 'rotation flag' in nt and 'colour profile' in nt, nt)
    check('notes never claim everything is gone', not re.search(r'all metadata|everything|completely|100%', nt, re.I), nt)
    check('stats: new size is smaller than the original', 'smaller' in p.inner_text('[data-r=barSaved]') or 'no reduction' in p.inner_text('[data-r=barSaved]'))
    p.uncheck('#keepicc'); ready(p); f, _ = download(p, 'mj2')
    check('JPEG lossless without "Keep colour profile": profile dropped, still no markers, still pixel-exact', b'ICC_PROFILE' not in open(f, 'rb').read() and leaks(f) == [] and np.array_equal(arr(fx('meta.jpg')), arr(f)))
    p.check('#keepicc'); ready(p)

    # ---------- JPEG rebuild ----------
    method(p, 'Rebuild image'); check('Rebuild: format controls are enabled again', p.is_enabled('#format') and not p.is_visible('.lock-note'))
    check('Rebuild: colour-profile option hidden (canvas export cannot keep it)', not p.is_visible('#keepicc'))
    f, name = download(p, 'mr'); im = Image.open(f); ex = im.getexif()
    check('Rebuild: JPEG, no planted marker, no GPS, no EXIF tags at all', im.format == 'JPEG' and leaks(f) == [] and not ex.get_ifd(0x8825) and len(ex.keys()) == 0, f'{im.format} {leaks(f)} {list(ex.keys())}')
    check('Rebuild: bakes the rotation in (upright 300 × 400, no flag) with red top / blue bottom', im.size == (300, 400) and near(im.convert('RGB').getpixel((150, 10)), RED, 40) and near(im.convert('RGB').getpixel((290, 390)), BLUE, 40), str(im.size))
    nt = notices(p); check('Rebuild notes: says redrawn + re-compressed, and reports the check on the new file', 'redrawn' in nt and 'Checked the new file for' in nt, nt)
    p.select_option('#format', 'image/png'); ready(p); f, name = download(p, 'mrp')
    check('Rebuild as PNG: real PNG named meta-clean.png, markers absent, only picture chunks', Image.open(f).format == 'PNG' and name == 'meta-clean.png' and leaks(f) == [] and set(png_chunks(f)[0]) <= KEEP_PNG, str(png_chunks(f)))
    p.select_option('#format', 'image/jpeg'); ready(p)

    # ---------- PNG ----------
    load(p, BASE, 'meta.png', '/remove-metadata'); p.wait_for_selector('.meta-list li'); shown = ' | '.join(p.locator('.meta-list li').all_text_contents())
    check('PNG: text notes, EXIF, GPS, timestamp, private chunk and trailing data are listed', all(w in shown for w in ['Text notes', 'GPS', 'timestamp', 'Other embedded data', 'after the end']), shown)
    f, name = download(p, 'mp'); chunks, trailing = png_chunks(f)
    check('PNG lossless: no planted marker; only picture chunks (+ colour profile); nothing after IEND', leaks(f) == [] and set(chunks) <= KEEP_PNG and trailing == 0, f'{leaks(f)} {chunks} {trailing}')
    check('PNG lossless: pixel-exact and PIL sees no text / EXIF / GPS', np.array_equal(arr(fx('meta.png')), arr(f)) and not Image.open(f).info.get('exif') and not Image.open(f).text and not Image.open(f).getexif().get_ifd(0x8825))
    check('PNG lossless: name is meta-clean.png', name == 'meta-clean.png', name)
    load(p, BASE, 'meta_rot.png', '/remove-metadata'); p.wait_for_selector('.meta-list li')
    check('PNG with rotation flag: Lossless is disabled with the reason and Rebuild is active', p.is_disabled('[aria-label="Removal method"] button:text-is("Lossless")') and 'rotation flag' in p.inner_text('.meta-reason') and meta_pressed(p, 'Rebuild image'), p.inner_text('.meta-reason'))
    f, _ = download(p, 'mpr'); im = Image.open(f).convert('RGB'); ref = ImageOps.exif_transpose(Image.open(fx('meta_rot.png'))).convert('RGB')
    check('PNG rotation-flag file rebuilt: upright, same size as the correctly rotated original, no markers/GPS', im.size == ref.size and np.abs(np.array(im, int) - np.array(ref, int)).max() == 0 and leaks(f) == [] and not Image.open(f).getexif().get_ifd(0x8825), f'{im.size} {ref.size}')

    # ---------- WEBP ----------
    load(p, BASE, 'meta.webp', '/remove-metadata'); p.wait_for_selector('.meta-list li')
    f, name = download(p, 'mw'); chunks, trailing = webp_chunks(f); im = Image.open(f)
    check('WEBP lossless: real WEBP, no marker, only picture chunks, no trailing bytes', im.format == 'WEBP' and leaks(f) == [] and set(chunks) <= {'VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP'} and trailing == 0, f'{im.format} {leaks(f)} {chunks} {trailing}')
    check('WEBP lossless: pixel-exact, PIL finds no EXIF/XMP', np.array_equal(arr(fx('meta.webp')), arr(f)) and len(im.getexif().keys()) == 0 and not im.info.get('xmp'), str(list(im.getexif().keys())))
    load(p, BASE, 'meta_rot.webp', '/remove-metadata'); p.wait_for_selector('.meta-list li')
    check('WEBP with rotation flag: Lossless disabled, Rebuild active', p.is_disabled('[aria-label="Removal method"] button:text-is("Lossless")') and meta_pressed(p, 'Rebuild image'))

    # ---------- no metadata / unreadable / edits ----------
    load(p, BASE, 'tiny.jpg', '/remove-metadata'); p.wait_for_timeout(300)
    check('file with nothing to remove: says so plainly (no false success claim)', 'None of the metadata types' in p.inner_text('.tool-hint[role=status]') and 'none of the metadata types' in notices(p).lower(), notices(p))
    load(p, BASE, 'junkseg.jpg', '/remove-metadata'); p.wait_for_timeout(400)
    check('JPEG that cannot be parsed safely: Lossless refused with reason, Rebuild used', p.is_disabled('[aria-label="Removal method"] button:text-is("Lossless")') and 'could not be read' in p.inner_text('.meta-reason') and meta_pressed(p, 'Rebuild image'), p.inner_text('.meta-reason'))
    f, _ = download(p, 'junk'); check('...and the rebuilt file is a valid JPEG', Image.open(f).format == 'JPEG' and Image.open(f).size == (200, 200))

    load(p, BASE, 'meta.jpg', '/crop'); p.click('.chip:text-is("1:1")'); ready(p); nav(p, 'Remove Metadata'); p.wait_for_selector('.meta-list li')
    check('with a Crop applied: Lossless disabled with the reason, Rebuild used', p.is_disabled('[aria-label="Removal method"] button:text-is("Lossless")') and 'Crop' in p.inner_text('.meta-reason') and meta_pressed(p, 'Rebuild image'), p.inner_text('.meta-reason'))
    f, name = download(p, 'mc'); im = Image.open(f)
    check('...output is cropped AND clean (300 × 300, no markers, no GPS)', im.size == (300, 300) and leaks(f) == [] and not im.getexif().get_ifd(0x8825) and name == 'meta-clean.jpg', f'{im.size} {leaks(f)} {name}')
    p.click('[aria-label^="Remove Crop"]'); ready(p); p.wait_for_timeout(200)
    check('removing the crop re-enables Lossless', meta_pressed(p, 'Lossless') and p.is_enabled('[aria-label="Removal method"] button:text-is("Lossless")') and p.is_disabled('#format'))
    nav(p, 'Compress'); check('leaving the tool restores normal compression (strip cleared, controls enabled)', p.is_enabled('#format') and 'quality' in txt(p, 'barLabel') and 'lossless clean-up' not in txt(p, 'barLabel'), txt(p, 'barLabel'))
    f, name = download(p, 'afterleave'); check('...and the download name is back to -compressed', name == 'meta-compressed.jpg', name)

    # ---------- big file ----------
    t0 = time.time(); load(p, BASE, 'meta_big.jpg', '/remove-metadata'); p.wait_for_selector('.meta-list li'); dt = time.time() - t0
    f, name = download(p, 'big'); check(f'6 MP JPEG lossless: clean, pixel-exact, quick ({dt:.1f}s)', leaks(f) == [] and np.array_equal(arr(fx('meta_big.jpg')), arr(f)) and dt < 20, f'{leaks(f)} {dt:.1f}s')
    check('no console errors', not errors, ' | '.join(errors)[:300])
    ctx.close(); b.close()
finally: srv.terminate()
finish()
