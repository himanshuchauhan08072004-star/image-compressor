# Shrinkit — handoff for a new Claude chat

Paste the short prompt from the chat reply, upload this repo as a zip, then let the AI read this file first.

## What this is
Shrinkit: a browser-only image toolkit (nothing uploaded). Started as a single-file image compressor. Goal: "Tell Shrinkit what you need to do with your image and it handles the technical details." Owner: Himanshu Chauhan (trial project for Digital Heroes). Vanilla JS ES modules, Vite (dev-only), no UI framework, deployed as static site on Vercel.

## Owner's rules (keep following these)
- Small controlled phases. Do not start the next phase until the current one is complete and reviewed.
- Reuse existing architecture. No redesign. No unnecessary dependencies.
- Keep processing logic (src/core) separate from UI (src/app).
- Preserve limits: 100 MB file, 100 MP input, 40 MP / 16384 px output, 16 px min crop.
- No new feature phases until the owner asks.
- Never claim browsers were tested unless actually tested. Only Chromium is available here (Playwright). Safari/Firefox are UNTESTED.
- Never claim success/safety beyond what is verified (e.g. never say "all metadata removed"; say what was checked).
- Do not stop to ask between implementation steps unless genuinely blocked.
- Final report format: files created/modified, features, tests actually executed + results, known limitations, remaining security/performance concerns.
- Owner likes terse "caveman" style replies (short fragments, no filler).

## Commands
```
npm install
npm run dev            # dev server
npm test               # unit tests (node:test), currently 254 (one fixture-dependent test is skipped until `python3 tests/e2e/make_fixtures.py` has run)
npm run build          # vite build -> dist/
python3 tests/e2e/make_fixtures.py     # generate fixtures (not committed)
python3 tests/e2e/run.py               # 78 e2e (Phase 0/1)
python3 tests/e2e/hardening.py         # 84 e2e (safety/compat/perf, pixel-exact crop/resize)
cd tests/e2e && python3 phase2_convert.py   # 34 e2e (Convert)
python3 phase2_metadata.py                  # 46 e2e (Remove Metadata, raw-byte marker search + PIL)
python3 phase2_blur.py                      # 46 e2e (Blur & Redact, pixel-exact)
python3 phase3_batch.py                     # 74 e2e (Batch: ZIP checked with Python zipfile/PIL)
python3 phase4_passport.py                  # 72 e2e (Passport + PDF: pypdf/pypdfium2 render checks)
```
E2E needs python3 + playwright + pillow; it serves dist/ with the real vercel.json CSP via tests/e2e/serve.mjs. Run `npm run build` before e2e.

## Architecture (reuse this)
```
src/core/   pure image logic, no UI
  geometry.js   planOutput(sw,sh,{crop,resize}) -> draw plan; limits enforced here; resizeRect/moveRect/fitAspectRect
  render.js     renderPlan(bitmap, plan, {flatten, background}) -> canvas (halving downscale; big-canvas probe)
  encode.js     encodeCanvas, supportsEncode (probes bytes, not just blob.type)
  verify.js     assertEncodedAs(blob, mime): magic-byte check of produced file
  solve.js      fitToBytes: target-KB search (few encodes, skips full-size encode for tiny targets)
  pipeline.js   runPipeline(decoded, recipe, {isCancelled, hintBytes}) -> {blob,width,height,mime,report} | {blocked}
  decode.js     inspectImage (header checks BEFORE decoding) + decodeImage (orientation fallback)
  dimensions.js header parser: width/height/EXIF orientation/alpha for PNG/JPEG/WebP (pure)
  sniff.js, validate.js, limits.js, errors.js (ImageError with userMessage), color.js (hex validation)
  summary.js    result labels/notes for the UI
  metadata.js   inspectMetadata / stripMetadata (lossless whitelist) / verifyMetadata (wired into pipeline + /remove-metadata)
  zip.js / batch.js / batchjob.js   Phase 3 batch core (see Status)
  redact.js     normalizeRegion(s), regionToOutput (outward rounding), pixelateRGBA/boxBlurRGBA (pure), applyRegions (canvas)
  filebytes.js  (NEW) cached File -> Uint8Array
src/app/
  session.js    createSession(): one image + one recipe shared by all tools; stale-load guard; setSuffix (download-name suffix, no re-run)
  processor.js  re-runs pipeline on recipe change (debounced, cancellable)
  registry.js   all tools (ready + planned); only ready+load() are routable
  router.js, app.js (shell), dom.js (h() safe builder)
  components/   dropzone, result-view, output-panel (shared format/quality/target/download), edits-bar
  tools/        compress, resize, crop, convert  — each: default export { mount(el,{session}) -> dispose }
```
Recipe shape: `{ crop, resize, strip, regions, output:{mime,mode:'quality'|'target',quality,targetKB,background} }`. Coordinates are in the already-upright bitmap (EXIF applied at decode). Tools share one recipe; edits show as chips in the edits bar.

## Status
- Phases 0-3 DONE (compress, resize, crop, convert, remove metadata, blur/redact, batch + ZIP). See earlier notes in this file's history.
- Phase 5.1 (Signature Cleaner): NOT part of this build. Registry entry is still 'planned'; no signature code exists here.
- Phase 4 (Passport Photo + print sheet): DONE, pending owner review.
  - Route /photo/passport (uses the shared single-image session). Core (pure, unit-tested): src/core/passport.js (mm<->px, validateSpec with existing limits, computeCrop from zoom+centre, outputPlan = never upscales), src/core/sheet.js (A4 grid, margins, spacing, extra pages), src/core/pdf.js (dependency-free PDF writer: one DCT JPEG drawn at physical size; validatePdf self-check). UI: src/app/tools/passport.js, src/app/components/sheet-panel.js.
  - pipeline.js: new optional `recipe.output.flatten` (solid fill under transparent pixels for any format; JPEG always flattens).
  - Passport tool sets recipe.crop/resize/output.flatten and bumps quality to 90 while open; on leave it clears flatten and restores quality (crop/resize stay, visible as edit chips).
  - "White fill" only fills transparent pixels; it does NOT remove a photographed background. No face detection, no segmentation, no compliance claims.
  - PDF always embeds a JPEG (q95) regardless of the chosen photo format. Pixel size is the real crop size when the photo is too small (physical size in the PDF stays as chosen).
