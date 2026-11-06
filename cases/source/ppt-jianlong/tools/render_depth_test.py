"""印刷水墨版 3D 纵深测试：刻线画 + 手工分层深度（引导滤波贴边）+ 视差推镜 + 雨 + 镜片框。"""
import sys, math, subprocess, numpy as np, torch, torch.nn.functional as F
from PIL import Image, ImageDraw, ImageFilter
sys.path.insert(0,'.')
from printfx import scratch
from depth_layers import build
from PIL import ImageOps
def prep(im,mix=0.55):
    g=im.convert('L'); eq=ImageOps.equalize(g.filter(ImageFilter.GaussianBlur(1)))
    a=np.asarray(im).astype(float); L=np.asarray(g).astype(float)+1; E=np.asarray(eq).astype(float)+1
    k=(1-mix)+mix*E/L; return Image.fromarray(np.clip(a*k[...,None],0,255).astype(np.uint8))
M='/private/tmp/claude-503/-Users-cuiqq/8a8174ea-70bd-46fb-8338-d333ccfd0d59/scratchpad/jianlong/x/ppt/media/'
OUT='@@WORKSPACE_ROOT@@/Desktop/见龙/样片/纵深测试_印刷水墨版.mp4'
W,H,FPS=1920,1080,30; G=(61,255,176)
def boxf(x,r): return F.avg_pool2d(F.pad(x,(r,r,r,r),mode='replicate'),2*r+1,1)
def guided(I,p,r=24,eps=2e-3):
    mI,mp=boxf(I,r),boxf(p,r); a=(boxf(I*p,r)-mI*mp)/(boxf(I*I,r)-mI*mI+eps); b=mp-a*mI
    return boxf(a,r)*I+boxf(b,r)
def refine(depth,src):
    I=torch.from_numpy(np.asarray(src.convert('L').resize((960,540))).astype(np.float32)/255)[None,None]
    p=torch.from_numpy(np.asarray(Image.fromarray((depth*255).astype(np.uint8)).resize((960,540)))/255.).float()[None,None]
    q=guided(I,p).clamp(0,1); return F.interpolate(q,(H,W),mode='bilinear',align_corners=False)[0,0]
def lens():
    o=Image.new('RGBA',(W,H),(0,0,0,0)); d=ImageDraw.Draw(o)
    m=Image.new('L',(W,H),255); ImageDraw.Draw(m).rounded_rectangle((60,50,W-60,H-50),radius=90,fill=0)
    o.paste((22,23,27,215),(0,0),m.filter(ImageFilter.GaussianBlur(40)))
    d.rounded_rectangle((60,50,W-60,H-50),radius=90,outline=G+(140,),width=2)
    for (x,y,sx,sy) in [(110,100,1,1),(W-110,100,-1,1),(110,H-100,1,-1),(W-110,H-100,-1,-1)]:
        d.line((x,y,x+sx*60,y),fill=G+(240,),width=3); d.line((x,y,x,y+sy*60),fill=G+(240,),width=3)
    a=np.asarray(o).astype(np.float32)/255; return torch.from_numpy(a[...,:3]).permute(2,0,1), torch.from_numpy(a[...,3:]).permute(2,0,1)
LC,LA=lens()
ease=lambda t:0.5-0.5*math.cos(math.pi*t)
SHOTS=[ # (图, 深度键, 秒, 亮度, 相机函数 t→(sx,sy,z0,zw), 雨)
 (1,'d01',6.0,1.3,lambda t:(30-60*t, 0, 1.07+0.02*t, 0.06*t),True),
 (9,'d09',6.0,1.2,lambda t:(-55+110*t, 0, 1.08, 0.015*t),True),
 (19,'d19',7.0,1.2,lambda t:(0, 12-30*t, 1.05+0.015*t, 0.07*t),False)]
yy,xx=torch.meshgrid(torch.linspace(-1,1,2*H),torch.linspace(-1,1,2*W),indexing='ij')
ff=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-',
    '-c:v','libx264','-crf','17','-preset','medium','-pix_fmt','yuv420p',OUT],stdin=subprocess.PIPE)
rng=np.random.default_rng(7)
for n,key,dur,br,cam,rain in SHOTS:
    src=Image.open(M+f'image{n}.png').convert('RGB').resize((W,H))
    P=torch.from_numpy(np.asarray(scratch(prep(src).resize((2*W,2*H),Image.LANCZOS),period=13)).astype(np.float32)/255).permute(2,0,1)[None]
    D=refine(build(key),src)
    Image.fromarray((D.numpy()*255).astype(np.uint8)).save(f'@@WORKSPACE_ROOT@@/Desktop/见龙/depth/{key}_贴边后.png')
    drops=[(rng.uniform(0,W),rng.uniform(0,H),rng.uniform(0.3,1.0)) for _ in range(260)] if rain else []
    N=int(dur*FPS)
    for i in range(N):
        t=ease(i/(N-1)); sx,sy,z0,zw=cam(t)
        qx,qy=xx.clone(),yy.clone()
        for _ in range(3):
            w=F.grid_sample(D[None,None],torch.stack([qx,qy],-1)[None],align_corners=False)[0,0]
            s=z0+zw*w; qx=(xx-sx*2/W*w)/s; qy=(yy-sy*2/H*w)/s
        fr=F.avg_pool2d(F.grid_sample(P,torch.stack([qx,qy],-1)[None],mode='bilinear',padding_mode='border',align_corners=False),2)[0]
        if rain:
            im=Image.new('RGBA',(W,H),(0,0,0,0)); d=ImageDraw.Draw(im)
            for (x0,y0,z) in drops:
                y=(y0+i*(18+30*z))%(H+80)-40; x=(x0+i*(3+5*z)-sx*z)%W; L=14+40*z
                d.line((x,y,x+0.25*L,y+L),fill=(237,229,205,int(70+110*z)),width=1 if z<0.7 else 2)
            r=torch.from_numpy(np.asarray(im).astype(np.float32)/255).permute(2,0,1)
            fr=fr*(1-r[3:])+r[:3]*r[3:]
        fr=fr*(1-LA)+LC*LA
        ff.stdin.write((fr.clamp(0,1).permute(1,2,0).numpy()*255).astype(np.uint8).tobytes())
    print(key,'done',flush=True)
ff.stdin.close(); ff.wait(); print('ok')
