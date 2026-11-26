import { paint } from './plate.js';

const surface = new OffscreenCanvas(1,1);
const ctx = surface.getContext('2d');
self.onmessage = ({data:{w,h,t}}) => {
  if(surface.width!==w || surface.height!==h) { surface.width=w; surface.height=h; }
  paint(ctx,w,h,t);
  const image=surface.transferToImageBitmap();
  self.postMessage(image,[image]);
};
