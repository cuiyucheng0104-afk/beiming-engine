#!/bin/bash
R=~/Desktop/见龙/tools/rog_ai.sh; P=~/Desktop/目之所及
$R music "Sunny laid-back West Coast road trip groove. Clean electric guitar licks, warm round bass, light brushed drums, relaxed and playful, golden hour on the Pacific Coast Highway. Instrumental, no vocals." 45 $P/音乐/open_s7.wav --seed 7 --structure intro,instrumental,instrumental,outro && echo O_DONE
$R music "Cinematic action thriller score. Pulsing low strings, ticking synth bass, taiko and tight snare, rising ostinato, relentless tension that keeps building, dark and driving. Instrumental, no vocals." 120 $P/音乐/tension_long_s9.wav --seed 9 --structure intro,instrumental,instrumental,instrumental,instrumental,instrumental,outro && echo T_DONE
$R music "Emotional cinematic climax. Big low drums, soaring strings and brass swelling, desperate then hopeful, ends suddenly on a held suspended chord. Instrumental, no vocals." 45 $P/音乐/climax_s7.wav --seed 7 --structure intro,instrumental,instrumental,outro && echo C_DONE
