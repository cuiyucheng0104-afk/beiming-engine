from pathlib import Path
import json,hashlib
root=Path(__file__).resolve().parents[1]
data=json.loads((root/'docs/project-manifest.json').read_text(encoding='utf-8'))
bad=[p for p,h in data['sha256'].items() if not (root/p).exists() or hashlib.sha256((root/p).read_bytes()).hexdigest()!=h]
print(json.dumps({'checked':len(data['sha256']),'differences':bad},ensure_ascii=False))
raise SystemExit(bool(bad))
