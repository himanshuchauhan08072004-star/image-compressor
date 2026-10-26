function ascii(b, from, to) {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'];
const HEIF_GENERIC = ['mif1', 'msf1'];

/** Classify an ISO-BMFF 'ftyp' box by major + compatible brands. Returns a kind or null. */
function sniffFtyp(b) {
  const size = b[0] * 16777216 + (b[1] << 16) + (b[2] << 8) + b[3];
  const end = Math.min(b.length, size >= 16 ? size : 16);
  const brands = [ascii(b, 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, i + 4));
  if (brands.some((x) => HEIC_BRANDS.includes(x))) return { type: 'heic', mime: 'image/heic', animated: false };
  if (brands.some((x) => x === 'avif' || x === 'avis')) return { type: 'avif', mime: 'image/avif', animated: false };
  if (brands.some((x) => HEIF_GENERIC.includes(x))) return { type: 'heic', mime: 'image/heic', animated: false };   // generic HEIF; the decoder decides if it can read it
  return null;
}

/** Identify image by magic bytes. Pass first >=32 bytes. Returns null if unknown. */
export function sniffImage(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: 'jpeg', mime: 'image/jpeg', animated: false };
  }
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) {
    return { type: 'png', mime: 'image/png', animated: false };
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    const animated = ascii(b, 12, 16) === 'VP8X' && b.length > 20 && (b[20] & 0x02) !== 0;
    return { type: 'webp', mime: 'image/webp', animated };
  }
  if (ascii(b, 0, 4) === 'GIF8') return { type: 'gif', mime: 'image/gif', animated: true };
  if (ascii(b, 0, 2) === 'BM') return { type: 'bmp', mime: 'image/bmp', animated: false };
  if (ascii(b, 4, 8) === 'ftyp' && b.length >= 12) return sniffFtyp(b);
  return null;
}
