// 合成光追分层图夹具（供 engine/look/layers.js 与 engine/offscreen/tsl/layers.js 对拍）：
// 含天空（id=0）、前景遮挡球（id=2）、带 16 位深度折痕与法线棱边的中景岩壁（id=1），以及等深相接柱（id=3）。
export function makeSyntheticLayers(width = 320, height = 180) {
  const n = width * height;
  const color = new Uint8Array(n * 3);
  const normal = new Uint8Array(n * 3);
  const depth = new Uint16Array(n);
  const ids = new Uint16Array(n);
  const depthUnit = 0.001; // 1 单位 = 1 毫米，最大 65.535 m

  const encN = (nx, ny, nz) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    return [
      Math.max(0, Math.min(255, Math.round(((nx / l) * 0.5 + 0.5) * 255))),
      Math.max(0, Math.min(255, Math.round(((ny / l) * 0.5 + 0.5) * 255))),
      Math.max(0, Math.min(255, Math.round(((nz / l) * 0.5 + 0.5) * 255))),
    ];
  };

  for (let y = 0; y < height; y++) {
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / Math.max(1, width - 1);
      const i = y * width + x;

      // 默认：天空（id = 0，z = 60 m）
      let id = 0;
      let zMeters = 60;
      let r = Math.round(218 - 42 * v + 18 * u);
      let g = Math.round(196 - 30 * v + 10 * u);
      let b = Math.round(214 - 14 * v);
      let [nx, ny, nz] = [0, 0, 1];

      // 中景岩壁（id = 1）与等深相接柱（id = 3）：x ∈ [150, 290], y ∈ [32, 165]
      if (x >= 150 && x <= 290 && y >= 32 && y <= 165) {
        id = x > 262 ? 3 : 1;
        // 在 x = 200 处造一道凹向远处的 V 形深度折痕（近侧 1/z 二阶差分为负：在两侧斜坡转平处或凸脊处出线）
        // 凸脊：x = 200 最浅（8.2 m），向两侧加深，1/zp + 1/zm - 2/z0 < 0！
        const distCrease = Math.abs(x - 200);
        zMeters = distCrease < 24 ? 8.2 + distCrease * 0.075 : 10.0;
        if (x > 262) zMeters = 10.0; // 与 id=1 右侧等深 10.0m，测试等深大号优先

        // 在 x = 236 处造一道纯法线棱边（深度连续 10.0m，法线夹角突变）
        if (x < 236) {
          nx = -0.68; ny = 0.22; nz = 0.70;
        } else {
          nx = 0.72; ny = 0.18; nz = 0.67;
        }
        const light = Math.max(0.18, Math.min(0.98, nx * -0.45 + ny * 0.55 + nz * 0.68));
        const texWave = Math.sin(x * 0.55) * Math.cos(y * 0.52) * 24;
        const base = id === 3 ? [156, 132, 178] : [132, 146, 192];
        r = Math.max(0, Math.min(255, Math.round(base[0] * light + texWave)));
        g = Math.max(0, Math.min(255, Math.round(base[1] * light + texWave * 0.8)));
        b = Math.max(0, Math.min(255, Math.round(base[2] * light - texWave * 0.6)));
      }

      // 前景球体（id = 2）：圆心 (125, 102)，半径 46，遮挡岩壁左缘
      const dx = (x - 125) / 46, dy = (y - 102) / 46;
      const rr = dx * dx + dy * dy;
      if (rr <= 1) {
        const dz = Math.sqrt(Math.max(0, 1 - rr));
        id = 2;
        zMeters = 4.5 - dz * 1.1;
        nx = dx; ny = -dy; nz = dz;
        const light = Math.max(0.22, Math.min(0.96, nx * -0.5 + ny * 0.6 + nz * 0.62));
        const texWave = Math.sin(x * 0.62 + 1.1) * Math.cos(y * 0.58 + 0.4) * 26;
        r = Math.max(0, Math.min(255, Math.round(215 * light + texWave)));
        g = Math.max(0, Math.min(255, Math.round(164 * light + texWave * 0.7)));
        b = Math.max(0, Math.min(255, Math.round(142 * light - texWave * 0.5)));
      }

      color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b;
      const en = encN(nx, ny, nz);
      normal[i * 3] = en[0]; normal[i * 3 + 1] = en[1]; normal[i * 3 + 2] = en[2];
      depth[i] = Math.max(1, Math.min(65535, Math.round(zMeters / depthUnit)));
      ids[i] = id;
    }
  }

  return {
    width,
    height,
    depthUnit,
    color: { width, height, channels: 3, depth: 8, data: color },
    normal: { width, height, channels: 3, depth: 8, data: normal },
    depth: { width, height, channels: 1, depth: 16, data: depth },
    ids: { width, height, channels: 1, depth: 16, data: ids },
  };
}
