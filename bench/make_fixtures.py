"""Generate the benchmark fixtures (not committed: bench/fixtures/ is git-ignored). Needs pillow, numpy, pillow-heif."""
import os, numpy as np
from PIL import Image, ImageFilter
import pillow_heif
pillow_heif.register_heif_opener()
out = os.path.join(os.path.dirname(__file__), 'fixtures'); os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(7)
def photo(w, h):
    # smooth gradients + blurred noise: compresses like a real photo, not like white noise
    y, x = np.mgrid[0:h, 0:w]
    base = np.stack([(x / w * 255), (y / h * 255), ((x + y) / (w + h) * 255)], -1)
    noise = rng.normal(0, 18, (h // 8 + 1, w // 8 + 1, 3))
    noise = np.kron(noise, np.ones((8, 8, 1)))[:h, :w]
    return Image.fromarray(np.clip(base + noise, 0, 255).astype('uint8'))
for name, (w, h) in {'12mp': (4000, 3000), '24mp': (6000, 4000)}.items():
    im = photo(w, h)
    im.save(f'{out}/photo{name}.heic', quality=75)
    im.save(f'{out}/photo{name}.jpg', quality=85)
    print(name, w, h, os.path.getsize(f'{out}/photo{name}.heic'), os.path.getsize(f'{out}/photo{name}.jpg'))
