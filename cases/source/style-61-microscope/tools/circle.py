# Fit the eyepiece field-stop circle in a photo (least squares on the bright/dark boundary).
import sys, json, numpy as np
from PIL import Image
from scipy import ndimage as ndi
def fit(path, thr):
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    L = ndi.uniform_filter(a.mean(2), 15)
    m = L > thr
    m = ndi.binary_opening(m, iterations=3)
    lab, n = ndi.label(m); sizes = ndi.sum(m, lab, range(1, n+1)); m = lab == (1+int(np.argmax(sizes)))
    m = ndi.binary_fill_holes(m)
    H, W = m.shape; pts = []
    for y in range(0, H, 4):
        xs = np.nonzero(m[y])[0]
        if len(xs) == 0: continue
        if xs[0] > 3: pts.append((xs[0], y))
        if xs[-1] < W-4: pts.append((xs[-1], y))
    for x in range(0, W, 4):
        ys = np.nonzero(m[:, x])[0]
        if len(ys) == 0: continue
        if ys[0] > 3: pts.append((x, ys[0]))
        if ys[-1] < H-4: pts.append((x, ys[-1]))
    P = np.array(pts, float)
    for it in range(3):
        A = np.c_[2*P[:,0], 2*P[:,1], np.ones(len(P))]; bb = (P**2).sum(1)
        cx, cy, c = np.linalg.lstsq(A, bb, rcond=None)[0]; r = np.sqrt(c + cx*cx + cy*cy)
        d = np.abs(np.hypot(P[:,0]-cx, P[:,1]-cy) - r)
        P = P[d < max(6, np.percentile(d, 80))]
    return dict(cx=float(cx), cy=float(cy), r=float(r), W=W, H=H, n=len(P), resid=float(np.median(d)))
if __name__ == '__main__':
    print(json.dumps({sys.argv[i]: fit(sys.argv[i], float(sys.argv[i+1])) for i in range(1, len(sys.argv), 2)}, indent=1))
