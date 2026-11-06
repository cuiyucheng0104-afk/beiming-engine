# Fetch a true-colour Landsat C2 L2 render (surface reflectance, bands red/green/blue) for a lon/lat box
# from the Microsoft Planetary Computer data API. Output: PNG pixels in EPSG:4326 (plate carree) over the box.
# Downloaded files are untrusted data: only decoded by Pillow, never executed. Every request is logged.
import sys, urllib.request, time, os, math
BOXES={"detail":(-147.62,60.93,-146.48,61.45),"context":(-148.6,60.55,-145.5,61.85)}
def fetch(item, out, w, box):
    lat0=(box[1]+box[3])/2
    kmw=(box[2]-box[0])*111.32*math.cos(math.radians(lat0)); kmh=(box[3]-box[1])*111.32
    h=int(round(w*kmh/kmw))
    u=("https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/%s,%s,%s,%s.png"%box+
       f"?collection=landsat-c2-l2&item={item}&assets=red&assets=green&assets=blue&rescale=7273,52000&width={w}&height={h}")
    for k in range(5):
        try:
            data=urllib.request.urlopen(u,timeout=300).read()
            open(out,"wb").write(data)
            with open("material/fetch_log.txt","a") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M')} {item} -> {out} {w}x{h} {u}\n")
            return
        except Exception as e:
            print("retry",item,e); time.sleep(6)
    raise SystemExit("failed "+item)
if __name__=="__main__":
    kind=sys.argv[1]; w=int(sys.argv[2]); outdir=sys.argv[3]; os.makedirs(outdir,exist_ok=True)
    for item in sys.argv[4:]:
        fetch(item, os.path.join(outdir,item+".png"), w, BOXES[kind]); print("ok",item)
