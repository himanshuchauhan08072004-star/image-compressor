"""Phase 4: Passport photo + print sheet. Real Chromium. The PDF is verified independently with pypdf and rendered with pypdfium2."""
import io, math
import numpy as np
import pypdf, pypdfium2 as pdfium
from PIL import Image
from common import *
from playwright.sync_api import sync_playwright
PORT = 4191; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT); PATH = '/photo/passport'
SRC = lambda n: Image.open(fx(n)).convert('RGB')

def frame_rect(p, sw, sh):
    st = p.eval_on_selector('.pp-frame', 'e=>[e.style.left,e.style.top,e.style.width,e.style.height]'); f = [float(s.rstrip('%')) for s in st]
    return (round(f[0] * sw / 100), round(f[1] * sh / 100), round(f[2] * sw / 100), round(f[3] * sh / 100))
def setv(p, sel, v): p.eval_on_selector(sel, "(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}", str(v)); ready(p)
def summary(p): return p.inner_text('#pp-summary')
def mad(a, b): return float(np.abs(np.array(a, int) - np.array(b, int)).mean())
def photo(p, tag):
    f, name = download(p, tag); return Image.open(f).convert('RGB'), f, name
def ref_from(src, r, size): x, y, w, h = r; return src.crop((x, y, x + w, y + h)).resize(size, Image.LANCZOS)
def layout(pw, ph, m, g, w, h, n):                       # independent re-implementation of the grid maths
    cols = int((pw - 2 * m + g + 1e-9) // (w + g)); rows = int((ph - 2 * m + g + 1e-9) // (h + g)); per = cols * rows; pages = []
    left = n
    while left > 0:
        k = min(per, left); left -= k; pages.append([(m + (i % cols) * (w + g), m + (i // cols) * (h + g), w, h) for i in range(k)])
    return cols, rows, pages
def pdf_download(p, tag):
    with p.expect_download() as d: p.click('#sh-pdf')
    f = os.path.join(tmp, tag + '.pdf'); d.value.save_as(f); return f, d.value.suggested_filename
def render(f, page=0, dpi=300): return pdfium.PdfDocument(f)[page].render(scale=dpi / 72).to_pil().convert('RGB')
def px(mm, dpi=300): return mm * dpi / 25.4

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))

    # ---------------- workspace
    p.goto(BASE + '/'); check('Passport Photo is in the nav and on the home cards (14 tools)', 'Passport Photo' in p.locator('#toolNav a').all_text_contents() and p.locator('.task-card').count() == 14)
    p.click('#toolNav a:text-is("Passport Photo")'); p.wait_for_selector('.dropzone')
    check('without a photo: hero + dropzone (upload step)', p.locator('h1').count() == 1 and p.locator('.dropzone').count() == 1)
    load(p, BASE, 'pp_portrait.jpg', PATH); p.wait_for_selector('.pp-frame')
    check('photo loaded: preview canvas, crop frame, original size/dimensions shown, reset/replace available', p.is_visible('.pp-canvas') and p.is_visible('.pp-frame') and '1200 × 1600' in p.inner_text('.workbench') and p.locator('button:has-text("Start over")').count() >= 1, '')
    check('default 35 × 45 mm @ 300 DPI = 413 × 531 px; summary states it', '413 × 531 px' in summary(p) and p.input_value('#pp-wpx') == '413' and p.input_value('#pp-hpx') == '531' and p.input_value('#pp-wmm') == '35' and p.input_value('#pp-hmm') == '45', summary(p))
    tool_txt = p.inner_text('.workbench')
    check('presets are labelled general; country/document differences and "not a guarantee" are explained', 'general sizes' in tool_txt and 'not a guarantee' in tool_txt and 'differ by country' in tool_txt)
    check('no compliance claim anywhere', not re.search(r'compliant|guaranteed|officially|approved|valid for', tool_txt, re.I))

    # ---------------- sizes
    p.click('.chip:text-is("2 × 2 in (50.8 × 50.8 mm)")'); ready(p); check('preset 2 × 2 in -> 600 × 600 px', '600 × 600 px' in summary(p), summary(p))
    p.click('.chip:text-is("35 × 45 mm")'); ready(p)
    p.fill('#pp-wmm', '40'); p.fill('#pp-hmm', '60'); ready(p); check('custom 40 × 60 mm -> 472 × 709 px', '472 × 709 px' in summary(p) and p.input_value('#pp-wpx') == '472', summary(p))
    p.fill('#pp-wpx', '500'); ready(p); check('custom pixels: width 500 px -> millimetres follow (42.33), height unchanged', p.input_value('#pp-wmm') == '42.33' and '500 × 709 px' in summary(p) and p.input_value('#pp-hmm') == '60', summary(p))
    p.click('.chip:text-is("35 × 45 mm")'); p.check('#pp-lock'); p.fill('#pp-wmm', '70'); ready(p)
    check('"keep aspect ratio" on: width 70 mm -> height follows to 90 mm', p.input_value('#pp-hmm') == '90' and '827 × 1063 px' in summary(p), summary(p))
    p.uncheck('#pp-lock'); p.click('.chip:text-is("35 × 45 mm")'); p.click('#pp-swap'); ready(p); check('swap width/height -> 45 × 35 mm = 531 × 413 px', '531 × 413 px' in summary(p) and p.input_value('#pp-wmm') == '45', summary(p)); p.click('#pp-swap'); ready(p)
    p.select_option('#pp-dpi', '600'); ready(p); check('600 DPI -> 827 × 1063 px', '827 × 1063 px' in summary(p), summary(p)); p.select_option('#pp-dpi', '300'); ready(p)
    p.fill('#pp-wmm', '300'); p.fill('#pp-hmm', '300'); p.select_option('#pp-dpi', '600'); ready(p)
    check('size over the 40 MP output limit is refused with a clear message (no crash)', p.is_visible('#pp-spec-error') and 'megapixel' in p.inner_text('#pp-spec-error') and '7087' in p.inner_text('#pp-spec-error') and p.is_disabled('#sh-pdf'), p.inner_text('#pp-spec-error'))
    p.fill('#pp-wmm', '5'); check('below the minimum size -> clear message', 'between 10 and 300' in p.inner_text('#pp-spec-error'))
    p.select_option('#pp-dpi', '300'); p.click('.chip:text-is("35 × 45 mm")'); ready(p); check('recovers once the size is valid again', not p.is_visible('#pp-spec-error') and '413 × 531 px' in summary(p))

    # ---------------- crop editor, portrait source
    cr = frame_rect(p, 1200, 1600); check('portrait photo: zoom 1 frame is the largest 35:45 fit (1200 × 1543)', cr[2] == 1200 and abs(cr[3] - 1543) <= 1 and cr[0] == 0, str(cr))
    out, f, name = photo(p, 'pt1'); check('exported photo is exactly 413 × 531 px (JPEG)', out.size == (413, 531) and Image.open(f).format == 'JPEG', str(out.size))
    check('exported pixels equal the framed region (not stretched, right place): mean diff < 4 vs reference crop+resize', mad(out, ref_from(SRC('pp_portrait.jpg'), cr, (413, 531))) < 4, f'{mad(out, ref_from(SRC("pp_portrait.jpg"), cr, (413, 531))):.2f}')
    check('output aspect = target aspect within 1 px (no distortion)', abs(out.size[0] / out.size[1] - 413 / 531) < 1 / 531)
    setv(p, '#pp-zoom', 2); cr2 = frame_rect(p, 1200, 1600); check('zoom 2× halves the frame (≈600 px wide) and keeps the aspect', abs(cr2[2] - 600) <= 2 and abs(cr2[2] / cr2[3] - 413 / 531) < 0.005, str(cr2))
    check('frame is centred after zooming', abs(cr2[0] + cr2[2] / 2 - 600) <= 2 and abs(cr2[1] + cr2[3] / 2 - 800) <= 2, str(cr2))
    p.locator('.pp-frame').scroll_into_view_if_needed(); bb = p.locator('.pp-frame').bounding_box(); cb = p.locator('.pp-canvas').bounding_box(); k = 1200 / cb['width']
    check('frame on screen == crop rectangle (±1.5 source px)', all(abs(a - e) <= 1.5 for a, e in zip(((bb['x'] - cb['x']) * k, (bb['y'] - cb['y']) * k, bb['width'] * k, bb['height'] * k), cr2)))
    p.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); p.mouse.down(); p.mouse.move(bb['x'] + bb['width'] / 2 + 60, bb['y'] + bb['height'] / 2 + 40, steps=5); p.mouse.up(); ready(p)
    cr3 = frame_rect(p, 1200, 1600); check('dragging moves the frame by the dragged distance (source px)', abs((cr3[0] - cr2[0]) - 60 * k) <= 3 and abs((cr3[1] - cr2[1]) - 40 * k) <= 3 and cr3[2:] == cr2[2:], f'{cr2} -> {cr3}')
    p.focus('.pp-frame'); p.keyboard.press('ArrowRight'); ready(p); check('arrow key nudges by 1% of the width (12 px)', frame_rect(p, 1200, 1600)[0] == cr3[0] + 12, str(frame_rect(p, 1200, 1600)))
    for _ in range(80): p.keyboard.press('ArrowLeft')
    for _ in range(80): p.keyboard.press('ArrowUp')
    ready(p); c4 = frame_rect(p, 1200, 1600); check('frame cannot leave the photo (clamped at 0,0)', c4[0] == 0 and c4[1] == 0, str(c4))
    out, _, _ = photo(p, 'pt2'); check('moved + zoomed export still matches its frame (mean diff < 4)', mad(out, ref_from(SRC('pp_portrait.jpg'), c4, (413, 531))) < 4)
    p.click('#pp-center'); ready(p); c5 = frame_rect(p, 1200, 1600); check('Recenter keeps zoom, centres the frame', abs(c5[2] - 600) <= 2 and abs(c5[0] + c5[2] / 2 - 600) <= 2 and abs(c5[1] + c5[3] / 2 - 800) <= 2, str(c5))
    p.click('#pp-reset'); ready(p); check('Reset crop returns to zoom 1, full width', frame_rect(p, 1200, 1600)[2] == 1200 and p.input_value('#pp-zoom') == '1')
    p.click('#pp-zin'); ready(p); check('zoom-in button works (no mouse needed)', frame_rect(p, 1200, 1600)[2] < 1200)
    p.click('#pp-reset'); ready(p)

    # ---------------- landscape + small sources
    load(p, BASE, 'pp_landscape.jpg', PATH); p.wait_for_selector('.pp-frame'); cl = frame_rect(p, 1600, 1200)
    check('landscape photo: frame is the largest portrait 35:45 area (height 1200, width ≈933), centred', cl[3] == 1200 and abs(cl[2] - 933) <= 1 and abs(cl[0] - 333) <= 2, str(cl))
    out, _, _ = photo(p, 'ls'); check('landscape source exports 413 × 531 matching its frame', out.size == (413, 531) and mad(out, ref_from(SRC('pp_landscape.jpg'), cl, (413, 531))) < 4)
    p.click('#pp-swap'); ready(p); cs = frame_rect(p, 1600, 1200); check('swapped (landscape 45 × 35) size gives a landscape frame', cs[2] > cs[3] and abs(cs[2] / cs[3] - 531 / 413) < 0.01, str(cs)); out, _, _ = photo(p, 'ls2'); check('...and a 531 × 413 export', out.size == (531, 413)); p.click('#pp-swap'); ready(p)
    load(p, BASE, 'pp_small.jpg', PATH); p.wait_for_selector('.pp-frame')
    check('small photo (300 × 400): warns that it is not enlarged and shows the effective DPI', p.is_visible('#pp-warn') and 'not enlarged' in p.inner_text('#pp-warn') and 'DPI' in p.inner_text('#pp-warn'), p.inner_text('#pp-warn'))
    out, _, _ = photo(p, 'sm'); cs = frame_rect(p, 300, 400); check('small photo export keeps its real pixels (no upscaling): size == crop size, < 413 × 531', out.size == (cs[2], cs[3]) and out.size[0] < 413, f'{out.size} {cs}')
    check('unnecessary upscaling avoided: output never larger than the source', out.size[0] <= 300 and out.size[1] <= 400)

    # ---------------- background
    load(p, BASE, 'pp_alpha.png', PATH); p.wait_for_selector('.pp-frame')
    check('background note: white fill does not remove a photographed background', 'does not remove or replace the background' in p.inner_text('.workbench') and 'not part of this tool' in p.inner_text('.workbench'))
    o1, f1, _ = (Image.open(download(p, 'al1')[0]).convert('RGBA'), None, None); check('Keep original: transparent corner stays transparent (PNG)', o1.getpixel((2, 2))[3] == 0, str(o1.getpixel((2, 2))))
    p.click('[aria-label="Background"] button:text-is("White fill")'); ready(p); o2 = Image.open(download(p, 'al2')[0]).convert('RGBA')
    check('White fill: the transparent corner becomes opaque white', o2.getpixel((2, 2)) == (255, 255, 255, 255) and o2.getpixel((200, 300))[3] == 255, str(o2.getpixel((2, 2))))
    check('White fill leaves the photographic pixels unchanged', np.abs(np.array(o2.convert('RGB'), int)[200:, 100:].astype(int) - np.array(o1.convert('RGB'), int)[200:, 100:]).max() <= 1)
    p.click('[aria-label="Background"] button:text-is("Keep original")'); ready(p)

    # ---------------- formats
    load(p, BASE, 'pp_portrait.jpg', PATH); p.wait_for_selector('.pp-frame')
    for mime, fmt in [('image/png', 'PNG'), ('image/webp', 'WEBP'), ('image/jpeg', 'JPEG')]:
        p.select_option('#format', mime); ready(p); im, f, name = photo(p, 'fmt' + fmt)
        check(f'output format {fmt}: real {fmt}, 413 × 531, extension matches, size shown', Image.open(f).format == fmt and im.size == (413, 531) and name.endswith({'PNG': '.png', 'WEBP': '.webp', 'JPEG': '.jpg'}[fmt]) and '413 × 531' in txt(p, 'dimsAfter'), f'{Image.open(f).format} {name}')
    check('default JPEG quality is raised for print (90%)', p.input_value('#quality') == '90', p.input_value('#quality'))

    # ---------------- print sheet
    p.wait_for_selector('#sh-preview'); inf = p.inner_text('#sh-info')
    check('sheet shows paper, page size, photo size, margin, spacing, DPI before export', all(w in inf for w in ['A4 portrait', '210 × 297 mm', '35 × 45 mm', 'margin 10 mm', 'spacing 3 mm', '300 DPI', '5 × 5 per page (25)', '8 copies on 1 page']), inf)
    check('preview canvas is the A4 aspect and drawn (not blank): non-white pixels inside', abs(p.evaluate("(()=>{const c=document.querySelector('#sh-preview');return c.width/c.height})()") - 210 / 297) < 0.01 and p.evaluate("(()=>{const c=document.querySelector('#sh-preview');const d=c.getContext('2d').getImageData(40,40,200,200).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]<250)n++;return n})()") > 1000)
    f, name = pdf_download(p, 'pdf1'); r = pypdf.PdfReader(f); pg = r.pages[0]
    check('PDF: downloaded as passport-sheet.pdf, 1 page, A4 MediaBox 595.28 × 841.89 pt (pypdf)', name == 'passport-sheet.pdf' and len(r.pages) == 1 and abs(float(pg.mediabox.width) - 595.2756) < 0.02 and abs(float(pg.mediabox.height) - 841.8898) < 0.02, f'{len(r.pages)} {pg.mediabox}')
    check('PDF: embeds one 413 × 531 JPEG; drawn at 35 × 45 mm (99.21 × 127.56 pt), aspect equals the pixels (no stretch)', len(pg.images) == 1 and pg.images[0].image.size == (413, 531) and pg.images[0].image.format == 'JPEG', str([i.image.size for i in pg.images]))
    cm = re.findall(rb'q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm /Im0 Do Q', pg.get_contents().get_data()); check('PDF draws 8 photos, each 99.2126 × 127.559 pt', len(cm) == 8 and all(abs(float(a) - 99.2126) < 0.001 and abs(float(b_) - 127.559) < 0.001 for a, b_, _, _ in cm), str(cm[:1]))
    img = render(f); cols, rows, pages = layout(210, 297, 10, 3, 35, 45, 8); okp = True; ref = Image.open(download(p, 'single')[0]).convert('RGB'); diffs = []
    for (x, y, w, h) in pages[0]:
        X, Y, W, H = round(px(x)), round(px(y)), round(px(w)), round(px(h)); inner = img.crop((X + 4, Y + 4, X + W - 4, Y + H - 4)); want = ref.resize((W, H), Image.LANCZOS).crop((4, 4, W - 4, H - 4)); diffs.append(mad(inner, want))
    check('rendered PDF: every one of the 8 photos sits at its mm position and matches the photo (mean diff < 12)', max(diffs) < 12, str([round(d, 1) for d in diffs]))
    a = np.array(img); nonwhite = np.argwhere((a < 245).any(-1)); y0, x0 = nonwhite.min(0); y1, x1 = nonwhite.max(0) + 1
    exp = (round(px(10)), round(px(10)), round(px(10 + 4 * 38 + 35)), round(px(10 + 1 * 48 + 45)))
    check('rendered PDF: content bounding box == expected block (margins 10 mm preserved), nothing outside', abs(x0 - exp[0]) <= 2 and abs(y0 - exp[1]) <= 2 and abs(x1 - exp[2]) <= 2 and abs(y1 - exp[3]) <= 2, f'{(x0, y0, x1, y1)} vs {exp}')
    gx = a[round(px(12)):round(px(40)), round(px(10 + 35 + 0.5)):round(px(10 + 35 + 2.5))]; check('rendered PDF: the 3 mm gap between photos is white', (gx > 245).all())
    p.fill('#sh-copies', '30'); ready(p); check('30 copies at 25 per page -> info says 2 pages', '30 copies on 2 pages' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    f, _ = pdf_download(p, 'pdf2'); r = pypdf.PdfReader(f); counts = [len(re.findall(rb' cm /Im0 Do Q', pg_.get_contents().get_data())) for pg_ in r.pages]
    check('PDF with 30 copies: 2 pages, 25 + 5 photos, all A4, same image object shared', len(r.pages) == 2 and counts == [25, 5] and all(abs(float(x.mediabox.width) - 595.2756) < 0.02 for x in r.pages), str(counts))
    p.click('#sh-fill'); ready(p); check('"Fill one page" sets copies to 25', p.input_value('#sh-copies') == '25')
    p.fill('#sh-margin', '20'); p.fill('#sh-gap', '5'); p.fill('#sh-copies', '9'); ready(p); cols, rows, pages = layout(210, 297, 20, 5, 35, 45, 9)
    check('margin 20 / spacing 5: grid is 4 × 5 per page and the info line updates', f'margin 20 mm · spacing 5 mm' in p.inner_text('#sh-info') and f'{cols} × {rows} per page' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    f, _ = pdf_download(p, 'pdf3'); img = render(f); a = np.array(img); nonwhite = np.argwhere((a < 245).any(-1)); y0, x0 = nonwhite.min(0); x1 = nonwhite[:, 1].max() + 1
    check('margin 20 mm respected in the rendered PDF (left edge at 20 mm, nothing left of it or above)', abs(x0 - round(px(20))) <= 2 and abs(y0 - round(px(20))) <= 2, f'{(x0, y0)} vs {round(px(20))}')
    check('right edge stays inside the 20 mm margin', x1 <= round(px(210 - 20)) + 2, f'{x1} vs {round(px(190))}')
    p.click('[aria-label="Page orientation"] button:text-is("Landscape")'); ready(p); f, _ = pdf_download(p, 'pdf4'); pg = pypdf.PdfReader(f).pages[0]
    check('landscape: MediaBox 841.89 × 595.28 pt', abs(float(pg.mediabox.width) - 841.8898) < 0.02 and abs(float(pg.mediabox.height) - 595.2756) < 0.02 and 'landscape' in p.inner_text('#sh-info'))
    p.click('[aria-label="Page orientation"] button:text-is("Portrait")'); ready(p)
    p.fill('#sh-margin', '120'); ready(p); check('margin too large -> message, PDF button disabled', p.is_visible('#sh-error') and p.is_disabled('#sh-pdf') and 'Margin must be' in p.inner_text('#sh-error'), p.inner_text('#sh-error'))
    p.fill('#sh-margin', '10'); p.fill('#sh-copies', '0'); ready(p); check('copies 0 -> message', 'Copies must be' in p.inner_text('#sh-error') and p.is_disabled('#sh-pdf'))
    p.fill('#sh-copies', '8'); p.fill('#pp-wmm', '200'); p.fill('#pp-hmm', '100'); ready(p); check('photo larger than the printable area -> "does not fit", no clipping, no PDF', 'does not fit' in p.inner_text('#sh-error') and p.is_disabled('#sh-pdf'), p.inner_text('#sh-error'))
    p.click('.chip:text-is("35 × 45 mm")'); ready(p); p.fill('#sh-margin', '10'); ready(p)
    p.fill('#pp-wmm', '50.8'); p.fill('#pp-hmm', '50.8'); p.select_option('#pp-dpi', '300'); ready(p); f, _ = pdf_download(p, 'pdf5'); r = pypdf.PdfReader(f); pg = r.pages[0]; cm = re.findall(rb'q ([\d.]+) 0 0 ([\d.]+) ', pg.get_contents().get_data())
    check('2 × 2 in photo: drawn 144 × 144 pt, image 600 × 600', abs(float(cm[0][0]) - 144) < 0.01 and abs(float(cm[0][1]) - 144) < 0.01 and pg.images[0].image.size == (600, 600), str(cm[0]))
    p.click('.chip:text-is("35 × 45 mm")'); ready(p)
    load(p, BASE, 'pp_small.jpg', PATH); p.wait_for_selector('#sh-preview'); f, _ = pdf_download(p, 'pdf6'); pg = pypdf.PdfReader(f).pages[0]; cm = re.findall(rb'q ([\d.]+) 0 0 ([\d.]+) ', pg.get_contents().get_data())
    sz = pg.images[0].image.size; check('low-resolution photo: PDF keeps the physical 35 × 45 mm size with the real (smaller) pixel grid; no upscaling', sz[0] < 413 and abs(float(cm[0][0]) - 99.2126) < 0.01 and abs(float(cm[0][1]) - 127.559) < 0.01, f'{sz} {cm[0]}')
    check('PDF status explains the self-check and that no authority rules were verified', 'passed its own structure check' in p.inner_text('#sh-status') and 'authority' in p.inner_text('#sh-status'), p.inner_text('#sh-status'))

    # ---------------- alignment at different preview sizes
    for vw, vh in [(1200, 900), (700, 800), (390, 844)]:
        c2 = b.new_context(viewport={'width': vw, 'height': vh}, accept_downloads=True); q = c2.new_page(); load(q, BASE, 'pp_portrait.jpg', PATH); q.wait_for_selector('.pp-frame'); setv(q, '#pp-zoom', 1.6)
        q.focus('.pp-frame')
        for _ in range(7): q.keyboard.press('ArrowRight')
        for _ in range(5): q.keyboard.press('ArrowDown')
        ready(q); fr = frame_rect(q, 1200, 1600); bb = q.locator('.pp-frame').bounding_box(); cb = q.locator('.pp-canvas').bounding_box(); k = 1200 / cb['width']
        vis = ((bb['x'] - cb['x']) * k, (bb['y'] - cb['y']) * k, bb['width'] * k, bb['height'] * k)
        im, _, _ = photo(q, f'al{vw}'); check(f'alignment @ {vw}px: frame on screen == crop == exported pixels (±1.5 px, diff < 4)', all(abs(a_ - e_) <= 1.5 for a_, e_ in zip(vis, fr)) and mad(im, ref_from(SRC('pp_portrait.jpg'), fr, (413, 531))) < 4, f'{tuple(round(v, 1) for v in vis)} {fr}')
        if vw == 390:
            sw_ = q.evaluate('document.documentElement.scrollWidth'); check(f'mobile 390 px: no sideways scroll ({sw_}); sheet preview fits', sw_ <= 391 and q.locator('#sh-preview').bounding_box()['width'] <= 391, str(sw_))
            f, _ = pdf_download(q, 'mobpdf'); check('mobile: PDF builds and is valid A4', len(pypdf.PdfReader(f).pages) == 1)
        c2.close()

    # ---------------- leaving the tool restores shared state; existing tools unaffected
    load(p, BASE, 'pp_portrait.jpg', PATH); p.wait_for_selector('.pp-frame'); p.click('.chip:text-is("35 × 45 mm")'); ready(p); nav(p, 'Compress'); ready(p)
    check('leaving Passport Photo restores the default quality slider (70) so other tools are not affected', p.input_value('#quality') == '70', p.input_value('#quality'))
    check('console clean', not errors, ' | '.join(errors)[:300])
    ctx.close(); b.close()
finally: srv.terminate()
finish()
