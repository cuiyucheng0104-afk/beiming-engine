"""每个视频镜头抽 4 帧（剪辑会用到的那段：src 起 + 按 speed 推进），每行一个镜头。"""
import subprocess, sys
from PIL import Image, ImageDraw, ImageFont
f = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 20)
out, ids = sys.argv[1], sys.argv[2].split(',')
v = sys.argv[3] if len(sys.argv) > 3 else '7'
W, H = 300, 172
o = Image.new('RGB', (W * 4 + 24, (H + 6) * len(ids)), 'white')
for r, sid in enumerate(ids):
    for c, fr in enumerate((2, 18, 34, 52)):
        p = f'/tmp/vs_{sid}_{c}.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'out/vid/{sid}_v{v}.mp4', '-vf', f'select=eq(n\\,{fr}),scale={W}:{H}', '-frames:v', '1', p])
        t = Image.open(p); d = ImageDraw.Draw(t)
        if c == 0: d.rectangle([0, 0, 50, 24], fill='black'); d.text((4, 1), sid, fill='yellow', font=f)
        o.paste(t, (c * (W + 8), r * (H + 6)))
o.save(out)
