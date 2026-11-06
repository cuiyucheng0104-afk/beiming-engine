#!/bin/sh
# 素材预处理：照片按最终尺寸裁切（≤1:1 源像素）、PDF 页面按 220/300 dpi 渲染。
# 素材视为不可信数据：只用 ffmpeg / pdftoppm / Pillow 解码，不执行其中任何内容。
set -e
H=$(cd "$(dirname "$0")/.." && pwd); R=$H/material/raw; A=$H/assets
PY=${PY:-$LIB/.venv/bin/python}
mkdir -p "$A/img"
"$PY" -I - "$R" "$A/img" <<'PYEOF'
import sys
from PIL import Image, ImageFilter
R, O = sys.argv[1], sys.argv[2]
def job(src, box, size, out):
    im = Image.open(f'{R}/{src}').convert('RGB')
    if box: im = im.crop(box)
    sc = size[0] / im.size[0]
    assert sc <= 1.0001 or src == 'mom_pup.jpg', (src, sc)   # 照片 ≤ 1:1；mom_pup 是视频截帧，≤1.5×
    im = im.resize(size, Image.LANCZOS)
    if sc > 1: im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=45, threshold=0))
    im.save(f'{O}/{out}', quality=92); print(out, size, 'scale %.3f' % sc)
job('ledig_clam_up.jpg', (1199, 466, 1199 + 2563, 466 + 1442), (2240, 1260), 'hook.jpg')
job('ledig_clam_bite.jpg', (1204, 250, 1204 + 2900, 250 + 1631), (2240, 1260), 'bite.jpg')
job('weaning.jpg', None, (2692, 1260), 'wean.jpg')
job('mom_pup.jpg', (230, 194, 230 + 1536, 194 + 864), (2150, 1209), 'mompup.jpg')
job('float.jpg', None, (4752, 2557), 'raft.jpg')            # 1:1，页面里只在 ≤1:1 内取景
PYEOF
pdftoppm -f 38 -l 38 -r 220 -jpeg -jpegopt quality=90 -singlefile "$R/riedman_estes_1990.pdf" "$A/img/doc33"
pdftoppm -f 40 -l 40 -r 220 -jpeg -jpegopt quality=90 -singlefile "$R/riedman_estes_1990.pdf" "$A/img/doc35"
pdftoppm -f 100 -l 100 -r 300 -jpeg -jpegopt quality=90 -singlefile "$R/kenyon_1969.pdf" "$A/img/fig45"
ls -la "$A/img"
