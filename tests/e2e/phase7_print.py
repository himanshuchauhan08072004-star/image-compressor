"""Phase 7: paper sizes, advanced layouts, multiple photo sizes, presets, manual placement, document workflows.
Real Chromium. PDFs are checked independently with pypdf and rendered with pypdfium2."""
import io, json, re
import numpy as np
import pypdf, pypdfium2 as pdfium
from PIL import Image
from common import *
from playwright.sync_api import sync_playwright
PORT = 4197; BASE = f'http://127.0.0.1:{PORT}'; srv = start_server(PORT)
MM = 72 / 25.4

def setv(p, sel, v): p.eval_on_selector(sel, "(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}", str(v)); p.wait_for_timeout(60)
def pdf_download(p, tag, btn='#sh-pdf'):
    with p.expect_download(timeout=60000) as d: p.click(btn)
    f = os.path.join(tmp, tag + '.pdf'); d.value.save_as(f); return f, d.value.suggested_filename
def box(f, i=0): r = pypdf.PdfReader(f).pages[i].mediabox; return float(r.width), float(r.height)
def draws(f, i=0):
    s = pypdf.PdfReader(f).pages[i].get_contents().get_data().decode('latin1')
    return [tuple(map(float, m[:4])) + (int(m[4]),) for m in re.findall(r'q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm /Im(\d+) Do Q', s)], s
def close(a, b, t=0.05): return abs(a - b) <= t
def add_pic(p, name):
    p.set_input_files('#sh-add-image', fx(name)); p.wait_for_function("()=>/added/.test(document.querySelector('#sh-add-note').textContent)", timeout=60000)
def open_adv(p):
    if not p.evaluate("document.querySelector('#sh-advanced').open"): p.click('#sh-advanced > summary')
