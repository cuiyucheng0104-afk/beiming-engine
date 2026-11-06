"""Independent delivery checks: actual WAV metadata, silence, gaps, music spans,
pre-master dialogue-band separation and FFmpeg EBU R128. Writes verification.json.
"""
import json, subprocess, re, hashlib
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import butter,sosfilt
R=Path(__file__).resolve().parent;SR=48000
cues=json.loads((R/'dialogue.json').read_text(encoding='utf-8')); report={}; files=[]
for c in cues:
 p=R.parent/c['file']; i=sf.info(p);x,_=sf.read(p,dtype='float32')
 assert i.samplerate==SR and i.channels==1 and abs(i.duration-(c['end']-c['start']))<1/SR
 assert np.max(np.abs(x))>.02 and c['end']-c['start']>=1.8
 files.append({'id':c['id'],'duration':i.duration,'peak_dbfs':round(float(20*np.log10(np.max(abs(x))+1e-12)),2),'bytes':p.stat().st_size})
report['dialogue_files']=files
p=R/'mix.wav';i=sf.info(p);assert i.frames==540*SR and i.channels==2
z,_=sf.read(p,start=486*SR,stop=488*SR,dtype='int32');assert np.count_nonzero(z)==0
report['master']={'seconds':i.duration,'sample_rate':i.samplerate,'channels':i.channels,'frames':i.frames,'subtype':i.subtype,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'zero_interval_seconds':[486,488],'nonzero_samples_in_interval':int(np.count_nonzero(z))}
# Measure in ffmpeg ebur128 independently from the mastering loudnorm report.
r=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(p),'-af','ebur128=peak=true','-f','null','-'],capture_output=True,text=True,check=True)
s=r.stderr[r.stderr.rfind('Summary:'):]; (R/'ebur128.txt').write_text(s,encoding='utf-8')
lu=float(re.search(r'I:\s+(-?[\d.]+) LUFS',s).group(1));tp=float(re.search(r'Peak:\s+(-?[\d.]+) dBFS',s).group(1));lra=float(re.search(r'LRA:\s+(-?[\d.]+) LU',s).group(1))
report['independent_ebur128']={'I_LUFS':lu,'TP_dBTP':tp,'LRA_LU':lra};assert abs(lu+14)<.3 and tp<=-1.2
vr={v['id']:v for v in json.loads((R/'voice_report.json').read_text(encoding='utf-8'))}
sos=butter(3,[300,4000],fs=SR,btype='bandpass',output='sos');snrs=[]
for c in cues:
 x,sr=sf.read(R.parent/c['file'],dtype='float32');length=round(vr[c['id']]['speech_seconds']*SR);x=x[:length]
 others=np.zeros((length,2),dtype='float32')
 for name,duck in [('ambience',.34),('effects',1-(1-.34)*.55),('music',1-(1-.34)*1.15)]:
  y,_=sf.read(R/'stems'/f'{name}.wav',start=round(c['start']*SR),frames=length,dtype='float32');others+=y*duck
 a=sosfilt(sos,x);b=sosfilt(sos,others,axis=0)
 # Voice goes to stereo with equal-power center; energy sum preserves mono energy.
 mask=np.abs(a)>.008;snr=10*np.log10(np.sum(a[mask]**2)/(np.sum(b[mask]**2)+1e-20))
 snrs.append({'id':c['id'],'speech_band_snr_db':round(float(snr),2)})
report['premaster_300_4000Hz_active_speech_separation']=snrs
report['minimum_speech_band_snr_db']=min(x['speech_band_snr_db'] for x in snrs)
# Verify all music lives in the three declared sections and is absent from lights-off scene.
spans=[(200,249),(455,486),(519,540)]; unexpected=0
with sf.SoundFile(R/'stems/music.wav') as f:
 for sec in range(540):
  y=f.read(SR,dtype='int32');allowed=any(a<=sec<b for a,b in spans)
  if not allowed:unexpected+=np.count_nonzero(y)
assert unexpected==0;report['music_spans_seconds']=spans;report['unexpected_music_samples']=int(unexpected)
bounds=[0,15,60,80,120,170,200,250,280,320,360,400,455,490,525,540];scenes=[]
for a,b in zip(bounds[:-1],bounds[1:]):
 x,_=sf.read(p,start=a*SR,stop=b*SR,dtype='float32');scenes.append({'start':a,'end':b,'rms_dbfs':round(float(20*np.log10(np.sqrt(np.mean(x*x))+1e-12)),2),'peak_dbfs':round(float(20*np.log10(np.max(abs(x))+1e-12)),2)})
report['scenes']=scenes
(R/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['dialogue_files','scenes','premaster_300_4000Hz_active_speech_separation']},ensure_ascii=False,indent=2))
