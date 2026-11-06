import sys
from PIL import Image
from gen import submit, wait, upload
from char import STYLE, NEG
from shots import SHOTS

im = Image.open("out/char_sheet_s11.png"); w, h = im.size; cw = int(h * 1.75)
im.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, h)).resize((1344, 768), Image.LANCZOS).save("out/ref_sheet_169.png")
REF = [upload("out/ref_sheet_169.png", "pv_ref_sheet.png"), upload("out/char_bust_s11.png", "pv_ref_bust.png")]
SINGLE = len(sys.argv) > 3 and sys.argv[3] == "single"
if SINGLE:  # 只给设定图：半身像当第二张参考时，常被画成画面里的第二个人
    REF = REF[:1]
KEEP = ("Keep her exact identity from the references: same face, long silver-white hair with cyan-blue gradient tips, thin braid on the left, "
        "glowing crescent-moon hairpin, bright violet eyes, white cropped jacket with glowing cyan circuit lines, navy sailor collar with cyan ribbon, "
        "black pleated skirt, black thigh-high boots, black fingerless gloves, white-handled katana with a glowing cyan blade.")


def kf_prompt(s):
    if SINGLE:
        return (f"Image 1 is the character design sheet of the girl Rin. Draw a brand-new single 16:9 anime movie frame "
                f"(not a character sheet, no multiple views, no white background). ONLY ONE girl appears in the image, exactly once: {s['kf']}. "
                f"{KEEP} {STYLE}, anime movie screenshot, dynamic composition.")
    return (f"Image 1 is the character design sheet and image 2 is a portrait of the same girl, Rin. Draw a brand-new single 16:9 anime movie frame "
            f"(not a character sheet, no multiple views, no white background): {s['kf']}. {KEEP} {STYLE}, anime movie screenshot, dramatic composition.")


ids = sys.argv[1].split(",") if len(sys.argv) > 1 else [s["id"] for s in SHOTS]
seeds = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [1]
jobs = [(f"out/kf/{s['id']}_s{sd}", submit({"mode": "edit", "prompt": kf_prompt(s), "negative": NEG, "ref_images": REF, "steps": 30, "seed": sd}))
        for s in SHOTS if s["id"] in ids for sd in seeds]
for out, pid in jobs:
    print(wait(pid, out), flush=True)
