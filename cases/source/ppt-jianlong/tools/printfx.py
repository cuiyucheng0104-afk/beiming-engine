"""印刷长镜头的刻线转换：只用墨、纸，保留红（灯笼）、黄（灯光）、绿（镜片界面）。"""
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance
PAPER_T='@@WORKSPACE_ROOT@@/Desktop/上影ppt/03-制作/共用/材质/宣纸.png'
INK=np.array([22,23,27]);PAP=np.array([237,229,205]);RED=np.array([196,51,43]);YEL=np.array([223,164,67]);GRN=np.array([61,255,176])
def scratch(im,period=7,bright=1.0,keep_red=True):
    W,H=im.size; im=ImageEnhance.Brightness(im.convert('RGB')).enhance(bright)
    a=np.asarray(im).astype(float)/255; L=0.3*a[...,0]+0.59*a[...,1]+0.11*a[...,2]
    L=np.asarray(Image.fromarray((L*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(float)/255
    L=np.clip((L-0.06)/0.6,0,1)**0.8
    yy,xx=np.mgrid[0:H,0:W]; ph=((yy+1.6*np.sin(xx/41.0)+1.1*np.sin(xx/13.0+yy/90.0))%period)/period
    ink=(np.abs(ph-0.5)<(1-L)*0.62)|(L<0.08)
    out=np.where(ink[...,None],INK,PAP).astype(float)
    hsv=np.asarray(im.convert('HSV')).astype(float)/255; h,s,v=hsv[...,0]*360,hsv[...,1],hsv[...,2]
    red=((h<14)|(h>345))&(s>0.55)&(v>0.4); yel=(h>22)&(h<52)&(s>0.45)&(v>0.62); grn=(h>130)&(h<185)&(s>0.35)&(v>0.4)
    mx=lambda k:np.asarray(Image.fromarray((k*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3)))>0
    out[yel&~ink]=YEL
    if keep_red: out[mx(red)]=RED
    out[mx(grn)]=GRN
    pt=np.asarray(Image.open(PAPER_T).convert('RGB').resize((W,H))).astype(float)/255
    out=out*(0.9+0.1*pt.mean(axis=2,keepdims=True)/pt.mean())
    return Image.fromarray(np.clip(out,0,255).astype(np.uint8))
