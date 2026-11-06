"""每个镜头：FastH3 Omni 多参考（参考图 = 角色半身像 + 本镜关键帧；关键帧同时钉在第 0 帧）。
用法：step3_video.py <shot_ids 逗号分隔|all> [seed]
关键帧取 picks.json 里选定的版本（没选就用 seed 1）。"""
import json
import os
import sys

from gen import submit, upload, wait
from shots import SHOTS

picks = json.load(open("picks.json")) if os.path.exists("picks.json") else {}
ids = None if len(sys.argv) < 2 or sys.argv[1] == "all" else sys.argv[1].split(",")
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7

PROMPT = ("2D anime style animation, cel shading, clean lineart, fluid high-quality anime movie animation. "
          "<Picture 1> is the girl Rin: long silver-white hair with cyan-blue tips, violet eyes, crescent-moon hairpin, white jacket with glowing cyan lines, "
          "navy sailor collar, black pleated skirt, glowing cyan katana. <Picture 2> shows the opening frame of this shot. "
          "{move} Keep the anime art style and her design consistent throughout. "
          "Audio: only ambient sound effects of the scene, no speech, no singing, no music. No text, no subtitles.")

jobs = []
for s in SHOTS:
    if ids and s["id"] not in ids:
        continue
    kf_local = f"out/kf/{s['id']}_s{picks.get(s['id'], 1)}.png"
    kf = upload(kf_local, f"pv_kf_{s['id']}.png")
    p = {"mode": "multiref", "engine": "fasth3_omni", "prompt": PROMPT.format(move=s["move"]),
         "ref_images": ["pv_ref_bust.png", kf], "keyframes": [{"image": kf, "time": 0}],
         "seconds": 2, "aspect": "16:9", "megapixels": 0.9, "seed": seed, "rtx_sr": True}
    jobs.append((s["id"], submit(p)))
for sid, pid in jobs:
    try:
        print(sid, wait(pid, f"out/vid/{sid}_v{seed}"), flush=True)
    except Exception as e:  # keep going; report at the end
        print(sid, "ERROR", str(e)[:300], flush=True)
