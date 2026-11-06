from gen import submit, wait
from char import CHAR, STYLE, NEG
jobs = []
for seed in (11, 22):
    jobs.append((f"out/char_sheet_s{seed}", submit({"mode": "t2i", "prompt": f"Full-body character design sheet of {CHAR}. Three views side by side: front view, side view, back view, standing neutral pose holding the sheathed katana, plain light gray background. {STYLE}", "negative": NEG, "aspect": "16:9", "megapixels": 1.6, "steps": 30, "seed": seed})))
    jobs.append((f"out/char_bust_s{seed}", submit({"mode": "t2i", "prompt": f"Bust portrait of {CHAR}, three-quarter view, gentle determined expression, wind blowing her hair, soft rim light, simple gradient background. {STYLE}", "negative": NEG, "aspect": "3:4", "megapixels": 1.2, "steps": 30, "seed": seed})))
for out, pid in jobs:
    print(wait(pid, out))
