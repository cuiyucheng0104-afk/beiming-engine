# -*- coding: utf-8 -*-
"""联系表（接触印）：把一次运行的若干帧拼成一张审片图——概览格子 + 切点逐帧条 + 镜头时间条。

两种用法：
  python tools/contact_sheet.py <输出.jpg> --manifest <清单.json> [--width 400]
      清单由 node tools/film/cli.mjs 写（build / animatic / stills / render 都会调用）：
      { title, film, run, profile, kind, final, width, height, fps, frames, shots: [{id, in, out}], cuts: [帧号],
        tiles: [{file, frame, shot, cut}], strips: [{cut, tiles: [...]}], truncatedStrips }
      每格标帧号、时间码（时:分:秒:帧）、镜头号；切点帧左侧加一道醒目竖条，切点逐帧条里切点前后用竖线分开。
      标题、画幅、帧率、时长全部来自清单（清单来自 film.json 与本次运行），本脚本不写死任何一部片子。
  python tools/contact_sheet.py <输出.jpg> a.jpg b.jpg … [--cols 4] [--w 480]
      旧用法：按给定顺序拼图，每格上方标文件名（Windows 反斜杠路径也只显示文件名）。

只用 Pillow。字体：逐段检查字形覆盖，依次试 BEIMING_SHEET_FONT、系统里同时含中文与拉丁字母的字体
（macOS 冬青黑体 / 华文黑体、Linux Noto Sans CJK / 文泉驿、Windows 微软雅黑 / 黑体）、系统拉丁字体，最后用 Pillow 自带字体；
仓库 fonts/ 里的是成片用的字形子集，不拿来写标注。找不到中文字体时标注改用英文、片名改用作品 id（只影响审片图，不影响成片）。
退出码：0 成功；1 读不了图或写不了文件；2 用法错误；3 缺 Pillow。出错只打印一行原因。
"""
import argparse
import json
import os
import sys
from pathlib import Path

BG = (22, 23, 28)
PANEL = (30, 32, 39)
FG = (232, 234, 238)
DIM = (139, 144, 154)
ACCENT = (255, 122, 69)        # 切点
SHOT_TINTS = [(74, 98, 140), (98, 84, 140), (70, 120, 112), (132, 98, 74)]

_WIN_FONTS = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts')
# 同时有中文与拉丁字母的字体排在前面：一张图里的标注用同一款字，字重、基线一致
FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/STHeiti Light.ttc',
    '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc',
    os.path.join(_WIN_FONTS, 'msyh.ttc'), os.path.join(_WIN_FONTS, 'simhei.ttf'), os.path.join(_WIN_FONTS, 'simsun.ttc'),
    # 只有拉丁字母的系统字体：没有中文字体时写英文标注
    '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    os.path.join(_WIN_FONTS, 'segoeui.ttf'), os.path.join(_WIN_FONTS, 'arial.ttf'),
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


class Fonts:
    """按「这段文字每个字都画得出」挑字体，结果按 (字号, 文字) 记住。"""

    def __init__(self, Image, ImageDraw, ImageFont):
        self.Image, self.ImageDraw, self.ImageFont = Image, ImageDraw, ImageFont
        self.loaded = {}
        self.missing = {}
        self.glyph = {}
        env = os.environ.get('BEIMING_SHEET_FONT')
        self.paths = ([env] if env else []) + [p for p in FONT_CANDIDATES if os.path.exists(p)]

    def _load(self, path, size):
        k = (path, size)
        if k not in self.loaded:
            try:
                self.loaded[k] = self.ImageFont.truetype(path, size) if path else self.ImageFont.load_default(size=size)
            except Exception:
                self.loaded[k] = None
        return self.loaded[k]

    def _raster(self, font, ch):
        im = self.Image.new('L', (48, 48), 0)
        self.ImageDraw.Draw(im).text((4, 4), ch, font=font, fill=255)
        return im.tobytes()

    def covers(self, path, font, text):
        """缺字时字体画的是同一个占位框：与必然缺字的私用区码位比较，相同即缺字。"""
        if path not in self.missing:
            try:
                self.missing[path] = self._raster(font, '\U000F0000')
            except Exception:
                return False
        for ch in set(text):
            if ch.isspace():
                continue
            k = (path, ch)
            if k not in self.glyph:
                try:
                    self.glyph[k] = self._raster(font, ch) != self.missing[path]
                except Exception:
                    self.glyph[k] = False
            if not self.glyph[k]:
                return False
        return True

    def pick(self, size, text):
        """画得出 text 的第一款字体；都画不出返回 None（调用方换成英文或作品 id）。"""
        for path in self.paths + [None]:
            font = self._load(path, size)
            if font is not None and self.covers(path or '<default>', font, text):
                return font
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


KIND_ZH = {'build': '工作版出片', 'final': '终渲', 'animatic': '动态预演', 'stills': '风格关键帧', 'render': '帧段'}
KIND_EN = {'build': 'BUILD', 'final': 'FINAL', 'animatic': 'ANIMATIC', 'stills': 'LOOK STILLS', 'render': 'FRAMES'}


