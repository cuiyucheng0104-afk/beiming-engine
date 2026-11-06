#!/bin/bash
R=~/Desktop/见龙/tools/rog_ai.sh
$R music "Elegant British spy thriller score, Kingsman style, gothic manor at midnight, pizzicato strings, harpsichord ostinato, low brass, ticking suspense, sly and witty, orchestral, 96 BPM, D minor, instrumental" 70 m1_manor.wav --seed 7 --structure intro,instrumental,instrumental,outro
$R music "Comedic orchestral adventure chase, Indiana Jones style, fast galloping string ostinato, snare drum, bold brass fanfare, playful woodwinds, bumbling hero, high energy, 132 BPM, instrumental" 90 m2_chase.wav --seed 7 --structure intro,instrumental,instrumental,instrumental,outro
$R music "Tense cinematic build, low pulsing strings, timpani heartbeat, ticking clock, car chase at night on a cliff road, rising suspense, no resolution, 120 BPM, instrumental" 40 m3_tense.wav --seed 7 --structure intro,instrumental,outro
$R music "Heroic triumphant orchestral theme, soaring French horns, big timpani, full strings, emotional homecoming, warm and proud, subtle Chinese bamboo flute melody, cinematic finale, instrumental" 55 m4_hero.wav --seed 7 --structure intro,instrumental,instrumental,outro
echo ALLDONE