- Test status: unit 124/124, run.py 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, build OK. Chromium only.
- hardening.py: NOT runnable from this repo (fixtures its generator never creates); fails identically on the untouched Phase-2 WIP zip.

## Known limitations / concerns
- Chromium only tested. Safari/Firefox untested; compatibility code (orientation fallback, WEBP probe, big-canvas probe) verified only by simulation in Chromium.
- Header checks are robustness guards, not a security boundary; the browser decoder still parses the file. 100 MP input = ~400 MB bitmap, risky on phones.
- Output cap 40 MP means a 48 MP photo cannot go through Compress as-is (use Resize/Crop). Kept on purpose.
- Orientation fallback only detects rotations that swap width/height on non-square photos.
- Target-KB search runs on the main thread (no Web Worker yet). A worker plan exists: OffscreenCanvas in render/encode, pipeline in a module worker, cancel via terminate, CSP worker-src 'self'.
- Metadata whitelist removal verifies only the categories listed in metadata.js CHECKED, not "every possible metadata".
- Passport: no ICC/DPI metadata is written into the exported photo file (canvas export); physical size lives in the PDF. Safari/Firefox and touch on the crop editor untested. A4 only.
- Batch: queue lives in memory only; leaving the tab/tool (or reloading) discards it. Results are held in memory until cleared.
- Batch: PNG outputs are re-encoded by the browser's canvas encoder and can be LARGER than an optimised source PNG (the row shows +N%). Same behaviour as the single Compress tool.
- Batch: images over 40 MP get no thumbnail (decoding just to preview is skipped).
- Batch: tested only with headless Chromium; timings in this sandbox say nothing about phones or very large batches. Safari/Firefox, touch and real 50-image/500 MB processing runs are untested.
- Batch: the ZIP is built in memory (Blob parts); the 1 GiB cap is a guard, not a tested ceiling.
- Blur/pixelate can be partly reversible on small text/faces; UI says so and recommends Solid.
- Rebuild mode: Chromium canvas export may embed a colour profile; it is reported as present (not personal data), not counted as a leak.
- Touch: drawing on the picture is mouse/pen only (stage keeps vertical page scroll); touch users use Add region then drag the box. Touch behaviour of the new editor was NOT tested.
- Lossless check re-decodes the output once (extra bitmap, up to the 40 MP output cap).

## Test-writing gotchas learned
- A Download click scrolls the page: scroll to top before mouse drags. Playwright drops mouse events at negative coordinates.
- Several `.seg` groups and `.tool-hint` elements exist; scope selectors (`[aria-label="Output format"]`, `.tool-hint:not([role])`, `button:text-is("…")`).
- `inner_text` applies CSS uppercase; use `all_text_contents` for nav.
- Recipe edits persist across tools; remove chips (`[aria-label^="Remove Resize"]`) before testing another tool.
- Use lossless PNG fixtures for exact pixel assertions; JPEG needs tolerance.
- Wait helper: sleep 350 ms then wait until `[data-r=barLabel]` is not "processing…".

---

## Phase 5.1: Signature Cleaner (implemented)

Route `/signature`, nav + home card. Status: working and tested. Phases 5.2-5.4 are NOT started.

**How it works.** Dark ink on light paper. Per pixel: grey, flatten uneven paper (block 90th-percentile background map), white point, brightness, contrast (pivot = light grey so pale ink gets stronger), ink-darkness curve, soft threshold ramp -> alpha 0..255. Small faint blobs (8-connected, no solid-ink pixel, below a size set by the Noise slider) are removed; thin strokes, dots and disconnected parts are kept. Ink colour: detected from solid strokes, black, blue or custom. Transparent PNG = ink colour + real alpha. White PNG/JPG = strokes composited on opaque white.

**Architecture.** `src/core/signature.js` (pure maths, Node-testable), `src/core/signature-render.js` (canvas glue: live preview at <=1400 px, full-detail export of the crop, read-back check of the written PNG), `src/app/tools/signature.js` (UI). Registry entry has `ownView: true`: it uses the shared session (upload, decode, limits) but not the shared Before/After + output panel. `session.setSuspended()` + processor changes pause the compress pipeline while this tool is open and resume it on leaving. `render.js`: `drawScaled` and `assertCanvasBacked` are now exported (no behaviour change).

**Limits / behaviour.** Crop processed 1:1 up to 12 MP, larger crops reduced first (UI says so). No enlarging unless "Allow enlarging". Output uses the app-wide MAX_SIDE / MAX_OUTPUT_PIXELS. Padding 0-500 px is inside the final size. Ignores any crop/resize set in other tools (works on the whole uploaded image). No Web Worker: measured 12 MP photo, first full result 1.3 s, slider repaint 48-60 ms (headless Chromium, this machine).

