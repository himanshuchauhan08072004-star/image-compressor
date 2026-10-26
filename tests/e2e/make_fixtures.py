"""Generate test images into tests/e2e/fixtures (not committed)."""
import os, numpy as np
from PIL import Image, ImageDraw
out = os.path.join(os.path.dirname(__file__), 'fixtures'); os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(1)

# 3000x2000 photo-like (gradient + noise) JPEG
w, h = 3000, 2000
x = np.linspace(0, 255, w)[None, :]; y = np.linspace(0, 255, h)[:, None]
img = np.stack([x + 0 * y, y + 0 * x, (x + y) / 2], -1) + rng.normal(0, 18, (h, w, 3))
Image.fromarray(np.clip(img, 0, 255).astype('uint8')).save(f'{out}/photo.jpg', quality=92)

# EXIF-rotated portrait: DISPLAY is 1500x2000, top 600 rows red, rest blue. Stored rotated, Orientation=6.
d = Image.new('RGB', (1500, 2000), (0, 0, 255)); ImageDraw.Draw(d).rectangle([0, 0, 1500, 599], fill=(255, 0, 0))
s = d.rotate(90, expand=True)           # stored 2000x1500
ex = Image.Exif(); ex[0x0112] = 6
s.save(f'{out}/rotated.jpg', quality=95, exif=ex)

# transparent PNG: 800x600, opaque red circle in middle, fully transparent corners
t = Image.new('RGBA', (800, 600), (0, 0, 0, 0)); ImageDraw.Draw(t).ellipse([200, 100, 600, 500], fill=(220, 30, 30, 255))
t.save(f'{out}/alpha.png')

Image.new('RGB', (200, 200), (10, 200, 10)).save(f'{out}/tiny.jpg', quality=90)
Image.new('RGB', (64, 64), (1, 2, 3)).save(f'{out}/anim.gif')
open(f'{out}/fake.jpg', 'wb').write(b'this is not an image at all' * 50)
open(f'{out}/empty.jpg', 'wb').close()
Image.new('L', (11000, 10000), 128).save(f'{out}/huge.png')   # 110 MP, tiny file
print('fixtures ok')

# ---- Phase 2 fixtures: convert ----
t = Image.new('RGBA', (800, 600), (0, 0, 0, 0)); ImageDraw.Draw(t).ellipse([200, 100, 600, 500], fill=(220, 30, 30, 255))
t.save(f'{out}/alpha.webp', lossless=True)
pal = Image.new('P', (64, 64), 0); pal.putpalette([255, 255, 255, 200, 0, 0] + [0] * 762); ImageDraw.Draw(pal).rectangle([16, 16, 48, 48], fill=1)
pal.save(f'{out}/pal_trns.png', transparency=0)

# ---- Phase 2 fixtures: metadata removal + redaction ----
import struct, zlib
from PIL import ImageCms
from PIL.PngImagePlugin import PngInfo
from markers import M

ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()

def make_exif(orientation=None):
    ex = Image.Exif()
    ex[0x010f] = M['make']; ex[0x0110] = M['model']; ex[0x0131] = M['soft']; ex[0x013b] = M['artist']; ex[0x010e] = M['desc']; ex[0x0132] = '2024:01:02 03:04:05'
    if orientation: ex[0x0112] = orientation
    ei = ex.get_ifd(0x8769); ei[0x9003] = '2024:01:02 03:04:05'; ei[0xa431] = M['serial']
    g = ex.get_ifd(0x8825); g[1] = 'N'; g[2] = (28.0, 36.0, 0.0); g[3] = 'E'; g[4] = (76.0, 39.0, 0.0)
    return ex

def scene(w, h):
    d = Image.new('RGB', (w, h), (0, 0, 255)); dr = ImageDraw.Draw(d)
    dr.rectangle([0, 0, w, int(h * 0.3) - 1], fill=(255, 0, 0)); dr.ellipse([w * 0.2, h * 0.4, w * 0.8, h * 0.9], fill=(250, 220, 20)); dr.line([0, h - 1, w, 0], fill=(0, 0, 0), width=3)
    return d

def seg(m, payload): return b'\xff' + bytes([m]) + struct.pack('>H', len(payload) + 2) + payload
def jpeg_inject(data, trailing=b''):
    xmp = seg(0xe1, b'http://ns.adobe.com/xap/1.0/\0' + ('<x:xmpmeta>' + M['xmp'] + '</x:xmpmeta>').encode())
    com = seg(0xfe, M['comment'].encode())
    return data[:2] + xmp + com + data[2:] + trailing
def png_chunk(t, payload): return struct.pack('>I', len(payload)) + t + payload + struct.pack('>I', zlib.crc32(t + payload) & 0xffffffff)
def png_inject(data, trailing=b''):
    i = data.index(b'IDAT') - 4
    chunks = png_chunk(b'tIME', struct.pack('>HBBBBB', 2024, 1, 2, 3, 4, 5)) + png_chunk(b'prVt', M['pprivate'].encode())
    return data[:i] + chunks + data[i:] + trailing

