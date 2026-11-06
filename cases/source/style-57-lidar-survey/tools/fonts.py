"""Subset the three OFL families to the characters the film uses (Google Fonts CSS2 API, &text=).
Scans index.html for every character; writes fonts/<name>.woff2. Files are data only."""
import os, re, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
chars = sorted(set(c for c in src if ord(c) >= 32) | set("0123456789.,:-+×·°NSEWm km/()%–—"))
text = "".join(chars)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
FAM = [("NotoSansSC-500", "Noto+Sans+SC:wght@500"), ("BarlowCondensed-300", "Barlow+Condensed:wght@300"),
       ("BarlowCondensed-500", "Barlow+Condensed:wght@500"), ("IBMPlexMono-400", "IBM+Plex+Mono:wght@400")]
os.makedirs(os.path.join(HERE, "fonts"), exist_ok=True)
for name, fam in FAM:
    url = "https://fonts.googleapis.com/css2?family=%s&text=%s" % (fam, urllib.parse.quote(text))
    css = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read().decode()
    furls = re.findall(r"url\((https://[^)]+)\)", css)
    assert len(furls) == 1, css[:300]
    data = urllib.request.urlopen(urllib.request.Request(furls[0], headers={"User-Agent": UA}), timeout=60).read()
    open(os.path.join(HERE, "fonts", name + ".woff2"), "wb").write(data)
    print(name, len(data), "bytes", furls[0][:80])
print(len(chars), "characters")
