#!/usr/bin/env python3
"""Mask for the HAER cable-clamp photo (main cable, clamp band, three suspender ropes against a clear sky).
    python3 kit/tools/cable_mask.py <cable.jpg> <out_mask.png>
Sky key: the sky is smooth and light (~165-171); the cable is dark, the ropes are textured.
mask = dark OR textured, restricted below the cable's top edge (drops the hand rope above),
holes filled, largest connected part kept."""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('L'); W, H = im.size
a = np.asarray(im, np.float32)
sky = ndi.median_filter(a[::8, ::8], size=15)
sky = np.asarray(Image.fromarray(sky).resize((W, H), Image.BICUBIC), np.float32)
dark = a < 132
hp = ndi.gaussian_filter(np.abs(a - ndi.gaussian_filter(a, 6)), 2.5)
tex = hp > 7
bright = a > sky + 12
m = dark | tex | bright
# keep below the line from (0, 455/1280*W) to (W, 80/1280*W) (grid preview coordinates ×3)
k = W / 1280.0
yy, xx = np.mgrid[0:H, 0:W]
top = 455 * k + (80 - 455) * k * (xx / W)
m &= yy > top
m = ndi.binary_closing(m, iterations=3)
m = ndi.binary_fill_holes(m)
lab, n = ndi.label(m)
sizes = ndi.sum(m, lab, range(1, n + 1))
m = lab == (1 + int(np.argmax(sizes)))
m = ndi.binary_opening(m, iterations=2)
Image.fromarray((m * 255).astype(np.uint8)).save(out)
print(out, m.mean())
