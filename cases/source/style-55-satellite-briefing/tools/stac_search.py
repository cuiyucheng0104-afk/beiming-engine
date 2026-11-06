# Search Planetary Computer STAC for Landsat C2 L2 scenes over Columbia Glacier
import json, sys, urllib.request
BBOX=[-147.30,60.98,-146.80,61.28]
def search(y):
    body={"collections":["landsat-c2-l2"],"bbox":BBOX,"datetime":f"{y}-06-01/{y}-09-30",
          "query":{"eo:cloud_cover":{"lt":40}},"limit":50}
    req=urllib.request.Request("https://planetarycomputer.microsoft.com/api/stac/v1/search",
        data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    r=json.load(urllib.request.urlopen(req,timeout=60))
    out=[]
    for f in r["features"]:
        p=f["properties"]
        out.append((p["eo:cloud_cover"],f["id"],p["datetime"][:10],p.get("platform")))
    return sorted(out)
for y in sys.argv[1:]:
    res=search(y)
    print(y,len(res))
    for x in res[:6]: print("  ",x)