**Known limitations.** Dark ink on light paper only (white ink on dark paper unsupported). Dark specks the size of a real dot are kept on purpose. Presets are tuned on synthetic fixtures plus one generated photo, not a collection of real signatures. Final file is rebuilt 0.6 s after the last change. Transparency percentage in the UI is sampled (<=1024 px). Safari/Firefox/touch not tested (mobile layout checked only in Chromium emulation). Visual polish was not reviewed by eye by the author of this change, only by layout assertions.

**Tests actually run.** `npm test`: final run 152 tests, 152 pass, 0 fail (one conditional test was skipped on earlier runs before `dist/` existed; baseline before my changes was 123 pass + 1 skipped) (28 new in `tests/signature.test.js`). `npm run build`: ok. E2E (Chromium): `phase5_signature.py` 52/52 (new, verifies downloaded files with Pillow), `run.py` 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72. `hardening.py` still fails: fixtures `photo24.jpg` / `photo50.jpg` are missing (pre-existing, not touched).

**Existing tests edited:** `tests/app.test.js` (ready-tool list + `/signature` route), `tests/e2e/run.py` and `phase4_passport.py` (9 tools instead of 8). `package.json` `test:e2e` now also runs `phase5_signature.py`.

**Files.** New: `src/core/signature.js`, `src/core/signature-render.js`, `src/app/tools/signature.js`, `tests/signature.test.js`, `tests/e2e/phase5_signature.py`. Modified: `src/app/registry.js`, `src/app/app.js`, `src/app/session.js`, `src/app/processor.js`, `src/core/render.js`, `src/styles.css`, `package.json`, the tests above, this file.

---

## Phase 5.2: Watermark Studio (implemented)

Route `/watermark`, nav + home card. Status: working and tested. Phases 5.3 and 5.4 are in the next two sections.

**Features.** Text watermark (font Sans/Serif/Mono, bold, colour, optional contrasting outline, up to 3 lines / 200 chars) or logo watermark (JPG/PNG/WEBP, reduced to 2048 px, never enlarged by us). Size (% of image width), opacity, rotation, single mark at one of 9 anchors with margin, or tiled/repeated (spacing %, optional brick offset, rotates with the mark). Presets: Copyright corner, Diagonal tiled, Centre stamp, Logo corner. Watermarked / Original / Compare preview. Save one image (keep format, JPG, PNG, WEBP). Batch: same watermark applied to the current image plus any added images, one ZIP (reuses `createRunner`, `checkLimits`, `uniqueName`, `buildZip` from Phase 3).

**Architecture.** `src/core/watermark.js` (pure: params, mark size, placement for single and tiled), `src/core/watermark-render.js` (canvas: draws the mark once on its own canvas, stamps it with one global opacity so overlaps/outline never double-darken; preview; full-resolution export), `src/app/tools/watermark.js` (UI). Registry `ownView: true` like Signature Cleaner (shared session for upload/decode, own preview/export; the compress pipeline is paused while open). Reuses the `.sig-*` preview CSS; only `.wm-*` styles are new.

**Behaviour to know.** Output is the image at its own size, re-encoded (metadata such as camera/location is NOT kept). JPG output is flattened on white; PNG/WEBP keep source transparency. Images over 40 MP are refused with a message (Resize first). Tiled layouts over 1500 copies are refused with a message. Size and margin are relative, so a batch of different image sizes gets a proportional watermark. Batch limits are the Phase 3 ones (50 files, 500 MB). The preview is drawn at <=1400 px; the saved file at full size, with the same relative layout.

**Known limitations.** Fonts are the device's own (Sans/Serif/Mono stacks), so text looks slightly different per OS. No drag-to-place on the preview (9 anchors + margin only). No SVG logos. Not tested in Safari/Firefox or on real touch devices. Batch results are held in memory until the ZIP is built (same as Phase 3). Watermarks are visible marks only: they can be cropped or painted out, and this tool does not claim to prevent that. Orientation: decoding already applies EXIF rotation, so the watermark lands on the upright picture.

**Tests actually run.** `npm test`: 163 tests, 163 pass, 0 fail (11 new in `tests/watermark.test.js`: params, text sanitising, all 9 anchors, rotated bounds, tile coverage/stagger/cap, notes). `npm run build`: ok. E2E (Chromium, pixel checks with Pillow/numpy against the untouched original): `phase5_watermark.py` 41/41 (corner placement, bytes unchanged outside the mark, opacity 100/30/0, all 9 positions, size ratio, rotation, tiled in 4 quadrants, too-many refusal, empty text, compare view, Unicode, HTML text drawn as text, logo + transparent logo area + invalid logo, JPG/WEBP/keep formats, transparent PNG source, batch ZIP of 4 incl. duplicate name + rejected file, mobile overflow, no console errors). Re-run after this change: `run.py` 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, phase5_signature 52/52. `hardening.py` still fails on missing fixtures `photo24.jpg` / `photo50.jpg` (pre-existing).

**Existing files edited:** `registry.js` (planned entry replaced), `styles.css`, `package.json` (`test:e2e`), `tests/app.test.js`, `tests/e2e/run.py`, `tests/e2e/phase4_passport.py` (10 tools now). New: `src/core/watermark.js`, `src/core/watermark-render.js`, `src/app/tools/watermark.js`, `tests/watermark.test.js`, `tests/e2e/phase5_watermark.py`.

---

## Phase 5.3: Smart Enhancement (implemented)

Route `/enhance`, nav + home card, `ownView: true`. Plain filters, NOT AI. Working and tested.

**Features.** Brightness, contrast, colour (saturation), warmth, sharpness, noise reduction, Auto levels (black/white points from the 0.5/99.5 % luminance percentiles; the stretch is capped at ~2.3x so grain and colour casts are not blown up). Presets: Auto fix, Vivid photo, Dark photo, Document, Warmer. Enhanced / Original / Compare preview. Save as keep/JPG/PNG/WEBP at the original size (re-encoded, so metadata is dropped). Alpha is never touched.

