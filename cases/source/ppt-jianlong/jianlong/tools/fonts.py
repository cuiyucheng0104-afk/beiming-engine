"""字体子集（可重跑，需联网）：Noto Serif SC（标题、字幕、大字）与 Noto Sans SC（界面标签），用 Google Fonts `&text=` 子集化。
字集 = data/whitelist.json 的全部白名单文字 + 旁白字幕全文。产出 assets/fonts/*.woff2 与 assets/fonts/fonts.json。
画面上要加新字，先确认在规范 §4 白名单里，加进 data/whitelist.json，再重跑本脚本。"""
import json, os, re, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = f'{HERE}/assets/fonts'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
FACES = [('Noto Serif SC', 500, 'serif500'), ('Noto Serif SC', 700, 'serif700'), ('Noto Serif SC', 900, 'serif900'), ('Noto Sans SC', 500, 'sans500')]


def charset():
    wl = json.load(open(f'{HERE}/data/whitelist.json'))
    s = ''.join(wl['all'])
    s += ''.join(c['text'] for c in json.load(open(f'{HERE}/data/subs.json')))
    s += '「」，。：、·~ 0123456789'
    return ''.join(sorted(set(s) - {'\n'}))


def main():
    os.makedirs(OUT, exist_ok=True); cs = charset(); meta = {}
    for fam, w, key in FACES:
        url = 'https://fonts.googleapis.com/css2?family=' + fam.replace(' ', '+') + f':wght@{w}&text=' + urllib.parse.quote(cs)
        css = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode()
        src = re.findall(r'url\((https://[^)]+)\)', css)
        assert len(src) == 1, css[:300]
        data = urllib.request.urlopen(urllib.request.Request(src[0], headers={'User-Agent': UA}), timeout=60).read()
        open(f'{OUT}/{key}.woff2', 'wb').write(data); meta[key] = dict(family=fam, weight=w, file=f'{key}.woff2', bytes=len(data))
        print(key, len(data))
    meta['_chars'] = cs
    json.dump(meta, open(f'{OUT}/fonts.json', 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
