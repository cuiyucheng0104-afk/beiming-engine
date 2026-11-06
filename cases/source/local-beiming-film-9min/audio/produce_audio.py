"""Northern Sea / 540s. Deterministic CPU-only sound, new sampled score and mix.
python audio/produce_audio.py --stage beds|score|mix|all --samples PATH
All generated files stay in audio/. No engine/src imports or writes.
"""
import os
os.environ.setdefault('OMP_NUM_THREADS','2'); os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
import argparse, hashlib, json, math, re, shutil, subprocess
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly
import lib_sampler as S
SR=48000; DUR=540.; SEED=20261105
ROOT=Path(__file__).resolve().parent
EVENTS=[]
def n(t): return int(round(t*SR))
def db(v): return 10**(v/20)
def smooth(x): x=np.clip(x,0,1); return x*x*(3-2*x)
def filt(x,cut,btype='lowpass',order=2): return sosfilt(butter(order,cut,fs=SR,btype=btype,output='sos'),x,axis=0).astype('float32')
def norm(x,rms=.1): return x*(rms/max(1e-9,float(np.sqrt(np.mean(x*x)))))
def envelope(d,attack=.03,release=.1):
    t=np.arange(n(d),dtype='float32')/SR
    return smooth(t/max(attack,.001))*smooth((d-t)/max(release,.001))
def put(buf,x,t,gain=1.,pan=0.):
    a=n(t); b=min(len(buf),a+len(x))
    if b<=a:return
    x=x[:b-a]
    if x.ndim==1:
        ang=(pan+1)*np.pi/4
        buf[a:b,0]+=x*gain*np.cos(ang); buf[a:b,1]+=x*gain*np.sin(ang)
    else: buf[a:b]+=x*gain

def write(name,x):
    p=ROOT/name; p.parent.mkdir(parents=True,exist_ok=True); sf.write(p,x,SR,subtype='PCM_24'); print('WROTE',name,round(len(x)/SR,3),flush=True)
def silence(x):
    # End every signal at the shutter boundary, leave [486,488) sample-exact zero.
    k=n(.025); x[n(486)-k:n(486)]*=np.linspace(1,0,k,dtype='float32')[:,None]
    x[n(486):n(488)]=0
    x[n(488):n(489.5)]*=np.linspace(0,1,n(1.5),dtype='float32')[:,None]
    return x

def reverberate(x,wet=.2):
    y=x.copy()
    for dt,amp in [(.071,.36),(.137,.26),(.229,.19),(.349,.13),(.523,.085),(.811,.05)]:
        k=n(dt); y[k:]+=x[:-k,::-1]*(wet*amp)
    return y

