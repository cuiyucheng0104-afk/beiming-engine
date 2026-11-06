#!/bin/sh
# Download only the seconds used, from NASA originals (public domain), as frame-accurate 30 fps excerpts.
# Each excerpt starts exactly at the source second of film time f0 (see sync.json).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
python3 - <<'PY' > jobs.txt
import json
S=json.load(open('sync.json')); off=S['ref_offset']
for k,c in S['cams'].items():
    if c['src']=='iso': s=c['f0']+off+c['shift']; url=S['iso_url']
    else: s=c['s_at_f0']+(0); url=S['mcc_url']
    d=c['f1']-c['f0']
    print(k, '%.4f'%s, '%.3f'%d, c['w'], url)
PY
while read k s d w url; do
  [ -s "$k.mp4" ] && continue
  if [ "$w" = 3840 ]; then VF="fps=30"; else VF="fps=30,scale=1920:1080:flags=lanczos"; fi
  ffmpeg -nostdin -v error -y -ss "$s" -i "$url" -t "$d" -an -vf "$VF" -c:v libx264 -crf 15 -preset medium -pix_fmt yuv420p "$k.part.mp4"
  mv "$k.part.mp4" "$k.mp4"; echo "fetched $k  s=$s d=$d"
done < jobs.txt
rm -f jobs.txt
