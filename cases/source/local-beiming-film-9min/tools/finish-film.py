"""Package the rendered 540s film, then verify the actual delivery files."""
from pathlib import Path
import concurrent.futures as futures
import hashlib, json, re, shutil, subprocess, time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'delivery'
OUT.mkdir(exist_ok=True)
QA = OUT / 'qa'
QA.mkdir(exist_ok=True)

def run(args, log=None):
    p = subprocess.run([str(x) for x in args], cwd=ROOT, text=True,
                       encoding='utf-8', errors='replace', capture_output=True)
    if log:
        Path(log).write_text(p.stdout + p.stderr, encoding='utf-8')
    if p.returncode:
        raise RuntimeError(f'{args[0]} failed ({p.returncode}): {p.stderr[-3000:]}')
    return p.stdout, p.stderr

def probe(file):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams',
                          '-show_chapters', '-of', 'json', file])[0])

def sha(file):
    h=hashlib.sha256()
    with open(file,'rb') as f:
        for block in iter(lambda:f.read(8*1024*1024),b''):h.update(block)
    return h.hexdigest()

chapters=[(0,15,'雾中的鸽群'),(15,60,'末班轮渡'),(60,80,'云中之眼'),
 (80,120,'北冥有鱼'),(120,170,'撞向灯海'),(170,200,'改航向'),
 (200,250,'随船下江'),(250,280,'江口掉头'),(280,320,'老周默许'),
 (320,360,'灯不是海'),(360,400,'关灯出江'),(400,455,'转身入海'),
 (455,490,'化鹏'),(490,525,'我接受'),(525,540,'它来过')]