**Architecture.** `src/core/enhance.js` (pure: normalize, autoLevels, curves, edge-preserving denoise (3x3, or 5x5 above 55), luminance-only unsharp mask, applyEnhance, notes), `src/core/enhance-render.js` (canvas glue, preview <=1400 px, full export, 40 MP cap), `src/app/tools/enhance.js` (UI, reuses `.sig-*` CSS). Order: denoise -> levels/brightness/contrast/warmth (per-channel curves) -> saturation -> sharpen. Sharpen radius scales with image size so preview and file look alike.

**Not built (on purpose).** No batch/ZIP for enhancement (Watermark has it; same runner can be reused later). No histogram, no curves editor, no red-eye, no face logic.

**Limits.** Noise reduction is a plain bilateral filter: it smooths grain, it does not restore detail. Full export of a 12 MP photo with every filter on took 2.2 s in headless Chromium here; a phone will be slower. Whole image is processed in memory (up to the 40 MP cap, ~160 MB RGBA plus working copies): risky on phones near the cap.

## Phase 5.4: Background Remover (implemented, colour based, NOT a model)

Route `/background`, nav + home card, `ownView: true`. Working and tested, but read the limits.

**Decision: no model shipped.** Evaluated here: `@imgly/background-removal-data` is 221 MB unpacked and licensed under its own LICENSE.md (check it before any commercial use); `@huggingface/transformers` (Apache-2.0) needs a model file from a CDN/hub, which this sandbox cannot reach (only npm/github/pypi are allowed), so no model could be downloaded, measured or tested. A CDN download at runtime would also break the app's `connect-src 'self'` CSP and the "nothing leaves your device" promise unless the model is self-hosted. So 5.4 ships a plain-colour remover. A real model remains an open, separate decision (size, speed, licence, WASM/worker CSP changes: `worker-src`, `'wasm-unsafe-eval'`).

**How it works.** Background colour(s) estimated from the border ring (median, plus a second cluster if 15 %+ of the border differs), or picked by clicking the picture / colour input. Pixels within Tolerance of the background colour that are connected to the border are removed ("Only outside the subject") or all such pixels ("Everywhere", for paper/scan holes). Soft ramp for near-background colours, an edge matting step (anti-aliased subject edge pixels are un-mixed from the background colour, so no pale halo), specks removal (islands smaller than a % of the image, largest kept), edge softness (alpha blur), fill: transparent / white / colour. Output PNG/WEBP transparent or JPG (always filled; white unless a colour is chosen). Pictures over 12 MP are reduced to 12 MP first (status says so); over 40 MP refused.

**Architecture.** `src/core/background.js` (pure), `src/core/background-render.js` (canvas glue, `pixelAt`, export), `src/app/tools/background.js` (UI). Reuses `previewBase` from enhance-render and `boxBlurGray` from enhance.js.

**Known limitations.** Plain/even backgrounds only. Does NOT separate a person from a busy scene, hair/fur strands, glass, shadows on the floor that differ in colour from the wall (use the Soft shadows preset or click the shadow), or a subject whose colour matches the background (a white shirt on a white wall will be eaten in "Everywhere" mode and may leak in edge mode when the colours touch). No brush to erase/restore by hand. A uniform tolerance is used, so uneven lighting needs a higher tolerance (and may then eat pale subject parts). Not tested in Safari/Firefox or on touch devices; click-to-pick uses a click, which works with touch taps but was only tested with a mouse.

## Test status after 5.3 + 5.4 (Chromium only)
unit 185/185; `npm run build` ok; run.py 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, phase5_signature 52/52, phase5_watermark 41/41, phase5_enhance 29/29, phase5_background 37/37. hardening.py still fails on missing fixtures photo24.jpg / photo50.jpg (pre-existing, not touched).

## Fixed while reviewing by eye
Screenshots of the three own-view tools showed the file name and every slider label were dark text on the dark panel (invisible). Fixed with one rule, `.sig-root{color:var(--paper)}`, so Signature Cleaner and Watermark Studio benefit too. Layout and visuals were reviewed on screenshots of Smart Enhancement and Background Remover only; Signature/Watermark were not re-reviewed beyond this colour fix.

**Existing files edited in 5.3/5.4:** `registry.js` (two planned entries became ready), `styles.css`, `package.json` (`test:e2e`), `tests/app.test.js`, `tests/e2e/run.py` and `phase4_passport.py` (12 tools now), `core/enhance.js` exports `boxBlurGray` for reuse. New: `core/enhance*.js`, `core/background*.js`, `app/tools/enhance.js`, `app/tools/background.js`, `tests/enhance.test.js`, `tests/background.test.js`, `tests/e2e/phase5_enhance.py`, `tests/e2e/phase5_background.py`.

---

## Phase 6: HEIC/HEIF input (implemented)

Decoder: `libheif-js` 1.19.8 (libheif + libde265 as WebAssembly, wasm embedded in `libheif-bundle.mjs`). Loaded by dynamic import ONLY when a HEIC file is opened (separate lazy chunk, ~1.46 MB, ~524 KB gzip). **Licence: LGPL-3.0** (owner must accept this before commercial release; it ships as its own chunk so it can be replaced). `vercel.json` CSP: `script-src 'self' 'wasm-unsafe-eval'` (needed for wasm; nothing else loosened).

