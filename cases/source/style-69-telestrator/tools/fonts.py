#!/usr/bin/env python3
"""Subset OFL fonts from the Google Fonts CSS API (&text=) into fonts/: only the characters used by index.html / timeline.js.
Change any on-screen text → delete fonts/*.woff2 and run again."""
import re, sys, os, urllib.parse, urllib.request
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = ''.join(open(os.path.join(D, f), encoding='utf-8').read() for f in ('index.html', 'timeline.js'))
chars = ''.join(sorted(set(src) - set('\n\r\t'))) + '0123456789.:′–—…→≈·❚◀▶½'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
JOBS = [('sans500', 'Noto Sans SC:wght@500'), ('sans700', 'Noto Sans SC:wght@700'), ('sans900', 'Noto Sans SC:wght@900'),
        ('cond800i', 'Barlow Condensed:ital,wght@1,800'), ('cond600', 'Barlow Condensed:wght@600'), ('mono500', 'IBM Plex Mono:wght@500')]
os.makedirs(os.path.join(D, 'fonts'), exist_ok=True)
for name, fam in JOBS:
    out = os.path.join(D, f'fonts/{name}.woff2')
    if os.path.exists(out) and '--force' not in sys.argv: print(name, 'exists'); continue
    url = 'https://fonts.googleapis.com/css2?' + urllib.parse.urlencode({'family': fam, 'text': chars, 'display': 'block'})
    css = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60).read().decode()
    urls = re.findall(r'url\((https://[^)]+)\)', css)
    if not urls: sys.exit(f'no font url for {fam}')
    data = urllib.request.urlopen(urllib.request.Request(urls[0], headers={'User-Agent': UA}), timeout=60).read()
    open(out, 'wb').write(data); print(name, len(data), 'bytes', len(urls), 'part(s)')
