"""把成片用到的字子集化（Google Fonts CSS2 API 的 &text=，全部 OFL）。
用法：python -I tools/fonts.py <工程目录>  → fonts/*.woff2 + fonts/fonts.css + fonts/OFL-*.txt"""
import sys, os, re, ssl, urllib.request, urllib.parse
D = sys.argv[1]
src = open(os.path.join(D, 'texts.js'), encoding='utf-8').read()
cjk = sorted(set(re.findall(r'[　-〿一-鿿＀-￯·°×]', src)))
text = ''.join(cjk) + ''.join(chr(c) for c in range(32, 127))
print(len(cjk), 'CJK chars:', ''.join(cjk))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()
get = lambda url: urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60, context=CTX).read()
os.makedirs(os.path.join(D, 'fonts'), exist_ok=True)
css = []
for fam, w, alias, out in (('Noto Sans SC', 400, 'SC', 'NotoSansSC-400.woff2'), ('Noto Sans SC', 600, 'SC', 'NotoSansSC-600.woff2'),
                           ('Noto Sans SC', 800, 'SC', 'NotoSansSC-800.woff2'),
                           ('Inter Tight', 400, 'IT', 'InterTight-400.woff2'), ('Inter Tight', 600, 'IT', 'InterTight-600.woff2'),
                           ('Inter Tight', 800, 'IT', 'InterTight-800.woff2'), ('IBM Plex Mono', 400, 'PM', 'IBMPlexMono-400.woff2')):
    c = get('https://fonts.googleapis.com/css2?family=' + urllib.parse.quote(fam) + f':wght@{w}&text=' + urllib.parse.quote(text)).decode()
    urls = re.findall(r'url\((https://[^)]+)\)', c)
    assert len(urls) == 1, c[:400]
    data = get(urls[0]); open(os.path.join(D, 'fonts', out), 'wb').write(data)
    css.append(f"@font-face{{font-family:'{alias}';src:url({out}) format('woff2');font-weight:{w}}}")
    print(out, len(data), 'bytes', urls[0])
open(os.path.join(D, 'fonts', 'fonts.css'), 'w').write('\n'.join(css) + '\n')
for fam, out in (('notosanssc', 'OFL-notosanssc.txt'), ('intertight', 'OFL-intertight.txt'), ('ibmplexmono', 'OFL-ibmplexmono.txt')):
    open(os.path.join(D, 'fonts', out), 'wb').write(get(f'https://raw.githubusercontent.com/google/fonts/main/ofl/{fam}/OFL.txt'))
