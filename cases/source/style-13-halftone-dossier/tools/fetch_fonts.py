"""按源码里实际出现的字符，从 Google Fonts CSS API（&text= 子集）下载字体到 fonts/。用法：python tools/fetch_fonts.py"""
import re, sys, urllib.request, urllib.parse, pathlib
HERE = pathlib.Path(__file__).resolve().parent.parent
src = ''.join((HERE / f).read_text() for f in ['main.js', 'draw.js', 'magpie.js'])
ascii_ = ''.join(chr(c) for c in range(0x20, 0x7f))
cjk = ''.join(sorted(set(ch for ch in src if ord(ch) > 0x7f)))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
FAM = {  # 文件名: (family, weight, 字符集)
    'serif900': ('Noto Serif SC', 900, cjk + ascii_),
    'sans900': ('Noto Sans SC', 900, cjk + ascii_),
    'bagel': ('Bagel Fat One', 400, ascii_),
    'mono800': ('JetBrains Mono', 800, ascii_),
    'kuaile': ('ZCOOL KuaiLe', 400, cjk + ascii_),
}
for name, (fam, w, chars) in FAM.items():
    url = 'https://fonts.googleapis.com/css2?family=' + urllib.parse.quote(fam) + f':wght@{w}&text=' + urllib.parse.quote(chars)
    css = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode()
    urls = re.findall(r'url\((https://[^)]+)\)', css)
    if len(urls) != 1: sys.exit(f'{name}: expected 1 font url, got {len(urls)}')
    data = urllib.request.urlopen(urllib.request.Request(urls[0], headers={'User-Agent': UA}), timeout=60).read()
    (HERE / 'fonts' / f'{name}.woff2').write_bytes(data)
    print(name, fam, w, len(data), 'bytes')
print('CJK chars:', cjk)
