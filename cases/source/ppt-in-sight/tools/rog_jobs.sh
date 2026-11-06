#!/bin/bash
# 深度图 + 两段配乐，都在 ROG 5090 上跑
R=~/Desktop/见龙/tools/rog_ai.sh; P=~/Desktop/目之所及
mkdir -p /private/tmp/claude-503/insight_depth_in && cp $P/素材/slides/s*.png /private/tmp/claude-503/insight_depth_in/
$R depth /private/tmp/claude-503/insight_depth_in $P/depth && echo DEPTH_DONE
$R music "Cinematic action thriller score for a coastal rescue film. Pulsing low strings, ticking synth bass, taiko and tight snare, building tension with rising ostinato, brief breakdowns, heroic but restrained, no cheese. Instrumental, no vocals." 150 $P/音乐/tension_s7.wav --seed 7 --structure intro,instrumental,instrumental,outro && echo M1_DONE
$R music "Cinematic action thriller score for a coastal rescue film. Pulsing low strings, ticking synth bass, taiko and tight snare, building tension with rising ostinato, brief breakdowns, heroic but restrained, no cheese. Instrumental, no vocals." 150 $P/音乐/tension_s8.wav --seed 8 --structure intro,instrumental,instrumental,outro && echo M2_DONE
$R music "Quiet reflective film ending at sunset by the ocean. Sparse solo piano, soft sustained strings, gentle and unresolved, a little melancholy, warm. Instrumental, no vocals." 45 $P/音乐/ending_s7.wav --seed 7 --structure intro,instrumental,outro && echo M3_DONE
