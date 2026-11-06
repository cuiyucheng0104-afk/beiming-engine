import numpy as np
from scipy.signal import butter,sosfilt
import soundfile as sf
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sr=48000;n=sr*10;t=np.arange(n)/sr; rng=np.random.default_rng(20261106)
y=np.zeros((n,2),np.float64)
def stereo(a,pan=0):
    return np.column_stack([a*np.sqrt((1-pan)/2),a*np.sqrt((1+pan)/2)])
def add(a,start,pan=0,gain=1):
    i=int(start*sr); k=min(len(a),n-i)
    if k>0:y[i:i+k]+=stereo(a[:k],pan)*gain
# Wind has independent stereo turbulence and a low pass; no hiss wall.
for ch in range(2):
    w=sosfilt(butter(3,420,fs=sr,output="sos"),rng.normal(size=n))
    y[:,ch]+=.08*w*(.6+.25*np.sin(t*.7+ch)+.15*np.sin(t*2.7))
# Water: sparse broadband ripples softened by 1 kHz low pass.
for k in range(32):
    d=.16+rng.random()*.24;u=np.arange(int(sr*d))/sr
    a=sosfilt(butter(2,1000,fs=sr,output="sos"),rng.normal(size=len(u)))
    a*=np.sin(np.pi*u/d)**2*.018
    add(a,rng.uniform(0,9.5),rng.uniform(-.8,.8))
# Ferry horn: gentle falling harmonic breath at the opening.
u=np.arange(int(sr*1.8))/sr
fr=146.83+7*np.exp(-u*6); ph=2*np.pi*np.cumsum(fr)/sr
a=(np.sin(ph)+.25*np.sin(2*ph)+.10*np.sin(3*ph))*np.sin(np.pi*u/1.8)**1.3
add(a,.45,-.35,.11)
# Kun answer on the eye shot. Low singing resonances, not a sharp synthetic roar.
u=np.arange(int(sr*3.1))/sr
fr=84-18*u/3.1+3*np.sin(u*2.3);ph=2*np.pi*np.cumsum(fr)/sr
body=(np.sin(ph)+.27*np.sin(ph*2)+.11*np.sin(ph*3.01))*np.sin(np.pi*u/3.1)**1.5
add(body,3.7,.2,.16)
for delay,g in [(.23,.18),(.61,.10),(.93,.06)]:add(body,3.7+delay,-.3,g*.16)
# Restrained bowed chord opens with the final wide shot, carrying the tail-out.
u=np.arange(int(sr*4.1))/sr
for k,fr in enumerate([146.832,220,293.665,369.994]):
    a=sum((.72**h)/(h+1)*np.sin(2*np.pi*fr*(h+1)*u + .003*np.sin(u*5.7)) for h in range(5))
    e=np.minimum(1,u/.95)*(1-np.clip((u-2.9)/1.2,0,1))
    add(a*e,5.9,(-.55+k*.36),.032)
for at,fr in [(6.35,587.33),(7.15,659.25),(8.1,880)]:
    u=np.arange(int(sr*1.7))/sr
    a=(np.sin(2*np.pi*fr*u)+.18*np.sin(2*np.pi*fr*2.01*u))*np.exp(-u*3.6)*np.minimum(1,u/.015)
    add(a,at,(at-7.1)*.3,.025)
fade=np.minimum(1,t/.25)*np.minimum(1,(10-t)/.65)
y*=fade[:,None];y*=.77/max(.77,np.abs(y).max())
sf.write(ROOT/'media/sound.wav',y,sr,subtype="PCM_24")