**Design.** One decoded-image shape for every tool: `decodeImage(file)` returns `{ bitmap, width, height, kind:{type:'heic',mime:'image/heic'}, hasAlpha }`, so no tool has its own HEIC engine.
- `core/sniff.js`: ftyp major + compatible brands (heic/heix/hevc/hevx/heim/heis, generic mif1/msf1 -> 'heic'; avif stays unsupported). Bytes decide, never name/MIME. A file NAMED .heic/.heif (or MIME image/hei*) whose bytes are not an image gets a specific error.
- `core/heic.js` (pure): `parseHeicHeader` reads primary-item size from the `meta` box (pitm, ipma, ispe, clap, irot) without wasm; `keepMime(kind)` (HEIC "keep format" = JPG); `claimsHeic`.
- `core/heic-decoder.js`: lazy loader (injectable for tests), strictly serial decodes, `peekHeic` (size without pixels), `decodeHeicPixels` (primary image only; MAX_PIXELS checked on decoder-reported size BEFORE the RGBA buffer is allocated; alpha detected by scanning; handles freed; module dropped after a failed decode).
- `core/decode.js`: `inspectImage` = header guard (reads only the meta box, not the whole file); if header cannot tell, asks decoder for size (no pixels). `decodeImage` -> RGBA -> one `ImageBitmap`.
- `core/heic-preview.js` + `session.js`: `<img>` cannot show HEIC, so the Before preview is a <=2048 px JPG/PNG made from the bitmap (`makePreview` injectable). Both URLs revoked on clear/replace.
- Orientation: libheif applies irot/imir itself; orientation is treated as 1 and the EXIF fallback is skipped, so rotation is applied once. EXIF-only orientation tags in HEIC are ignored (HEIF spec: irot is authoritative).
- Output: browsers cannot write HEIC. "Keep format" = JPG everywhere (session default, batch, Enhance, Watermark). Convert offers JPG/PNG/WEBP (existing `supportsEncode` probe + `assertEncodedAs` byte check).
- Metadata tool: lossless is disabled for HEIC (explained); Rebuild is used. HEIC metadata is NOT listed/inspected; the rebuilt output is verified for the categories Shrinkit knows. `runLossless` also refuses HEIC (`strip-heic`).
- Batch: HEIC/HEIF accepted, each file inspected independently, bad ones listed with their own error; thumbnails for HEIC go through the serial decoder; HEIC jobs count 3x pixels against `BATCH_PIXEL_BUDGET`; queued files do not pin their bytes (HEIC bytes are not cached). ZIP names unique via existing `uniqueName` (IMG.heic and IMG.heif both -> IMG-converted.png / IMG-converted (2).png). "Include originals" uses the `.heic` extension.
- Tools verified to open and use HEIC: Compress, Resize, Crop, Convert, Remove Metadata, Blur, Signature, Watermark, Enhance, Background, Passport, Batch (see tests for which were only smoke-loaded).

**Tests actually run (Chromium only).** `npm test` 195/195 (10 new in `tests/heic.test.js`). `npm run build` ok. E2E: new `phase6_heic.py` 36/36; run.py 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, phase5_signature 52/52, phase5_watermark 41/41, phase5_enhance 29/29, phase5_background 37/37. hardening.py not run (still missing photo24/photo50 fixtures).
**Real vs mock.** REAL HEIC files and the REAL libheif-js wasm are used in `tests/heic.test.js` (all decode/header/orientation/alpha/failure tests) and in `phase6_heic.py`. Fixtures in `tests/fixtures/heic/` were generated with pillow-heif 1.8.1 (libheif 1.23.6): landscape.heic, exif6.heic (EXIF tag 6, no irot), alpha.heic, square.heif; `irot.heic` = landscape.heic with an `irot` box added by hand (verified by Pillow and libheif: 48x64). Only ONE test uses mocks, and it is labelled `MOCKED decoder` (load failure, display failure, size limit before decode). Session preview test uses stubs.
**NOT tested:** real iPhone/Android HEIC (HDR, 10-bit, Display P3, grid/tiled, burst, Live Photo, depth maps), large HEIC (tens of MP) or phone memory, Safari/Firefox, touch, HEIC from other encoders (AVC/JPEG-coded HEIF), `.heic` with MIME `image/heic-sequence` animations. Passport/Signature/Watermark/Crop/Blur only smoke-loaded with HEIC (opened without error), not exported.