def manifest_sheet(out, m, tile_w):
    Image, ImageDraw, ImageFont = load_pil()
    F = Fonts(Image, ImageDraw, ImageFont)
    fps = int(m.get('fps') or 0)
    W, H = int(m.get('width') or 0), int(m.get('height') or 0)
    if fps <= 0 or W <= 0 or H <= 0:
        raise SheetError('清单缺 fps / width / height（应由 node tools/film/cli.mjs 写）')
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
    cuts = set(int(c) for c in (m.get('cuts') or []))
    frames = int(m.get('frames') or 0)
    kind_key = 'final' if m.get('final') else str(m.get('kind') or '')

    # 标注：有中文字体就写中文，没有就写英文（不出豆腐块）
    title = str(m.get('title') or m.get('film') or '')
    f_title = F.pick(30, title)
    if not f_title:
        title = str(m.get('film') or 'film')
        f_title = F.pick(30, title)
    dur = frames / fps if frames else 0
    zh_meta = f"{KIND_ZH.get(kind_key, kind_key)} · 档位 {m.get('profile') or '—'} · {W}×{H} · {fps} fps · {frames} 帧 · {dur:.2f} 秒"
    zh_run = f"作品 {m.get('film') or '—'} · 运行 {m.get('run') or '—'}"
    zh_strip = '切点逐帧：前 3 帧 │ 后 3 帧'
    zh_more = f"另有 {m.get('truncatedStrips') or 0} 个切点没有列出"
    f_meta = F.pick(15, zh_meta + zh_run + zh_strip + zh_more)
    if f_meta:
        meta_text, run_text, strip_text, more_text = zh_meta, zh_run, zh_strip, zh_more
    else:
        meta_text = f"{KIND_EN.get(kind_key, kind_key.upper())} · {m.get('profile') or '-'} · {W}x{H} · {fps} fps · {frames} frames · {dur:.2f} s"
        run_text = f"film {m.get('film') or '-'} · run {m.get('run') or '-'}"
        strip_text = 'CUTS: 3 frames before | 3 after'
        more_text = f"+{m.get('truncatedStrips') or 0} more cuts not shown"
        f_meta = F.pick(15, meta_text + run_text + strip_text + more_text)
    shot_ids = ''.join(str(s.get('id') or '') for s in shots) + ''.join(str(t.get('shot') or '') for t in tiles)
    f_cap = F.pick(14, 'F0123456789:' + shot_ids) or F.pick(14, 'F0123456789:')
    f_small = F.pick(12, '0123456789:' + shot_ids) or F.pick(12, '0123456789:')
    if not (f_title and f_meta and f_cap and f_small):
        raise SheetError('找不到能写标注的字体（Pillow 太旧且系统没有可用字体）：升级 Pillow ≥ 10.1，或设 BEIMING_SHEET_FONT=<字体文件>')

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
    d.text((pad, pad), title, font=f_title, fill=FG)
    d.text((pad, pad + 44), meta_text, font=f_meta, fill=DIM)
    d.text((pad, pad + 66), run_text, font=f_meta, fill=DIM)

    def caption(x, y, w, t, highlight=False):
        fr = int(t['frame'])
        d.rectangle([x, y, x + w - 1, y + cap_h - 1], fill=PANEL)
        d.text((x + 8, y + 5), f'F{fr:04d}', font=f_cap, fill=ACCENT if highlight else FG)
        tc = timecode(fr, fps)
        if w >= 200:
            d.text((x + 70, y + 5), tc, font=f_cap, fill=DIM)
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
        d.text((pad, y + 8), strip_text, font=f_meta, fill=DIM)
        if m.get('truncatedStrips'):
            d.text((pad + 12 + d.textlength(strip_text, font=f_meta) + 24, y + 8), more_text, font=f_meta, fill=DIM)
        y += 34
        for s in strips:
            c = int(s['cut'])
            before = next((str(x['shot']) for x in s['tiles'] if int(x['frame']) == c - 1), '')
            after = next((str(x['shot']) for x in s['tiles'] if int(x['frame']) == c), '')
            d.text((pad, y + 6), f'{before} > {after}', font=f_cap, fill=FG)
            d.text((pad, y + 28), f'F{c:04d}', font=f_cap, fill=ACCENT)
            d.text((pad, y + 48), timecode(c, fps), font=f_small, fill=DIM)
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
            label = str(s.get('id') or '')
            if label and b - a > d.textlength(label, font=f_small) + 10:
                d.text((a + 6, ty + 4), label, font=f_small, fill=FG)
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
    F = Fonts(Image, ImageDraw, ImageFont)
    first = open_rgb(Image, files[0])
    height = width * first.height // first.width
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * width, rows * (height + 22)), (20, 20, 24))
    draw = ImageDraw.Draw(sheet)
    # Windows 反斜杠路径也只显示文件名（main 62ad28e 的修复：POSIX 上 Path 不把 \ 当分隔符）
    names = [os.path.basename(str(f).replace('\\', '/')) for f in files]
    font = F.pick(13, ''.join(names)) or F.pick(13, 'abc')
    for k, f in enumerate(files):
        x, y = (k % cols) * width, (k // cols) * (height + 22)
        sheet.paste(fit(Image, open_rgb(Image, f), width, height), (x, y + 22))
        draw.text((x + 6, y + 4), names[k], fill=(230, 230, 230), font=font)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        sheet.save(out, quality=88)
    except Exception as e:
        raise SheetError(f'写不了 {out}：{e}')
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
            if a.width and not 64 <= a.width <= 2000:
                die('用法错误：--width 要在 64–2000 之间', 2)
            try:
                m = json.loads(Path(a.manifest).read_text(encoding='utf-8'))
            except Exception as e:
                die(f'读不了清单 {a.manifest}：{e}', 2)
            if not isinstance(m, dict):
                die(f'清单 {a.manifest} 顶层必须是对象', 2)
            size = manifest_sheet(out, m, a.width)
        else:
            if not a.images:
                die('用法错误：要么给 --manifest <清单.json>，要么给至少一张图（旧用法：out.jpg a.jpg b.jpg …）', 2)
            if a.cols < 1 or a.w < 16:
                die('用法错误：--cols 至少 1，--w 至少 16', 2)
            size = legacy_sheet(out, a.images, a.cols, a.w)
    except SheetError as e:
        die(str(e), 1)
    print(f'{out} {size[0]}x{size[1]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
