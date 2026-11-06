"""旁白逐字时间戳 → 字幕时间表（可重跑）。
输入：data/subs_raw/nXX.titles（MiniMax subtitle_file，已下载存档）+ data/timeline.json（旁白起点）
输出：data/words.json 逐字时间；data/subs.json  [{id, seg, vo, t0, t1, text, style}]（绝对秒）；jianlong.srt
切句：先按 ，。：；！？ 断成小句，再把相邻小句贪心合并，每行 ≤18 字（句中标点算字，行尾标点去掉不计）。
行尾的 ，。： 去掉，句中标点保留。时间：首字 time_begin → 末字 time_end；
每条至少显示 max(1.8 s, 念完 + 0.6 s)，但不压到下一条（留 0.05 s）；最后一条最多延到段尾。
style：present（墨色半透明条、纸色字）/ flash（宣纸色条、墨色字），由旁白所在段决定（S12–S17 为 flash）。
"""
import json, os, re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAXC = 18
PUNCT = '，。：；！？、'
FLASH = {'S12', 'S13', 'S14', 'S15', 'S16', 'S17'}


def words_of(n):
    d = json.load(open(f'{HERE}/data/subs_raw/{n}.titles'))
    ws = []
    for s in d:
        for w in s['timestamped_words']:
            ws.append((w['word'], w['time_begin'] / 1000, w['time_end'] / 1000))
    return ws


def clauses(ws):
    out, cur = [], []
    for w in ws:
        cur.append(w)
        if w[0] in PUNCT: out.append(cur); cur = []
    if cur: out.append(cur)
    return out


def nchar(c): return sum(1 for w in c if w[0] not in PUNCT)


def merge(cl):
    """整句旁白的小句做最优分行：行数最少优先，其次各行长短均衡、尽量在句末断、每行念的时间不太短"""
    n = len(cl); INF = float('inf')
    L = [len(c) for c in cl]   # 返修第 8 条：句中标点也算字（审片按屏幕上的实际字数数，原来不计标点，3 行实际 19–20 字）
    best = {n: (0, 0.0, [])}   # i → (行数, 代价, 分行)
    for i in range(n - 1, -1, -1):
        cand = None
        for j in range(i + 1, n + 1):
            ln = sum(L[i:j]) - (1 if cl[j - 1][-1][0] in PUNCT else 0)   # 行尾标点会去掉，不计
            if ln > MAXC: break
            k, cost, rest = best[j]
            line = [w for c in cl[i:j] for w in c]
            c2 = (MAXC - ln) ** 2 * 0.1
            if line[-1][0] not in '。！？：' and j < n: c2 += 8          # 句中断行略罚
            if line[-1][2] - line[0][1] < 1.2: c2 += 25                  # 念得太快的短行重罚
            if ln <= 2 and n > 1: c2 += 40                              # 单字、两字孤行重罚
            tot = (k + 1, cost + c2, [line] + rest)
            if cand is None or tot[:2] < cand[:2]: cand = tot
        best[i] = cand
    return best[0][2]


def main():
    tl = json.load(open(f'{HERE}/data/timeline.json'))
    cues = []
    for s in tl['segments']:
        vo = s.get('vo')
        if not vo: continue
        ws = words_of(vo['id'])
        for ln in merge(clauses(ws)):
            text = ''.join(w[0] for w in ln).rstrip('，。：；、')
            assert len(text) <= MAXC, text
            cues.append(dict(id=f"{vo['id']}_{len([c for c in cues if c['vo'] == vo['id']])}", seg=s['seg'], vo=vo['id'],
                             t0=round(vo['start'] + ln[0][1], 3), speak_end=round(vo['start'] + ln[-1][2], 3),
                             seg_end=s['end'], text=text, style='flash' if s['seg'] in FLASH else 'present'))
    for i, c in enumerate(cues):
        nxt = cues[i + 1]['t0'] - 0.05 if i + 1 < len(cues) else 1e9
        want = max(c['t0'] + 1.8, c['speak_end'] + 0.6)
        c['t1'] = round(min(want, nxt, c['seg_end'] if c is cues[-1] or cues[i + 1]['seg'] != c['seg'] else 1e9), 3)
        c['t1'] = max(c['t1'], round(min(c['speak_end'] + 0.15, nxt), 3))
    for c in cues: c.pop('seg_end')
    # 逐字时间（相对每句旁白开头，秒）：页面用 api.words() 做逐字出字、口型、标签对齐
    words = {}
    for s in tl['segments']:
        if s.get('vo'): words[s['vo']['id']] = [[w, round(a, 3), round(b, 3)] for w, a, b in words_of(s['vo']['id'])]
    json.dump(words, open(f'{HERE}/data/words.json', 'w'), ensure_ascii=False)
    json.dump(cues, open(f'{HERE}/data/subs.json', 'w'), ensure_ascii=False, indent=1)
    def ts(x):
        ms = int(round(x * 1000)); return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
    with open(f'{HERE}/jianlong.srt', 'w') as f:
        for i, c in enumerate(cues): f.write(f"{i + 1}\n{ts(c['t0'])} --> {ts(c['t1'])}\n{c['text']}\n\n")
    short = [c for c in cues if c['t1'] - c['t0'] < 1.8]
    print(len(cues), '条字幕；短于 1.8 s 的：', [(c['id'], round(c['t1'] - c['t0'], 2), c['text']) for c in short])


if __name__ == '__main__':
    main()
