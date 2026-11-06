"""北冥九景：可恢复的 TRELLIS.2 高精度重建。只提交本轮作业，不中断其他任务。"""
import argparse,copy,json,time,urllib.request,urllib.error,uuid,pathlib,shutil,sys

ROOT=pathlib.Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('scenes',nargs='+');ap.add_argument('--host',default='127.0.0.1:8188');ap.add_argument('--mode');ap.add_argument('--resolution',type=int);ap.add_argument('--tag',default='r1')
args=ap.parse_args();url='http://'+args.host
def request(endpoint,data=None):
    r=urllib.request.Request(url+endpoint,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(r,timeout=90) as f:return json.load(f)
    except urllib.error.HTTPError as e:raise RuntimeError(e.read().decode()) from e

configs=json.loads((ROOT/'scenes.json').read_text(encoding='utf-8'))
for sid in args.scenes:
    cfg=next(s for s in configs if s['id']==sid);tag=args.tag
    folder=ROOT/'models'/sid/tag;folder.mkdir(parents=True,exist_ok=True)
    statefile=folder/'job.json'
    if (folder/'model_tex.glb').exists():print(sid,'already complete',flush=True);continue
    state=json.loads(statefile.read_text()) if statefile.exists() else {}
    g=copy.deepcopy(json.loads((ROOT/'tools/trellis-base.json').read_text()))
    mode=args.mode or cfg['mode'];prefix=f'nine360/{sid}_{tag}'
    source=pathlib.Path('D:/Apps/ComfyUI_windows_portable/ComfyUI/input')/f'nine360_ref_{sid}.jpg'
    shutil.copy2(ROOT/cfg['ref'],source)
    g['122']['inputs']['image']=source.name
    if mode=='scene':
        # Preserve the full reference and aspect ratio in a square conditioning frame.
        w=1024;h=round(cfg['height']/cfg['width']*w/8)*8
        g['310']={'class_type':'ImageScale','inputs':{'image':['122',0],'upscale_method':'lanczos','width':w,'height':h,'crop':'disabled'}}
        g['312']={'class_type':'ImagePadForOutpaint','inputs':{'image':['310',0],'left':0,'right':0,'top':(1024-h)//2,'bottom':1024-h-(1024-h)//2,'feathering':0}}
        for k in ['193','192']:del g[k]
    g['94']['inputs']['target_resolution']=args.resolution or cfg['target_resolution']
    for node,offset in [('3',0),('18',14),('23',14),('12',13)]:g[node]['inputs']['seed']=cfg['seed']-offset
    g['241']['inputs'].update(resolution=cfg['remesh_resolution'],smooth_iters=cfg['smooth_iters'],project_back=cfg['project_back'],drop_small_components=.0005)
    g['186']['inputs']['target_face_count']=cfg['target_faces']
    for node in ['238','260']:g[node]['inputs']['crease_angle']=cfg['crease_angle']
    g['196']['inputs'].update(resolution=cfg['texture_size'],padding=2)
    g['147']['inputs']['texture_size']=cfg['texture_size']
    for node,suffix in [('502','input'),('503','vc'),('504','tex')]:g[node]['inputs']['filename_prefix']=prefix+'_'+suffix
    (folder/'workflow.json').write_text(json.dumps(g,indent=2))
    if state.get('prompt_id'):
        pid=state['prompt_id'];print(sid,'resuming',pid,flush=True)
    else:
        while True:
            q=request('/queue')
            if not q['queue_running'] and not q['queue_pending']:break
            print(sid,'waiting for existing Comfy work',flush=True);time.sleep(15)
        pid=request('/prompt',{'prompt':g,'client_id':'nine360-'+str(uuid.uuid4())})['prompt_id']
        state={'scene':sid,'mode':mode,'tag':tag,'prompt_id':pid,'started':time.time(),'config':cfg}
        statefile.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8')
        print(sid,'submitted',pid,flush=True)
    while True:
        history=request('/history/'+pid)
        if pid in history:break
        print(sid,'running',round(time.time()-state['started']),'s',flush=True);time.sleep(15)
    history=history[pid];(folder/'history.json').write_text(json.dumps(history,ensure_ascii=False,indent=2),encoding='utf-8')
    if history['status']['status_str']!='success':
        print(sid,'FAILED',json.dumps(history['status'],ensure_ascii=False)[-4000:],flush=True);sys.exit(2)
    output=pathlib.Path('D:/Apps/ComfyUI_windows_portable/ComfyUI/output')
    for suffix,dest in [('vc','model_vc.glb'),('tex','model_tex.glb'),('input','conditioning.png')]:
        found=sorted((output/'nine360').glob(f'{sid}_{tag}_{suffix}_*'),key=lambda p:p.stat().st_mtime)
        if not found:raise RuntimeError(f'Missing output {sid} {suffix}')
        shutil.copy2(found[-1],folder/dest)
    events=dict((k,v.get('timestamp')) for k,v in history['status']['messages'] if isinstance(v,dict))
    state.update(status='success',seconds=(events['execution_success']-events['execution_start'])/1000)
    statefile.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8')
    print(sid,'DONE',state['seconds'],'sec',flush=True)
