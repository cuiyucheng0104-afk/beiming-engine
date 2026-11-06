"""Read GLB headers/accessors without loading geometry; record actual mesh/texture sizes."""
import pathlib,struct,json,hashlib
root=pathlib.Path(__file__).resolve().parents[1]
rows=[]
for p in sorted((root/'models').glob('*/r*/model_tex.glb')):
 data=p.read_bytes();n=struct.unpack_from('<I',data,12)[0];g=json.loads(data[20:20+n]);a=g['accessors'];faces=verts=0;bounds=[]
 for m in g['meshes']:
  for q in m['primitives']:
   v=a[q['attributes']['POSITION']];verts+=v['count'];faces+=(a[q['indices']]['count'] if 'indices' in q else v['count'])//3
   bounds.append({'min':v.get('min'),'max':v.get('max')})
 row={'scene':p.parts[-3],'tag':p.parts[-2],'vertices':verts,'faces':faces,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'bounds':bounds,'images':len(g.get('images',[]))}
 rows.append(row)
(root/'models/manifest.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{k:v for k,v in r.items() if k not in ['bounds','sha256']} for r in rows],indent=2))
