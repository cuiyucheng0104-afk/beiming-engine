"""从两条已编码母版抽取交接邻帧，量环的屏幕位移、投影面积与重合度。"""
import argparse
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw


def decode(video, output, indices):
    info = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', str(video)],
        check=True, capture_output=True, text=True,
    )
    stream = json.loads(info.stdout)['streams'][0]
    width, height = stream['width'], stream['height']
    fps = f"{output['fps']}/1"
    if (width, height, stream['avg_frame_rate'], int(stream.get('nb_frames', 0))) != (
        output['width'], output['height'], fps, output['frameCount'],
    ):
        raise ValueError(f'{video.name} 的幅面、帧率或帧数与本案例的 film.json 不一致')
    selector = '+'.join(f'eq(n\\,{i})' for i in indices)
    pixels = subprocess.run(
        ['ffmpeg', '-v', 'error', '-xerror', '-i', str(video), '-an',
         '-vf', f'select={selector}', '-fps_mode', 'passthrough',
         '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
        check=True, stdout=subprocess.PIPE,
    )
    frames = np.frombuffer(pixels.stdout, dtype=np.uint8).reshape(-1, height, width, 3)
    if len(frames) != len(indices):
        raise ValueError(f'{video.name} 的交接邻帧解码不全')
    return frames


def face_mask(rgb):
    # 亮金顶面是画面中唯一通过这一色域的区域。较深的金属侧面不进入统计。
    r, g, b = rgb.transpose(2, 0, 1)
    return (r >= 214) & (g >= 130) & (g <= 205) & (b <= 130)


def compare_pair(first, second):
    a, b = face_mask(first), face_mask(second)
    y0, x0 = np.nonzero(a)
    y1, x1 = np.nonzero(b)
    if not len(x0) or not len(x1):
        raise ValueError('采样帧没有识别到金色环顶面')
    dx, dy = x1.mean() - x0.mean(), y1.mean() - y0.mean()
    area_ratio = len(x1) / len(x0)
    detail = {
        'dxPx': round(float(dx), 3),
        'dyPx': round(float(dy), 3),
        'centerDistancePx': round(math.hypot(dx, dy), 3),
        'faceAreaPx': [len(x0), len(x1)],
        'faceAreaChangePct': round((area_ratio - 1) * 100, 3),
        'faceIoU': round(float(np.count_nonzero(a & b) / np.count_nonzero(a | b)), 5),
        'frameMeanRgbDelta': round(float(np.abs(first.astype(np.int16) - second).mean()), 5),
    }
    return detail


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('matched', type=Path, help='默认匹配版的 master.mp4')
    parser.add_argument('unmatched', type=Path, help='错位对照版的 master.mp4')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    spec = json.loads((here / 'film.json').read_text(encoding='utf-8'))
    h = next(event['frame'] for event in spec['events'] if event['id'] == 'handoff')
    indices = list(range(h - 2, h + 3))
    folder = here / 'out' / 'comparison'
    folder.mkdir(parents=True, exist_ok=True)
    sheet = Image.new('RGB', (400 * len(indices), 2 * 251), '#101c25')
    labels = ImageDraw.Draw(sheet)
    report = {'handoff': h, 'frames': indices, 'variants': {}}
    for row, (name, video) in enumerate(vars(args).items()):
        frames = decode(video, spec['output'], indices)
        report['variants'][name] = {
            f'{start}->{end}': compare_pair(a, b)
            for start, end, a, b in zip(indices[:-1], indices[1:], frames[:-1], frames[1:])
        }
        for col, (index, frame) in enumerate(zip(indices, frames)):
            sheet.paste(Image.fromarray(frame).resize((400, 225), Image.Resampling.LANCZOS), (col * 400, row * 251))
            labels.text((col * 400 + 10, row * 251 + 231), f'{name}  f{index}', fill='white')
    result = json.dumps(report, ensure_ascii=False, indent=2)
    (folder / 'seam.json').write_text(result + '\n', encoding='utf-8')
    sheet.save(folder / 'seam.jpg', quality=94)
    print(result)


if __name__ == '__main__':
    main()
