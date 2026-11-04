// 北冥引擎 · 水彩斑驳 + 纸纹：低分辨率生成一张亮暗交错的半透明纹理，放大铺满后叠在已画好的内容上（只落在不透明处）。
//   washTexture(o) → canvas    一次生成，调用方自己缓存。o：
//       blotch, grain   两个 createNoise2D(...)：大斑块（分形叠加）与细纸纹
//       light, dark     [r, g, b]：斑块偏亮处、偏暗处的颜色
//       width 480, height 260   纹理尺寸（放大后自然柔和）
//       freq [4.2, 2.3]         斑块在纹理宽、高上的频率；octaves 4、lacunarity 2.1 分形层数与倍频
//       mix [0.8, 0.35]         斑块、纸纹的权重；gain [120, 140] 亮、暗两侧的不透明度增益
//   washOver(g, tex, alpha, clip)   以 source-atop 把纹理拉伸铺满整张画布；clip（Path2D，可省）限定范围

export function washTexture({ blotch, grain, light, dark, width = 480, height = 260, freq = [4.2, 2.3], octaves = 4, lacunarity = 2.1, mix = [0.8, 0.35], gain = [120, 140] }) {
  const W = width, H = height, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), im = g.createImageData(W, H), d = im.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W * freq[0], v = y / H * freq[1];
    let f = 0, a = 1, s = 1; for (let o = 0; o < octaves; o++) { f += a * blotch(u * s, v * s); a *= 0.5; s *= lacunarity; }
    const pap = grain(x * 0.9, y * 0.9) * 0.5 + grain(x * 0.31 + 50, y * 0.31) * 0.5;
    const i = (y * W + x) * 4, v2 = f * mix[0] + pap * mix[1];
    if (v2 > 0) { d[i] = light[0]; d[i + 1] = light[1]; d[i + 2] = light[2]; d[i + 3] = Math.min(255, v2 * gain[0]); }
    else { d[i] = dark[0]; d[i + 1] = dark[1]; d[i + 2] = dark[2]; d[i + 3] = Math.min(255, -v2 * gain[1]); }
  }
  g.putImageData(im, 0, 0); return c;
}

export function washOver(g, tex, alpha, clip) {
  g.save(); if (clip) g.clip(clip);
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = alpha;
  g.imageSmoothingEnabled = true; g.drawImage(tex, 0, 0, g.canvas.width, g.canvas.height); g.restore();
}
