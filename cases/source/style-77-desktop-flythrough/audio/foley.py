"""Foley for 灵感送达: every on-screen action gets a sound, placed on its event's frame (window.EV → out/events.json); pitched sounds take
their notes from the bar's chord (music/harmony.json); camera whips get whooshes sized by the measured camera speed (out/camspeed.json),
except inside the silence. Usage: foley.py <events.json> <camspeed.json> <harmony.json> <timeline.json> <out.wav>"""
import sys, os, json
import numpy as np
sys.path.insert(0, os.path.join(os.environ.get('LIB', os.path.expanduser('~/lemo-opuscar')), 'core/audio'))
from sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, whoosh, thump, click, step, creak, add

ev = json.load(open(sys.argv[1]))['ev']; cam = json.load(open(sys.argv[2])); HAR = json.load(open(sys.argv[3])); TL = json.load(open(sys.argv[4]))
BEAT, BAR, DUR = TL['BEAT'], TL['BAR'], TL['DUR']; T = TL['T']
N = int(DUR * SR); out = np.zeros((N, 2))
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
def chord(t): return HAR[max(0, min(len(HAR) - 1, int(t / BAR + 1e-6)))]['notes']
def note(t, deg, octv=1):
    ns = sorted(n % 12 + 60 for n in chord(t)); return ns[deg % len(ns)] + 12 * (octv + deg // len(ns))

def marimba(f, d=.7, v=1.0):
    tt = t_(d)
    x = np.sin(2 * np.pi * f * tt) * env_exp(d, .28) + .3 * np.sin(2 * np.pi * f * 3.93 * tt) * env_exp(d, .045) + .1 * np.sin(2 * np.pi * f * 9.2 * tt) * env_exp(d, .01)
    return norm(x + hp(noise(d), 3000) * env_exp(d, .002) * .25) * v
def bell(f, d=1.2, v=1.0):
    tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * r * tt) * env_exp(d, tau) for r, a, tau in [(1, 1, .5), (2.01, .45, .3), (3.0, .25, .18), (4.2, .15, .1)])
    return norm(x) * v
def blip(f, d=.12, v=1.0):
    tt = t_(d); return norm(np.sin(2 * np.pi * f * tt) * env_exp(d, .025) * (1 - np.exp(-tt / .002))) * v
def sweep(f0=500, f1=1400, d=.16, v=1.0):
    tt = t_(d); f = f0 + (f1 - f0) * tt / d; return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .045)) * v
def swish(d=.3, v=1.0, lo=2000, hi=8000):
    return norm(bp(noise(d), lo, hi) * np.sin(np.pi * t_(d) / d) ** 2) * v
def felt(v=1.0):   # a toy landing on paper: soft low thud + paper brush
    d = .18; tt = t_(d); return norm(np.sin(2 * np.pi * 120 * tt * (1 - .4 * tt)) * env_exp(d, .03) + bp(noise(d), 600, 3000) * env_exp(d, .012) * .5) * v
def lamp_click(v=1.0):   # a rocker switch: two clicks 25 ms apart, then the bulb's faint hum fading in
    o = np.zeros(int(.9 * SR)); a = click(.55, 1); b2 = click(.8, .6); o[:len(a)] += a; s = int(.025 * SR); o[s:s + len(b2)] += b2
    tt = t_(.85); hum = np.sin(2 * np.pi * 100 * tt) * .02 * np.minimum(1, tt / .2) * np.exp(-tt / .5); o[:len(hum)] += hum
    return o * v
def drawer_slide(d, v=1.0):   # wood on wood: band-passed noise with a little chatter, ending in a soft knock
    tt = t_(d); x = bp(noise(d), 250, 2200) * (.6 + .4 * np.abs(np.sin(2 * np.pi * 31 * tt))) * np.sin(np.pi * tt / d * .5 + .2) ** 2
    return norm(x) * v
