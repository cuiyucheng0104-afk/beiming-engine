from pathlib import Path
import subprocess,json,re,math,hashlib
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'delivery'; OUT.mkdir(exist_ok=True)
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True,encoding='utf-8').stdout
movie=OUT/'paper-rivers_E_4k.mp4'
probe=json.loads(run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(movie)]))
v=next(s for s in probe['streams'] if s['codec_type']=='video')
assert int(v['width'])==3840 and int(v['height'])==2080
assert v['nb_frames']=='360' and v['r_frame_rate']=='24/1'
assert abs(float(probe['format']['duration'])-15)<.05
q=subprocess.run(['ffmpeg','-hide_banner','-i',str(movie),'-vf','blackdetect=d=0.04:pix_th=0.06,freezedetect=n=-60dB:d=0.6','-af','ebur128=peak=true','-f','null','-'],capture_output=True,text=True,encoding='utf-8',check=True)
(OUT/'verification.log').write_text(q.stderr,encoding='utf-8')
black=[s for s in q.stderr.splitlines() if 'black_start' in s]
freezes=[s for s in q.stderr.splitlines() if 'freeze_start' in s]
frames=ROOT/'out'/'qa_frames';frames.mkdir(exist_ok=True)
run(['ffmpeg','-v','error','-y','-i',str(movie),'-vf','fps=1,scale=480:260',str(frames/'key_%02d.jpg')])
files=sorted(frames.glob('key_*.jpg'));sheet=Image.new('RGB',(1920,math.ceil(len(files)/4)*288),(30,39,39));d=ImageDraw.Draw(sheet)
for i,f in enumerate(files):
 x=i%4*480;y=i//4*288;sheet.paste(Image.open(f),(x,y));d.text((x+10,y+265),f'{i+.5:.1f} s',fill=(227,213,184))
sheet.save(OUT/'contact_sheet.jpg',quality=94)
run(['ffmpeg','-v','error','-y','-ss','5.9','-i',str(movie),'-t','2.4','-vf','fps=5,scale=480:260',str(frames/'fold_%02d.jpg')])
fs=sorted(frames.glob('fold_*.jpg'));s=Image.new('RGB',(1920,math.ceil(len(fs)/4)*288),(30,39,39));d=ImageDraw.Draw(s)
for i,f in enumerate(fs):
 x=i%4*480;y=i//4*288;s.paste(Image.open(f),(x,y));d.text((x+10,y+265),f'{6+i*.2:.1f} s',fill=(227,213,184))
s.save(OUT/'fold_strip.jpg',quality=94)
cyan_counts={f.name:sum(1 for r,g,b in Image.open(f).convert('RGB').getdata() if r<170 and g>220 and b>210) for f in fs}
assert max(cyan_counts.values(),default=0)<4, f'折纸区域有意外青色闪片: {cyan_counts}'
run(['ffmpeg','-v','error','-y','-ss','8.3','-i',str(movie),'-frames:v','1','-q:v','2',str(OUT/'poster.jpg')])
for time,name in [('2.8','desk'),('7.9','court'),('12','river')]:run(['ffmpeg','-v','error','-y','-ss',time,'-i',str(movie),'-frames:v','1','-vf','scale=1280:-2','-q:v','2',str(OUT/f'{name}.jpg')])
report={'video':{k:v[k] for k in ['width','height','nb_frames','r_frame_rate','duration']},'black_frames':black,'freeze_events':freezes,'unexpected_cyan_pixels':cyan_counts,'sha256':hashlib.sha256(movie.read_bytes()).hexdigest(),'gpu_probe':json.loads((ROOT/'out/probe.json').read_text(encoding='utf-8'))}
(OUT/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:report[k] for k in ['video','black_frames','freeze_events','sha256']},ensure_ascii=False))
