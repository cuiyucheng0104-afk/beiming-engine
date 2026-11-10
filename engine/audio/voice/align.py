# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · 逐字时间：把一句台词切成计时单位，再把时间落到每个单位上。

计时单位（units）：汉字 / 假名一个字一个单位；拉丁字母、数字连成一个词一个单位；标点是零时长的「停顿」单位；
停顿标记 <#秒#>（与 MiniMax 的写法相同）是指定时长的停顿。
  units(text) → [Unit(text, kind, weight, pause)]          kind：char / word / punct / pause；weight 是相对念的时长
  split_pauses(text) → [(文本段, 段后停顿秒), …]            按 <#秒#> 切段（不支持停顿标记的 TTS 逐段合成再拼起来）
  strip_markers(text) → 去掉停顿标记的文本
  from_provider(us, words) → [[单位, 起, 止], …]           TTS 给了逐字 / 逐词时间戳：按单位重新分配（timing = "tts"）
  proportional(audio, sr, us) → ([[单位, 起, 止], …], 说明)   没有时间戳：按能量找出声段与停顿，标点对齐到停顿，
                                                         段内按单位权重比例分配（timing = "proportional"，method 写明锚点）
时间都是相对这句开头的秒（保留 4 位小数）；标点单位的起止相同（落在停顿里）。
"""
import re
import unicodedata

import numpy as np

PAUSE_RE = re.compile(r'<#\s*([0-9]*\.?[0-9]+)\s*#>')
_WORD = re.compile(r"[A-Za-z0-9]+(?:['’\-.][A-Za-z0-9]+)*")
STRONG = set('。！？!?…')
MEDIUM = set('；;：:')
WEAK = set('，,、')
CLOSE = set('，。、；：？！）》」』】〕…—,.;:?!)]}"\'”’')       # 不放在行首（避头）
OPEN = set('（《「『【〔([{"“‘')                                  # 不放在行尾（避尾）


class Unit:
    __slots__ = ('text', 'kind', 'weight', 'pause')

    def __init__(self, text, kind, weight=0.0, pause=0.0):
        self.text, self.kind, self.weight, self.pause = text, kind, weight, pause

    def __repr__(self):
        return f'Unit({self.text!r}, {self.kind})'


def _is_cjk(ch):
    o = ord(ch)
    return (0x3400 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0x20000 <= o <= 0x2FFFF or 0x3040 <= o <= 0x30FF
            or 0xAC00 <= o <= 0xD7AF)


def _is_punct(ch):
    return unicodedata.category(ch).startswith('P') or ch in '…—～~'


def _syllables(word):
    """拉丁词的粗略音节数（念的时长权重）：元音组的个数，至少 1；纯数字按位数"""
    if word.isdigit():
        return max(1, len(word))
    return max(1, len(re.findall(r'[aeiouyAEIOUY]+', word)))


def units(text):
    out, i = [], 0
    while i < len(text):
        m = PAUSE_RE.match(text, i)
        if m:
            out.append(Unit(m.group(0), 'pause', 0.0, float(m.group(1))))
            i = m.end()
            continue
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        m = _WORD.match(text, i)
        if m and not _is_cjk(ch):
            out.append(Unit(m.group(0), 'word', float(_syllables(m.group(0)))))
            i = m.end()
            continue
        if _is_punct(ch):
            out.append(Unit(ch, 'punct', 0.0))
        else:
            out.append(Unit(ch, 'char', 1.0))
        i += 1
    return out


def split_pauses(text):
    segs, pos = [], 0
    for m in PAUSE_RE.finditer(text):
        segs.append((text[pos:m.start()], float(m.group(1))))
        pos = m.end()
    segs.append((text[pos:], 0.0))
    return [(s, p) for s, p in segs if s.strip() or p > 0]


def strip_markers(text):
    return PAUSE_RE.sub('', text)


def punct_strength(ch):
    return 3 if ch in STRONG else (2 if ch in MEDIUM else (1 if ch in WEAK else 1))


def from_provider(us, words):
    """words = [[文本, 起, 止], …]（TTS 的逐字或逐词时间戳，按时间顺序）。把两边都拆成字符序列做序列比对（difflib）：
    对上的字符直接取 TTS 的时间，对不上的（读法与字面不同、TTS 漏字）在两侧对上的字符之间线性插值；单位取首字符起、末字符止。"""
    import difflib
    spoken = [u for u in us if u.kind in ('char', 'word')]
    pc, pt = [], []
    for w, a, b in words or []:
        s = ''.join(c for c in str(w) if not c.isspace() and not _is_punct(c))
        for k, c in enumerate(s):
            pc.append(c.lower())
            pt.append((a + (b - a) * k / len(s), a + (b - a) * (k + 1) / len(s)))
    if not spoken or not pc:
        return [[u.text, 0.0, 0.0] for u in us]
    oc = [c.lower() for u in spoken for c in u.text]
    t0 = [None] * len(oc)
    t1 = [None] * len(oc)
    for blk in difflib.SequenceMatcher(a=oc, b=pc, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            t0[blk.a + k], t1[blk.a + k] = pt[blk.b + k]
    known = [i for i in range(len(oc)) if t0[i] is not None]
    end = pt[-1][1]
    for i in range(len(oc)):
        if t0[i] is None:
            lo = max([j for j in known if j < i], default=None)
            hi = min([j for j in known if j > i], default=None)
            a = t1[lo] if lo is not None else 0.0
            b = t0[hi] if hi is not None else end
            n = (hi if hi is not None else len(oc)) - (lo if lo is not None else -1) - 1
            k = i - (lo if lo is not None else -1) - 1
            t0[i], t1[i] = a + (b - a) * k / n, a + (b - a) * (k + 1) / n
    out, ci, last = [], 0, 0.0
    span = {}
    for u in spoken:
        n = len(u.text)
        span[id(u)] = (t0[ci], t1[ci + n - 1])
        ci += n
    for u in us:
        if id(u) in span:
            a, b = span[id(u)]
            a = max(a, last)
            b = max(b, a)
            out.append([u.text, round(a, 4), round(b, 4)])
            last = b
        else:
            out.append([u.text, round(last, 4), round(last, 4)])
    return out


def voiced_regions(audio, sr, frame=0.01, rel_db=-35.0, min_gap=0.08):
    """→ [(起, 止), …] 有声段（秒）：10 ms 均方根比 95 分位低 35 dB 以内算有声，短于 min_gap 的空隙并掉"""
    x = np.asarray(audio, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    h = max(1, int(round(frame * sr)))
    m = len(x) // h
    if m == 0:
        return []
    e = np.sqrt(np.mean(x[:m * h].reshape(m, h) ** 2, axis=1) + 1e-20)
    ref = np.percentile(e, 95)
    if ref <= 1e-9:
        return []
    on = 20 * np.log10(e / ref) > rel_db
    regs, i = [], 0
    while i < m:
        if on[i]:
            j = i
            while j < m and on[j]:
                j += 1
            regs.append([i * frame, j * frame])
            i = j
        else:
            i += 1
    merged = []
    for a, b in regs:
        if merged and a - merged[-1][1] < min_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(round(a, 4), round(b, 4)) for a, b in merged]


def proportional(audio, sr, us):
    """没有时间戳时的对齐：停顿锚定的按比例分配。返回 ([[单位, 起, 止], …], {method, regions, anchors})"""
    regs = voiced_regions(audio, sr)
    dur = len(audio) / sr
    if not regs:
        regs = [(0.0, dur)]
    v0, v1 = regs[0][0], regs[-1][1]
    gaps = [(regs[i][1], regs[i + 1][0]) for i in range(len(regs) - 1) if regs[i + 1][0] - regs[i][1] >= 0.12]
    # 短语边界：每个标点 / 停顿标记之后（句末的不算）
    phrases, cur = [], []
    bounds = []
    for u in us:
        if u.kind in ('punct', 'pause'):
            if cur:
                phrases.append(cur)
                cur = []
                bounds.append(punct_strength(u.text) + (2 if u.kind == 'pause' else 0))
            continue
        cur.append(u)
    if cur:
        phrases.append(cur)
    elif bounds:
        bounds.pop()
    anchors, method = [], 'uniform'
    if len(phrases) > 1 and gaps:
        need = len(phrases) - 1
        if len(gaps) >= need:
            pick = sorted(sorted(range(len(gaps)), key=lambda i: gaps[i][1] - gaps[i][0], reverse=True)[:need])
            anchors = [gaps[i] for i in pick]
            method = 'pause-anchored'
        else:
            # 停顿不够：先给最强的标点
            order = sorted(range(need), key=lambda i: -bounds[i])[:len(gaps)]
            slots = sorted(order)
            anchors = [None] * need
            for g, b in zip(gaps, slots):
                anchors[b] = g
            method = 'pause-anchored-partial'
    # 每个短语的时间跨度
    spans = []
    if method == 'uniform':
        W = sum(u.weight for p in phrases for u in p) or 1.0
        t = v0
        for p in phrases:
            w = sum(u.weight for u in p)
            spans.append((t, t + (v1 - v0) * w / W))
            t = spans[-1][1]
    else:
        starts, ends = [v0], []
        for a in anchors:
            ends.append(a[0] if a else None)
            starts.append(a[1] if a else None)
        ends.append(v1)
        # 没有锚点的边界：在相邻锚点之间按权重插值
        idx = [i for i, s in enumerate(starts) if s is not None]
        for i in range(len(phrases)):
            if starts[i] is None or ends[i] is None:
                lo = max(j for j in idx if j <= i)
                hi = min([j for j in idx if j > i] + [len(phrases)])
                t0 = starts[lo]
                t1 = ends[hi - 1] if ends[hi - 1] is not None else (starts[hi] if hi < len(phrases) else v1)
                W = sum(u.weight for p in phrases[lo:hi] for u in p) or 1.0
                acc = sum(u.weight for p in phrases[lo:i] for u in p)
                w = sum(u.weight for u in phrases[i])
                a = t0 + (t1 - t0) * acc / W
                spans.append((a, a + (t1 - t0) * w / W))
            else:
                spans.append((starts[i], ends[i]))
    timing = {}
    for p, (a, b) in zip(phrases, spans):
        W = sum(u.weight for u in p) or 1.0
        t = a
        for u in p:
            d = (b - a) * u.weight / W
            timing[id(u)] = (t, t + d)
            t += d
    out, last = [], 0.0
    for u in us:
        if id(u) in timing:
            a, b = timing[id(u)]
            out.append([u.text, round(a, 4), round(b, 4)])
            last = b
        else:
            out.append([u.text, round(last, 4), round(last, 4)])
    return out, {'method': method, 'regions': [list(r) for r in regs], 'anchors': [list(a) if a else None for a in anchors]}