def paper_creak(v=1.0):   # the paper plane flexing under load: a slow, quiet creak + crinkle
    c = creak(1.0); d = .35; cr = bp(noise(d), 2500, 9000) * (np.random.default_rng(3).random(int(d * SR)) > .993) * 3
    o = np.zeros(int(.4 * SR)); o[:len(c)] += c * .7; o[:len(cr)] += lp(cr, 9000) * .5; return norm(o) * v
def launch(v=1.0):   # the most important sound: a paper snap, a low kick of air, and the take-off rush
    d = 1.1; tt = t_(d)
    snap = hp(noise(d), 1500) * env_exp(d, .006) * 1.2
    air = np.sin(2 * np.pi * 70 * tt * (1 - .35 * tt)) * env_exp(d, .12)
    rush = np.zeros(int(d * SR)); n = noise(d)
    for i in range(0, len(n), 480):
        hi_ = min(len(n), i + 480); f = 500 + 3500 * (i / len(n)) ** .6; rush[i:hi_] = bp(n[max(0, i - 2000):hi_], f * .7, f * 1.3)[-(hi_ - i):]
    rush *= np.minimum(1, tt / .05) * np.exp(-tt / .45)
    return norm(snap + air * .9 + rush * .7) * v
def flight_wind(d, v=1.0):   # a light airstream while the plane flies
    tt = t_(d); x = bp(noise(d), 400, 2400) * (.7 + .3 * np.sin(2 * np.pi * .9 * tt)); return norm(x) * np.sin(np.pi * tt / d) ** .8 * v
def stamp_slam(v=1.0):   # rubber on paper on wood: a low thump, a crack, a paper slap and a crumble of confetti
    d = 1.2; tt = t_(d)
    sub = np.sin(2 * np.pi * 52 * tt * (1 - .2 * tt)) * env_exp(d, .2)
    body = lp(noise(d), 450) * env_exp(d, .05); crack = hp(noise(d), 2500) * env_exp(d, .01)
    slap = bp(noise(d), 900, 5000) * env_exp(d, .03)
    return norm(sub + body * .8 + crack * .45 + slap * .5) * v
def crumble(d=.6, v=1.0, n=26, pitch=1.0):
    o = np.zeros(int((d + .1) * SR)); r = np.random.default_rng(int(d * 1000 + n))
    for k in range(n):
        c = click(pitch * (.7 + r.random() * .8), .3 + r.random() * .7); s = int(r.random() ** 1.3 * d * SR); o[s:s + len(c)] += c[:len(o) - s]
    return norm(o) * v
def fall(d=.27, v=1.0):
    tt = t_(d); f = 1600 * (1 - .65 * tt / d); return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d) ** 2) * v

def card_land(v=1.0):   # a big sheet of card hitting the desk flat: a puff of air, the slap, a soft low thump under it
    d = .5; tt = t_(d)
    puff = lp(noise(d), 900) * env_exp(d, .03); slap = bp(noise(d), 700, 4500) * env_exp(d, .012)
    low = np.sin(2 * np.pi * 85 * tt * (1 - .3 * tt)) * env_exp(d, .07)
    return norm(puff * .5 + slap * .8 + low * .9) * v

