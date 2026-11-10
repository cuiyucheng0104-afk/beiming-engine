#!/usr/bin/env python3
"""检查导演与画面规范（Markdown / JSON）的命名与路径纪律。

规则：
1. 禁用名：任何位置出现都报错（不区分大小写，英文按词边界）。
2. 第三方风格库名、作者名、上游组织名：只允许出现在标题含「出处」「许可」「来源」的小节里，
   或者 SOURCES.md 全文。标题只认代码块之外的 Markdown 标题行。
3. 本机绝对路径（/private/tmp/、/Users/、/home/、~/、Windows 盘符）：任何位置出现都报错，没有豁免。
4. RAEA 大写写法：只报告位置，供人工核对是否属于路径、命令或出处，不算错误。

用法：
    python3 tools/check_directing_docs.py <规范目录>      # 有问题时退出码 1
    python3 tools/check_directing_docs.py --self-test     # 每条规则用应当报错的样例自测
"""
import re
import sys
import tempfile
from pathlib import Path

BANNED = [
    re.compile(r'苔藓巨人'),
    re.compile(r'moss[\s_-]*keeper', re.I),
    re.compile(r'(?<![A-Za-z])UTS(?![A-Za-z])'),          # 只认独立的大写词，不误报 OUTSIDE 一类
    re.compile(r'rokid', re.I),
    re.compile(r'乐奇'),
]
# 与 tools/build-showcase.py 的页面禁用词表对齐（库名部分）；内部代号 raea 用于定位文件，不在这里拦。
THIRD = [
    re.compile(r'lemo\s?lab', re.I),
    re.compile(r'lemo', re.I),
    re.compile(r'opuscar', re.I),
    re.compile(r'sy[\s_-]?style', re.I),
    re.compile(r'sy[\s_-]?100', re.I),
    re.compile(r'xiaoxiong', re.I),
    re.compile(r'肖雄'),
    re.compile(r'shinyobjectz', re.I),
]
ABS_PATH = [
    re.compile(r'/private/tmp/'),
    re.compile(r'/Users/[^/\s`]+'),
    re.compile(r'/home/[^/\s`]+'),
    re.compile(r'(?<![\w.$])~/'),
    re.compile(r'(?<![A-Za-z])[A-Za-z]:\\\\?[A-Za-z0-9_]'),
]
ALLOW_HEAD = re.compile(r'出处|许可|来源')
WHOLE_OK = {'SOURCES.md'}


def scan(root: Path):
    problems, notes = [], []
    for f in sorted(root.rglob('*')):
        if f.suffix not in ('.md', '.json') or not f.is_file():
            continue
        rel = f.relative_to(root)
        whole_ok = rel.name in WHOLE_OK
        heading, in_code = '', False
        for i, line in enumerate(f.read_text(encoding='utf-8').split('\n'), 1):
            if line.lstrip().startswith('```'):
                in_code = not in_code
            elif not in_code and f.suffix == '.md' and re.match(r'#{1,6} ', line):
                heading = line
            for pat in BANNED:
                if pat.search(line):
                    problems.append(f'禁用名 {pat.pattern!r}：{rel}:{i}: {line[:100]}')
            if not whole_ok and not ALLOW_HEAD.search(heading):
                for pat in THIRD:
                    if pat.search(line):
                        problems.append(f'库名出现在出处段之外 {pat.pattern!r}：{rel}:{i} [{heading[:40]}]: {line[:100]}')
                        break
            for pat in ABS_PATH:
                if pat.search(line):
                    problems.append(f'本机绝对路径 {pat.pattern!r}：{rel}:{i}: {line[:100]}')
                    break
            if 'RAEA' in line and not whole_ok and not ALLOW_HEAD.search(heading):
                notes.append(f'（核对）RAEA：{rel}:{i} [{heading[:30]}]: {line[:100]}')
    return problems, notes


def self_test() -> int:
    cases = {
        'banned_cn.md': '# 正文\n苔藓巨人\n',
        'banned_en.md': '# 正文\nthe MOSS KEEPER look\n',
        'banned_uts.md': '# 正文\n用 UTS 做\n',
        'banned_rokid.md': '# 正文\nrokid 眼镜\n',
        'banned_leqi.md': '# 正文\n乐奇眼镜\n',
        'third_case.md': '# 正文\nOpuscar 风格库\n',
        'third_lab.md': '# 正文\n署名 Lemo Lab\n',
        'third_code_heading.md': '# 正文\n```sh\n# 来源\nlemo-opuscar\n```\n',
        'third_author.md': '# 正文\n作者 肖雄\n',
        'abs_users.md': '# 出处与许可\n/Users/someone/x\n',
        'abs_tmp_readme/README.md': '# 出处与许可\n见 /private/tmp/x\n',
        'abs_home.md': '# 正文\n~/Desktop/x\n',
        'abs_win.md': '# 正文\nD:\\work\\x\n',
    }
    clean = {
        'ok_source_section.md': '# 出处与许可\n`$甲` = `cases/vendor/lemo-opuscar`（MIT，LemoLab）\n',
        'ok_outside.md': '# 正文\nOUTSIDE 与 outputs 不应被当成禁用词\n`$甲/DIRECTOR.md §3`\n',
    }
    bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        for name, text in {**cases, **clean}.items():
            sub = base / name.replace('/', '_dir/', 1) if '/' in name else base / name
            sub.parent.mkdir(parents=True, exist_ok=True)
            sub.write_text(text, encoding='utf-8')
        problems, _ = scan(base)
        hit = '\n'.join(problems)
        for name in cases:
            key = name.split('/')[-1] if '/' in name else name
            if key not in hit:
                print(f'自测失败：{name} 应当报错却没有报')
                bad += 1
        for name in clean:
            if name in hit:
                print(f'自测失败：{name} 不应报错却报了')
                bad += 1
    print('自测', '通过' if not bad else f'失败 {bad} 项')
    return 1 if bad else 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == '--self-test':
        return self_test()
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    problems, notes = scan(root)
    for line in problems + notes:
        print(line)
    print('问题数', len(problems))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
