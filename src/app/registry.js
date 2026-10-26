/**
 * Every tool, present and planned. A tool is routable only when status === 'ready' and it has load().
 * Planned entries document the roadmap and keep ids/paths stable; they never show in the UI.
 * ownView: true = uses the shared single-image session (upload, decode, limits) but draws its own preview/export, so the shared Before/After + output panel are not mounted and the compress pipeline is paused.
 * standalone: true = the tool manages its own images (no shared single-image session), e.g. Batch.
 * A tool module's default export: { mount(el, { session }) -> dispose() }
 */
export const TOOLS = [
  { id: 'compress', path: '/compress', title: 'Compress', status: 'ready', category: 'optimize', group: 'image', icon: 'compress', popular: true, keywords: 'shrink reduce size kb target upload limit', short: 'Reduce file size by quality, or hit an exact size like 200 KB.',
    blurb: 'Shrink a photo to a quality you choose, or to an exact size like 200 KB.',
    hero: { a: 'Make the photo', b: 'fit the ', em: 'limit.' },
    load: () => import('./tools/compress.js') },
  { id: 'resize', path: '/resize', title: 'Resize', status: 'ready', category: 'resize-crop', group: 'image', icon: 'resize', popular: true, keywords: 'dimensions width height pixels scale', short: 'Set exact pixel dimensions. Never enlarges unless you allow it.',
    blurb: 'Set width and height, or an exact size like 1080 × 1080. Never enlarges unless you say so.',
    hero: { a: 'Get the size', b: '', em: 'exactly right.' },
    load: () => import('./tools/resize.js') },
  { id: 'crop', path: '/crop', title: 'Crop', status: 'ready', category: 'resize-crop', group: 'image', icon: 'crop', popular: false, keywords: 'cut trim aspect ratio 1:1 4:5 16:9', short: 'Free crop, or snap to 1:1, 4:5, 16:9 and more.',
    blurb: 'Free crop, or snap to common shapes like 1:1, 4:5 and 16:9.',
    hero: { a: 'Cut the photo', b: 'to the ', em: 'shape you need.' },
    load: () => import('./tools/crop.js') },
  { id: 'convert', path: '/convert', title: 'Convert', status: 'ready', category: 'convert', group: 'image', icon: 'convert', popular: true, keywords: 'format jpg png webp heic iphone', short: 'Switch between JPG, PNG and WEBP. Opens HEIC photos too.',
    blurb: 'Switch between JPG, PNG and WEBP, or turn HEIC photos into them. Transparent areas are handled for you.',
    hero: { a: 'Change the', b: 'file ', em: 'format.' },
    load: () => import('./tools/convert.js') },
  { id: 'metadata', path: '/remove-metadata', title: 'Remove Metadata', status: 'ready', category: 'privacy', group: 'privacy', icon: 'shield', popular: true, keywords: 'exif gps location camera strip privacy', short: 'See and remove location, camera and date data from a photo.',
    blurb: 'See what is hidden in a photo, like location, camera and date, and remove it without changing the picture.',
    hero: { a: 'Strip the', b: 'hidden ', em: 'details.' },
    load: () => import('./tools/metadata.js') },
  { id: 'blur', path: '/blur', title: 'Blur & Redact', status: 'ready', category: 'privacy', group: 'privacy', icon: 'blur', popular: false, keywords: 'redact pixelate face plate censor hide', short: 'Blur, pixelate or cover faces, plates and text.',
    blurb: 'Blur, pixelate or cover faces, plates and text. Draw boxes on the parts to protect.',
    hero: { a: 'Cover what', b: 'you must ', em: 'not show.' },
    load: () => import('./tools/blur.js') },
  { id: 'batch', path: '/batch', title: 'Batch Processing', status: 'ready', category: 'business', group: 'batch', icon: 'stack', popular: false, keywords: 'many folder zip bulk multiple', short: 'Process many images at once and download one ZIP.', standalone: true,
    blurb: 'Process many images at once: resize, convert, compress or clean them, then download one ZIP.',
    hero: { a: 'Do the whole', b: 'folder ', em: 'at once.' },
    load: () => import('./tools/batch.js') },

  { id: 'passport', path: '/photo/passport', title: 'Passport Photo', status: 'ready', category: 'document', group: 'documents', icon: 'id', popular: true, keywords: 'passport id visa photo mm print', short: 'Crop to a size in millimetres and print copies on a sheet.',
    blurb: 'Crop a photo to a chosen size in millimetres, then lay copies out on an A4 sheet and download a print-ready PDF.',
    hero: { a: 'Passport photos,', b: 'sized and ', em: 'print-ready.' },
    load: () => import('./tools/passport.js') },
  { id: 'signature', path: '/signature', title: 'Signature Cleaner', status: 'ready', category: 'document', group: 'enhance', icon: 'pen', popular: false, keywords: 'sign scan transparent ink paper', short: 'Turn a photographed signature into a clean transparent PNG.', ownView: true,
    blurb: 'Turn a photographed or scanned signature into a clean digital one. Remove the paper, keep the pen strokes, and save a transparent PNG or a white-background image.',
    hero: { a: 'A clean signature', b: 'from a ', em: 'photo of paper.' },
    load: () => import('./tools/signature.js') },
  { id: 'watermark', path: '/watermark', title: 'Watermark Studio', status: 'ready', category: 'business', group: 'enhance', icon: 'stamp', popular: false, keywords: 'logo copyright text overlay brand', short: 'Add a text or logo watermark, single or tiled, to many images.', ownView: true,
    blurb: 'Add a text or logo watermark to your pictures. Place it, resize it, rotate it, repeat it across the image, and apply it to many images at once.',
    hero: { a: 'Your name on every image', b: 'with a ', em: 'watermark.' },
    load: () => import('./tools/watermark.js') },

  { id: 'enhance', path: '/enhance', title: 'Smart Enhancement', status: 'ready', category: 'advanced', group: 'enhance', icon: 'wand', popular: false, keywords: 'brightness contrast sharpen colour fix filter', short: 'Brightness, contrast, colour, sharpness and grain, with compare.', ownView: true,
    blurb: 'Fix brightness, contrast, colour, sharpness and grain with plain filters. Compare before and after, then save.',
    hero: { a: 'Fix a dull photo', b: 'with ', em: 'a few sliders.' },
    load: () => import('./tools/enhance.js') },

  { id: 'background', path: '/background', title: 'Background Remover', status: 'ready', category: 'advanced', group: 'enhance', icon: 'layers', popular: true, keywords: 'remove cutout transparent subject', short: 'Remove a plain background. Best on even, uncluttered scenes.', ownView: true,
    blurb: 'Remove a plain background from a photo and save a transparent PNG, or swap in white or a colour. Works on even backgrounds, not busy scenes.',
    hero: { a: 'Lift the subject', b: 'off a plain ', em: 'background.' },
    load: () => import('./tools/background.js') },

  { id: 'print', path: '/print', title: 'Print Layout', status: 'ready', category: 'print', group: 'documents', icon: 'print', popular: false, keywords: 'a4 letter sheet pdf layout paper', short: 'Lay photos out on A4, A5 or Letter and export a true-size PDF.', standalone: true,
    blurb: 'Lay photos out on A4, A5, US Letter or your own paper size. Mix photo sizes, drag photos into place, save layouts and download a PDF at true physical size.',
    hero: { a: 'Photos on paper,', b: 'at their ', em: 'real size.' },
    load: () => import('./tools/print.js') },
  { id: 'workflows', path: '/workflows', title: 'Document Workflows', status: 'ready', category: 'business', group: 'batch', icon: 'flow', popular: false, keywords: 'chain steps pipeline automate pdf', short: 'Chain crop, resize, watermark, convert and print steps.', standalone: true,
    blurb: 'Chain crop, resize, watermark, convert and print-sheet steps in the order you choose, then run them on your pictures in one go.',
    hero: { a: 'Several steps,', b: 'one ', em: 'click.' },
    load: () => import('./tools/workflows.js') },

  // Planned. Not routable yet.
  { id: 'privacy', path: '/privacy', title: 'Privacy', status: 'planned', category: 'privacy' },
  { id: 'pdf', path: '/image-to-pdf', title: 'Image to PDF', status: 'planned', category: 'document' },
];

export const readyTools = () => TOOLS.filter((t) => t.status === 'ready' && typeof t.load === 'function');
export const toolByPath = (path) => readyTools().find((t) => t.path === path) || null;
/** Discovery groups used by the home page and /tools. Every tool belongs to exactly one. */
export const GROUPS = [
  { id: 'image', title: 'Image', blurb: 'Shrink, resize, crop and convert.' },
  { id: 'privacy', title: 'Privacy', blurb: 'Remove hidden data, cover what must not show.' },
  { id: 'batch', title: 'Batch', blurb: 'Many images, one run, one ZIP.' },
  { id: 'documents', title: 'Documents', blurb: 'Passport photos and print-ready PDF sheets.' },
  { id: 'enhance', title: 'Enhance', blurb: 'Clean signatures, watermarks, filters, plain backgrounds.' },
];
export const DEFAULT_TOOL_PATH = '/compress';
