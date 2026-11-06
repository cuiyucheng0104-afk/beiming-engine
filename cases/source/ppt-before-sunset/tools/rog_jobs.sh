#!/bin/bash
# 深度图 + 分幕配乐，都在 ROG 5090 上跑
R=~/Desktop/见龙/tools/rog_ai.sh; P=~/Desktop/日落之前
$R depth /private/tmp/claude-503/sunset_depth_in $P/depth && echo DEPTH_DONE
W="Modern western film score, lonely desert at golden hour."
for s in 7 8; do
$R music "$W Solo baritone electric guitar with deep tremolo and spring reverb, distant harmonica, soft whistling, dry wind, slow and spacious, melancholic, Ennio Morricone inspired. Instrumental, no vocals." 60 $P/音乐/open_s$s.wav --seed $s --structure intro,instrumental,instrumental,outro && echo OPEN$s
$R music "$W Driving urgent ride across the desert. Galloping low toms and shaker, fast palm-muted baritone guitar ostinato, cello pulse, rising tension, determined, motorcycle chase energy. Instrumental, no vocals." 110 $P/音乐/ride_s$s.wav --seed $s --structure intro,instrumental,instrumental,instrumental,instrumental,outro && echo RIDE$s
$R music "$W Dark suspense inside an abandoned mine at dusk. Low drones, sparse plucked guitar harmonics, creaking metal textures, slow heartbeat kick, quiet and tense, building slowly. Instrumental, no vocals." 60 $P/音乐/sneak_s$s.wav --seed $s --structure intro,instrumental,instrumental,outro && echo SNEAK$s
$R music "$W Explosive escape climax. Huge war drums, heroic brass, fast tremolo guitar, strings soaring, a truck smashing through a gate, triumphant release at the end. Instrumental, no vocals." 60 $P/音乐/climax_s$s.wav --seed $s --structure intro,instrumental,instrumental,outro && echo CLIMAX$s
$R music "$W Warm tender ending at sunset, father and daughter resting. Fingerpicked acoustic guitar, soft harmonica melody, gentle strings, hopeful and quiet. Instrumental, no vocals." 75 $P/音乐/end_s$s.wav --seed $s --structure intro,instrumental,instrumental,outro && echo END$s
done
echo ALL_DONE
