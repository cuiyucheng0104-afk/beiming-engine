"""按节拍表剪成片：每个镜头的起止帧都由绝对时间换算（24fps 四舍五入），不累积误差。
效果：drop / 重击镜头开头闪白；推进段最后一拍黑场；结尾叠片名；配乐 = music.wav（生成视频的声音不用）。
用法：edit.py [out.mp4]
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from shots import SHOTS, at

FPS = 24
W, H = 1920, 1080
OUT = sys.argv[1] if len(sys.argv) > 1 else "AFTERGLOW_PV.mp4"
picks = json.load(open("picks.json")) if os.path.exists("picks.json") else {}
vpicks = json.load(open("vpicks.json")) if os.path.exists("vpicks.json") else {}
os.makedirs("out/seg", exist_ok=True)

# 每镜的剪辑参数：src = 从生成视频第几秒开始取，speed = 播放速度，flash = 开头闪白秒数
CUT = {
    "s01": dict(src=0.2), "s02": dict(src=0.3), "s03": dict(src=0.1, speed=1.15), "s04": dict(src=0.3, speed=1.3),
    "s05": dict(src=0.2, speed=1.3),
    "s06": dict(src=0.2, speed=1.4, flash=0.18), "s07": dict(src=0.2, speed=1.4), "s08": dict(src=0.2, speed=1.3),
    "s09": dict(src=0.2, speed=1.5, flash=0.12), "s10": dict(src=0.2, speed=1.4), "s11": dict(src=0.2, speed=1.3, flash=0.1),
    "s12": dict(src=0.4, speed=1.3), "s13": dict(src=0.2, speed=1.5), "s14": dict(src=0.2),
    "s15": dict(src=0.1, flash=0.35), "s16": dict(src=0.2),
    "s17": dict(src=0.2, speed=1.1), "s18": dict(src=0.2, speed=1.2), "s19": dict(src=0.3, speed=1.5),
    "s20": dict(src=0.2, speed=1.4, flash=0.18), "s21": dict(src=0.2, speed=1.4), "s22": dict(src=0.2, speed=1.3),
    "s23": dict(src=0.2, speed=1.4, flash=0.15), "s24": dict(src=0.2), "s25": dict(src=0.2),
    "s26": dict(src=0.1, flash=0.3),
}
GAPS = [(at(3, 3), at(4)), (at(11, 3), at(12))]  # 推进段最后一拍：黑场


def frame(t):
    return int(round(t * FPS))


def run(cmd):
    subprocess.run(cmd, check=True)


def title_png(path):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 150)
    zh = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 64)
    small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 30)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd, d = ImageDraw.Draw(glow), ImageDraw.Draw(img)

    cx = W * 0.30  # 片名放在左侧空天空，避开右边的人物

    def centered(draw, y, text, font, fill, spacing=0):
        x = cx - (sum(draw.textlength(c, font=font) + spacing for c in text) - spacing) / 2
        for c in text:
            draw.text((x, y), c, font=font, fill=fill)
            x += draw.textlength(c, font=font) + spacing

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for draw, fill in ((sd, (20, 30, 60, 170)), (gd, (90, 220, 255, 255)), (d, (255, 255, 255, 255))):
        centered(draw, 330, "AFTERGLOW", big, fill, spacing=10)
        centered(draw, 510, "星 痕", zh, fill, spacing=24)
        centered(draw, 610, "ORIGINAL ANIME PV   2026", small, fill if draw is not d else (240, 245, 255, 240), spacing=6)
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    glow = glow.filter(ImageFilter.GaussianBlur(14))
    Image.alpha_composite(Image.alpha_composite(shadow, glow), img).save(path)


segs = []
timeline = sorted([(s["t0"], s["t1"], s) for s in SHOTS] + [(a, b, None) for a, b in GAPS], key=lambda x: x[0])
for i, (t0, t1, s) in enumerate(timeline):
    n = frame(t1) - frame(t0)
    out = f"out/seg/{i:02d}.mp4"
    if s is None:
        run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={FPS}", "-frames:v", str(n),
             "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", out])
        segs.append(out)
        continue
    c = CUT.get(s["id"], {})
    src = f"out/vid/{s['id']}_v{vpicks.get(s['id'], 7)}.mp4"
    speed, start, flash = c.get("speed", 1.0), c.get("src", 0.2), c.get("flash", 0)
    vf = [f"trim=start={start}", "setpts=PTS-STARTPTS", f"setpts=PTS/{speed}", f"fps={FPS}",
          f"scale={W}:-2:flags=lanczos", f"crop={W}:{H}", "setsar=1", f"tpad=stop_mode=clone:stop={n}"]
    if flash:
        vf.append(f"fade=t=in:st=0:d={flash}:c=white")
    if s["id"] == "s26":
        vf.append(f"fade=t=out:st={(n / FPS) - 0.35:.3f}:d=0.35")
    if s["id"] == "s26":  # 片名镜头用关键帧静帧 + 缓推（视频版构图偏到中间，会压到左边的片名）
        kf = f"out/kf/s26_s{picks.get('s26', 1)}.png"
        z = [f"scale={W * 2}:{H * 2}:flags=lanczos", f"zoompan=z='1+0.035*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={W}x{H}:fps={FPS}",
             "setsar=1", f"fade=t=in:st=0:d={flash}:c=white", f"fade=t=out:st={(n / FPS) - 0.35:.3f}:d=0.35"]
        run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", kf, "-vf", ",".join(z), "-frames:v", str(n),
             "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", "-r", str(FPS), out])
        segs.append(out)
        continue
    run(["ffmpeg", "-v", "error", "-y", "-i", src, "-an", "-vf", ",".join(vf), "-frames:v", str(n),
         "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", "-r", str(FPS), out])
    segs.append(out)

open("out/seg/list.txt", "w").write("".join(f"file '{os.path.abspath(p)}'\n" for p in segs))
run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", "out/seg/list.txt", "-c", "copy", "out/seg/video.mp4"])

title_png("out/title.png")
t_title = at(15) + 0.35
run(["ffmpeg", "-v", "error", "-y", "-i", "out/seg/video.mp4", "-loop", "1", "-i", "out/title.png", "-i", "music.wav",
     "-filter_complex",
     f"[1]format=rgba,fade=t=in:st={t_title}:d=0.5:alpha=1,fade=t=out:st=29.6:d=0.35:alpha=1[t];"
     f"[0][t]overlay=0:0:shortest=1:enable='gte(t,{t_title})'[v]",
     "-map", "[v]", "-map", "2:a", "-t", "30", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", OUT])
print(OUT, subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT],
                          capture_output=True, text=True).stdout.strip())
