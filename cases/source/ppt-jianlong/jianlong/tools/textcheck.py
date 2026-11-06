"""画面文字白名单静态检查：src/ 下所有 JS 字符串和 sfx/*.json 的 text 字段里出现的中文，必须是规范 §4 白名单
（data/whitelist.json）或旁白字幕（data/subs.json）里的内容（整条或其中连续的一段）。注释不查。
运行时还有第二道关：ui.text() 画字前会查白名单，不在名单里直接抛错让渲染失败。
用法：$LIB/.venv/bin/python tools/textcheck.py   （退出码 0 = 全部合规）"""
import json, os, re, glob, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
wl = json.load(open(f'{HERE}/data/whitelist.json'))['all'] + [c['text'] for c in json.load(open(f'{HERE}/data/subs.json'))]
CJK = re.compile(r'[㐀-鿿]')
ok = lambda s: any(s in w for w in wl)
bad = []
for f in glob.glob(f'{HERE}/src/**/*.js', recursive=True):
    src = open(f).read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = '\n'.join(re.sub(r'(^|[^:\'"])//.*$', r'\1', ln) for ln in src.split('\n'))
    for m in re.finditer(r"'([^'\n]*)'|\"([^\"\n]*)\"|`([^`]*)`", src):
        s = next(g for g in m.groups() if g is not None)
        if not CJK.search(s): continue
        if 'throw' in src[max(0, m.start() - 40):m.start()] or 'Error(' in src[max(0, m.start() - 12):m.start()] or 'console.' in src[max(0, m.start() - 20):m.start()]: continue
        if not ok(s.strip()): bad.append((os.path.relpath(f, HERE), s))
for f in glob.glob(f'{HERE}/sfx/*.json'):
    for e in json.load(open(f)).get('events', []):
        if 'text' in e and not ok(e['text']): bad.append((os.path.relpath(f, HERE), e['text']))
for f, s in bad: print(f'不在白名单：{f}: 「{s}」')
print('文字检查', '通过' if not bad else f'{len(bad)} 处不合规'); sys.exit(1 if bad else 0)
