#!/bin/sh
# material/<cam>.mp4 (frame-accurate excerpts starting at film time f0) → frames/<cam>/NNNN.jpg named by FILM frame number (30 fps),
# with one grade for every source (STYLE §2). Burned-in camera numbers (top right of the pad cameras) are removed with delogo
# after they were used to identify the camera. Hero (913) and CS5 (907) come from the 4K originals; 913 is a 1:1 crop of
# the lower centre (its burned-in number lies outside the crop).
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
G="eq=contrast=1.07:saturation=0.9:gamma=0.97:brightness=-0.01,colorbalance=rs=-0.02:bs=0.03:rh=0.03:bh=-0.02"
D2K="delogo=x=1455:y=172:w=210:h=112"
D4K="delogo=x=2910:y=344:w=420:h=224"
cut() {  # cam filter
  f0=$(python3 -c "import json;print(round(json.load(open('material/sync.json'))['cams']['$1']['f0']*30))")
  rm -rf "frames/$1"; mkdir -p "frames/$1"
  ffmpeg -nostdin -v error -y -i "material/$1.mp4" -vf "$2,$G" -q:v 3 -start_number "$f0" "frames/$1/%04d.jpg"
  echo "$1: $(ls frames/$1 | head -1) … $(ls frames/$1 | tail -1) ($(ls frames/$1 | wc -l | tr -d ' '))"
}
cut mcc "null"
cut pao "null"
cut flag "null"
cut gantry "null"
cut v8 "$D2K"
cut fair "$D2K"
cut srm "$D2K"
cut mlp "$D2K"
cut hero "crop=1920:1080:660:1080"   # 913 at 1:1 4K pixels, framed on the boosters, core and tower: all nine puzzle tiles carry picture
cut cs5 "$D4K,scale=1920:1080:flags=lanczos"
