"""按画面线索推算深度（不用模型）：大气透视（远处亮、反差低）+ 画面纵向位置 + 前景暗色剪影。
输出 0=最远 1=最近 的 16 位 PNG。"""
import sys, numpy as np, torch, torch.nn.functional as F
from PIL import Image, ImageFilter
def box(x,r):  # 均值滤波
    k=2*r+1; t=torch.from_numpy(x)[None,None].float()
    return F.avg_pool2d(F.pad(t,(r,r,r,r),mode='replicate'),k,1)[0,0].numpy()
def guess(path, w_y=0.45, w_haze=0.35, w_fg=0.20, sky_rows=0.0):
    im=Image.open(path).convert('RGB').resize((960,540)); a=np.asarray(im).astype(np.float32)/255
    L=0.3*a[...,0]+0.59*a[...,1]+0.11*a[...,2]
    H,W=L.shape; y=np.linspace(0,1,H)[:,None].repeat(W,1)
    mu=box(L,12); sd=np.sqrt(np.clip(box(L*L,12)-mu*mu,0,None))
    con=sd/ (sd.max()+1e-6)
    haze=(1-np.clip((mu-mu.min())/(np.ptp(mu)+1e-6),0,1))*0.6+con*0.4   # 暗且反差高 → 近
    fg=np.clip((0.22-box(L,20))/0.22,0,1)*np.clip((y-0.45)/0.55,0,1)        # 下半部的大块暗剪影 → 最近
    d=w_y*y**1.3+w_haze*haze+w_fg*fg
    if sky_rows>0: d=d*np.clip((y-sky_rows*0.6)/(sky_rows*0.4+1e-6),0,1)**0.5
    d=(d-d.min())/(np.ptp(d)+1e-6)
    d=np.asarray(Image.fromarray((d*255).astype(np.uint8)).filter(ImageFilter.MedianFilter(9)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32)/255
    return np.asarray(Image.fromarray((d*65535).astype(np.uint16)).resize((1920,1080),Image.BICUBIC))
if __name__=='__main__':
    src,out=sys.argv[1],sys.argv[2]; kw=dict(a.split('=') for a in sys.argv[3:]); kw={k:float(v) for k,v in kw.items()}
    Image.fromarray(guess(src,**kw)).save(out)
