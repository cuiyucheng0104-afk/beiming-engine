#!/bin/bash
while pgrep -f "gen.sh" >/dev/null; do sleep 10; done
R=~/Desktop/见龙/tools/rog_ai.sh
$R music "Elegant British spy thriller score, Kingsman style, gothic manor at midnight, pizzicato strings, harpsichord ostinato, low brass, ticking suspense, sly and witty, orchestral, 96 BPM, D minor, instrumental" 70 m1_manor_b.wav --seed 8 --structure intro,instrumental,instrumental,instrumental,outro
$R music "Comedic orchestral adventure chase, Indiana Jones style, fast galloping string ostinato, snare drum, bold brass fanfare, playful woodwinds, bumbling hero, high energy, 132 BPM, instrumental" 90 m2_chase_b.wav --seed 8 --structure intro,instrumental,instrumental,instrumental,instrumental,outro
echo ALLDONE2