def save_bytes(im, fmt, **kw):
    b = io.BytesIO(); im.save(b, fmt, **kw); return b.getvalue()
import io

# JPEG: displayed 300x400, stored rotated (400x300) with Orientation=6, plus EXIF/GPS/XMP/COM/ICC/trailing data
disp = scene(300, 400); stored = disp.rotate(90, expand=True)
open(f'{out}/meta.jpg', 'wb').write(jpeg_inject(save_bytes(stored, 'JPEG', quality=92, exif=make_exif(6), icc_profile=ICC), M['trail'].encode()))
# PNG upright: tEXt, iTXt, zTXt, eXIf, tIME, private chunk, trailing data
pi = PngInfo(); pi.add_text('Comment', M['ptext']); pi.add_itxt('Description', M['pitxt']); pi.add_text('Note', M['pztxt'], zip=True)
open(f'{out}/meta.png', 'wb').write(png_inject(save_bytes(scene(300, 200), 'PNG', pnginfo=pi, exif=make_exif(), icc_profile=ICC), M['trail'].encode()))
# PNG with a rotation flag (stored 300x200, Orientation=6 -> shows 200x300)
open(f'{out}/meta_rot.png', 'wb').write(save_bytes(scene(300, 200), 'PNG', exif=make_exif(6)))
# WEBP lossless: EXIF + XMP + ICC + trailing data
open(f'{out}/meta.webp', 'wb').write(save_bytes(scene(300, 200), 'WEBP', lossless=True, exif=make_exif(), xmp=('<x:xmpmeta>' + M['xmp'] + '</x:xmpmeta>').encode(), icc_profile=ICC) + M['trail'].encode())
open(f'{out}/meta_rot.webp', 'wb').write(save_bytes(scene(300, 200), 'WEBP', lossless=True, exif=make_exif(6)))
# 6 MP photo with metadata
big = Image.open(f'{out}/photo.jpg').convert('RGB')
open(f'{out}/meta_big.jpg', 'wb').write(jpeg_inject(save_bytes(big, 'JPEG', quality=90, exif=make_exif(), icc_profile=ICC), M['trail'].encode()))
# the browser tolerates stray bytes between segments (libjpeg skips them) but our strict parser must refuse lossless on it
t = open(f'{out}/tiny.jpg', 'rb').read(); i = t.index(b'\xff\xda'); open(f'{out}/junkseg.jpg', 'wb').write(t[:i] + b'\x00\x01\x02' + t[i:])

# redaction: 400x300 checkerboard (20 px cells) as lossless PNG
cb = np.zeros((300, 400, 3), 'uint8'); yy, xx = np.mgrid[0:300, 0:400]; cb[((xx // 20 + yy // 20) % 2) == 0] = 255
Image.fromarray(cb).save(f'{out}/checker.png')
print('phase2 fixtures ok')

# ---- fixtures needed by tests/dimensions.test.js (were missing from this script) ----
g = np.linspace(0, 255, 1200)[None, :, None] * np.ones((800, 1, 3)); g = np.clip(g + rng.normal(0, 10, (800, 1200, 3)), 0, 255).astype('uint8')
Image.fromarray(g).save(f'{out}/prog.jpg', quality=85, progressive=True)                       # 1200x800 progressive
pj = io.BytesIO(); Image.fromarray(g).save(pj, 'JPEG', quality=85)
filler = b''.join(seg(0xfe, b'x' * 60000) for _ in range(3))                                      # ~180 KB of comments before the frame header
open(f'{out}/bigmeta.jpg', 'wb').write(pj.getvalue()[:2] + filler + pj.getvalue()[2:])             # frame header sits beyond the first 64 KB
fr = [Image.new('RGB', (64, 64), c) for c in [(255, 0, 0), (0, 0, 255)]]
fr[0].save(f'{out}/anim.webp', save_all=True, append_images=fr[1:], duration=100, loop=0)
print('dimension fixtures ok')

# ---- Phase 4 fixtures: passport photo (position-coded: R = x, G = y, so any crop can be verified from pixels) ----
def coded(w, h, mode='RGB'):
    a = np.zeros((h, w, 3), 'uint8'); yy, xx = np.mgrid[0:h, 0:w]
    a[..., 0] = (xx * 255 // max(1, w - 1)); a[..., 1] = (yy * 255 // max(1, h - 1)); a[..., 2] = 128
    return Image.fromarray(a)
coded(1200, 1600).save(f'{out}/pp_portrait.jpg', quality=95)       # portrait
coded(1600, 1200).save(f'{out}/pp_landscape.jpg', quality=95)      # landscape
coded(300, 400).save(f'{out}/pp_small.jpg', quality=95)            # fewer pixels than 413 x 531
al = coded(800, 1000).convert('RGBA'); aa = np.array(al); aa[:200, :200, 3] = 0; Image.fromarray(aa).save(f'{out}/pp_alpha.png')   # transparent top-left corner
print('passport fixtures ok')
