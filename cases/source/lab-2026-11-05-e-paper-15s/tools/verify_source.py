from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'out/source-manifest.json').read_text(encoding='utf-8'))
bad=[]
for item in manifest:
 p=root/item['path']
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:bad.append(item['path'])
report={'matched':len(manifest)-len(bad),'total':len(manifest),'mismatches':bad}
(root/'delivery/source_sync.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False));sys.exit(bool(bad))
