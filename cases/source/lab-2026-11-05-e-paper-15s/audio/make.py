"""原创合成声：纸、风、水、稀疏弹拨；时间和动画事件对应。5090 工作站运行。"""
from pathlib import Path
import numpy as np
from scipy.signal import butter,sosfilt
import soundfile as sf
import subprocess,json,re
SR=48000; DUR=15;N=SR*DUR;rng=np.random.default_rng(110506)
t=np.arange(N)/SR;mix=np.zeros((N,2),dtype=np.float64)

def band(n,lo,hi):
 return sosfilt(butter(2,[lo,hi],fs=SR,btype='band',output='sos'),n)
def add(a,start,pan=0,gain=1):
 i=int(start*SR);j=min(N,i+len(a));a=a[:j-i]*gain
 if len(a)==0:return
 mix[i:j,0]+=a*np.sqrt((1-pan)/2);mix[i:j,1]+=a*np.sqrt((1+pan)/2)
def pluck(at,midi,gain=.08,length=3.5,pan=0):
 tt=np.arange(int(length*SR))/SR;f=440*2**((midi-69)/12);a=np.zeros_like(tt)
 for k in range(1,14):
  a+=np.sin(2*np.pi*f*k*(1+.000035*k*k)*tt+rng.random()*.04)*np.exp(-tt*(.85+k*.28))/k**1.35
 a*=np.minimum(tt/.008,1);add(a,at,pan,gain)
def paper(at,length=.45,pan=0,gain=.12):
 tt=np.arange(int(length*SR))/SR;en=np.sin(np.pi*tt/length)**1.8
 n=band(rng.normal(0,1,len(tt)),650,8500);n*=en*(.5+.5*np.sin(tt*90)**2)
 add(n,at,pan,gain)

# Wide, quiet ambience, differentiated across the three places.
for pan in [-.75,.75]:
 noise=rng.normal(0,1,N);wind=band(noise,70,1250)
 env=.016+.007*np.sin(t*.55+pan)**2+.027*np.clip((t-4)/3,0,1)
 wind*=env;add(wind,0,pan)
 water=band(rng.normal(0,1,N),380,4200)*(.7+.3*np.sin(t*11)**2)*np.clip((t-9)/2,0,1)*.018
 add(water,0,pan)
for at,note,vol,pan in [(0.12,50,.055,-.25),(1.25,57,.08,.15),(2.5,62,.065,-.12),(4.5,57,.06,-.25),(5.35,64,.06,.25),(6.1,66,.05,.1),(7.82,74,.10,0),(8.45,69,.07,.2),(9.7,62,.09,-.2),(10.3,66,.07,.15),(10.95,69,.07,-.1),(12.1,74,.06,.3),(13.1,62,.065,-.2)]:pluck(at,note,vol,pan=pan)
for at,p,g in [(1.05,-.2,.07),(2.05,0,.08),(3.6,.4,.19),(4.15,-.3,.13),(5.0,.2,.07),(6.25,-.05,.13),(6.85,.05,.13),(7.5,.15,.14),(8.2,0,.08),(8.8,.2,.08),(9.35,.3,.08),(10.1,.4,.06)]:paper(at,.34 if at>6 else .52,p,g)
# Air pulled towards the reveal; generated rather than a stock whoosh.
for at,L,g in [(3.5,.85,.085),(8.95,1.05,.07)]:
 tt=np.arange(int(L*SR))/SR;a=band(rng.normal(0,1,len(tt)),120,2300)*np.sin(np.pi*tt/L)**2;add(a,at,.2,g)
# Two breathable reductions. Key folding/turn sounds remain audible after them.
for at,span in [(3.32,.28),(6.0,.20)]:
 mask=np.maximum(0,1-np.abs((t-at-span/2)/(span/2)));mix*=1-.65*mask[:,None]
fade=np.minimum(t/.07,1)*np.minimum((DUR-t)/.7,1);mix*=fade[:,None]
mix*=.82/max(np.max(np.abs(mix)),1e-9)
Path('out').mkdir(exist_ok=True);sf.write('out/mix_raw.wav',mix,SR,subtype='PCM_24')
analysis=subprocess.run(['ffmpeg','-hide_banner','-i','out/mix_raw.wav','-af','loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True,encoding='utf-8',check=True).stderr
m=json.loads(re.findall(r'\{[^{}]*"input_i"[^{}]*\}',analysis,re.S)[-1])
af=f"loudnorm=I=-14:TP=-1.2:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true:print_format=json"
r=subprocess.run(['ffmpeg','-hide_banner','-y','-i','out/mix_raw.wav','-af',af,'-ar',str(SR),'-c:a','pcm_s24le','out/mix.wav'],capture_output=True,text=True,encoding='utf-8',check=True)
Path('out/audio_normalization.json').write_text(json.dumps({'analysis':m,'second_pass':r.stderr},ensure_ascii=False,indent=2),encoding='utf-8')
print('合成声音完成：15 秒 / 48kHz / 双遍 loudnorm')
