#!/bin/sh
# material/raw → assets/: archival pipeline (STYLE.md §2): crop borders → deblock → lanczos 1.5× → light unsharp → greyscale.
# Grade and grain are applied in the page. Never colourised or "restored".
set -e
P=$(cd "$(dirname "$0")/.." && pwd); cd "$P"
LIB=${LIB:-@@LEMO_ROOT@@}; PY="$LIB/.venv/bin/python"
A=assets; mkdir -p $A/side $A/deck $A/fall
VF="bwdif=0,crop=608:456:16:12,hqdn3d=2:2:3:3,scale=912:684:flags=lanczos,unsharp=5:5:0.5:5:5:0,format=gray"
ff() { ffmpeg -v error -y "$@"; }
SRC=material/raw/tacoma.ogv
# side view of the twisting deck: src 62.0–66.5 s
ff -ss 62.0 -t 4.5 -i $SRC -an -vf "fps=30,$VF" -q:v 3 $A/side/%03d.jpg
# along the deck from the tower: src 70.0–79.0 s
ff -ss 70.0 -t 9.0 -i $SRC -an -vf "fps=30,$VF" -q:v 3 $A/deck/%03d.jpg
# the fall: src 115.9–122.0 s
ff -ss 115.9 -t 6.1 -i $SRC -an -vf "fps=30,$VF" -q:v 3 $A/fall/%03d.jpg
# NOAA surface analysis 1940-11-07: greyscale, inverted into light lines on a dark ground (map grade, STYLE.md §2)
"$PY" -I -c "
from PIL import Image, ImageOps, ImageEnhance
m=Image.open('material/raw/noaa_1940-11-07.jpg').convert('L'); m=ImageOps.autocontrast(m,cutoff=1); m=ImageOps.invert(m)
m=ImageEnhance.Contrast(m).enhance(1.25); m.save('$A/noaa.jpg',quality=90)
"
echo "side $(ls $A/side | wc -l) deck $(ls $A/deck | wc -l) fall $(ls $A/fall | wc -l)"
