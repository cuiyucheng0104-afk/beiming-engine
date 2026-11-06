# 收集源码里用到的字符，从 Google Fonts CSS API（&text= 子集）下载字体到 fonts/，写 fonts.css
import os, re, sys, urllib.parse, urllib.request, glob
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = ''.join(open(p, encoding='utf-8').read() for p in glob.glob(os.path.join(HERE, '*.js')))
ascii_ = ''.join(chr(c) for c in range(32, 127))
non = sorted(set(ch for ch in src if ord(ch) > 127))
allc = ascii_ + ''.join(non)
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
FAM = [('LongCang', 'Long+Cang', 400, allc), ('Arch', 'Architects+Daughter', 400, allc), ('B612M', 'B612+Mono', 400, allc),
       ('NotoSC', 'Noto+Sans+SC:wght@500', 500, allc), ('NotoSC', 'Noto+Sans+SC:wght@700', 700, allc), ('LJMC', 'Liu+Jian+Mao+Cao', 400, '林墨')]
css = []
for name, fam, wt, chars in FAM:
    url = f'https://fonts.googleapis.com/css2?family={fam}&text={urllib.parse.quote(chars)}'
    c = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode()
    m = re.search(r'url\((https://[^)]+)\)', c)
    data = urllib.request.urlopen(urllib.request.Request(m.group(1), headers={'User-Agent': UA}), timeout=60).read()
    fn = f'{name}-{wt}.woff2'
    open(os.path.join(HERE, 'fonts', fn), 'wb').write(data)
    css.append(f"@font-face {{ font-family: '{name}'; src: url('{fn}') format('woff2'); font-weight: {wt}; }}")
    print(fn, len(data))
open(os.path.join(HERE, 'fonts', 'fonts.css'), 'w').write('\n'.join(css) + '\n')
print('chars:', ''.join(non))
