# Shrinkit

Make a photo fit the limit. Image tools that run entirely in your browser: nothing is uploaded, nothing is stored.

Today: compress JPG / PNG / WEBP with a live before/after preview.
Direction: a practical image and document toolkit (resize, exact dimensions, target KB, presets, privacy tools, print layouts). Built in small phases.

## Develop

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (node:test, no extra deps)
npm run test:e2e   # real-Chromium end-to-end tests (needs python3 + playwright + pillow)
npm run build      # outputs dist/
```

## Tools

Compress (quality or target size, e.g. 100 KB), Resize (scale, exact size, fit modes, never enlarges unless allowed), Crop (free or aspect presets). One image and one recipe are shared across tools, so you can crop, then resize, then compress without re-uploading.

## Layout

```
index.html              shell markup
src/main.js             bootstrap
src/styles.css          styles
src/core/               image logic, no UI: geometry (crop/resize planner), solve (target size),
                        render, encode, pipeline, decode, sniff, validate, summary, limits
src/app/                shell: registry (all tools, ready + planned), router, session store,
                        processor, components/, tools/
tests/                  unit tests; tests/e2e = Chromium tests against the built site with real CSP
vercel.json             static deploy, SPA rewrite, strict CSP (no third-party requests)
```

Adding a tool: add an entry to `src/app/registry.js` and a module in `src/app/tools/` exporting `default { mount(el, { session }) }`. Geometry goes through `core/geometry.js`, output through `core/pipeline.js`.

## Privacy and safety: what is and is not claimed

- No image data is sent anywhere: the app has no upload code, and on the deployed site the CSP in `vercel.json` restricts the page to its own origin (scripts, styles, fonts, images, `fetch`/XHR). The CSP does not stop a user clicking an outbound link, and the local dev server does not send it.
- Re-encoding through `canvas` drops EXIF metadata (including location).
- Input checks (file size, header-reported dimensions read before decoding, 100 MP input cap, 40 MP / 16384 px output cap, magic-byte type check) protect the browser tab from accidents and oversized files. They are robustness guards, not a security boundary. There is no server-side processing, and the browser's own image decoder still does the real parsing.

## Browser support

Developed and tested in Chromium only (headless, via Playwright). Safari and Firefox have NOT been tested. Code paths written for them, verified only by simulation inside Chromium:

- `createImageBitmap` rejecting the `imageOrientation` option: retried without it; if the engine then ignores EXIF rotation on a non-square photo, the app rotates it itself (flips and 180 degree cases, and square images, cannot be detected this way).
- Browsers that cannot encode WEBP (some return PNG): detected up front with a 1x1 probe; the app switches to JPG with a note.
- Canvases the engine silently fails to back (very large on some mobile browsers): detected with a one-pixel readback; the app refuses instead of exporting a blank image.
- HEIC/AVIF/GIF/BMP: rejected with a specific message (no HEIC support yet).

## Status

Phase 0 and Phase 1 done (hardened). Phase 2 in progress: Convert done and tested; metadata-removal core written and unit-tested but not yet wired into the UI; region blur/redaction not started. See HANDOFF.md. Limits: 100 MB file, 100 MP input, 40 MP / 16384 px output.

## Built for

This project was built as part of a developer trial task for Digital Heroes ([digitalheroesco.com](https://digitalheroesco.com)).

## Author

Himanshu Chauhan — himanshuchauhan08072004@gmail.com
