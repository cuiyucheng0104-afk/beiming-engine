export function paint(ctx,w,h,t) {
  ctx.fillStyle='#10212a'; ctx.fillRect(0,0,w,h);
  const cx=w*(.15+.7*t),cy=h*(.5+.16*Math.sin(t*2*Math.PI));
  ctx.strokeStyle='#79b9bc'; ctx.lineWidth=2;
  ctx.beginPath();
  for(let i=0;i<=120;i++){
    const p=i/120, x=w*(.15+.7*p),y=h*(.5+.16*Math.sin(p*2*Math.PI));
    ctx.lineTo(x,y);
  }
  ctx.stroke();
  ctx.fillStyle='#f0c68a'; ctx.beginPath(); ctx.arc(cx,cy,h*.12,0,Math.PI*2); ctx.fill();
}