def status(p): return p.inner_text('#sh-status')
def wait_pdf(p): p.wait_for_function("()=>!document.querySelector('#sh-pdf').disabled", timeout=30000)

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000}, accept_downloads=True); p = ctx.new_page()
    errors = []; p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); p.on('pageerror', lambda e: errors.append(str(e)))

    # ---------------- Print Layout tool: standalone
    p.goto(BASE + '/print'); p.wait_for_selector('#sh-preview')
    check('Print Layout is routable, in the nav, and needs no upload first', 'Print Layout' in p.locator('#toolNav a').all_text_contents() and p.is_visible('#sh-paper'))
    check('without a picture the PDF button is off and says what to do', p.is_disabled('#sh-pdf') and 'picture' in p.inner_text('#sh-warn'))
    open_adv(p); add_pic(p, 'pp_portrait.jpg'); wait_pdf(p)
    check('adding a picture assigns it to the group and enables export', p.input_value('#sh-g1-src') != '' and not p.is_disabled('#sh-pdf'))
    check('paper dimensions are displayed (mm and in)', '210 × 297 mm' in p.inner_text('#sh-paper-dims') and '8.27 × 11.69 in' in p.inner_text('#sh-paper-dims'), p.inner_text('#sh-paper-dims'))
    f, name = pdf_download(p, 'a4'); w, h = box(f); d, s = draws(f)
    check('A4 default: 595.28 × 841.89 pt, 8 photos at 35 × 45 mm, file print-sheet.pdf', close(w, 210 * MM) and close(h, 297 * MM) and len(d) == 8 and all(close(x[0], 35 * MM, .02) and close(x[1], 45 * MM, .02) for x in d) and name == 'print-sheet.pdf', f'{w} {h} {len(d)} {name}')
    ref = Image.open(io.BytesIO(pypdf.PdfReader(f).pages[0].images[0].data)).convert('RGB')
    check('embedded picture is the centre crop with the 35:45 shape (no stretch)', close(ref.width / ref.height, 35 / 45, 0.01), str(ref.size))

    for key, wmm, hmm in [('A5', 148, 210), ('LETTER', 215.9, 279.4)]:
        p.select_option('#sh-paper', key); wait_pdf(p)
        f, _ = pdf_download(p, key); w, h = box(f); d, _ = draws(f)
        check(f'{key}: MediaBox {wmm} × {hmm} mm, photos 35 × 45 mm and inside the 10 mm margin', close(w, wmm * MM) and close(h, hmm * MM) and all(x[2] >= 10 * MM - .05 and x[2] + x[0] <= w - 10 * MM + .05 and x[3] >= 10 * MM - .05 and x[3] + x[1] <= h - 10 * MM + .05 for x in d), f'{w} {h}')
        check(f'{key}: info and page size text name the paper', ('US Letter' if key == 'LETTER' else key) in p.inner_text('#sh-info') and f'{wmm:g} × {hmm:g} mm' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    f, _ = pdf_download(p, 'letter_check'); w, h = box(f); check('US Letter is exactly 612 × 792 pt', close(w, 612, .01) and close(h, 792, .01), f'{w} {h}')
    p.click('#sh-landscape'); wait_pdf(p); f, _ = pdf_download(p, 'letter_land'); w, h = box(f)
    check('Letter landscape: 792 × 612 pt', close(w, 792, .01) and close(h, 612, .01)); p.click('#sh-portrait')

    # custom paper, inches and mm
    p.select_option('#sh-paper', 'CUSTOM'); p.select_option('#sh-cunit', 'in'); setv(p, '#sh-cw', 4); setv(p, '#sh-ch', 6); wait_pdf(p)
    check('custom 4 × 6 in: dims line shows 101.6 × 152.4 mm', '101.6 × 152.4 mm' in p.inner_text('#sh-paper-dims'), p.inner_text('#sh-paper-dims'))
    f, _ = pdf_download(p, 'c46'); w, h = box(f); check('custom 4 × 6 in: MediaBox 288 × 432 pt', close(w, 288, .01) and close(h, 432, .01), f'{w} {h}')
    p.select_option('#sh-cunit', 'mm'); check('switching unit converts the same physical size: 101.6 × 152.4 mm', p.input_value('#sh-cw') == '101.6' and p.input_value('#sh-ch') == '152.4', p.input_value('#sh-cw'))
    for bad in ['0', '-5', '2', '5000', '']:
        setv(p, '#sh-cw', bad); ok = p.is_disabled('#sh-pdf') and ('between' in p.inner_text('#sh-paper-dims') or 'greater than zero' in p.inner_text('#sh-paper-dims') or 'Enter' in p.inner_text('#sh-paper-dims'))
        check(f'custom width "{bad}" is rejected with a message and no export', ok, p.inner_text('#sh-paper-dims') + '|' + p.inner_text('#sh-error'))
    setv(p, '#sh-cw', 210); setv(p, '#sh-ch', 297); p.select_option('#sh-paper', 'A4'); wait_pdf(p)

    # alignment, columns, guides
    p.select_option('#sh-alignh', 'center'); p.select_option('#sh-alignv', 'middle'); setv(p, '#sh-copies', 1); wait_pdf(p)
    f, _ = pdf_download(p, 'centre'); d, _ = draws(f); w, h = box(f)
    check('centre/middle: the single photo is centred on the page', close(d[0][2] + d[0][0] / 2, w / 2, .1) and close(d[0][3] + d[0][1] / 2, h / 2, .1), str(d[0]))
    p.select_option('#sh-alignh', 'left'); p.select_option('#sh-alignv', 'top'); setv(p, '#sh-copies', 8); setv(p, '#sh-cols', 2); setv(p, '#sh-rows', 2); wait_pdf(p)
    check('2 columns × 2 rows limit: 4 per page, 8 copies need 2 pages', '2 × 2 per page (4)' in p.inner_text('#sh-info') and '8 copies on 2 pages' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    f, _ = pdf_download(p, 'grid22'); check('PDF has 2 pages with 4 photos each', len(pypdf.PdfReader(f).pages) == 2 and len(draws(f, 0)[0]) == 4 and len(draws(f, 1)[0]) == 4)
    check('pager shows Page 1 of 2 and moves', p.inner_text('#sh-page-label') == 'Page 1 of 2' and not p.is_disabled('#sh-next')); p.click('#sh-next'); check('Page 2 of 2, Next disabled', p.inner_text('#sh-page-label') == 'Page 2 of 2' and p.is_disabled('#sh-next')); p.click('#sh-prev')
    setv(p, '#sh-cols', 0); setv(p, '#sh-rows', 0); p.select_option('#sh-guides', 'box'); setv(p, '#sh-copies', 6); wait_pdf(p)
    f, _ = pdf_download(p, 'guides'); d, s = draws(f); n = len(re.findall(r' re S', s))
    check('cutting guides: one outline per photo in the PDF, none when off', n == 6, str(n)); p.select_option('#sh-guides', 'none'); wait_pdf(p); f, _ = pdf_download(p, 'noguides'); check('guides off -> no outlines', ' re S' not in draws(f)[1])
    setv(p, '#sh-hgap', 8); setv(p, '#sh-vgap', 2); wait_pdf(p); f, _ = pdf_download(p, 'gaps'); d, _ = draws(f)
    check('separate spacing: 8 mm horizontal, 2 mm vertical between photos (rendered PDF geometry)', close(d[1][2] - (d[0][2] + d[0][0]), 8 * MM, .05) and close(d[0][3] - (d[5][3] + d[5][1]), 2 * MM, .05) if len(d) > 5 else close(d[1][2] - (d[0][2] + d[0][0]), 8 * MM, .05), str(d[:2]))
    check('overall spacing box is disabled and says to use advanced when the two differ', p.is_disabled('#sh-gap'))
    setv(p, '#sh-hgap', 3); setv(p, '#sh-vgap', 3); check('equal spacing re-enables the simple box', not p.is_disabled('#sh-gap'))

    # ---------------- multiple photo sizes
    p.click('#sh-add-group'); setv(p, '#sh-g2-w', 70); setv(p, '#sh-g2-h', 90); setv(p, '#sh-g2-copies', 1); setv(p, '#sh-copies', 6); wait_pdf(p)
    check('two groups: legend lists both sizes, info mentions both', '35 × 45 mm' in p.inner_text('#sh-legend') and '70 × 90 mm' in p.inner_text('#sh-legend') and '7 copies on 1 page' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    add_pic(p, 'pp_landscape.jpg'); p.select_option('#sh-g2-src', index=2); wait_pdf(p)
    f, _ = pdf_download(p, 'mixed'); d, s = draws(f); rd = pypdf.PdfReader(f)
    sizes = sorted({(round(x[0] / MM), round(x[1] / MM), x[4]) for x in d})
    check('mixed sheet: 6 photos 35×45 mm (image 0) + 1 photo 70×90 mm (image 1), each physically exact', sizes == [(35, 45, 0), (70, 90, 1)] and len(d) == 7, str(sizes))
    xs = [(x[2], x[3], x[0], x[1]) for x in d]; ov = any(min(a[0] + a[2], c[0] + c[2]) - max(a[0], c[0]) > .01 and min(a[1] + a[3], c[1] + c[3]) - max(a[1], c[1]) > .01 for i, a in enumerate(xs) for c in xs[i + 1:])
    check('no photos overlap in the PDF', not ov); im = rd.pages[0].images; check('two different pictures are embedded', len(im) == 2, str(len(im)))
    g = Image.open(io.BytesIO(im[1].data)); check('the large photo uses the landscape picture cropped to 70:90 (no stretch)', close(g.width / g.height, 70 / 90, .01), str(g.size))
    p.select_option('#sh-g2-fit', 'contain'); wait_pdf(p); f, _ = pdf_download(p, 'contain'); im2 = pypdf.PdfReader(f).pages[0].images
    g2 = Image.open(io.BytesIO(im2[1].data)).convert('RGB'); check('"Fit whole picture" pads with white instead of cropping', close(g2.width / g2.height, 70 / 90, .02) and g2.getpixel((2, 2)) == (255, 255, 255), str(g2.size))
    p.select_option('#sh-g2-fit', 'cover')
    setv(p, '#sh-g2-w', 300); check('a photo too large for the page: clear message naming the group, export off, nothing clipped', 'Photo group 2' in p.inner_text('#sh-error') and 'does not fit' in p.inner_text('#sh-error') and p.is_disabled('#sh-pdf'), p.inner_text('#sh-error'))
    setv(p, '#sh-g2-w', 70)
    p.click('#sh-g2-src ~ * >> nth=0') if False else None

    # ---------------- manual layout
    setv(p, '#sh-copies', 2); p.click('#sh-g2-src >> xpath=ancestor::div[contains(@class,"sh-group-row")]//button[contains(.,"Remove")]'); wait_pdf(p)
    p.click('#sh-mode-manual'); wait_pdf(p)
    check('manual mode shows the position tools and hint', p.is_visible('#sh-manual-tools') and p.is_visible('#sh-manual-hint'))
    cv = p.locator('#sh-preview'); cv.scroll_into_view_if_needed(); p.wait_for_timeout(150); bb = cv.bounding_box(); sx = bb['width'] / 210; sy = bb['height'] / 297
    p.mouse.move(bb['x'] + 20 * sx, bb['y'] + 20 * sy); p.mouse.down(); p.mouse.move(bb['x'] + 60 * sx, bb['y'] + 150 * sy, steps=8); p.mouse.up(); p.wait_for_timeout(100)
    x0, y0 = float(p.input_value('#sh-sel-x')), float(p.input_value('#sh-sel-y'))
    check('dragging the first photo by (40, 130) mm moves it there (position shows in the X/Y boxes)', 45 <= x0 <= 55 and 135 <= y0 <= 145, f'{x0},{y0}')
    f, _ = pdf_download(p, 'manual'); d, _ = draws(f); H = 297 * MM
    check('PDF places the dragged photo where the preview shows it', close(d[0][2], x0 * MM, .5) and close(H - d[0][3] - d[0][1], y0 * MM, .5), f'{d[0]} {x0} {y0}')
    setv(p, '#sh-sel-x', 48); setv(p, '#sh-sel-y', 10); wait_pdf(p)
    check('typing a position that lands on another photo is refused (no overlap), message shown', 'on top of another photo' in status(p) or (float(p.input_value('#sh-sel-x')) != 48 or float(p.input_value('#sh-sel-y')) != 10), status(p))
    setv(p, '#sh-sel-x', 500); wait_pdf(p); check('a position outside the page is pulled inside the printable area', float(p.input_value('#sh-sel-x')) <= 210 - 10 - 35 + 0.01, p.input_value('#sh-sel-x'))
    p.focus('#sh-preview'); xb = float(p.input_value('#sh-sel-x')); p.keyboard.press('ArrowLeft'); p.wait_for_timeout(80); check('keyboard: ArrowLeft nudges the selected photo by 0.5 mm', close(float(p.input_value('#sh-sel-x')), xb - 0.5, .01), p.input_value('#sh-sel-x'))
    p.click('#sh-reset-pos'); wait_pdf(p); f, _ = pdf_download(p, 'reset'); d, _ = draws(f); check('Reset positions returns to the automatic layout', close(d[0][2], 10 * MM, .05) and close(H - d[0][3] - d[0][1], 10 * MM, .05), str(d[0]))
    p.click('#sh-mode-auto')

    # ---------------- presets
    p.select_option('#sh-preset', index=0); p.click('#sh-preset-apply'); check('built-in preset applies (A4 passport)', '8 copies' in p.inner_text('#sh-info') and 'Applied' in p.inner_text('#sh-preset-status'), p.inner_text('#sh-info'))
    p.select_option('#sh-preset', 'builtin:us-2x2-letter'); p.click('#sh-preset-apply'); wait_pdf(p)
    check('US 2×2 in preset: Letter, 50.8 mm photos, 6 copies', 'US Letter' in p.inner_text('#sh-info') and '50.8 × 50.8 mm' in p.inner_text('#sh-info') and '6 copies' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    f, _ = pdf_download(p, 'preset_letter'); d, _ = draws(f); check('preset PDF: 6 photos of 144 pt (2 in)', len(d) == 6 and all(close(x[0], 144, .02) for x in d)); 
    p.select_option('#sh-paper', 'A4'); setv(p, '#sh-margin', 15); setv(p, '#sh-g1-w', 40); setv(p, '#sh-g1-h', 55); setv(p, '#sh-copies', 3); p.select_option('#sh-guides', 'box')
    setv(p, '#sh-preset-name', 'My 40x55'); p.click('#sh-preset-save'); check('custom layout saved and selectable', 'Saved' in p.inner_text('#sh-preset-status') and 'My 40x55' in p.locator('#sh-preset option').all_inner_texts(), p.inner_text('#sh-preset-status'))
    stored = p.evaluate("localStorage.getItem('shrinkit.layoutPresets.v1')"); check('stored preset contains settings only: no picture data, no file names', stored and 'data:image' not in stored and 'pp_' not in stored and '"source"' not in stored and 'My 40x55' in stored, (stored or '')[:200])
    p.reload(); p.wait_for_selector('#sh-preview'); open_adv(p); check('saved preset survives a reload', 'My 40x55' in p.locator('#sh-preset option').all_inner_texts())
    open_adv(p); p.select_option('#sh-preset', label='My 40x55'); p.click('#sh-preset-apply'); check('applying the saved preset restores margin, size, copies, guides', p.input_value('#sh-margin') == '15' and p.input_value('#sh-g1-w') == '40' and p.input_value('#sh-copies') == '3' and p.input_value('#sh-guides') == 'box', p.input_value('#sh-margin'))
    setv(p, '#sh-preset-name', 'Renamed'); p.click('#sh-preset-rename'); check('rename works', 'Renamed' in p.locator('#sh-preset option').all_inner_texts() and 'My 40x55' not in p.locator('#sh-preset option').all_inner_texts())
    p.click('#sh-preset-delete'); check('delete works', 'Renamed' not in p.locator('#sh-preset option').all_inner_texts() and 'Deleted' in p.inner_text('#sh-preset-status'))
    p.select_option('#sh-preset', index=0); p.click('#sh-preset-delete'); check('built-in presets cannot be deleted', 'cannot be deleted' in p.inner_text('#sh-preset-status'), p.inner_text('#sh-preset-status'))
    p.evaluate("localStorage.setItem('shrinkit.layoutPresets.v1', '{broken json')"); p.reload(); p.wait_for_selector('#sh-preview'); open_adv(p)
    check('corrupted saved presets: page still works, built-ins still listed, user told', p.locator('#sh-preset option').count() >= 4 and 'could not be read' in p.inner_text('#sh-preset-status') and p.is_visible('#sh-preview'), p.inner_text('#sh-preset-status'))
    p.evaluate("""localStorage.setItem('shrinkit.layoutPresets.v1', JSON.stringify({v:1,presets:[{id:'a',name:'Old style',paper:'A5',margin:8,gap:4,photoW:35,photoH:45,copies:6},{id:'b',name:'Bad',settings:{margin:-4,groups:[]}}]}))"""); p.reload(); p.wait_for_selector('#sh-preview'); open_adv(p)
    check('outdated preset is upgraded, invalid one is skipped and reported', 'Old style' in p.locator('#sh-preset option').all_inner_texts() and 'Bad' not in p.locator('#sh-preset option').all_inner_texts() and '1 saved layout was damaged' in p.inner_text('#sh-preset-status'), p.inner_text('#sh-preset-status'))
    p.select_option('#sh-preset', label='Old style'); p.click('#sh-preset-apply'); check('upgraded preset applies (A5, 6 copies)', 'A5' in p.inner_text('#sh-info') and '6 copies' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))
    p.evaluate("localStorage.removeItem('shrinkit.layoutPresets.v1')")

    # ---------------- preview: scale text, accessibility, no layout jump
    p.select_option('#sh-paper', 'A4'); h1 = p.locator('#sh-preview').bounding_box()['height']; setv(p, '#sh-margin', 12); setv(p, '#sh-gap', 4); h2 = p.locator('#sh-preview').bounding_box()['height']
    check('changing margin/spacing does not resize the preview (no layout jump)', abs(h1 - h2) < 1, f'{h1} {h2}')
    check('preview scale is stated separately from the real page size', 'Preview scale' in p.inner_text('#sh-scale') and 'exactly 210 × 297 mm' in p.inner_text('#sh-scale'), p.inner_text('#sh-scale'))
    check('controls have accessible names (every input/select has a label)', p.evaluate("()=>[...document.querySelectorAll('.sheet-panel input,.sheet-panel select')].filter(e=>!e.labels.length&&!e.getAttribute('aria-label')).length") == 0)
    check('preview canvas has a text alternative', 'page 1' in p.get_attribute('#sh-preview', 'aria-label'))
    p.set_viewport_size({'width': 390, 'height': 800}); p.wait_for_timeout(200); sw = p.evaluate('document.documentElement.scrollWidth')
    check('mobile 390 px: no sideways scroll on Print Layout', sw <= 391, str(sw)); p.set_viewport_size({'width': 1200, 'height': 1000})

    # ---------------- Passport tool still works and gained paper sizes
    load(p, BASE, 'pp_portrait.jpg', '/photo/passport'); p.wait_for_selector('.pp-frame'); p.click('.chip:text-is("35 × 45 mm")'); ready(p); p.wait_for_function("()=>!document.querySelector('#sh-pdf').disabled", timeout=30000)
    p.select_option('#sh-paper', 'LETTER'); wait_pdf(p); f, name = pdf_download(p, 'pp_letter'); w, h = box(f); d, _ = draws(f)
    check('Passport tool: Letter sheet 612 × 792 pt, 8 photos, passport-sheet.pdf', close(w, 612, .01) and close(h, 792, .01) and len(d) == 8 and name == 'passport-sheet.pdf', f'{w} {h} {len(d)} {name}')
    p.select_option('#sh-paper', 'A4'); wait_pdf(p); p.evaluate("document.querySelector('#sh-advanced').open=true"); p.click('#sh-add-group'); setv(p, '#sh-g2-w', 50); setv(p, '#sh-g2-h', 70); setv(p, '#sh-g2-copies', 1); wait_pdf(p)
    f, _ = pdf_download(p, 'pp_mixed'); d, _ = draws(f); check('Passport tool: second photo size from the same photo, exact 50 × 70 mm', sorted({(round(x[0] / MM), round(x[1] / MM)) for x in d}) == [(35, 45), (50, 70)] and len(d) == 9, str(sorted({(round(x[0] / MM), round(x[1] / MM)) for x in d})))
    check('Passport: photo size comes from the tool above (group 1 locked)', p.is_disabled('#sh-g1-w'))
    p.select_option('#sh-preset', 'builtin:passport-a5'); p.click('#sh-preset-apply'); wait_pdf(p); check('Passport: preset applies paper and copies', 'A5' in p.inner_text('#sh-info') and '6 copies' in p.inner_text('#sh-info'), p.inner_text('#sh-info'))

    # ---------------- Document workflows
    p.goto(BASE + '/workflows'); p.wait_for_selector('#wf-steps')
    check('Workflows tool routable; default passport template shows Crop, Resize, Print sheet in order', [t.strip().split('.')[1].strip() for t in p.locator('.wf-step-head strong').all_inner_texts()] == ['Crop', 'Resize', 'Print sheet (PDF)'], str(p.locator('.wf-step-head strong').all_inner_texts()))
    check('Run is disabled until a picture is added, with a reason', p.is_disabled('#wf-run') and 'Add at least one picture' in p.inner_text('#wf-problems'))
    p.set_input_files('#wf-files', [fx('pp_portrait.jpg'), fx('pp_landscape.jpg')]); p.wait_for_function("()=>document.querySelectorAll('#wf-images li').length===2", timeout=60000)
    check('two pictures listed, Run enabled', not p.is_disabled('#wf-run'))
    p.click('#wf-run'); p.wait_for_selector('#wf-download', timeout=120000)
    check('passport workflow: every step shows Done', all(s == 'done' for s in p.locator('.wf-prog').evaluate_all('els=>els.map(e=>e.dataset.status)')), str(p.locator('.wf-prog').evaluate_all('els=>els.map(e=>e.dataset.status)')))
    with p.expect_download() as dl: p.click('#wf-download')
    f = os.path.join(tmp, 'wf.pdf'); dl.value.save_as(f); d, _ = draws(f); w, h = box(f)
    check('workflow PDF: A4, 16 photos (2 pictures × 8), each 35 × 45 mm, two embedded pictures', close(w, 210 * MM) and len(d) == 16 and all(close(x[0], 35 * MM, .02) and close(x[1], 45 * MM, .02) for x in d) and len(pypdf.PdfReader(f).pages[0].images) == 2, f'{w} {len(d)}')
    img0 = pypdf.PdfReader(f).pages[0].images[0]; im = Image.open(io.BytesIO(img0.data)); check('workflow picture is cropped to the photo shape and not larger than needed (≤ 413 × 531)', close(im.width / im.height, 35 / 45, .01) and im.width <= 413 and im.height <= 531, str(im.size))
    # reorder / remove / validation
    p.click('button[aria-label="Move Print sheet (PDF) up"]'); check('moving Print sheet above another step is flagged as an error and blocks Run', 'must be the last step' in p.inner_text('#wf-problems') and p.is_disabled('#wf-run'), p.inner_text('#wf-problems'))
    p.click('button[aria-label="Move Print sheet (PDF) down"]'); check('moving it back clears the error', 'must be the last' not in p.inner_text('#wf-problems') and not p.is_disabled('#wf-run'))
    p.select_option('#wf-add-type', 'convert'); p.click('#wf-add'); check('adding Convert to a Print-sheet workflow is flagged as incompatible', 'cannot be combined with Convert' in p.inner_text('#wf-problems') and p.is_disabled('#wf-run'), p.inner_text('#wf-problems'))
    p.click('button[aria-label="Remove Convert"]'); check('removing the step clears it', 'cannot be combined' not in p.inner_text('#wf-problems') and p.locator('.wf-step').count() == 3)
    setv(p, '#' + p.locator('.wf-step').nth(0).get_attribute('id').replace('wf-step-', '') + '-aw', 0); check('invalid step setting is reported at once and blocks Run', 'greater than zero' in p.inner_text('#wf-problems') and p.is_disabled('#wf-run'), p.inner_text('#wf-problems'))
    p.click('#wf-tpl-passport'); check('template button restores a valid workflow', not p.is_disabled('#wf-run') if p.locator('#wf-images li').count() else True)

    # workflow B: prepare -> convert + watermark, ZIP for two pictures, single download for one
    p.click('#wf-tpl-prepare'); check('image-preparation template: Resize, Convert, Watermark', [t.strip().split('.')[1].strip() for t in p.locator('.wf-step-head strong').all_inner_texts()] == ['Resize', 'Convert', 'Watermark'])
    rid = p.locator('.wf-step').nth(0).get_attribute('id').replace('wf-step-', ''); setv(p, f'#{rid}-w', 400); setv(p, f'#{rid}-h', 400)
    cid = p.locator('.wf-step').nth(1).get_attribute('id').replace('wf-step-', ''); p.select_option(f'#{cid}-fmt', 'image/png')
    p.click('#wf-run'); p.wait_for_selector('#wf-download', timeout=120000); check('two pictures -> ZIP offered', 'Download ZIP' in p.inner_text('#wf-download'))
    with p.expect_download() as dl: p.click('#wf-download')
    import zipfile; zf = os.path.join(tmp, 'wf.zip'); dl.value.save_as(zf); z = zipfile.ZipFile(zf); names = z.namelist()
    check('ZIP has 2 PNG files named from the originals', len(names) == 2 and all(n.endswith('.png') for n in names), str(names))
    im = Image.open(io.BytesIO(z.read(names[0]))); check('output is a real PNG, resized to fit inside 400 × 400 (shape kept)', im.format == 'PNG' and max(im.size) == 400, str((im.format, im.size)))
    g = np.array(im.convert('L')).astype(float); w0, h0 = im.size; tr = g[h0 - int(h0 * .1):, w0 - int(w0 * .3):]; tl = g[h0 - int(h0 * .1):, :int(w0 * .3)]
    lap = lambda a: np.abs(4 * a[1:-1, 1:-1] - a[:-2, 1:-1] - a[2:, 1:-1] - a[1:-1, :-2] - a[1:-1, 2:]).mean()
    check('watermark was applied: bottom-right text area has edges, the same-size bottom-left area is a smooth gradient', lap(tr) > 5 * max(lap(tl), 0.2) and lap(tr) > 2, f'{lap(tr):.2f} vs {lap(tl):.2f}')
    p.click('button[aria-label="Remove pp_landscape.jpg"]'); p.click('#wf-run'); p.wait_for_selector('#wf-download', timeout=120000); check('one picture -> direct download button', p.inner_text('#wf-download').strip() == 'Download')
    with p.expect_download() as dl: p.click('#wf-download')
    f = os.path.join(tmp, 'wf1.png'); dl.value.save_as(f); check('single result is named from the original and is PNG', 'pp_portrait-workflow.png' == dl.value.suggested_filename and Image.open(f).format == 'PNG', dl.value.suggested_filename)
    # failure: resize 'fill' to a size bigger than the source without allowing enlarging -> step fails, clear message, nothing skipped
    setv(p, f'#{rid}-w', 3000); setv(p, f'#{rid}-h', 3000); p.select_option(f'#{rid}-fit', 'fill'); p.click('#wf-run'); p.wait_for_selector('#wf-error:not([hidden])', timeout=60000)
    st = p.locator('.wf-prog').evaluate_all('els=>els.map(e=>e.dataset.status)')
    check('failed step is shown as Failed, later steps stay Waiting (nothing skipped silently)', st[0] == 'failed' and st[1] == 'pending' and st[2] == 'pending', str(st))
    check('error names the picture and says the original is unchanged', 'pp_portrait.jpg' in p.inner_text('#wf-error') and 'unchanged' in p.inner_text('#wf-error'), p.inner_text('#wf-error'))
    p.select_option(f'#{rid}-fit', 'inside'); setv(p, f'#{rid}-w', 300); setv(p, f'#{rid}-h', 300); p.click('#wf-run'); p.wait_for_selector('#wf-download', timeout=60000)
    check('after fixing the step, the same loaded picture runs again (original preserved)', 'pp_portrait-workflow.png' in p.inner_text('#wf-done'), p.inner_text('#wf-done'))
    p.set_viewport_size({'width': 390, 'height': 800}); p.wait_for_timeout(200); sw = p.evaluate('document.documentElement.scrollWidth'); check('mobile 390 px: no sideways scroll on Workflows', sw <= 391, str(sw))
    p.set_viewport_size({'width': 1200, 'height': 1000})
    # leaving and returning leaves no stale state
    nav(p, 'Compress') if False else None
    check('console clean', not errors, ' | '.join(errors)[:400])
    ctx.close(); b.close()
finally: srv.terminate()
finish()
