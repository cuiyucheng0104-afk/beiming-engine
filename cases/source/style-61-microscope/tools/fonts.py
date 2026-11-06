"""Fetch the page's fonts (all OFL, Google Fonts): Barlow Condensed Light/Regular and IBM Plex Mono Regular/Medium
from github.com/google/fonts; Noto Sans SC 400/500 and Noto Serif SC 600 subset (CSS2 API &text=) to the
characters in film.js + timeline.js.   usage: python -I tools/fonts.py <project_dir>"""
import sys, os, re, urllib.request, urllib.parse
D = sys.argv[1]
src = ''.join(open(os.path.join(D, f), encoding='utf-8').read() for f in ('film.js', 'timeline.js'))
cjk = sorted(set(re.findall(r'[　-〿一-鿿＀-￯·×µ]', src)))
text = ''.join(cjk) + '0123456789%.,:;-+()/°=· ' + ''.join(chr(c) for c in range(65, 91)) + ''.join(chr(c) for c in range(97, 123))
print(len(cjk), 'chars:', ''.join(cjk))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
get = lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA}), timeout=60).read()
os.makedirs(os.path.join(D, 'fonts'), exist_ok=True)
GH = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
for rel in ('barlowcondensed/BarlowCondensed-Light.ttf', 'barlowcondensed/BarlowCondensed-Regular.ttf',
            'ibmplexmono/IBMPlexMono-Regular.ttf', 'ibmplexmono/IBMPlexMono-Medium.ttf',
            'barlowcondensed/OFL.txt'):
    out = os.path.join(D, 'fonts', rel.split('/')[1] if not rel.endswith('OFL.txt') else 'OFL-barlowcondensed.txt')
    if os.path.exists(out) and not os.environ.get('FETCH'): continue
    data = get(GH + rel); open(out, 'wb').write(data); print(os.path.basename(out), len(data), 'bytes')
for fam, w, out in (('Noto Sans SC', 400, 'NotoSansSC-400.woff2'), ('Noto Sans SC', 500, 'NotoSansSC-500.woff2'), ('Noto Serif SC', 600, 'NotoSerifSC-600.woff2')):
    css = get('https://fonts.googleapis.com/css2?family=%s:wght@%d&text=%s' % (urllib.parse.quote(fam), w, urllib.parse.quote(text))).decode()
    urls = re.findall(r'url\((https://[^)]+)\)', css); assert len(urls) == 1, css[:300]
    data = get(urls[0]); open(os.path.join(D, 'fonts', out), 'wb').write(data); print(out, len(data), 'bytes')