def beds():
    rng=np.random.default_rng(SEED); amb=np.zeros((n(DUR),2),dtype='float32')
    # Each minute draws fresh noise; overlaps are crossfaded. No short ambience loops.
    for start in range(0,540,54):
        d=min(60.,540.-start); tt=start+np.arange(n(d),dtype='float32')/SR
        white=rng.standard_normal((n(d),2),dtype='float32')
        wind=norm(filt(filt(white,75,'highpass'),1700),.025)
        gust=.65+.18*np.sin(tt*.21)+.12*np.sin(tt*.071+1.3)+.1*np.sin(tt*.413)
        wind*=gust[:,None]
        sea=smooth((tt-390)/60)
        wind*=np.interp(tt,[0,60,170,250,320,400,430,450,470,490,540],[.65,.5,.8,.6,.35,.32,.65,1.6,1.9,.8,.65])[:,None]
        water=norm(filt(filt(rng.standard_normal((n(d),2),dtype='float32'),180,'highpass'),5800),.023)
        short=(.42+.58*np.maximum(0,np.sin(tt*2.1+np.sin(tt*.43)))**3)
        long=(.18+.82*(.5+.5*np.sin(tt*.57+np.sin(tt*.09)))**2)
        water*=((1-sea)*short+sea*long)[:,None]
        hum=np.zeros(n(d),dtype='float32')
        for hz,amp in [(42,.012),(63,.008),(84,.005),(126,.0028),(168,.0016)]:
            hum+=amp*np.sin(2*np.pi*hz*tt+.25*np.sin(tt*.8))
        motor=np.interp(tt,[0,15,35,60,170,195,250,300,320,355,370,400,430,490,525,540],[.3,.9,.5,.3,.45,1.,.9,.5,.08,.08,.15,.22,.2,.12,.3,.35])
        hum*=motor*(.88+.12*np.sin(tt*8.5))
        city=norm(filt(rng.standard_normal((n(d),2),dtype='float32'),350),.004)
        city*=np.clip(1-(tt-200)/160,0,1)[:,None]
        chunk=wind+water+hum[:,None]*.707+city
        fade=np.ones(n(d),dtype='float32')
        if start>0: fade[:n(6)]*=smooth(np.arange(n(6))/n(6))
        if start+d<540: fade[-n(6):]*=smooth(np.arange(n(6),0,-1)/n(6))
        chunk*=fade[:,None]; put(amb,chunk,start)
    amb[:n(2)]*=np.linspace(0,1,n(2),dtype='float32')[:,None]
    amb[n(537):]*=np.linspace(1,0,n(3),dtype='float32')[:,None]
    silence(amb); write('stems/ambience.wav',amb); del amb
    fx=np.zeros((n(DUR),2),dtype='float32')
    def event(label,t,x,gain=1.,pan=0.):
        put(fx,x,t,gain,pan); EVENTS.append({'name':label,'start':t,'end':round(t+len(x)/SR,4)})
    def noise(d,lo=300,hi=3000):
        return norm(filt(rng.standard_normal(n(d),dtype='float32'),[lo,hi],'bandpass'),.1)
    def clack(t,amp=.15,p=-.15):
        d=.18; tt=np.arange(n(d))/SR
        x=(noise(d,800,6000)*np.exp(-tt*85)+.08*np.sin(2*np.pi*810*tt)*np.exp(-tt*35))*envelope(d,.001,.015)
        event('mechanical_click',t,x,amp,p)
    # Bird family: small, local wing beats at opening; giant feather movement in climax.
    for t in [1.8,2.16,2.52,4.1,4.39,4.67]:
        d=.24; x=noise(d,450,4200)*np.sin(np.linspace(0,np.pi,n(d)))**2
        event('pigeon_wing',t,x,.32,-.6+.12*t)
    for t in [22.7,24.2,31.6,34.2,52.8,57.5,61.3,63.5,172.1,187.8,196.6,322.2,334.1,362.5,366.0,371.5,380.2,501.0,520.1,528.4]:clack(t, .22 if 360<t<390 else .12)
    for t in [23.5,54.3,526.3]:
        d=1.3; x=noise(d,200,2300)*envelope(d,.2,.5)*(.45+.55*np.sin(np.arange(n(d))/SR*17)**2)
        event('rope_friction',t,x,.12,-.3)
    # Shared harmonic family: 65.4 Hz ferry -> descending 65/49 Hz creature, no speech.
    def call(t,d,kun=False,g=.8):
        tt=np.arange(n(d),dtype='float32')/SR
        freq=(65.4 if not kun else 65.4-16*smooth(tt/d))*(1+.004*np.sin(tt*5.1))
        phase=2*np.pi*np.cumsum(freq)/SR; x=np.zeros(n(d),dtype='float32')
        for h,a in [(1,.11),(2,.075),(3,.035),(4,.016),(6,.005)]: x+=a*np.sin(h*phase+.1*h)
        x+=noise(d,80,700)*(.035 if kun else .08)
        x*=envelope(d,.55 if kun else .16,1.6 if kun else .5)
        st=np.stack([x,np.roll(x,n(.015 if kun else .002))],axis=1)*.707
        st=reverberate(st,.5 if kun else .15)
        event('kun_call' if kun else 'ferry_horn',t,st,g)
    call(12.8,2.4,False,.33); call(71.2,6.5,True,.6); call(122.,7.,True,.46)
    call(208.,3.2,False,.9); call(218.,7.5,True,.85); call(263.5,7.,True,.45); call(420.5,8.5,True,.75)
    # Loose glass/barnacle contact, no disaster explosion.
    for t in [124.8,132.6,150.1,163.4]:
        d=2.; tt=np.arange(n(d))/SR
        x=sum(.014*np.sin(2*np.pi*f*tt)*np.exp(-tt*(2+i*.4)) for i,f in enumerate([640,857,1301,1991]))
        x*=envelope(d,.006,.3); event('glass_shell_resonance',t,x,1.,.3)
    # Quiet interface ticks; no science-fiction sweep.
    for t in [38.7,86.2,180.7,313.7,494.7,515.7]:
        d=.14; tt=np.arange(n(d))/SR; x=.016*np.sin(2*np.pi*940*tt)*envelope(d,.015,.09)
        event('interface_tick',t,x,1.,0.)
    # Radio opens around actual dialogue, signal floor is included only near speaker.
    cues=json.loads((ROOT/'dialogue.json').read_text(encoding='utf-8'))
    for c in cues:
        if c['speaker']=='老周':
            d=.15; x=noise(d,550,3300)*envelope(d,.005,.08)
            event('radio_open',c['start']-.17,x,.08,0.)
    # Breath-level close sounds during glasses off / lights off; no musical drone.
    for t in [321.7,335.0,357.0,386.0,395.0]:
        d=1.5; x=noise(d,360,2400)*envelope(d,.38,.65)
        event('breath_close',t,x,.045,0.)
    for t,d,g in [(228.,4.5,.4),(429.,11.,.72),(455.,7.,.9)]:
        tt=np.arange(n(d))/SR; x=noise(d,80,6000)*envelope(d,.5,4.)
        x+=.04*np.sin(2*np.pi*(35*tt+5*tt**1.2))*envelope(d,.2,3.)
        event('water_displacement',t,x,g,0.)
    for i,t in enumerate([459.,463.5,468.,473.0,478.0]):
        d=2.5; x=noise(d,250,4200)*envelope(d,.35,1.7)
        event('peng_wing_air',t,x,.35+.035*i,(-1)**i*.5)
    # 486.000 is the visual shutter cut. Its preceding mechanical stroke is 120 ms.
    d=.12; tt=np.arange(n(d))/SR
    x=(noise(d,700,9000)*np.exp(-tt*52)+.1*np.sin(2*np.pi*1450*tt)*np.exp(-tt*90))*envelope(d,.001,.015)
    event('shutter_resolves_at_486',485.88,x,.95,0.)
    silence(fx); write('stems/effects.wav',fx)
    (ROOT/'effects_events.json').write_text(json.dumps(EVENTS,ensure_ascii=False,indent=2),encoding='utf-8')

