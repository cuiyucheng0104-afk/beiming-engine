"""读点统一入口：v1（data/picks.json）→ v2（picks_v2.json）→ v3（picks_v3.json，Opus 精校）逐版合并。
同一镜头同一帧同名的点，新版覆盖旧版；v2 重读过的几何镜头（REREAD）不用 v1。"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REREAD = {"S03", "S07", "S21", "S23", "S25"}
FILES = ["data/picks.json", "data/picks_v2.json", "data/picks_v3.json", "data/picks_v4.json"]   # v4：开场 Opus 复核


def _load(i):
    p = os.path.join(HERE, FILES[i])
    return json.load(open(p))["shots"] if os.path.exists(p) else []


def _drops():
    p = os.path.join(HERE, "data/picks_drop.json")
    return {tuple(x) for x in json.load(open(p))["drop"]} if os.path.exists(p) else set()


def merged(shot):
    """→ [{"frame": f, "picks": [...]}, ...]，按帧排序；picks_drop.json 里的旧读点剔除（v3 同帧同名重读的除外）"""
    by = {}
    drop = _drops()
    for i in range(len(FILES)):
        if i == 0 and shot in REREAD:
            continue
        for s in _load(i):
            if s["shot"] != shot:
                continue
            for k in s["keys"]:
                d = by.setdefault(k["frame"], {})
                for p in k["picks"]:
                    if i < 3 and (shot, k["frame"], p["name"]) in drop:
                        continue
                    d[p["name"]] = p                      # 新版覆盖旧版
    return [{"frame": f, "picks": list(d.values())} for f, d in sorted(by.items()) if d]


def all_shots():
    ks = sorted({s["shot"] for i in range(len(FILES)) for s in _load(i)})
    return [{"shot": k, "keys": merged(k)} for k in ks]
