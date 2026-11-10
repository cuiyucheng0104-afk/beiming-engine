"""舞台交付图压缩：PNG → 目标尺寸（Lanczos）→ 渐进式 JPG，按体积上限二分质量。

由 render-assets.mjs 调用：python3 encode_assets.py '<JSON 列表>'
每项：{ name, raw（PNG）, out（JPG）, size: [宽, 高], kb（体积上限，KB） }
"""
import io
import json
import sys

from PIL import Image


def encode(img, q):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q, optimize=True, progressive=True, subsampling='4:2:0')
    return buf.getvalue()


def main():
    jobs = json.loads(sys.argv[1])
    for j in jobs:
        img = Image.open(j['raw']).convert('RGB')
        w, h = j['size']
        if img.size != (w, h):
            img = img.resize((w, h), Image.LANCZOS)
        limit = j['kb'] * 1024
        lo, hi, best = 50, 92, None
        while lo <= hi:                      # 体积上限内质量最高的一档
            mid = (lo + hi) // 2
            data = encode(img, mid)
            if len(data) <= limit:
                best, lo = (mid, data), mid + 1
            else:
                hi = mid - 1
        if best is None:
            best = (50, encode(img, 50))
        with open(j['out'], 'wb') as f:
            f.write(best[1])
        print(f"{j['name']}.jpg  {w}×{h}  质量 {best[0]}  {len(best[1]) / 1024:.0f} KB（上限 {j['kb']} KB）")


if __name__ == '__main__':
    main()
