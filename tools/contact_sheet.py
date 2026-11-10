# -*- coding: utf-8 -*-
"""联系表（接触印）：把一次运行的若干帧拼成一张审片图——概览格子 + 切点逐帧条 + 镜头时间条。

两种用法：
  python tools/contact_sheet.py <输出.jpg> --manifest <清单.json> [--width 400]
      清单由 node tools/film/cli.mjs 写（build / animatic / stills / render 都会调用）：
      { title, film, run, profile, kind, width, height, fps, frames, shots: [{id, in, out}], cuts: [帧号],
        tiles: [{file, frame, shot, cut}], strips: [{cut, tiles: [...]}], truncatedStrips }
      每格标帧号、时间码（时:分:秒:帧）、镜头号；切点帧左侧加一道醒目竖条，切点逐帧条里切点前后用竖线分开。
  python tools/contact_sheet.py <输出.jpg> a.jpg b.jpg … [--cols 4] [--w 480]
      旧用法：按给定顺序拼图，格子标文件名。

只用 Pillow。字体：拉丁字母与数字用仓库的 fonts/Barlow-500.woff2；标题里的中文依次试 BEIMING_SHEET_FONT、
仓库 fonts/ 子集与系统中文字体，都缺字时改用作品 id（只影响审片图，不影响成片）。
退出码：0 成功；1 读不了图或写不了文件；2 用法错误。出错只打印一行原因。
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BG = (22, 23, 28)
PANEL = (30, 32, 39)
FG = (232, 234, 238)
DIM = (139, 144, 154)
ACCENT = (255, 122, 69)        # 切点
SHOT_TINTS = [(74, 98, 140), (98, 84, 140), (70, 120, 112), (132, 98, 74)]

CJK_CANDIDATES = [
    'fonts/NotoSansSC-var.woff2',
    '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc',
]


class SheetError(Exception):
    pass


def die(msg, code=1):
    print(f'contact_sheet.py：{msg}', file=sys.stderr)
    sys.exit(code)


def load_pil():
    try:
        from PIL import Image, ImageDraw, ImageFont  # noqa: F401
        return Image, ImageDraw, ImageFont
    except ImportError:
        die('缺少 Pillow：pip install -r requirements.txt，或用 PYTHON=<装了 Pillow 的 python> 运行', 3)


def latin_font(ImageFont, size):
    for p in [ROOT / 'fonts' / 'Barlow-500.woff2', ROOT / 'fonts' / 'Barlow-400.woff2']:
        try:
            return ImageFont.truetype(str(p), size)
        except Exception:
            continue
    return ImageFont.load_default()


def covers(Image, ImageDraw, font, text):
    """字体是否画得出 text 里的每个字：与必然缺字的私用区码位渲染结果比较，相同即缺字。"""
    def raster(ch):
        im = Image.new('L', (64, 64), 0)
        ImageDraw.Draw(im).text((4, 4), ch, font=font, fill=255)
        return im.tobytes()
    try:
        missing = raster('\U000F0000')
        return all(ch.isspace() or ord(ch) < 128 or raster(ch) != missing for ch in text)
    except Exception:
        return False


def cjk_font(Image, ImageDraw, ImageFont, size, text):
    cands = ([os.environ['BEIMING_SHEET_FONT']] if os.environ.get('BEIMING_SHEET_FONT') else []) + CJK_CANDIDATES
    for c in cands:
        p = Path(c) if os.path.isabs(c) else ROOT / c
        if not p.exists():
            continue
        try:
            f = ImageFont.truetype(str(p), size)
        except Exception:
            continue
        if covers(Image, ImageDraw, f, text):
            return f
    return None


def timecode(frame, fps):
    s, f = divmod(int(frame), int(fps))
    return f'{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}:{f:02d}'


def open_rgb(Image, path):
    try:
        with Image.open(path) as im:
            return im.convert('RGB')
    except Exception as e:
        raise SheetError(f'读不了图 {path}：{e}')


def fit(Image, im, w, h):
    return im.resize((w, h), Image.LANCZOS)


def manifest_sheet(out, m, tile_w):
    Image, ImageDraw, ImageFont = load_pil()
    fps = int(m.get('fps') or 24)
    W, H = int(m.get('width') or 1920), int(m.get('height') or 1080)
    portrait = H > W
    tile_w = tile_w or (220 if portrait else 400)
    cols = 6 if portrait else 4
    tile_h = round(tile_w * H / W)
    cap_h = 26
    pad = 16
    tiles = m.get('tiles') or []
    strips = m.get('strips') or []
    if not tiles and not strips:
        raise SheetError('清单里没有任何帧（tiles / strips 都是空的）')
    shots = m.get('shots') or []
    cuts = set(m.get('cuts') or [])
    frames = int(m.get('frames') or 0)

    f_title_text = str(m.get('title') or m.get('film') or '')
    f_title = cjk_font(Image, ImageDraw, ImageFont, 30, f_title_text)
    title_text = f_title_text if f_title else str(m.get('film') or 'film')
    f_title = f_title or latin_font(ImageFont, 30)
    f_meta = latin_font(ImageFont, 15)
    f_cap = latin_font(ImageFont, 14)
    f_small = latin_font(ImageFont, 12)
    zh = cjk_font(Image, ImageDraw, ImageFont, 14, '切点逐帧镜头概览预演关键帧工作版终渲')

    grid_w = cols * tile_w + (cols - 1) * 8
    strip_tile_w = max(120, (grid_w - 150 - 5 * 6) // 6)
    strip_tile_h = round(strip_tile_w * H / W)
    rows = (len(tiles) + cols - 1) // cols
    header_h = 96
    grid_h = rows * (tile_h + cap_h + 8)
    strips_h = (34 + len(strips) * (strip_tile_h + cap_h + 12)) if strips else 0
    timeline_h = 64 if frames else 0
    sheet_w = grid_w + 2 * pad
    sheet_h = header_h + grid_h + strips_h + timeline_h + 2 * pad
    sheet = Image.new('RGB', (sheet_w, sheet_h), BG)
    d = ImageDraw.Draw(sheet)

    # 页眉：片名 + 规格 + 运行
    d.text((pad, pad), title_text, font=f_title, fill=FG)
    kind = {'build': 'BUILD', 'animatic': 'ANIMATIC', 'stills': 'LOOK STILLS', 'render': 'FRAMES'}.get(m.get('kind'), str(m.get('kind') or '').upper())
    meta = f"{m.get('film', '')}  ·  {kind}  ·  {m.get('profile', '')}  ·  {W}x{H} @ {fps} fps  ·  {frames} frames  ·  {timecode(frames, fps) if frames else ''}"
    d.text((pad, pad + 42), meta, font=f_meta, fill=DIM)
    d.text((pad, pad + 64), f"run {m.get('run', '')}", font=f_small, fill=DIM)

    def caption(x, y, w, t, highlight=False):
        fr = int(t['frame'])
        d.rectangle([x, y, x + w - 1, y + cap_h - 1], fill=PANEL)
        d.text((x + 8, y + 5), f'F{fr:04d}', font=f_cap, fill=ACCENT if highlight else FG)
        d.text((x + 64, y + 5), timecode(fr, fps), font=f_cap, fill=DIM)
        sid = str(t.get('shot') or '')
        if sid:
            tw = d.textlength(sid, font=f_cap)
            d.text((x + w - tw - 8, y + 5), sid, font=f_cap, fill=FG)

    # 概览
    y0 = pad + header_h
    for k, t in enumerate(tiles):
        x = pad + (k % cols) * (tile_w + 8)
        y = y0 + (k // cols) * (tile_h + cap_h + 8)
        sheet.paste(fit(Image, open_rgb(Image, t['file']), tile_w, tile_h), (x, y))
        is_cut = bool(t.get('cut')) or int(t['frame']) in cuts
        if is_cut:
            d.rectangle([x, y, x + 4, y + tile_h - 1], fill=ACCENT)
        caption(x, y + tile_h, tile_w, t, is_cut)

    # 切点逐帧条：c−3 … c+2，切点前后之间画竖线
    y = y0 + grid_h
    if strips:
        label = '切点逐帧（前 3 帧 | 后 3 帧）' if zh else 'CUTS  (3 frames before | 3 after)'
        d.text((pad, y + 8), label, font=zh or f_meta, fill=DIM)
        if m.get('truncatedStrips'):
            d.text((pad + 360, y + 10), f"+{m['truncatedStrips']} more cuts not shown", font=f_small, fill=DIM)
        y += 34
        for s in strips:
            c = int(s['cut'])
            before = next((x['shot'] for x in s['tiles'] if int(x['frame']) == c - 1), '')
            after = next((x['shot'] for x in s['tiles'] if int(x['frame']) == c), '')
            d.text((pad, y + 6), f'{before} > {after}', font=f_meta, fill=FG)
            d.text((pad, y + 28), f'F{c:04d}', font=f_cap, fill=ACCENT)
            d.text((pad, y + 46), timecode(c, fps), font=f_small, fill=DIM)
            x = pad + 150
            for t in s['tiles']:
                fr = int(t['frame'])
                if fr == c:
                    d.rectangle([x - 5, y - 2, x - 3, y + strip_tile_h + cap_h + 1], fill=ACCENT)
                sheet.paste(fit(Image, open_rgb(Image, t['file']), strip_tile_w, strip_tile_h), (x, y))
                caption(x, y + strip_tile_h, strip_tile_w, t, fr == c)
                x += strip_tile_w + 6
            y += strip_tile_h + cap_h + 12

    # 镜头时间条：镜头分段、切点、概览格所在位置
    if frames:
        ty = sheet_h - pad - 40
        x0, x1 = pad, sheet_w - pad
        span = x1 - x0
        px = lambda f: x0 + span * f / frames  # noqa: E731
        segs = shots if shots else [{'id': '', 'in': 0, 'out': frames}]
        for i, s in enumerate(segs):
            a, b = px(int(s['in'])), px(int(s['out']))
            d.rectangle([a, ty, max(a + 1, b - 1), ty + 22], fill=SHOT_TINTS[i % len(SHOT_TINTS)])
            if s.get('id') and b - a > 30:
                d.text((a + 6, ty + 4), str(s['id']), font=f_small, fill=FG)
        for c in sorted(cuts):
            cx = px(c)
            d.rectangle([cx - 1, ty - 4, cx + 1, ty + 26], fill=ACCENT)
        for t in tiles:
            tx = px(int(t['frame']) + 0.5)
            d.ellipse([tx - 2, ty + 28, tx + 2, ty + 32], fill=DIM)
        d.text((x0, ty + 34), timecode(0, fps), font=f_small, fill=DIM)
        end = timecode(frames, fps)
        d.text((x1 - d.textlength(end, font=f_small), ty + 34), end, font=f_small, fill=DIM)

    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        sheet.save(out, quality=90, optimize=True, progressive=True)
    except Exception as e:
        raise SheetError(f'写不了 {out}：{e}')
    return sheet.size


def legacy_sheet(out, files, cols, width):
    Image, ImageDraw, ImageFont = load_pil()
    if not files:
        raise SheetError('没有给任何图片')
    first = open_rgb(Image, files[0])
    height = width * first.height // first.width
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * width, rows * (height + 22)), (20, 20, 24))
    draw = ImageDraw.Draw(sheet)
    font = latin_font(ImageFont, 13)
    for k, f in enumerate(files):
        x, y = (k % cols) * width, (k // cols) * (height + 22)
        sheet.paste(fit(Image, open_rgb(Image, f), width, height), (x, y + 22))
        draw.text((x + 6, y + 4), Path(f).name, fill=(230, 230, 230), font=font)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=88)
    return sheet.size


def main(argv):
    ap = argparse.ArgumentParser(prog='python tools/contact_sheet.py', description='联系表：把一组帧拼成一张审片图（帧号、时间码、镜头号、切点）。',
                                 epilog='新用法由 node tools/film/cli.mjs 自动调用；手动拼图用旧用法：python tools/contact_sheet.py out.jpg a.jpg b.jpg --cols 4 --w 480')
    ap.add_argument('out', help='输出 JPEG 路径')
    ap.add_argument('images', nargs='*', help='旧用法：按顺序拼的图片')
    ap.add_argument('--manifest', help='film CLI 写的清单 JSON')
    ap.add_argument('--width', type=int, default=0, help='新用法：概览每格的宽（像素，默认横屏 400 / 竖屏 220）')
    ap.add_argument('--cols', type=int, default=4, help='旧用法：每行几格（默认 4）')
    ap.add_argument('--w', type=int, default=480, help='旧用法：每格宽（默认 480）')
    ap.error = lambda msg: die(f'用法错误：{msg}（加 --help 看用法）', 2)
    a = ap.parse_args(argv)
    out = Path(a.out)
    try:
        if a.manifest:
            if a.images:
                die('用法错误：--manifest 与图片列表只能用一种', 2)
            try:
                m = json.loads(Path(a.manifest).read_text(encoding='utf-8'))
            except Exception as e:
                die(f'读不了清单 {a.manifest}：{e}', 2)
            size = manifest_sheet(out, m, a.width)
        else:
            if a.cols < 1 or a.w < 16:
                die('用法错误：--cols 至少 1，--w 至少 16', 2)
            size = legacy_sheet(out, a.images, a.cols, a.w)
    except SheetError as e:
        die(str(e), 1)
    print(f'{out} {size[0]}x{size[1]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
