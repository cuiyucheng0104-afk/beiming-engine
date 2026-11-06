"""Generate/fix 35 Chinese dialogue cues on CPU; online EdgeTTS with persistent MP3 cache.
Usage: python audio/make_voices.py [--root PROJECT/audio]
Never fabricates a WAV on TTS failure. Cached MP3 and source hashes make reruns reproducible.
"""
import os
os.environ.setdefault('OMP_NUM_THREADS','2')
import asyncio, argparse, hashlib, io, json, subprocess
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt
import edge_tts
SR=48000
VOICES={'林潮':('zh-CN-XiaoxiaoNeural','-7%','-8Hz'), '老周':('zh-CN-YunxiNeural','-12%','-6Hz'), '乐奇':('zh-CN-XiaoyiNeural','+0%','+0Hz')}
def decode(path):
    r=subprocess.run(['ffmpeg','-v','error','-i',str(path),'-ar',str(SR),'-ac','1','-f','f32le','-'],capture_output=True,check=True)
    x=np.frombuffer(r.stdout,dtype='<f4').copy()
    if len(x)<SR*.15 or np.max(np.abs(x))<.001: raise RuntimeError('Empty or silent TTS')
    return x
async def main(root):
    root=Path(root); cues=json.loads((root/'dialogue.json').read_text(encoding='utf-8'))
    (root/'dialogue').mkdir(exist_ok=True); (root/'tts_cache').mkdir(exist_ok=True)
    sem=asyncio.Semaphore(3); results=[]
    async def one(c):
        async with sem:
            voice,rate,pitch=VOICES[c['speaker']]
            spoken_text={'d01':'末班船。靠岸后，收船。','d09':'海运。则将徙于南冥。'}.get(c['id'],c['text'])
            if c['id']=='d09': rate='-12%'
            # Spoken-only disambiguation: 鲲/冥/徙 are retained for accurate original dialogue.
            key=hashlib.sha256(json.dumps([spoken_text,voice,rate,pitch],ensure_ascii=False).encode()).hexdigest()[:20]
            cache=root/'tts_cache'/f'{key}.mp3'
            if not cache.exists():
                for attempt in range(3):
                    try:
                        await asyncio.wait_for(edge_tts.Communicate(spoken_text,voice,rate=rate,pitch=pitch).save(str(cache)+'.part'),timeout=45)
                        Path(str(cache)+'.part').replace(cache); break
                    except Exception as e:
                        if attempt==2: raise RuntimeError(f'{c["id"]}: {e}')
                        await asyncio.sleep(2+attempt)
            x=decode(cache); nz=np.flatnonzero(np.abs(x)>max(.0004,np.max(np.abs(x))*.014))
            x=x[max(0,nz[0]-int(.035*SR)):min(len(x),nz[-1]+int(.13*SR))]
            natural=len(x)/SR; budget=c['end']-c['start']; target=budget-.08
            speed=max(.88,min(1.18,natural/target)) if natural>target or natural<budget*.72 else 1.
            if natural/speed>target: speed=natural/target
            if abs(speed-1)>.001:
                p=subprocess.run(['ffmpeg','-v','error','-f','f32le','-ar',str(SR),'-ac','1','-i','pipe:0','-af',f'atempo={speed}','-f','f32le','pipe:1'],input=x.astype('<f4').tobytes(),capture_output=True,check=True)
                x=np.frombuffer(p.stdout,dtype='<f4').copy()
            x=sosfilt(butter(2,100,fs=SR,btype='highpass',output='sos'),x).astype(np.float32)
            if c['speaker']=='老周':
                x=sosfilt(butter(3,[230,4200],fs=SR,btype='bandpass',output='sos'),x).astype(np.float32)
                x=np.tanh(x*1.7)/1.7
                rng=np.random.default_rng(20261105+int(c['id'][1:])); noise=rng.normal(size=len(x)).astype(np.float32)
                noise=sosfilt(butter(2,[600,3400],fs=SR,btype='bandpass',output='sos'),noise)
                noise*=.00055/(np.std(noise)+1e-9); x+=noise.astype(np.float32)
            frames=np.pad(x,(0,(-len(x))%(SR//100))).reshape(-1,SR//100)
            active=np.sqrt(np.mean(frames**2,axis=1)); used=frames[active>max(active.max()*.08,.0005)]
            rms=np.sqrt(np.mean(used**2)); x*=10**(-22/20)/max(rms,1e-8)
            x=.52*np.tanh(x/.52)
            f=min(int(.008*SR),len(x)//2); x[:f]*=np.linspace(0,1,f); x[-f:]*=np.linspace(1,0,f)
            speech_duration=len(x)/SR; total=round(budget*SR)
            if len(x)>total: raise RuntimeError(f'{c["id"]}: fitted audio exceeds cue')
            x=np.pad(x,(0,total-len(x))); dest=root/'dialogue'/f'{c["id"]}.wav'; sf.write(dest,x,SR,subtype='PCM_24')
            row={'id':c['id'],'voice':voice,'spoken_text':spoken_text,'rate':rate,'pitch':pitch,'natural_seconds':round(natural,4),'tempo_factor':round(speed,5),'speech_seconds':round(speech_duration,4),'file_seconds':budget,'sample_rate':SR,'peak_dbfs':round(float(20*np.log10(np.max(np.abs(x))+1e-12)),2),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'cache':str(cache.name)}
            results.append(row); print(c['id'],c['speaker'],round(speech_duration,2),'/',budget,flush=True)
    await asyncio.gather(*(one(c) for c in cues))
    (root/'voice_report.json').write_text(json.dumps(sorted(results,key=lambda x:x['id']),ensure_ascii=False,indent=2),encoding='utf-8')
    def tc(t):
        ms=round(t*1000); return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'
    srt='\n\n'.join(f'{i+1}\n{tc(c["start"])} --> {tc(c["end"])}\n{c["text"]}' for i,c in enumerate(cues))+'\n'
    (root/'dialogue.srt').write_text(srt,encoding='utf-8')
    (root/'dialogue_speakers.srt').write_text('\n\n'.join(f'{i+1}\n{tc(c["start"])} --> {tc(c["end"])}\n{c["speaker"]}：{c["text"]}' for i,c in enumerate(cues))+'\n',encoding='utf-8')
if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--root',default=str(Path(__file__).resolve().parent)); a=p.parse_args(); asyncio.run(main(a.root))