**Known limitations.**
- Decoding runs on the main thread (libheif is synchronous, mostly blocks the UI during decode). Worker not done: needs a module worker + `worker-src 'self'` CSP + build config. Decodes are serialized, so at most one at a time.
- 100 MP input limit kept, but a 100 MP HEIC needs ~400 MB RGBA in the wasm heap plus ~400 MB bitmap; expect failures on phones. A failed decode shows a generic "may be too large" message.
- Output is 8-bit sRGB: ICC / Display P3 / HDR / 10-bit are not honoured (colours may look slightly less saturated than Apple's viewer). Only the primary image is used (burst/Live Photo extras, depth, gain maps ignored).
- Not every HEIF variant is supported; failures say so.
- Batch row dimensions for HEIC come from the header (ispe/clap/irot); an odd file could differ from the final decoded size (the decode re-checks the real size).
- Browser support for converting to WEBP/JPEG/PNG still depends on `supportsEncode`; unavailable formats are disabled with a message.


## Phase 7: advanced print layouts and document workflows (implemented)
Entry points: **Print Layout** (`/print`, standalone) and **Document Workflows** (`/workflows`, standalone). The **Passport Photo** sheet panel was upgraded in place (same ids as Phase 4).

### One shared layout model (the key design point)
- `src/core/paper.js` paper sizes (A4, A5, US Letter, custom), mm/in conversion, limits (custom side 20-1200 mm). Portrait = short side is the width for EVERY paper; landscape swaps.
- `src/core/layout.js` `planLayout(settings)`: the ONLY place that computes positions (mm). Preview, PDF, `layoutSheet`, presets validation and workflows all use it. Deterministic row ("shelf") packing: left to right, new row when full, new page when no row fits; optional column/row limits, alignment, per-group "new row", manual overrides. It never clips: one photo too big = error; manual positions are clamped (with a warning); overlap/overflow go into `layout.problems` and block export (`exportable`). `checkItems()` re-verifies any layout independently. `moveItem()` = clamp + no-overlap + slide along one axis.
- `src/core/sheet.js` is now a thin wrapper (`layoutSheet`, same API/messages/output shape as Phase 4). A test compares it with the original grid formula over 300+ combinations, so A4 output is unchanged.
- `src/core/pdf.js` `buildPdf` now takes `images[]` (rect.image = index; old `jpeg` param still works and produces the same object numbering for one image) and `guides:'box'` (hairline outline exactly on each photo). `validatePdf` now checks EVERY photo's size/position (pt) against the layout, image sizes, page boxes and guide count. `src/core/sheet-export.js` = layout + images -> PDF -> self-check (refuses to offer a PDF that fails).
- `src/core/sheet-images.js` pure `planGroupImage` (centre cover-crop or contain-with-white, never enlarges, never stretches, stays in the 40 MP / 16384 px limits) + canvas `renderGroupJpeg` (JPEG q 90). In Passport mode the group that matches the passport shape embeds the exact q95 JPEG from the crop above (as in Phase 4).
- `src/app/components/sheet-panel.js` (`createSheetPanel({session, mode:'passport'|'standalone', setPhotoSize})`): paper/orientation/margin/spacing/copies on top; **Advanced layout** (custom paper + unit, separate H/V spacing, cols/rows, alignment, cutting guides, DPI, photo groups with own size/copies/picture/fit, up to 8 groups, up to 4 extra pictures, auto/manual mode, presets). Preview: page pager, printable-area outline, per-photo size label, red outline on problems, scale text ("about N% of real size; PDF is exactly W x H mm").
- Presets: `src/core/presets.js`. localStorage key `shrinkit.layoutPresets.v1` (falls back to in-memory if storage is blocked). Settings only (never pictures, file names or manual positions). `sanitizeSettings` upgrades old shapes (string paper, single `gap`, single photo size) and rejects bad values; corrupt JSON / damaged entries are skipped and reported; built-ins (5) cannot be renamed or deleted; max 30 saved, names <= 40 chars, unique.
- Workflows: `src/core/workflow.js` (pure: ops, validation, list editing, `runWorkflow`) + `src/core/workflow-exec.js` (canvas glue that calls the EXISTING services: `planOutput`/`renderPlan` for crop+resize, `stampWatermark`, `encodeCanvas`+`assertEncodedAs`, layout + PDF writer) + `src/app/tools/workflows.js`. Steps: Crop, Resize, Watermark (text), Convert, Print sheet (PDF). Rules: each at most once; Print sheet must be last and cannot be combined with Convert; Convert only picks the output format (encoded once at the end, so steps after it do not re-encode). Reorder (Up/Down), remove, add; two templates (Passport printing, Image preparation). 1-6 pictures (120 MP total budget); several pictures -> ZIP, or one PDF with a photo group per picture. A failed step stops the run, is shown as Failed with the picture name, later steps stay Waiting; inputs are never closed or changed (runner only releases working copies it made), so you can fix and re-run.

### Decisions / limitations (be honest about these)
- Packing is row-based only, in group order, no rotation. A different order can give a different (sometimes less dense) result. "Start each photo size on a new row" is optional.
- Manual placement: pointer drag, arrow keys (Shift = 5 mm), X/Y boxes, snap 0.5 mm; photos stay on the page they were auto-assigned to; positions are keyed per photo copy and are not saved in presets. Not tested on touch hardware (only mouse in Chromium).
- Margin is one value for all four sides. Photo size units are mm only (paper supports mm and in).
- Cutting guides = outline only (no crop marks).
- Photos taken from the passport "Current photo" at another shape use the already cropped result, so a much larger group gets fewer pixels (effective DPI is shown).
- The PDF embeds JPEG for every photo, whatever output format is chosen above. Physical size is checked in the PDF geometry (self-check + independent pypdf/pdfium checks in e2e). "Exact print size" still depends on the user printing at 100% / actual size.
- Workflows: text watermark only (no logo), one picture list (not per-picture settings), no branching. Print sheet in a workflow centre-crops pictures that do not have the photo shape (noted in the result).
- Not built (deliberately): free-form desktop-publishing placement, rotation, per-side margins, multi-page manual page assignment, saving workflows.

### Tests after Phase 7 (Chromium only; Firefox/Safari NOT tested)
- Unit: `npm test` = 254 pass (new: paper 7, layout 17, printpdf 10, presets 11, workflow 14).
- E2E `tests/e2e/phase7_print.py` 90/90 (real Chromium; PDFs read with pypdf and rendered with pypdfium2).
- Regression e2e re-run on the new build: run.py 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, phase5_signature 52/52, phase5_watermark 41/41, phase5_enhance 29/29, phase5_background 37/37, phase6_heic 36/36 (needs `pip install pillow-heif`).
- `tests/e2e/hardening.py` times out in THIS sandbox at its first "reject" case after the 110 MP case, on the untouched Phase 6 project too (same error), so it is an environment issue, not a Phase 7 regression; it was not re-verified here.
- Existing e2e assertions updated for the new tools: nav/home card counts 12 -> 14 (run.py, phase4_passport.py), nav list in run.py, registry order in tests/app.test.js.

---

## Phase 8: performance, reliability, compatibility, security review (implemented, owner review pending)

Scope rule kept: no new features, no rewrite. Chromium only (headless Playwright). Firefox, Safari, mobile, touch: NOT tested.

### Confirmed bugs fixed (each shown by a probe or failing test first)
- `safeBase` cut names at 80 UTF-16 units (lone surrogate -> U+FFFD in ZIP names) and kept bidi-override / zero-width characters. Now by code point, invisible chars stripped.
- Workflow errors showed raw `Error.message`. New `userMessageOf()` (errors.js): only our own `userMessage` is shown, else a generic text. One existing workflow test was edited for this.
- Workflow step that reports `code:'cancelled'` (sheet step) was shown as Failed; now Cancelled.
- Canvas leaks on failure: `renderPlan`, `drawScaled`, enhance/watermark/background `canvasOf`, signature `makeCanvas`, `applyOrientation`, `blurBox`, watermark text probe. New shared `makeCanvas()` in render.js (checked canvas, released if refused).
- App shell: a tool chunk that fails to load (offline, stale tab after deploy) left a blank page; a tool throwing in `mount` broke the shell. Now message + Reload button (`#reload-tool`).
- Dropzone: no busy state, parallel opens. Now "Opening your image..." + one at a time, always cleared (`finally`). A failed open keeps the previous image.
- `validateFile` accepted `size: NaN`/Infinity/negative.
- Batch: every HEIC row did a FULL wasm decode on the main thread just for a thumbnail, then decoded again when processed. Now placeholder "HEIC", thumbnail made from the processed result.
- ZIP: `buildZip` now rejects unsafe entry names (`isSafeEntryName`); `verifyZip(zip, entries)` checks end record, central directory, names, order, sizes, offsets, local headers before any download (Batch + Workflows). It does NOT recompute CRCs (tests + e2e do). Workflows ZIP button guarded against double click. CRC-32 is now slice-by-8.
- HEIC: wasm heap never shrinks. Module is dropped after a decode >= `HEIC_RELEASE_PIXELS` (16 MP) and rebuilt next time.
- `vercel.json`: added `Permissions-Policy` (camera, microphone, geolocation, payment, usb denied). Restrictive only; not verified on a live Vercel deploy. CSP unchanged.

### Measurements (all real, all small; see `bench/`)
Fixtures: `python3 bench/make_fixtures.py` (needs pillow, numpy, pillow-heif; output git-ignored).
- Node, CRC-32 over 64 MiB: old byte loop 374 MiB/s -> slice-by-8 814 MiB/s (prototype measured; identical output, tested against `node:zlib.crc32`). `bench/measure-zip.mjs` was not re-run on the shipped code. buildZip 50 x 4 MiB Blobs: 762 ms (measured BEFORE the CRC change only).
- Node, real libheif-js, `bench/measure-heic.mjs` (`DROP=1` = release module after each decode): 12 MP decode 0.5-0.8 s, 24 MP 1.0-1.5 s. RSS after decode, module kept: ~210-220 MB (12 MP), ~377-385 MB (24 MP). Module dropped: ~117 MB and ~167 MB (one 24 MP sample read 350 MB: noisy). Cost of dropping: ~+0.25 s per decode at 12 MP. Node numbers, NOT browser.
- Chromium, `bench/measure-browser.py <dir> 3`, original Phase 7 build vs this build (medians): open 12 MP JPG 509 vs 509 ms; open 12 MP HEIC 1504 vs 1469 ms; batch 6 x 12 MP JPG resize to 1600 px 1332 vs 1253 ms; ZIP click->download 80 vs 116 ms. All differences are within run-to-run spread (e.g. 1470-2077 ms): NO browser speed-up is claimed. The long-task counter read 0 everywhere, so it is not a usable responsiveness proxy here (headless; not investigated).

### Tests actually run (Chromium only)
- `npm test`: 274 pass, 0 fail, 0 skipped (fixtures generated). Baseline was 254 (253 + 1 skipped). New `tests/phase8.test.js` (20 tests), each tagged `[unit]`, `[real]` (real libheif-js wasm, real HEIC files, `node:zlib` CRC oracle) or `[mocked]` (fake `document`, cleanup only; NOT a browser).
- `npm run build`: ok.
- E2E on the new build: run.py 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, phase5_signature 52/52, phase5_watermark 41/41, phase5_enhance 29/29, phase5_background 37/37, phase6_heic 36/36, phase7_print 90/90, NEW phase8_reliability 18/18 (header checks, bad file message + busy cleared, chunk-load failure, HEIC placeholder/thumbnail, ZIP via Python `zipfile.testzip`, duplicate/hostile names, no request to another origin, no console errors).
- `hardening.py`: still fails here (`Page.set_input_files` timeout at its first reject case after the 110 MP case; same as Phase 7 notes). Not investigated; environment limit suspected, NOT verified.
- Added to `package.json` `test:e2e`: NOT done yet; run `cd tests/e2e && python3 phase8_reliability.py` by hand (or append it).

### Not done / known limits
- No Web Worker. Rendering code builds canvases via `document` in ~10 files (OffscreenCanvas port = large change). HEIC decode is the one contained candidate: still blocks the main thread (0.5-1.5 s per 12-24 MP in Node). Worker CSP would already be covered by `script-src 'self'` (worker-src falls back) but was not tried. `terminate()` of a worker would also free the wasm heap.
- No streaming ZIP (Blob parts, one file read at a time for CRC; whole ZIP still in memory/blob store). Peak browser memory not measured.
- Cancel still cannot interrupt a running decode/encode (UI text says so).
- HEIC with an unknown header still reads the file twice (peek + decode). 100 MP HEIC still needs ~2x400 MB.
- Not reviewed in this phase: `pdf.js`, `sheet-export.js`, Passport flow internals, metadata-removal correctness beyond existing tests.
- Source grep found no fetch/XHR/eval/WebSocket; `innerHTML` only with static strings. This is source inspection plus one e2e network check, NOT a security audit. Header inspection remains a robustness guard, not a boundary.
- Licence: libheif-js is LGPL-3.0 (ships as its own lazy chunk). No legal review done; get one before commercial distribution.
- Outstanding browser matrix: Firefox, Safari (desktop + iOS), Android Chrome, touch; HEIC from real phones (HDR, 10-bit, grid, Live Photo); large HEIC on phones; Vercel header check on the live site.


---

## Phase 9: premium UI/UX transformation

**Scope.** Whole-app visual redesign; processing engine, limits and tool logic untouched. Class names and ids used by tools/e2e were kept, so tools were re-themed through CSS, not rewritten.

**Identity.** Ink-black/charcoal dark theme and a separately authored cool-paper light theme. Accent: electric violet to cool blue, used only on primary buttons, progress, focus/selection and one headline word. Fonts unchanged (Archivo / Inter / JetBrains Mono, already bundled). Logo: four converging corner brackets around a centre square (`logoMark` in `src/app/icons.js`).

**Design system.** `src/styles/tokens.css` (all colours, type scale, 4px spacing scale, radii, motion; both themes), `base.css` (controls, header, nav, palette, pages, footer, motion, reduced-motion), `tool.css` (every tool surface). No hardcoded colours outside tokens except image-overlay shades and the white paper preview. `src/styles.css` just imports the three.

**Theme.** `public/theme-init.js` (external, blocking, CSP-safe) sets `data-theme` before first paint; `src/app/theme.js` + `theme-logic.js` handle toggle, persistence (`localStorage` key `shrinkit.theme`, failure-tolerant) and live system-preference following until the user chooses. Keep `resolveTheme` in both places in sync.

**Navigation.** `components/site-header.js`: brand, search palette (native `<dialog>`, `/` or Ctrl/Cmd+K, arrow keys, Enter), theme button, "All tools", mobile menu. ONE `#toolNav` element: tab strip under the header on desktop, drawer on <900px. Tools are grouped (Image, Privacy, Batch, Documents, Enhance) via new registry fields `group`, `icon`, `popular`, `keywords`, `short`; `GROUPS` exported from `registry.js`. Nav order is now grouped (e2e updated).

**Pages.** `pages/home.js` (hero + real upload via the existing `createDropzone`/session, quick links, all tools by group, workflow, privacy facts, capabilities), `pages/tools-page.js` (new route `/tools`: search, category filter, empty state; `pendingGroup` lets home category links pre-filter), `components/hero-demo.js` (draws a procedural sample and really encodes it at JPG Q95 and Q25; sizes shown are real blob sizes; hidden if encoding fails; object URLs revoked on leave). Tool pages get `components/page-header.js` (breadcrumb + h1) and shared `components/tool-card.js`. `site-footer.js` replaces the old footer markup (author/email/Digital Heroes link preserved).

**Other changes.** Dropzone: new look, format and limit text, drag feedback ("Release to open"), busy state. Result view: checkerboard only when transparency is real (`hasAlpha`). `app.js`: new `PAGES` table, `body[data-page]`, scroll-to-top + focus on `main` on navigation, document titles.

**Dependencies.** None added (hand-drawn SVG icon set, CSS-only motion).

**Tests actually run (this environment, Chromium 141).** `npm test` 281/281 (8 new in `tests/phase9.test.js`: registry groups/icons, search ranking/filtering/odd input, theme rules). `npm run build` ok. E2E: run.py 78/78, phase2_convert 34/34, phase2_metadata 46/46, phase2_blur 46/46, phase3_batch 74/74, phase4_passport 72/72, phase5_signature 52/52, phase5_watermark 41/41, phase5_enhance 29/29, phase5_background 37/37, phase6_heic 36/36, phase7_print 90/90, phase8_reliability 18/18, **phase9_ui 42/42 (new: theme persistence/no-flash, hero demo real sizes, invalid-file error, upload-to-tool, drag state, palette keyboard flow, directory search/filter/empty/clear, home category link, skip link, unknown route, 375px overflow on 4 routes, mobile menu, touch target size, reduced motion, same-origin-only requests, no console errors)**. `hardening.py` still not runnable (missing fixtures; pre-existing, see Phase 8 notes).
Edited existing e2e (documented): nav order assertion (grouped), mobile crop test opens the menu first, crop-handle drag scrolls the handle into view.

**Contrast.** Token pairs computed against WCAG: text and accent-text pairs >= 4.5:1 in both themes after adjusting `--fg-3` and light `--success`. White-on-gradient button text 4.86:1 minimum. Not audited: every runtime combination (e.g. text over user images).

**Known limitations / manual checks still needed.** Only Chromium was tested; Safari/Firefox untested (`color-mix`, `backdrop-filter`, `dialog` need modern versions). No real-device touch or screen-reader (NVDA/VoiceOver) pass; focus order and announcements are by construction plus automated checks only. Light/dark screenshots were reviewed for home, /compress, /watermark, /crop, /remove-metadata; the other tools were verified functionally by e2e but not eyeballed in both themes. Desktop nav strip scrolls horizontally with a fade (14 tools). Hero demo sizes depend on the synthetic sample; the caption says so. Phase 10 not started.
