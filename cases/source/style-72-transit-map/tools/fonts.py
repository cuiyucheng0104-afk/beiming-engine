"""Self-hosted fonts (OFL): Inter (Latin and figures) and Noto Sans SC subset to the characters the film prints.
The CJK subset comes from the Google Fonts CSS API with &text= (TECHNIQUE.md §11); nothing is linked at render time.
Run: python3 tools/fonts.py   (writes fonts/Inter.ttf, fonts/NotoSC-<w>.<ext>, fonts/fonts.css)"""
import os, re, subprocess, urllib.parse
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); FD = os.path.join(HERE, 'fonts')
env = dict(os.environ); env.setdefault('SSL_CERT_FILE', '/etc/ssl/cert.pem')
def curl(url, out=None, ua=None):
    cmd = ['curl', '-sfL', '--retry', '3', url] + (['-A', ua] if ua else []) + (['-o', out] if out else [])
    r = subprocess.run(cmd, capture_output=True, env=env, check=True); return r.stdout.decode('utf-8', 'replace')
txt = ''.join(open(os.path.join(HERE, f), encoding='utf-8').read() for f in ['net.js', 'timeline.js', 'film.js'])
chars = ''.join(sorted(set(ch for ch in txt if ord(ch) > 0x2E7F)))
open(os.path.join(HERE, 'tools', 'chars.txt'), 'w', encoding='utf-8').write(chars)
inter = os.path.join(FD, 'Inter.ttf')
if not os.path.exists(inter): curl('https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf', inter)
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
css = curl('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@500;600;700;800&text=' + urllib.parse.quote(chars), ua=UA)
faces = re.findall(r'font-weight:\s*(\d+);.*?src:\s*url\((.*?)\)\s*format\(\'(\w+)\'\)', css, re.S)
out = ["@font-face{font-family:Inter;src:url(Inter.ttf) format('truetype');font-weight:100 900}"]
urls = sorted(set(u for _, u, _ in faces))
if len(urls) == 1:   # the API serves one variable file for every weight
    fmt = faces[0][2]; fn = 'NotoSC.' + ('woff2' if fmt == 'woff2' else 'ttf'); curl(urls[0], os.path.join(FD, fn))
    out.append(f"@font-face{{font-family:NotoSC;src:url({fn}) format('{fmt}');font-weight:100 900}}")
else:
    for w, url, fmt in faces:
        fn = f'NotoSC-{w}.' + ('woff2' if fmt == 'woff2' else 'ttf'); curl(url, os.path.join(FD, fn))
        out.append(f"@font-face{{font-family:NotoSC;src:url({fn}) format('{fmt}');font-weight:{w}}}")
open(os.path.join(FD, 'fonts.css'), 'w').write('\n'.join(out) + '\n')
print(len(chars), 'CJK chars;', len(faces), 'Noto Sans SC weights')