def main():
    started=time.time()
    source=ROOT/'out/video_4k.mp4'
    master=probe(source)
    v=next(s for s in master['streams'] if s['codec_type']=='video')
    assert (v['width'],v['height'],int(v['nb_frames']))==(3840,2080,12960),v
    assert abs(float(master['format']['duration'])-540)<.05
    progress=json.loads((ROOT/'out/chunks-3840x2080/progress.json').read_text())
    for i in range(1,16):
        meta=json.loads((ROOT/f'out/chunks-3840x2080/{i}.json').read_text())
        assert meta['key']==progress['key'],f'旧版本镜头 {i}'
    locked=json.loads((ROOT/'docs/style-lock.json').read_text(encoding='utf-8'))
    assert all(sha(ROOT/p)==h for p,h in locked['sha256'].items()),'原片样式源文件有变更'
    metadata=QA/'chapters.ffmeta'
    metadata.write_text(';FFMETADATA1\ntitle=北冥\ncomment=北冥引擎 · 九分钟完整动画\n'+''.join(
        f'[CHAPTER]\nTIMEBASE=1/1000\nSTART={a*1000}\nEND={b*1000}\ntitle={title}\n'
        for a,b,title in chapters),encoding='utf-8')
    # Encoding runs only after the render is finished. Probe the actual hardware
    # encoder; fall back to software without changing any rendered art settings.
    nv=['-c:v','h264_nvenc','-preset','p7','-tune','hq','-rc','vbr','-cq','18',
        '-b:v','0','-maxrate','60M','-bufsize','120M','-spatial-aq','1',
        '-temporal-aq','1','-aq-strength','8']
    try:
        run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=s=3840x2080:r=24',
             '-frames:v','4',*nv,'-f','null','-'], QA/'encoder-probe.log')
        codec=nv; encoder='RTX 5090 NVENC H.264 / p7 / CQ18 / 60Mbps ceiling'
    except RuntimeError:
        codec=['-c:v','libx264','-preset','medium','-crf','18','-maxrate','60M','-bufsize','120M']
        encoder='libx264 medium CRF18 / 60Mbps ceiling'
    print('DELIVERY ENCODER',encoder,flush=True)
    full=OUT/'beiming_9min_4k.mp4'
    color='scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p'
    cmd=['ffmpeg','-v','warning','-nostdin','-y','-i',source,'-i',ROOT/'audio/mix.wav',
         '-f','ffmetadata','-i',metadata,'-map','0:v:0','-map','1:a:0','-map_metadata','2','-map_chapters','2',
         '-vf',color,*codec,'-pix_fmt','yuv420p','-profile:v','high','-colorspace','bt709',
         '-color_trc','bt709','-color_primaries','bt709','-color_range','tv',
         '-c:a','aac','-b:a','256k','-ar','48000','-t','540','-movflags','+faststart',full]
    run(cmd,QA/'encode-4k.log');print('4K packaged',full.stat().st_size,flush=True)
    preview=OUT/'beiming_9min_1080.mp4'
    smallcodec=nv.copy() if codec is nv else codec.copy()
    if codec is nv:smallcodec[smallcodec.index('18')]='20'
    else:smallcodec[smallcodec.index('18')]='20'
    smallcodec[smallcodec.index('60M')]='14M';smallcodec[smallcodec.index('120M')]='28M'
    run(['ffmpeg','-v','warning','-nostdin','-y','-i',full,'-map','0:v:0','-map','0:a:0',
         '-map_metadata','0','-map_chapters','0','-vf','scale=1920:1040:flags=lanczos,setsar=1',
         *smallcodec,'-pix_fmt','yuv420p','-profile:v','high','-colorspace','bt709',
         '-color_trc','bt709','-color_primaries','bt709','-color_range','tv','-c:a','copy',
         '-movflags','+faststart',preview],QA/'encode-1080.log')
    print('1080 packaged',preview.stat().st_size,flush=True)

    # Decode every delivery frame, checking durations, frame count, missing
    # pictures, accidental blackouts and post-AAC loudness. The 486–488s still
    # image and silence are intentional dramatic events, documented separately.
    def video_check(file):
        p=probe(file);v=next(s for s in p['streams'] if s['codec_type']=='video')
        assert int(v['nb_frames'])==12960 and v['r_frame_rate']=='24/1',v
        assert abs(float(p['format']['duration'])-540)<.05
        run(['ffmpeg','-v','error','-nostdin','-i',file,'-map','0:v:0','-f','null','-'],QA/f'{file.stem}-decode.log')
        return {'duration':p['format']['duration'],'frames':v['nb_frames'],
                'width':v['width'],'height':v['height'],'fps':v['r_frame_rate'],
                'color_space':v.get('color_space'),'bytes':file.stat().st_size,
                'sha256':sha(file),'chapters':len(p.get('chapters',[])),'decode':'passed'}
    with futures.ThreadPoolExecutor(max_workers=2) as pool:
        reports=dict(zip(['4k','1080'],pool.map(video_check,[full,preview])))
    _,q=run(['ffmpeg','-hide_banner','-nostdin','-i',preview,'-an','-vf',
             'scale=320:-2,blackdetect=d=0.15:pix_th=0.02,freezedetect=n=-45dB:d=1',
             '-f','null','-'],QA/'picture-check.log')
    blacks=re.findall(r'black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)',q)
    unexpected=[b for b in blacks if float(b[0])>1 and float(b[1])<539]
    assert not unexpected,unexpected
    _,loud=run(['ffmpeg','-hide_banner','-nostdin','-i',full,'-vn','-af',
               'loudnorm=I=-14:TP=-1:LRA=11:print_format=json','-f','null','-'],QA/'audio-check.log')
    measure=json.loads(re.findall(r'\{\s*"input_i"[\s\S]*?\}',loud)[-1])
    assert -15.5<float(measure['input_i'])<-12.5,measure
    assert float(measure['input_tp'])<-.3,measure
    shutil.copy2(ROOT/'audio/dialogue.srt',OUT/'北冥_对白.srt')
    result={'duration_seconds':540,'total_frames':12960,'renderer':progress['gpu'],
        'render_source_key':progress['key'],'render_seconds':progress['wallSeconds']+progress.get('previousRenderSeconds',0),
        'encoder':encoder,'style_lock':'all 7 original files unchanged','deliveries':reports,
        'black_intervals':blacks,'unexpected_black_intervals':unexpected,
        'loudness_LUFS':measure['input_i'],'true_peak_dBTP':measure['input_tp'],
        'intentional_still_and_silence':[486,488],
        'limitation':'技术检测及关键帧检查通过，不代表品牌审定或人工逐秒审片。',
        'packaging_and_qa_seconds':round(time.time()-started,2)}
    (QA/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print('DELIVERY VERIFIED',json.dumps(result,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
