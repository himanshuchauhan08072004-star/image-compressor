import { formatBytes, sizeDelta } from './format.js';
import { LABELS } from './metadata.js';

const fmtName = (mime) => (mime === 'image/jpeg' ? 'JPG' : mime.replace('image/', '').toUpperCase());

const list = (keys) => keys.map((k) => LABELS[k] || k).join('; ');

/** Plain-language notes about metadata. Claims only what was checked: never "all metadata removed". */
export function metadataNotes(report) {
  const n = [];
  if (report.mode === 'strip') {
    n.push(report.removed.length ? 'Removed from the file: ' + list(report.removed) + '.' : 'The original had none of the metadata types Shrinkit looks for.');
  } else if (report.rebuilt) {
    n.push('The image was redrawn from its pixels and saved again, so the original file’s metadata blocks were not copied. The picture is re-compressed.');
  }
  const v = report.verify;
  if (v) {
    n.push(v.clean ? 'Checked the new file for: ' + list(v.checked) + '. None found.' : 'Still present in the new file: ' + list(v.remaining) + '.');
    if (v.keptIcc) n.push(report.rebuilt ? 'The new file contains a colour profile (not personal data).' : 'Kept the colour profile (not personal data).');
  } else if (report.verifyError) n.push('Could not re-read the new file to check it, so do not assume it is clean.');
  if (report.keptRotationFlag) n.push('Kept the rotation flag so the photo still shows upright. It is not personal data.');
  return n;
}

/** Turn a finished result into the labels and notes the UI shows. Pure. */
export function summarize({ fileSize, blob, width, height, mime, report, hasGeometryEdits }) {
  const format = fmtName(mime);
  const delta = sizeDelta(fileSize, blob.size);
  const notes = [];
  let label;

  if (report.mode === 'strip') {
    label = format + ' · lossless clean-up · original quality kept';
  } else if (report.mode === 'target') {
    const t = formatBytes(report.targetBytes);
    label = format + ' · target ' + t + ' · quality ' + Math.round(report.quality * 100) + '%';
    if (report.scale < 0.995) label += ' · scaled to ' + Math.round(report.scale * 100) + '%';
    if (!report.reached) {
      notes.push('Could not get under ' + t + ' without shrinking the image to ' + width + ' × ' + height +
        '. Closest possible is ' + formatBytes(blob.size) + '. Try a larger target' + (mime === 'image/jpeg' ? ', or WEBP.' : '.'));
    } else if (report.scale < 0.995) {
      notes.push('To fit ' + t + ' the image was also scaled down to ' + width + ' × ' + height + '.');
    }
    if (!hasGeometryEdits && fileSize <= report.targetBytes) {
      notes.push('Your original is already under ' + t + '. You may not need to compress it.');
    }
  } else {
    label = format + (mime === 'image/png' ? ' · lossless' : ' · quality ' + report.quality + '%');
  }
  if (report.regions) notes.push(report.regions + (report.regions === 1 ? ' region was' : ' regions were') + ' blurred, pixelated or covered in the exported pixels. Check the file before sharing it.');
  if (report.mode === 'strip' || report.rebuilt || report.verifyError) notes.push(...metadataNotes(report));
  if (report.flattened) notes.push('JPG cannot store transparency, so transparent areas were filled with ' + report.flattened.color + '.');
  return {
    format, label, delta, notes,
    savedText: delta.smaller ? '−' + delta.magnitude + '% smaller' : 'no reduction at this setting',
    statSaved: (delta.smaller ? '−' : '+') + delta.magnitude + '%',
    dims: width + ' × ' + height,
  };
}
