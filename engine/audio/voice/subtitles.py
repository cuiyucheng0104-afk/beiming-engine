# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · 字幕：把带逐字时间的台词切成字幕条、断行、定起止帧，写 SRT / WebVTT / ASS。

规则（routes/directing/DIRECTING.md 步骤 9、VISUAL-DESIGN.md §6.3、craft/animation.md §5.6；数字都可在 dialogue.json 的 subtitles 段改）：
  · 字幕跟着声音起止：起点 = 这一条第一个字开口的那一帧（floor，字幕不晚于声音），台词说完后再留一会儿；
  · 每行不超过 maxChars（默认 18，汉字与全角标点算 1，拉丁字母与数字算 0.5），最多 maxLines 行（默认 2），每条最长 maxSec（默认 7 秒）；
    超出就在标点处（其次在字与字之间）切成几条，每条的时间取它自己那几个字的时间；
  · 断行守避头尾（W3C clreq）：行首不放 ，。、；：？！）》」』】… 这类收尾标点，行尾不放（《「『【 这类开头标点；两行尽量等长；
  · 停留：每条不少于 max(minSec 1.8 秒, 台词时长 + holdSec 0.6 秒)，但给下一条让出 gapFrames（默认 2 帧）的间隔
    （下一句紧接着开口时可以短于 1.8 秒）；读速超过 maxCps（默认每秒 9 字）只告警；
  · 切点：止点离切点不到 snapFrames（默认 12 帧）且台词已经说完时吸附到切点；起点离切点不到 snapInFrames（默认 1 帧）时吸附；
    台词本身跨切点时整条跨过去（报 info）；
  · 标点样式 punct："cn-film"（默认，中文影视字幕习惯：行末的全角 ，。、；： 去掉，行内的换成空格；？！…与引号书名号保留；
    拉丁文的标点照原样）或 "keep"；
  · 字数：汉字、全角标点算 1，拉丁字母、数字算 0.5（行宽与读速都按这个数）。

接口：
  Config(**dialogue.json 的 subtitles 段)
  tokens(text) → [Tok(text, kind, start, end, width)]       kind：char / word / punct；start/end 是在原文里的下标（保留原文的空格）
  cue_texts(text, units_timed, cfg) → [{text, lines, t0, t1, chars}]   units_timed = [[单位, 起秒, 止秒], …]（align 的输出，绝对时间）
  layout_frames(cues, fps, cfg, cuts=(), frames=None) → (cues 加 startFrame / endFrame / speechEndFrame, warnings)
  write_srt(path, cues, fps) / write_vtt(path, cues, fps) / write_ass(path, cues, fps, size, style)
  fmt_srt(sec) / fmt_vtt(sec) / fmt_ass(sec)
"""
import math
import re

from . import align as AL

CJK_PUNCT = set('，。、；：？！…—～·「」『』（）《》〈〉【】〔〕“”‘’')
CLOSE = AL.CLOSE
OPEN = AL.OPEN
DROP_END = set('，。、；：')         # 只动全角（中文）标点；拉丁文字幕的标点照原样
SOFT_INNER = set('，、。；：')        # 行内的这些换成空格（？！… 保留）
BREAK_AFTER = {3: set('。！？!?…'), 2: set('；;：:'), 1: set('，,、—')}


class Config:
    DEFAULTS = {'maxChars': 18, 'maxLines': 2, 'maxSec': 7.0, 'minSec': 1.8, 'holdSec': 0.6, 'gapFrames': 2, 'maxCps': 9.0,
                'snapFrames': 12, 'snapInFrames': 1, 'punct': 'cn-film'}

    def __init__(self, **kw):
        unknown = sorted(set(kw) - set(self.DEFAULTS))
        if unknown:
            raise ValueError(f'subtitles 段里有不认识的字段：{"、".join(unknown)}（可用：{"、".join(self.DEFAULTS)}）')
        for k, v in self.DEFAULTS.items():
            setattr(self, k, kw.get(k, v))
        if self.punct not in ('cn-film', 'keep'):
            raise ValueError(f'subtitles.punct 只能是 cn-film 或 keep（收到 {self.punct!r}）')
        for k in ('maxChars', 'maxLines', 'gapFrames', 'snapFrames', 'snapInFrames'):
            if not isinstance(getattr(self, k), int) or getattr(self, k) < 0 or (k in ('maxChars', 'maxLines') and getattr(self, k) < 1):
                raise ValueError(f'subtitles.{k} 要非负整数（maxChars、maxLines 至少 1）')
        for k in ('maxSec', 'minSec', 'holdSec', 'maxCps'):
            if not isinstance(getattr(self, k), (int, float)) or getattr(self, k) < 0:
                raise ValueError(f'subtitles.{k} 要非负数')

    def as_dict(self):
        return {k: getattr(self, k) for k in self.DEFAULTS}


class Tok:
    __slots__ = ('text', 'kind', 'start', 'end', 'width', 't0', 't1')

    def __init__(self, text, kind, start, end, width):
        self.text, self.kind, self.start, self.end, self.width = text, kind, start, end, width
        self.t0 = self.t1 = None

    def __repr__(self):
        return f'Tok({self.text!r}, {self.kind})'


def char_width(ch):
    if ch.isspace():
        return 0.5
    if AL._is_cjk(ch) or ch in CJK_PUNCT or ord(ch) >= 0x2E80:
        return 1.0
    return 0.5


def text_width(s):
    return sum(char_width(c) for c in s)


def tokens(text):
    """原文 → 计时单位（与 align.units 一一对应，另带在原文里的位置与显示宽度）。停顿标记 <#秒#> 先去掉"""
    text = AL.strip_markers(text)
    out, pos = [], 0
    for u in AL.units(text):
        if u.kind == 'pause':
            continue
        while pos < len(text) and text[pos].isspace():
            pos += 1
        i = text.find(u.text, pos)
        if i < 0:                                   # 不应发生：units 按顺序扫原文
            i = pos
        out.append(Tok(u.text, u.kind, i, i + len(u.text), text_width(u.text)))
        pos = i + len(u.text)
    return text, out


