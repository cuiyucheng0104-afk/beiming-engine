#!/bin/bash
R=~/Desktop/见龙/tools/rog_ai.sh; cd ~/baobian-film/audio
gen(){ v=$1; p=$2; bpm=$3; for seed in 21 22 23 24 25 26; do
  bash $R music "$p" 44 try_$v.wav --seed $seed --bpm $bpm >/dev/null 2>&1 || continue
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 try_$v.wav); echo "$v seed=$seed ${d}s"
  awk -v d=$d 'BEGIN{exit !(d>=31)}' && { mv try_$v.wav $v.wav; return; }
done; echo "$v 六次都不够长"; }
gen B_zhuangshi "Instrumental score, about 40 seconds long, for a Chinese decorative mural-style animated short (Dunhuang murals). Pipa melody, sheng organ chords, small hand percussion, bianzhong bronze bells; elegant ornamental rhythm, steady and graceful, builds to a bright golden finale near the end, then a long ringing bell tail. No vocals, no lyrics." 84
gen C_qitan "Instrumental score, about 40 seconds long, for a contemporary Chinese animation anthology episode. Minimal plucked guzheng, prepared piano, soft warm electronic texture and breath-like pads, playful yet mysterious, quiet tension in the middle, tender warm resolution and long fading tail at the end. No vocals, no lyrics." 76
gen D_wushan "Instrumental epic Chinese fantasy animation score, about 40 seconds long. Dizi bamboo flute lead, guzheng runs, dagu and taiko drums, sweeping strings; misty quiet opening, rising tension, a heroic leap and big swell around 22 seconds, then soaring airy resolution among clouds with a long tail. No vocals, no lyrics." 90
