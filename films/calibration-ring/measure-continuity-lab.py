"""Measure the original lab fixture's probe records and encoded frames."""

import argparse
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw


WIDTH, HEIGHT = 640, 360
CARRY_VARIANTS = ("baseline", "rename", "teleport")
SHUTTER_VARIANTS = ("pulse-0", "pulse-180", "alternating-180")
BOUNDARY_FRAMES = (59, 60, 61)


def decode(path, frames=None):
    cmd = ["ffmpeg", "-v", "error", "-xerror", "-i", str(path)]
    if frames:
        cmd += ["-vf", "select=" + "+".join(f"eq(n\\,{n})" for n in frames)]
    cmd += ["-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "-threads:v", "1", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    images = np.frombuffer(raw, np.uint8).reshape(-1, HEIGHT, WIDTH, 3)
    expected = len(frames) if frames else 120
    if len(images) != expected:
        raise ValueError(f"{path}: expected {expected} decoded frames, found {len(images)}")
    return images


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def carry_row(root, variant, baseline):
    path = root / variant / "film.mp4"
    pixels = baseline if variant == "baseline" else decode(path)
    xs = [float(np.nonzero((pixels[n] >= 128).all(axis=2))[1].mean()) for n in BOUNDARY_FRAMES]
    probe = read_json(root / "probe" / variant / "tracks.json")["continuity"]
    result = {
        "score": probe["score"],
        "boundaries": probe["considered"],
        "events": probe["events"],
        "different_frames_from_baseline": int(np.count_nonzero(np.any(pixels != baseline, axis=(1, 2, 3)))),
        "delta_x_px_59_to_60": round(xs[1] - xs[0], 3),
        "delta_x_px_60_to_61": round(xs[2] - xs[1], 3),
    }
    return result, pixels[list(BOUNDARY_FRAMES)]


def shutter_row(root, variant):
    directory = root / variant
    pixels = decode(directory / "film.mp4", (60,))[0]
    with Image.open(directory / "_frames/00060.png") as png:
        before_encode = png.convert("RGB").getpixel((320, 180))
    render = read_json(directory / "film.render.json")
    return {
        "rgb_png_frame_60": before_encode,
        "rgb_decoded_frame_60": pixels[180, 320].tolist(),
        **{key: render[key] for key in ("captures", "still_frames", "cut_frames")},
    }, pixels


def write_contact(path, carry, shutter):
    sheet = Image.new("RGB", (3 * 224, 4 * 150), "#181818")
    draw = ImageDraw.Draw(sheet)
    for row, (name, images) in enumerate(carry.items()):
        for col, (frame, pixels) in enumerate(zip(BOUNDARY_FRAMES, images)):
            x, y = col * 224, row * 150
            draw.text((x + 6, y + 5), f"{name} / frame {frame}")
            sheet.paste(Image.fromarray(pixels).resize((216, 122)), (x + 4, y + 23))
    for col, (name, pixels) in enumerate(shutter.items()):
        x, y = col * 224, 3 * 150
        draw.text((x + 6, y + 5), f"{name} / frame 60")
        sheet.paste(Image.fromarray(pixels).resize((216, 122)), (x + 4, y + 23))
    sheet.save(path, quality=94)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    root = parser.parse_args().out
    baseline = decode(root / "baseline/film.mp4")
    carry, shutter, carry_pixels, shutter_pixels = {}, {}, {}, {}
    for name in CARRY_VARIANTS:
        carry[name], carry_pixels[name] = carry_row(root, name, baseline)
    for name in SHUTTER_VARIANTS:
        shutter[name], shutter_pixels[name] = shutter_row(root, name)
    write_contact(root / "fixture-contact.jpg", carry_pixels, shutter_pixels)
    report = json.dumps({"carry": carry, "shutter": shutter}, indent=2)
    (root / "fixture-results.json").write_text(report + "\n", encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