def _strength(tok):
    if tok.kind != 'punct':
        return 0
    for s, chars in BREAK_AFTER.items():
        if tok.text in chars:
            return s
    return 1


def _style(s, cfg):
    s = s.strip()
    if cfg.punct == 'keep':
        return s
    while s and s[-1] in DROP_END:
        s = s[:-1].rstrip()
    out = []
    for i, c in enumerate(s):
        if c in SOFT_INNER and i < len(s) - 1:
            if out and out[-1] != ' ':
                out.append(' ')
            continue
        out.append(c)
    return re.sub(r' {2,}', ' ', ''.join(out)).strip()


def _slice(text, toks):
    return text[toks[0].start:toks[-1].end] if toks else ''


def _can_break_before(toks, j):
    """能不能在 toks[j] 之前断行 / 断条：行首不放收尾标点，行尾不放开头标点，拉丁词中间不断"""
    if j <= 0 or j >= len(toks):
        return False
    a, b = toks[j - 1], toks[j]
    if b.kind == 'punct' and (b.text in CLOSE or b.text in CJK_PUNCT and b.text not in OPEN):
        return False
    if a.kind == 'punct' and a.text in OPEN:
        return False
    return True


def _wrap(text, toks, cfg):
    """一条字幕 → 行（≤ maxLines 行、每行 ≤ maxChars）。两行时找最接近中点、守避头尾的断点，标点后优先"""
    whole = _style(_slice(text, toks), cfg)
    if text_width(whole) <= cfg.maxChars or cfg.maxLines == 1 or len(toks) < 2:
        return [whole]
    total = sum(t.width for t in toks)
    best, best_cost = None, None
    acc = 0.0
    for j in range(1, len(toks)):
        acc += toks[j - 1].width
        if not _can_break_before(toks, j):
            continue
        top, bottom = acc, total - acc
        if max(top, bottom) > cfg.maxChars + 1e-9:
            continue
        cost = abs(top - bottom) - (3.0 if _strength(toks[j - 1]) else 0.0)
        if best_cost is None or cost < best_cost:
            best, best_cost = j, cost
    if best is None:
        return [whole]                              # 放不进两行：调用方会再切条
    return [_style(_slice(text, toks[:best]), cfg), _style(_slice(text, toks[best:]), cfg)]


def _fits(text, toks, cfg):
    lines = _wrap(text, toks, cfg)
    return len(lines) <= cfg.maxLines and all(text_width(ln) <= cfg.maxChars + 1e-9 for ln in lines)


def _timed(toks):
    sp = [t for t in toks if t.kind != 'punct' and t.t0 is not None]
    if not sp:
        return None, None
    return sp[0].t0, sp[-1].t1


