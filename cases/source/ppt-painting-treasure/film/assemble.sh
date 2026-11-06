#!/bin/bash
# 画面拼接 + 混音响度标准化 + 封装 + 字幕
set -e
cd "$(dirname "$0")"
/usr/local/bin/python3 mix.py
cd out
ls shot*.mp4 | sed "s/^/file '/;s/$/'/" > list.txt
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -c copy video.mp4
M=$(ffmpeg -hide_banner -i mix_raw.wav -af loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json -f null - 2>&1 | /usr/local/bin/python3 -c "import sys,json,re;d=json.loads(re.search(r'\{[^{}]*\}',sys.stdin.read()).group());print(f\"measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}\")")
ffmpeg -loglevel error -y -i mix_raw.wav -af loudnorm=I=-14:TP=-1.0:LRA=11:$M:linear=true -ar 48000 mix.wav
ffmpeg -loglevel error -y -i video.mp4 -i mix.wav -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart "$HOME/Desktop/上影ppt/画境追宝_故事介绍.mp4"
cd ..
/usr/local/bin/python3 - <<'PY'
import json, os
tl=json.load(open('timeline.json'))['shots']; L={x['id']:x for x in json.load(open('lines.json'))}; D=json.load(open('vo/dur.json'))
def ts(t):
    h=int(t//3600); m=int(t%3600//60); s=t%60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s-int(s))*1000)):03d}".replace(',1000',',999')
k=0; out=[]
for s in tl:
    for lid,t in s['lines'].items():
        k+=1; a=s['start']+t; b=a+D[lid]+0.25
        txt=f"{L[lid]['who']}：{L[lid]['zh']}"
        if L[lid]['lang']!='Chinese': txt+=f"\n{L[lid]['say']}"
        out.append(f"{k}\n{ts(a)} --> {ts(b)}\n{txt}\n")
open(os.path.expanduser('~/Desktop/上影ppt/画境追宝_故事介绍.srt'),'w').write('\n'.join(out))
PY
ffprobe -v error -show_entries format=duration -of csv=p=0 "$HOME/Desktop/上影ppt/画境追宝_故事介绍.mp4"