R = np.random.default_rng(5)
for e in sorted(ev, key=lambda e: e['t']):
    t, ty = e['t'], e['type']; pan = float(R.uniform(-.25, .25)); k = e.get('k', 0)
    if ty == 'lamp': add(out, lamp_click(.32), t, 1, -.45)
    elif ty == 'pop':   # sticker → toy: a marimba note from the bar's chord + an upward sweep
        g = 1.25 if e.get('big') else 1.0
        add(out, marimba(hz(note(t, 2 + k, 1)), .6, .26 * g), t, 1, pan); add(out, sweep(420, 1500, .14, .12 * g), t, 1, pan); add(out, felt(.1), t + .4, 1, pan)
    elif ty == 'qflash': add(out, blip(hz(note(t, 3, 2)), .14, .07), t, 1, -.2); add(out, blip(hz(note(t, 4, 2)), .14, .05), t + BEAT / 4, 1, -.2)
    elif ty == 'blink': add(out, blip(2600, .03, .025), t, 1, pan)
    elif ty == 'hop': add(out, swish(.12, .05), t, 1, pan); add(out, blip(hz(note(t, k % 4, 1)), .08, .06), t, 1, pan)
    elif ty == 'jump': add(out, swish(.26, .08), t, 1, pan); add(out, blip(hz(note(t, 0, 1)), .1, .06), t, 1, pan)
    elif ty == 'land': add(out, felt(.3 * e.get('v', .4) / .4), t, 1, pan); add(out, step(.06 * e.get('v', .4) / .4), t, 1, pan)
    elif ty == 'drawer': d = e['d']; add(out, drawer_slide(d, .16), t, 1, .1); add(out, thump(.28, 95), t + d, 1, .1); add(out, click(.6, .1), t + d, 1, .1)
    elif ty == 'glow': add(out, bell(hz(note(t, 0, 2)), 1.4, .12), t, 1, 0); add(out, sweep(800, 2400, .2, .05), t, 1, 0)
    elif ty == 'win': add(out, bell(hz(note(t, k, 1)), .5, .06 + .004 * min(k, 8)), t, 1, -.4 + .07 * (k % 12))
    elif ty == 'creak': add(out, paper_creak(.13), t, 1, 0)
    elif ty == 'launch': add(out, launch(.62), t, 1, -.1); add(out, flight_wind(T['tap1'] - t, .06), t + .1, 1, .1)
    elif ty == 'roll': d = e['d']; add(out, swish(d, .12, 900, 5000), t, 1, .3)
    elif ty == 'tap': add(out, click(.95, .16), t, 1, .35); add(out, bell(hz(note(t, 2 - k, 2)), 1.0, .14), t, 1, .35)
    elif ty == 'drop': add(out, fall(.27, .08), t, 1, .3)
    elif ty == 'slam': add(out, stamp_slam(.75), t, 1, .2); add(out, crumble(.7, .12, 26, 1.1), t + .03, 1, .2); add(out, bell(hz(note(t, 0, 2)), 1.6, .08), t + .02, 1, .2)
    elif ty == 'tdrop': add(out, swish(e['d'], .07, 600, 3500), t, 1, 0); add(out, fall(e['d'], .035), t, 1, 0)
    elif ty == 'title':   # a large paper card lands flat: an air-cushioned slap, a soft low thump and one marimba note from the held chord
        add(out, card_land(.5), t, 1, 0); add(out, marimba(hz(note(t, 0, 1)), .9, .2), t, 1, 0); add(out, crumble(.3, .04, 8, 1.3), t + .02, 1, 0)
    elif ty == 'cc': add(out, marimba(hz(note(t, k, 2)), .5, .16), t, 1, -.5 + .25 * k); add(out, felt(.12), t + .14, 1, -.5 + .25 * k)
# camera whips: one whoosh per burst of fast motion (never inside the silence: the camera's descent there is quiet)
sp = np.array([c[1] + .25 * c[2] for c in cam]); ts = np.array([c[0] for c in cam]); i = 0
while i < len(sp):
    if sp[i] > .9:
        j = i
        while j < len(sp) and sp[j] > .5: j += 1
        a = max(0, i - 4); pk = sp[i:j].max(); d = max(.25, (j - a) / 30 + .1)
        if not (T['silence'][0] - .1 < ts[a] < T['launch'] - .05):
            tw = round(ts[a] / (BEAT / 4)) * (BEAT / 4)   # whooshes start on the 16th grid too
            add(out, whoosh(d, min(.5, .12 + pk * .1)), tw, 1, float(R.uniform(-.4, .4)))
        i = j + 3
    else: i += 1
peak = np.abs(out).max(); print('sfx peak', round(peak, 3))
if peak > .98: out *= .98 / peak
import soundfile as sf
sf.write(sys.argv[5], out.astype(np.float32), SR, subtype='PCM_24')
print('wrote', sys.argv[5])