def _split(text, toks, cfg):
    """一段 → 若干条：先按句末、再按分句标点切，最后在字与字之间切；每条放得进 maxLines × maxChars、说完不超过 maxSec"""
    t0, t1 = _timed(toks)
    if _fits(text, toks, cfg) and (t0 is None or t1 - t0 <= cfg.maxSec):
        return [toks]
    for level in (3, 2, 1):
        cuts = [j + 1 for j, t in enumerate(toks[:-1]) if _strength(t) >= level and _can_break_before(toks, j + 1)]
        if cuts:
            # 选最接近"按宽度对半"的那个切点，两边再递归
            total = sum(t.width for t in toks)
            acc, best, best_d = 0.0, None, None
            for j in range(1, len(toks)):
                acc += toks[j - 1].width
                if j in cuts:
                    d = abs(acc - total / 2)
                    if best_d is None or d < best_d:
                        best, best_d = j, d
            return _split(text, toks[:best], cfg) + _split(text, toks[best:], cfg)
    # 没有标点可切：在字与字之间切（守避头尾），尽量满一条
    limit = cfg.maxChars * cfg.maxLines
    acc, last_ok = 0.0, None
    for j in range(1, len(toks)):
        acc += toks[j - 1].width
        if acc > limit + 1e-9:
            break
        if _can_break_before(toks, j):
            last_ok = j
    if last_ok is None or last_ok >= len(toks):
        return [toks]
    if t0 is not None and t1 - t0 > cfg.maxSec and _fits(text, toks, cfg):
        # 字数放得下，只是说得太久：按时间对半
        mid = (t0 + t1) / 2
        j = min(range(1, len(toks)), key=lambda k: abs((toks[k].t0 or mid) - mid) if _can_break_before(toks, k) else 1e9)
        return _split(text, toks[:j], cfg) + _split(text, toks[j:], cfg)
    return _split(text, toks[:last_ok], cfg) + _split(text, toks[last_ok:], cfg)


def cue_texts(text, units_timed, cfg):
    """一句台词 → 字幕条 [{text, lines, t0, t1, chars}]（t0 / t1 是这一条第一个字开口、最后一个字说完的绝对秒）"""
    disp, toks = tokens(text)
    spoken = [t for t in toks]
    if len(units_timed) != len(spoken):
        raise ValueError(f'逐字时间 {len(units_timed)} 个单位，字幕原文 {len(spoken)} 个单位：对不上（{text!r}）')
    for t, (_, a, b) in zip(toks, units_timed):
        t.t0, t.t1 = float(a), float(b)
    out = []
    for part in _split(disp, toks, cfg):
        t0, t1 = _timed(part)
        if t0 is None:                              # 只有标点：并进前一条
            continue
        lines = _wrap(disp, part, cfg)
        chars = round(sum(char_width(c) for t in part if t.kind != 'punct' for c in t.text if not c.isspace()), 1)
        out.append({'text': '\n'.join(lines), 'lines': lines, 't0': round(t0, 4), 't1': round(t1, 4), 'chars': chars})
    return out


def layout_frames(cues, fps, cfg, cuts=(), frames=None):
    """给每条字幕定起止帧（含义见文件头）。cues 按时间排序后就地加 startFrame / endFrame / speechEndFrame。返回 (cues, warnings)"""
    warns = []
    cues.sort(key=lambda c: (c['t0'], c.get('line', '')))
    cuts = sorted(int(c) for c in cuts)
    for c in cues:
        s = int(math.floor(c['t0'] * fps + 1e-6))
        se = int(math.ceil(c['t1'] * fps - 1e-6))
        for k in cuts:
            if 0 < s - k <= cfg.snapInFrames or 0 < k - s <= cfg.snapInFrames:
                s = k
                break
        want = max(s + int(math.ceil(cfg.minSec * fps - 1e-6)), int(math.ceil((c['t1'] + cfg.holdSec) * fps - 1e-6)))
        c['startFrame'], c['speechEndFrame'], c['endFrame'] = s, se, max(want, se + 1)
    for i, c in enumerate(cues):
        nxt = cues[i + 1]['startFrame'] if i + 1 < len(cues) else None
        limit = nxt - cfg.gapFrames if nxt is not None else (frames if frames else None)
        e = c['endFrame']
        # 切点吸附：说完以后的止点离切点不到 snapFrames → 落在切点上
        for k in cuts:
            if k >= c['speechEndFrame'] and abs(e - k) < cfg.snapFrames and k > c['startFrame']:
                if k < e and k - c['startFrame'] >= int(math.ceil(min(cfg.minSec, (c['t1'] - c['t0']) + cfg.holdSec) * fps - 1e-6)):
                    e = k
                elif k > e and (limit is None or k <= limit):
                    e = k
                break
        if limit is not None and e > limit:
            e = limit
        if e <= c['startFrame']:
            e = c['startFrame'] + 1
            warns.append({'code': 'subtitle.overlap', 'message': f'字幕 {c.get("id")} 与下一条挤在一起：只留了 1 帧',
                          'hint': '台词之间留出至少 gapFrames 帧，或把两句并成一条'})
        if e < c['speechEndFrame']:
            warns.append({'code': 'subtitle.cut-short', 'message': f'字幕 {c.get("id")} 在台词说完前 {c["speechEndFrame"] - e} 帧就被下一条顶掉',
                          'hint': '下一句晚一点开口，或两句并成一条'})
        c['endFrame'] = e
        dur = (e - c['startFrame']) / fps
        cps = c['chars'] / dur if dur > 0 else float('inf')
        c['cps'] = round(cps, 2)
        if cps > cfg.maxCps + 1e-9:
            warns.append({'code': 'subtitle.reading-speed', 'message': f'字幕 {c.get("id")} 每秒 {cps:.1f} 字，超过 {cfg.maxCps:g}：观众读不完',
                          'hint': '删字、拆成两条，或让这句说慢一点'})
        if dur > cfg.maxSec + 1e-9:
            warns.append({'code': 'subtitle.too-long', 'message': f'字幕 {c.get("id")} 停留 {dur:.1f} 秒，超过 {cfg.maxSec:g} 秒',
                          'hint': '在标点处拆开'})
        crossed = [k for k in cuts if c['startFrame'] < k < c['endFrame']]
        if crossed:
            c['crossesCut'] = crossed
    return cues, warns


