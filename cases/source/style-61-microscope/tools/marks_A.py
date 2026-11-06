# Hand-marked diatom frustules in plate A (one field). Each mark: x, y, r in plate-A pixels.
# Method: the author marked, by eye on the full-resolution photo, every complete or nearly complete
# diatom frustule whose outline is clear; debris, fragments and out-of-focus blobs are not marked.
import json
from PIL import Image, ImageDraw
HERE = __file__.rsplit('/', 2)[0]
M = [
 (760, 1050, 70), (660, 1000, 60), (765, 745, 120), (480, 722, 80), (795, 1210, 110), (1320, 1150, 110), (1425, 1000, 90),
 (2070, 1030, 90), (1275, 1360, 35), (1470, 1210, 35), (1140, 610, 55), (945, 430, 40), (1050, 782, 35),
 (720, 475, 80), (1770, 1285, 55), (1935, 1315, 35), (1770, 700, 80), (465, 535, 45),
 (1575, 430, 35), (1350, 512, 40), (975, 1330, 60),
 (1245, 1705, 160), (1035, 1825, 90), (720, 1705, 90), (645, 1885, 80), (1590, 1840, 90), (1920, 1975, 80),
 (1845, 1742, 40), (1770, 1735, 30), (1755, 1990, 50), (1035, 2335, 45), (1215, 2320, 40), (540, 1660, 70),
 (840, 2200, 80), (1545, 2230, 80), (1425, 2035, 35), (450, 1480, 50), (2010, 1720, 40), (1215, 1840, 35),
]
# the film shows field A inside the largest circle that stays within the photo (its ring is cropped on the left);
# a mark counts only if it sits inside that circle
META = json.load(open(f'{HERE}/plates/meta.json'))['A']
RC = min(META['r'], META['cx'] - 3, META['W'] - META['cx'] - 3)
M = [m for m in M if ((m[0] - META['cx']) ** 2 + (m[1] - META['cy']) ** 2) ** .5 <= RC - 25]
if __name__ == '__main__':
    import sys
    json.dump(dict(n=len(M), marks=[list(m) for m in M], method='人工逐个圈点：轮廓清楚的完整或近完整硅藻壳；碎片、杂质、失焦团块不计'),
              open(f'{HERE}/plates/count_A.json', 'w'))
    im = Image.open(f'{HERE}/plates/A.jpg'); d = ImageDraw.Draw(im)
    for i, (x, y, r) in enumerate(M):
        d.ellipse((x-r, y-r, x+r, y+r), outline=(255, 0, 0), width=5); d.text((x+r, y-r), str(i+1), fill=(255, 0, 0))
    im.crop((0, 250, 2268, 2650)).resize((1134, 1200)).save(sys.argv[1], quality=88)
    print(len(M))
