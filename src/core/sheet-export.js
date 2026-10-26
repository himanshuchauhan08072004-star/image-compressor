import { ImageError } from './errors.js';
import { buildPdf, validatePdf, jpegInfo } from './pdf.js';

/** Layout (from planLayout) + one JPEG per photo group -> a PDF that has passed its own geometry check. */
export const pdfPagesFor = (layout) => layout.pages.map((page) => page.map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h, image: it.group })));

export async function exportSheetPdf({ layout, images, title = 'Shrinkit photo sheet' }) {
  if (!layout || !layout.ok) throw new ImageError('layout', (layout && layout.error) || 'There is no layout to export.');
  if (!layout.exportable) throw new ImageError('layout', layout.problems[0].message + ' Fix the layout before exporting.');
  if (!Array.isArray(images) || images.length !== layout.groups.length) throw new ImageError('pdf-image', 'Every photo group needs a picture before the PDF can be made.');
  const pages = pdfPagesFor(layout), infos = images.map((im) => jpegInfo(im.bytes));
  const blob = buildPdf({ pageMM: layout.page, pages, images, guides: layout.guides, title });
  const check = validatePdf(new Uint8Array(await blob.arrayBuffer()), { pageMM: layout.page, pages, images: infos.map((i) => ({ w: i.width, h: i.height })), guides: layout.guides });   // refuse to offer a PDF that fails its own check
  return { blob, check, infos };
}
