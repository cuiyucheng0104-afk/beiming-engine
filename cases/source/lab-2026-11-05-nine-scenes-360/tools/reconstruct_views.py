"""单视角场景几何：保留九张图的构图，估计深度与法线。不是完整可绕拍模型。"""
import pathlib,json,time,urllib.request,uuid,shutil,sys
ROOT=pathlib.Path(__file__).resolve().parents[1];URL='http://127.0.0.1:8188'
def req(p,data=None):
 r=urllib.request.Request(URL+p,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(r,timeout=90) as f:return json.load(f)
for s in json.loads((ROOT/'scenes.json').read_text(encoding='utf-8')):
 sid=s['id'];d=ROOT/'models'/sid/'view';d.mkdir(parents=True,exist_ok=True)
 if (d/'scene.glb').exists():print(sid,'already complete',flush=True);continue
 source=pathlib.Path('D:/Apps/ComfyUI_windows_portable/ComfyUI/input')/f'nine360_ref_{sid}.jpg';shutil.copy2(ROOT/s['ref'],source)
 g={
 '1':{'class_type':'LoadImage','inputs':{'image':source.name}},
 '2':{'class_type':'LoadMoGeModel','inputs':{'model_name':'moge_2_vitl_normal_fp16.safetensors'}},
 '3':{'class_type':'MoGeInference','inputs':{'moge_model':['2',0],'image':['1',0],'resolution_level':9,'fov_x_degrees':0,'batch_size':1,'force_projection':True,'apply_mask':False,'refine_steps':3}},
 '4':{'class_type':'MoGePointMapToMesh','inputs':{'moge_geometry':['3',0],'batch_index':0,'decimation':1,'discontinuity_threshold':0,'texture':True}},
 '5':{'class_type':'SaveGLB','inputs':{'mesh':['4',0],'filename_prefix':f'nine360/{sid}_view'}},
 }
 for i,mode in enumerate(['depth','normal_opengl','mask'],10):
  g[str(i)]={'class_type':'MoGeRender','inputs':{'moge_geometry':['3',0],'output':mode}}
  g[str(i+10)]={'class_type':'SaveImage','inputs':{'images':[str(i),0],'filename_prefix':f'nine360/{sid}_{mode}'}}
 (d/'workflow.json').write_text(json.dumps(g,indent=2))
 # Queueing is serialized by Comfy; this script never interrupts a running prompt.
 pid=req('/prompt',{'prompt':g,'client_id':'nine-view-'+str(uuid.uuid4())})['prompt_id'];print(sid,'submitted',pid,flush=True)
 while True:
  hist=req('/history/'+pid)
  if pid in hist:break
  time.sleep(8)
 hist=hist[pid];(d/'history.json').write_text(json.dumps(hist,ensure_ascii=False,indent=2),encoding='utf-8')
 if hist['status']['status_str']!='success':print(hist['status'],flush=True);sys.exit(2)
 out=pathlib.Path('D:/Apps/ComfyUI_windows_portable/ComfyUI/output/nine360')
 for key,target in [('view','scene.glb'),('depth','depth.png'),('normal_opengl','normals.png'),('mask','mask.png')]:
  files=sorted(out.glob(f'{sid}_{key}_*'),key=lambda x:x.stat().st_mtime);shutil.copy2(files[-1],d/target)
 print(sid,'DONE',flush=True)
