import sys
import numpy as np
from PIL import Image, ImageFilter

src, outdir = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
g = np.asarray(im.convert('L')).astype(np.int32)

def flood(mask_bool, seed):
    """Connected region of True pixels containing seed (x, y)."""
    region = np.zeros_like(mask_bool)
    region[seed[1], seed[0]] = mask_bool[seed[1], seed[0]]
    while True:
        grow = region.copy()
        grow[1:] |= region[:-1]; grow[:-1] |= region[1:]
        grow[:, 1:] |= region[:, :-1]; grow[:, :-1] |= region[:, 1:]
        grow &= mask_bool
        if (grow == region).all():
            return region
        region = grow

def dilate(mask, size):
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(size))) > 0

bg = flood(g > 200, (0, 0))
solid = ~bg

# bird = white body (+ its holes) grown enough to swallow the outline and beak
inside = flood(g > 200, (470, 175))
filled = ~flood(~inside, (0, 0))
STEM_Y = 193  # where the stem starts; below this only take a thin outline so we don't steal the stem
bird = dilate(filled, 19) & solid
bird[STEM_Y:] = (dilate(filled, 11) & solid)[STEM_Y:]
bird[:, :398] = False
# beak tip pokes out past the dilation
beak = np.zeros_like(bird); beak[130:200, 490:540] = True
bird |= beak & solid

STEM_TOP, STEM_RIGHT = 200, 452
body = solid & ~bird
patch = bird.copy(); patch[:STEM_TOP] = False; patch[:, STEM_RIGHT:] = False
body |= patch  # where the bird sat on the stem, keep the stem solid

orig = np.asarray(im).copy()
rgb = orig.copy()
rgb[patch] = 0

def save(mask, name, src_rgb, pad=3):
    soft = bg & dilate(mask, 5)  # anti-aliased edge pixels right next to this sprite's ink
    a = np.zeros(g.shape, np.uint8)
    a[mask] = 255
    a[soft] = np.clip((255 - g[soft]) * 255 // 70, 0, 255)
    px = src_rgb.copy(); px[soft] = 0
    ys, xs = np.nonzero(mask)
    box = (xs.min() - pad, ys.min() - pad, xs.max() + pad + 1, ys.max() + pad + 1)
    Image.fromarray(np.dstack([px, a])).crop(box).save(f'{outdir}/{name}')
    print(name, 'box', tuple(int(v) for v in box))

# --- face: lift the eyes out as their own sprites, paint face-white where eyes + mouth were
dark = g < 128
features = {'eye-left': (303, 460), 'eye-right': (437, 440), 'mouth': (397, 483)}
for name, seed in features.items():
    comp = flood(dark, seed)
    ys, xs = np.nonzero(comp)
    print(name, 'component box', (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())), 'px', int(comp.sum()))
    region = ~flood(~comp, (0, 0))          # component + the white enclosed by it
    region = dilate(region, 5)               # take a little face-white margin along
    if name != 'mouth':
        ys, xs = np.nonzero(region)
        box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        a = np.where(region, 255, 0).astype(np.uint8)
        Image.fromarray(np.dstack([orig, a])).crop(box).save(f'{outdir}/{name}.png')
        print(name, 'sprite box', box)
    rgb[region] = 255

save(body, 'idle.png', rgb)
save(bird, 'bird.png', orig)
