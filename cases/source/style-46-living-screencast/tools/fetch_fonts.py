"""按 TECHNIQUE.md §11：从 Google Fonts CSS API 用 &text= 取子集，存到 fonts/（只在制作时运行一次）。"""
import re, sys, urllib.parse, urllib.request, pathlib
HERE = pathlib.Path(__file__).resolve().parent.parent
src = ''.join((HERE / f).read_text() for f in ['ui.js', 'main.js', 'index.html'])
cjk = sorted(set(c for c in src if '　' <= c <= '鿿' or '＀' <= c <= '￯'))
latin = ''.join(sorted(set(' 0123456789:/·.,+-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
def get(family, wght, text, out):
    url = f'https://fonts.googleapis.com/css2?family={family}:wght@{wght}&text=' + urllib.parse.quote(text)
    css = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode()
    furl = re.search(r'url\((https://[^)]+)\)', css).group(1)
    data = urllib.request.urlopen(urllib.request.Request(furl, headers={'User-Agent': UA}), timeout=30).read()
    (HERE / 'fonts' / out).write_bytes(data); print(out, len(data), 'bytes')
chars = ''.join(cjk) + latin
print('CJK chars:', ''.join(cjk))
for w in (500, 700): get('Noto+Sans+SC', w, chars, f'NotoSansSC-{w}.woff2')
for w in (500, 700): get('Inter', w, latin + '⋯', f'Inter-{w}.woff2')
