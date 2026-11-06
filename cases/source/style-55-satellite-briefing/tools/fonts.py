"""Fonts for the page (all OFL, Google Fonts) into fonts/:
  Barlow Condensed Light/Regular and IBM Plex Mono Regular/Medium whole from github.com/google/fonts (with OFL.txt);
  Noto Sans SC 400/500 and Noto Serif SC 600 subset to the characters film.js uses (CSS2 API, &text=).
usage: python -I tools/fonts.py <film_dir>"""
import sys, os, re, urllib.request, urllib.parse
D = sys.argv[1]
src = ''.join(open(os.path.join(D, f), encoding='utf-8').read() for f in ('film.js', 'overlay.js'))
cjk = sorted(set(re.findall(r'[　-〿一-鿿＀-￯·×→：]', src)))
extra = '0123456789%.,:;-+()/°=→· ' + ''.join(chr(c) for c in range(65, 91)) + ''.join(chr(c) for c in range(97, 123))
text = ''.join(cjk) + extra
print(len(cjk), 'CJK:', ''.join(cjk))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=90).read()
GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
os.makedirs(os.path.join(D, 'fonts'), exist_ok=True)
for fam, fn, lic in [('barlowcondensed', 'BarlowCondensed-Light.ttf', 'OFL-barlow.txt'), ('barlowcondensed', 'BarlowCondensed-Regular.ttf', 'OFL-barlow.txt'),
                     ('ibmplexmono', 'IBMPlexMono-Regular.ttf', 'OFL-ibmplexmono.txt'), ('ibmplexmono', 'IBMPlexMono-Medium.ttf', 'OFL-ibmplexmono.txt')]:
    dst = os.path.join(D, 'fonts', fn)
    if not os.path.exists(dst): open(dst, 'wb').write(get(GF + fam + '/' + fn)); print(fn)
    if not os.path.exists(os.path.join(D, 'fonts', lic)): open(os.path.join(D, 'fonts', lic), 'wb').write(get(GF + fam + '/OFL.txt'))
for fam, w, out, lic in (('Noto Sans SC', 400, 'NotoSansSC-400.woff2', 'notosanssc'), ('Noto Sans SC', 500, 'NotoSansSC-500.woff2', 'notosanssc'), ('Noto Serif SC', 600, 'NotoSerifSC-600.woff2', 'notoserifsc')):
    css = get('https://fonts.googleapis.com/css2?family=' + urllib.parse.quote(fam) + f':wght@{w}&text=' + urllib.parse.quote(text)).decode()
    urls = re.findall(r'url\((https://[^)]+)\)', css); assert len(urls) == 1, css[:300]
    open(os.path.join(D, 'fonts', out), 'wb').write(get(urls[0])); print(out)
    lp = os.path.join(D, 'fonts', f'OFL-{lic}.txt')
    if not os.path.exists(lp): open(lp, 'wb').write(get(GF + lic + '/OFL.txt'))