def score(samples):
    S.ROOT=str(samples); S.seed(SEED)
    S.INSTRUMENTS['piano']=('vsco2ce/Keys/Upright Nr1','dec',1.5)
    S.INSTRUMENTS['flute']=('vsco2ce/Woodwinds/Flute/susvib','sus',.45)
    # Capture the exact picked sample set, not merely a dependency on an external library.
    used=set(); original=S._read
    def track(path): used.add(Path(path)); return original(path)
    S._read=track
    score_events=[]; full=np.zeros((n(DUR),2),dtype='float32')
    def instrument(buf,inst,pitch,t,d,vel=.35,g=-4,pan=0,attack=.3,release=.6):
        if d<=0:return
        x=S.note(inst,pitch,d,vel=vel,attack=attack if inst!='piano' and inst!='harp' else .005,release=release)
        # Normalize a stable body of each sample, retain attack/transient detail and velocity.
        body=x[n(min(.4,d*.2)):n(max(.6,min(d,2.)))]
        x=x*(.065/max(float(np.sqrt(np.mean(body*body))),.005))
        x*=db(g)*(.75+.5*vel)
        put(buf,x,t,1.,pan)
        score_events.append({'cue':cue_name,'instrument':inst,'pitch':pitch,'start':round(offset+t,3),'duration':d,'velocity':vel,'gain_db':g,'pan':pan})
    def finish(buf,target,name,start):
        import pyloudnorm as pyln
        buf=reverberate(buf,.7)
        buf[:n(.8)]*=smooth(np.arange(n(.8))/n(.8))[:,None]
        tail=.05 if name=='02_peng' else 2.4
        buf[-n(tail):]*=smooth(np.arange(n(tail),0,-1)/n(tail))[:,None]
        measured=pyln.Meter(SR).integrated_loudness(buf); buf*=db(target-measured)
        write('music/'+name+'.wav',buf); put(full,buf,start)
    # I. 6/8, ~72 dotted-quarter, 49 sec. D(add9) -> Gmaj9 -> Bm7 -> A(sus) -> D6.
    # Piano and flute exchange two unequal phrases; strings breathe between bow changes.
    cue_name='river'; offset=200.; b=np.zeros((n(49),2),dtype='float32')
    chords=[(0,7.7,['D3','A3','E4']),(8.8,7.6,['G2','D3','B3']),(17.8,7.5,['B2','F#3','D4']),(27.1,7.8,['A2','E3','G3']),(37.0,8.2,['D3','A3','F#4'])]
    for t,d,notes in chords:
        for j,p in enumerate(notes):instrument(b,['cellos','violas','violins'][j],p,t,d,.28,-10-j*2,[-.15,.2,-.35][j],.8,1.2)
        for j,p in enumerate([notes[0],notes[1],notes[2],notes[1]]):instrument(b,'piano',p,t+.1+j*.86,2.3,.28,-9,-.18,release=1.5)
    melody=[(1.5,'A4',1.1),(3.2,'B4',1.3),(5.1,'D5',2.),(9.9,'E5',1.1),(11.7,'D5',1.3),(13.6,'B4',2.3),(19.,'F#4',1.6),(21.5,'A4',1.3),(23.4,'B4',1.8),(28.5,'E5',1.6),(31.0,'F#5',1.5),(33.3,'A5',1.8),(38.1,'F#5',1.9),(41.,'E5',1.7),(43.5,'D5',2.5)]
    for i,(t,p,d) in enumerate(melody):instrument(b,'piano' if i<6 or i>11 else 'flute',p,t,d,.36,-3 if i<6 or i>11 else -7,-.25 if i<6 or i>11 else .25,attack=.22,release=1.3)
    finish(b,-26.5,'01_river',offset)
    # II. 31-second through-composed ascent; D minor colour opens into D major.
    cue_name='peng'; offset=455.; b=np.zeros((n(31),2),dtype='float32')
    chords=[(0,5.5,['D2','A3','F4','A4']),(6.,5.1,['Bb2','F3','D4','Bb4']),(11.7,5.1,['G2','D4','B4','D5']),(17.5,4.4,['A2','E4','G4','E5']),(22.5,7.8,['D2','A3','F#4','F#5'])]
    for ci,(t,d,notes) in enumerate(chords):
        for j,p in enumerate(notes):
            instrument(b,['contrabass','cellos','violas','violins'][j],p,t,d,.32+ci*.12,-8+j*.5,[-.05,.25,.05,-.4][j],.6 if ci<4 else .15,.6)
        if ci>=2:
            for j,p in enumerate([notes[1],notes[2]]): instrument(b,'horn',p,t+.2,d-.3,.35+ci*.1,-11,.1+j*.15,.5,.6)
        for j,p in enumerate([notes[0],notes[1],notes[2],notes[3],notes[2]]):instrument(b,'harp',p,t+.15+j*.42,1.4,.35+ci*.07,-11,-.6+j*.15,release=.9)
    mel=[(.9,'A4',1.6),(3.1,'D5',2.),(6.9,'F5',1.7),(9.1,'E5',1.4),(12.4,'D5',1.6),(14.5,'G5',2.),(18.1,'E5',1.1),(19.7,'A5',1.8),(22.7,'F#5',2.2),(25.5,'A5',1.6),(27.7,'D6',2.3)]
    for i,(t,p,d) in enumerate(mel):instrument(b,'violins',p,t,d,.4+i*.035,-3,-.3,.35,.45)
    # Wordless breath/formant choir, clearly documented as synthesis (no fake singer sample).
    rng=np.random.default_rng(SEED+90)
    for j,p in enumerate(['D4','A4','F#5']):
        d=8.2; tt=np.arange(n(d),dtype='float32')/SR; f=440*2**((S.midi(p)-69)/12)
        x=np.zeros(n(d),dtype='float32')
        for v in range(4):
            phase=2*np.pi*f*(1+(v-1.5)*.0015)*tt+.015*np.sin(2*np.pi*(4.5+.1*v)*tt)
            for h in range(1,15):
                amp=np.exp(-((f*h-750)/480)**2)+.3*np.exp(-((f*h-1250)/330)**2)
                x+=np.sin(h*phase+rng.uniform(0,2*np.pi))*amp/h
        x=norm(x,.014)*envelope(d,1.5,.5); put(b,x,22.5,1.,-.45+j*.45)
        score_events.append({'cue':'peng','instrument':'synthetic_wordless_choir','pitch':p,'start':477.5,'duration':d})
    dyn=np.interp(np.arange(len(b))/SR,[0,5,10,15,20,21.4,22.3,24,29.5,31],[.35,.5,.55,.75,.9,.62,.64,1.,.86,.6]); b*=dyn[:,None]
    finish(b,-22.7,'02_peng',offset)
    # III. A new 21-second coda after the reply: warm, incomplete horizon, no looping reprise.
    cue_name='morning'; offset=519.; b=np.zeros((n(21),2),dtype='float32')
    for t,p,d in [(0.,'D3',8.),(8.6,'G3',5.8),(15.1,'D3',4.)]:instrument(b,'cellos',p,t,d,.2,-15,.18,1.2,1.)
    for t,p,d in [(0.7,'F#4',2.2),(3.7,'A4',2.2),(7.0,'E5',2.8),(11.0,'D5',2.5),(14.7,'A4',2.1),(17.1,'D5',2.5)]:instrument(b,'piano',p,t,d,.25,-5,-.2,release=1.8)
    for t,p in [(1.1,'A3'),(7.4,'B3'),(12.,'G4'),(17.5,'E4')]:instrument(b,'harp',p,t,2.5,.2,-16,.4,release=1.5)
    finish(b,-29.,'03_morning',offset)
    silence(full); write('stems/music.wav',full)
    (ROOT/'score_events.json').write_text(json.dumps(score_events,ensure_ascii=False,indent=2),encoding='utf-8')
    manifest=[]
    for path in sorted(used):
        rel=path.relative_to(samples); dest=ROOT/'samples'/rel; dest.parent.mkdir(parents=True,exist_ok=True)
        if path.resolve()!=dest.resolve():shutil.copy2(path,dest)
        manifest.append({'file':str(rel).replace('\\','/'),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
    for name in ['vsco2ce','vcsl']:
        p=Path(samples)/name/'LICENSE'
        if p.exists() and p.resolve()!=(ROOT/'samples'/name/'LICENSE').resolve():shutil.copy2(p,ROOT/'samples'/name/'LICENSE')
    (ROOT/'samples/manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print('SAMPLES',len(manifest),flush=True)

def ffmeasure(path):
    p=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(path),'-af','loudnorm=I=-14:TP=-1.5:LRA=16:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
    return json.loads(p.stderr[p.stderr.rfind('{'):p.stderr.rfind('}')+1])

def mix():
    cues=json.loads((ROOT/'dialogue.json').read_text(encoding='utf-8'))
    dialogue=np.zeros((n(DUR),2),dtype='float32'); duck=np.ones(n(DUR),dtype='float32')
    vreport=json.loads((ROOT/'voice_report.json').read_text(encoding='utf-8')); spoken={v['id']:v['speech_seconds'] for v in vreport}
    for c in cues:
        x,sr=sf.read(ROOT.parent/c['file'],dtype='float32'); assert sr==SR and len(x)==n(c['end']-c['start'])
        put(dialogue,x,c['start'])
        # Automate from actual WAV duration without changing the authoritative cue.
        a=max(0,n(c['start']-.18)); b=min(n(DUR),n(c['start']+spoken[c['id']]+.6))
        e=np.ones(b-a,dtype='float32'); aa=n(.18); rr=n(.6)
        e[:aa]=smooth(np.arange(aa)/aa); e[-rr:]=smooth(np.arange(rr,0,-1)/rr)
        duck[a:b]*=1-.66*e
    write('stems/dialogue.wav',dialogue)
    premix=dialogue
    for name,g,du in [('ambience',1.,1.),('effects',1.,.55),('music',1.,1.15)]:
        x,sr=sf.read(ROOT/'stems'/f'{name}.wav',dtype='float32'); assert sr==SR and len(x)==n(DUR)
        x*=np.clip(1-(1-duck)*du,.18,1.)[:,None]; premix+=x*g
        del x
    silence(premix); write('premix.wav',premix); del premix
    measured=ffmeasure(ROOT/'premix.wav')
    filtstr=('loudnorm=I=-14:TP=-1.5:LRA=16:measured_I={input_i}:measured_TP={input_tp}:measured_LRA={input_lra}:measured_thresh={input_thresh}:offset={target_offset}:linear=true:print_format=json').format(**measured)
    p=subprocess.run(['ffmpeg','-hide_banner','-nostats','-y','-i',str(ROOT/'premix.wav'),'-af',filtstr,'-ar',str(SR),'-c:a','pcm_s24le',str(ROOT/'mix_normalized.wav')],capture_output=True,text=True,check=True)
    normalization=json.loads(p.stderr[p.stderr.rfind('{'):p.stderr.rfind('}')+1])
    x,sr=sf.read(ROOT/'mix_normalized.wav',dtype='float32',always_2d=True)
    # Resampling/dither/limiting may smear a cut: enforce zero AFTER mastering.
    x=x[:n(DUR)]
    if len(x)<n(DUR):x=np.pad(x,((0,n(DUR)-len(x)),(0,0)))
    x[n(486):n(488)]=0; write('mix.wav',x); del x
    final=ffmeasure(ROOT/'mix.wav')
    # A final uniform correction preserves artistic envelopes and zero-sample interval.
    delta=-14-float(final['input_i'])
    if abs(delta)>.08 and float(final['input_tp'])+delta<=-1.25:
        x,sr=sf.read(ROOT/'mix.wav',dtype='float32'); x*=db(delta); x[n(486):n(488)]=0;write('mix.wav',x);del x
        final=ffmeasure(ROOT/'mix.wav')
    silence_data,sr=sf.read(ROOT/'mix.wav',start=n(486),stop=n(488),dtype='int32')
    info=sf.info(ROOT/'mix.wav'); result={'duration_seconds':info.duration,'frames':info.frames,'sample_rate':info.samplerate,'channels':info.channels,'subtype':info.subtype,'integrated_LUFS':float(final['input_i']),'true_peak_dBTP':float(final['input_tp']),'LRA_LU':float(final['input_lra']),'silence_486_488_nonzero_samples':int(np.count_nonzero(silence_data)),'silence_frames':len(silence_data),'dialogue_count':len(cues),'min_subtitle_seconds':min(round(c['end']-c['start'],3) for c in cues),'seed':SEED,'normalization':normalization,'premix_measurement':measured,'mix_sha256':hashlib.sha256((ROOT/'mix.wav').read_bytes()).hexdigest()}
    assert abs(info.duration-540)<1/SR
    assert abs(result['integrated_LUFS']+14)<=.3, result
    assert result['true_peak_dBTP']<=-1.2, result
    assert result['silence_486_488_nonzero_samples']==0
    (ROOT/'mix_report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)
    # Lightweight preview for review, not the master (lossy encoding doesn't preserve exact zeros).
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(ROOT/'mix.wav'),'-c:a','libmp3lame','-b:a','192k',str(ROOT/'mix_preview.mp3')],check=True)
    for name in ['mix_normalized.wav']:
        (ROOT/name).unlink(missing_ok=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--stage',choices=['all','beds','score','mix'],default='all');p.add_argument('--samples',type=Path,default=ROOT/'samples');a=p.parse_args()
    if a.stage in ['all','beds']:beds()
    if a.stage in ['all','score']:score(a.samples)
    if a.stage in ['all','mix']:mix()
