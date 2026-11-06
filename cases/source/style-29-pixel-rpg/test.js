import { FB, C, makeOut, LUT } from './px.js';
import { initCJK, text, bigText } from './font.js';
import { hero, POSE, walkPose, chestSprite, portraitMimic, key, HEART, BANG } from './art.js';
const q = new URLSearchParams(location.search);
const fb = new FB(), out = makeOut(document.getElementById('c'));
await initCJK('宝箱怪勇者', 'NotoSC5', 500, .45, 14);
fb.clear(C.night);
let x = 14;
for (const n of ['stand', 'reach', 'recoil', 'guard', 'lower', 'catch', 'crouch', 'raise']) { const s = hero(POSE[n], 0); fb.blit(s, x - s.ox, 50 - s.oy); x += 38; }
x = 14; for (let i = 0; i < 8; i++) { const s = hero(walkPose(i / 4), i / 8); fb.blit(s, x - s.ox, 92 - s.oy); x += 30; }
const st = [{}, { open: .5, mouth: 4, eyes: 'mad', tongue: .6 }, { open: 1, mouth: 7, eyes: 'mad', tongue: 1 }];
x = 260; for (const s0 of st) { const s = chestSprite(22, 10, 7, s0); fb.blit(s, x - s.ox, 92 - s.oy); x += 0; x += 0; break; }
const sts = [{}, { open: 1, mouth: 20, eyes: 'mad', tongue: 1 }, { open: .8, mouth: 14, eyes: 'scared' }, { open: .4, mouth: 8, eyes: 'shy', look: -1, teeth: .4 }, { open: .6, mouth: 10, eyes: 'happy' }];
x = 34; for (const s0 of sts) { const s = chestSprite(56, 26, 18, s0); fb.blit(s, x - s.ox, 176 - s.oy); x += 62; }
const p = portraitMimic({ open: .4, mouth: 4, eyes: 'shy', look: -1 }); fb.blit(p, 284, 98);
key(fb, 290, 20, 0, 1); key(fb, 290, 34, .6, 1); key(fb, 290, 48, 1.2, 1); key(fb, 300, 64, 0, 2);
fb.blit(HEART, 266, 20); fb.blit(BANG, 266, 34);
const sm = [{ open: .6, mouth: 5, eyes: 'mad', tongue: 1 }, { open: .4, mouth: 3, eyes: 'happy' }];
x = 250; for (const s0 of sm) { const s = chestSprite(22, 10, 7, s0); fb.blit(s, x - s.ox, 120 - s.oy); x += 28; }
out.present(fb, q.has('blush') ? LUT.blush : LUT.full); out.show();
window.DUR = 1; window.render = () => {}; window.READY = true;