def _hms(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return h, m, s, ms


def fmt_srt(sec):
    h, m, s, ms = _hms(sec)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def fmt_vtt(sec):
    h, m, s, ms = _hms(sec)
    return f'{h:02d}:{m:02d}:{s:02d}.{ms:03d}'


def fmt_ass(sec):
    cs = int(round(sec * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f'{h:d}:{m:02d}:{s:02d}.{cs:02d}'


def _write(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return path


def write_srt(path, cues, fps):
    blocks = [f'{i}\n{fmt_srt(c["startFrame"] / fps)} --> {fmt_srt(c["endFrame"] / fps)}\n{chr(10).join(c["lines"])}\n'
              for i, c in enumerate(cues, 1)]
    return _write(path, '\n'.join(blocks))


def write_vtt(path, cues, fps):
    blocks = ['WEBVTT\n'] + [f'{c.get("id", i)}\n{fmt_vtt(c["startFrame"] / fps)} --> {fmt_vtt(c["endFrame"] / fps)} line:-1 align:center\n'
                             f'{chr(10).join(c["lines"])}\n' for i, c in enumerate(cues, 1)]
    return _write(path, '\n'.join(blocks))


def write_ass(path, cues, fps, size=(1920, 1080), style=None):
    """ASS（给烧录或剪辑软件用）：字高约为画高的 4.5%，底边留 5% 安全区，描边 + 轻阴影；字体默认 Noto Sans SC"""
    w, h = size
    st = {'font': 'Noto Sans SC', 'sizeRatio': 0.045, 'marginRatio': 0.05, 'outline': 2.5, 'shadow': 1.0}
    st.update(style or {})
    fs = max(12, int(round(h * st['sizeRatio'])))
    mv = int(round(h * st['marginRatio']))
    ml = int(round(w * 0.05))
    head = ('[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n'
            '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, '
            'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            'Style: Default,{font},{fs},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,{ol},{sh},2,{ml},{ml},{mv},1\n\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n').format(
        w=w, h=h, font=st['font'], fs=fs, ol=st['outline'], sh=st['shadow'], ml=ml, mv=mv)
    ev = [f'Dialogue: 0,{fmt_ass(c["startFrame"] / fps)},{fmt_ass(c["endFrame"] / fps)},Default,{c.get("speaker", "")},0,0,0,,'
          + '\\N'.join(ln.replace('{', '（').replace('}', '）') for ln in c['lines']) for c in cues]
    return _write(path, head + '\n'.join(ev) + '\n')


_SRT_TIME = re.compile(r'(\d+):(\d\d):(\d\d)[,.](\d{3})')


def parse_time(s):
    m = _SRT_TIME.match(s.strip())
    if not m:
        raise ValueError(f'不是 SRT / VTT 时间：{s!r}')
    h, mi, se, ms = (int(g) for g in m.groups())
    return h * 3600 + mi * 60 + se + ms / 1000.0


def read_srt(path):
    """→ [{start, end, text}]（秒）；测试与核对用"""
    with open(path, encoding='utf-8') as f:
        blocks = [b for b in f.read().strip().split('\n\n') if b.strip()]
    out = []
    for b in blocks:
        ln = b.strip().split('\n')
        a, z = ln[1].split(' --> ')
        out.append({'start': parse_time(a), 'end': parse_time(z.split(' ')[0]), 'text': '\n'.join(ln[2:])})
    return out
