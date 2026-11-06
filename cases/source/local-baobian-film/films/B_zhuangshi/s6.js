// s6.js — S6 回现实（镜 #11）：修复室，越过右肩的 3/4 背后。
// 契约：f668 起右肩顶光斑 0 在 A = (1188, 592)；f658 镜片外缘闪点在 P_g（由 A09 的镜片锚点按 f658 机位算出，T2 豹眼高光同点）。
// 光斑：f658–f670 软边椭圆（小孔成像日影）随柳叶摆动漂 → f670–f674 人身上的光斑一齐变成「光斑态」文斑（第一枚在 A，其余按距离延迟），
//       墙和桌上的光斑一直是不规则的（窗光 gobo）。
import * as THREE from 'three';
import { W, H, K, lin3, DEG, clamp, lerp, seg, ss, eo, eio, hashi, aimCamera, screenToWorld, project, placeSprite, setRot, clearDeform, mulberry, fseg, cardMat, card } from './lib.js';

const FPX40 = 520 / Math.tan(27.40 / 2 * DEG);
// 右镜片（fix3，story-12）：A09 只画了镜片外框的左段"("（约 137°），闪光退去后读不出是眼镜。
// 在精灵上补一张小卡片（跟精灵同一平面、同一变换）：沿同一个椭圆把镜框补成整圈——左段（图里那道）是 3 px 深框，
// 其余（镜片远侧）2 px、淡一档；框里一层极淡的镜片色、一道斜 35° 的细反光。眼镜不做特写，只让"圆镜片"认得出来。
// 椭圆按图里墨线量：圆心 (946, 346)、横半径 30、竖半径 41（图像像素）；左段端点约在 ±111.5°
const LENS_FS = /* glsl */`
uniform vec4 uRect, uL; uniform vec3 uFrame, uGlass; uniform float uPxS, uA;
void main(){
  vec2 px = vec2(uRect.x + vUv.x * uRect.z, uRect.y + (1. - vUv.y) * uRect.w);
  vec2 q = (px - uL.xy) / uL.zw, gq = (px - uL.xy) / (uL.zw * uL.zw);
  float k0 = length(q), k1 = max(length(gq), 1e-5);
  float dist = k0 * (k0 - 1.) / k1;                         // 到椭圆的近似距离（图像像素）
  float aa = max(fwidth(dist), 1e-4);
  float th = atan(q.y, q.x);                                // 0 = 右侧，±π = 左侧（图像 y 向下）
  float near = smoothstep(1.86, 2.02, abs(th));             // 左段（图里画了的那道）
  float hw = mix(1.0, 1.5, near) / uPxS;                    // 半线宽：远侧 2 px、左段 3 px（屏幕）
  float ln = (1. - smoothstep(hw - aa, hw + aa, abs(dist))) * mix(.85, 1., near);
  float inG = 1. - smoothstep(-aa, aa, dist + hw);
  vec2 gd = vec2(.819, .574);
  float gl = (1. - smoothstep(.045, .075, abs(dot(q, gd) - .30))) * smoothstep(.95, .70, k0) * step(abs(dot(q, vec2(-gd.y, gd.x))), .55);
  // 预乘合成：镜框压在镜片上（镜框处不混进镜片的浅色）
  float aG = inG * (.10 + .30 * gl);
  vec3 pm = uFrame * ln + mix(uGlass, vec3(1., .99, .95), gl) * aG * (1. - ln);
  float a = ln + aG * (1. - ln);
  if (a < .003) discard;
  gl_FragColor = vec4(pm / a, a * uA);
}`;
export const S6_CAM = { yaw: 36.5 * DEG, pitch: -15.7 * DEG };

export function buildS6({ room, tex }) {
  const { desk6, mendR, mendL, arm, setBook } = room.s6;
  // w3（v3-04）：S6 里书几乎不在画里（只在两只手之间露出约 80 px 的一角）。机位、P_g、A 都不动，只挪书和手：
  //   书沿桌面挪到他右前方（世界 (0.24, 0, 0.0)）、转 36.5° 正对着他（也正对镜头），右页的 ䷰ 整个露在执笔手右边，
  //   左页木刻豹在笔尖旁露出一部分；双手缩到 0.86 倍（原来比头还大一圈），左手下移 28 px、指尖按在书的左上沿。
  //   笔尖落在左页靠书口一侧，不在右页上：手精灵的手掌在笔尖右上方约 210 × 260 px，笔尖一放到右页，就会把 ䷰ 整个盖住（偏差见 NOTES 第六节）
  const BOOK6 = { x: 0.24, z: 0.0, rot: 36.5 * DEG };
  const HAND6 = { s: 0.86, R: [0, 0], L: [5, 28] };
  const cam = room.cam;
  const A09 = tex.manifest.A09.锚点, A13 = tex.manifest.A13.锚点;
  const camAt = f => {
    const u = eo(fseg(f, 658, 668));
    cam.fov = 27.40; cam.updateProjectionMatrix();
    aimCamera(cam, new THREE.Vector3(lerp(0.95, 1.02, u), lerp(1.25, 1.30, u), lerp(2.35, 2.52, u)), S6_CAM.yaw, S6_CAM.pitch);
  };
  // 越肩背影：按 f668 机位让右肩光斑 0 落在 A；屏幕比例 0.92（背向下出画）
  camAt(668);
  const q668 = new THREE.Quaternion(); cam.getWorldQuaternion(q668);
  const D = 2.2, S = 0.98, PPM = 1 / (S * D / FPX40);
  const WA = screenToWorld(cam, W, H, 1188 * K, 592 * K, D);
  const SH0 = A09.light_spots[0].px;
  // 右臂：绕肩向下转 40°，袖子按最后一列延伸到画外（从画面下缘出去）
  desk6.crop.set(0, 0, 1.38, 1.22); desk6.U.uClamp.value.set(1444 / 1448, 1076 / 1082);
  placeSprite(desk6, WA, q668, SH0, PPM);
  const pxToWorld = (sp, px) => {
    const c = sp.crop, cw = (c.z - c.x) * sp.img.x, ch = (c.w - c.y) * sp.img.y;
    return new THREE.Vector3((px[0] - c.x * sp.img.x) / cw - 0.5, 0.5 - (px[1] - c.y * sp.img.y) / ch, 0).applyMatrix4(sp.group.matrixWorld);
  };
  // 镜片卡片：挂在精灵组下面（精灵局部坐标按 crop 换算），跟精灵一起摆、一起后拉
  const LENS = { cx: 946, cy: 346, rx: 30, ry: 41 };
  const LR = [900, 290, 96, 112];
  const lensMat = cardMat(LENS_FS, { uRect: { value: new THREE.Vector4(...LR) }, uL: { value: new THREE.Vector4(LENS.cx, LENS.cy, LENS.rx, LENS.ry) },
    uFrame: { value: lin3('#3A2E26') }, uGlass: { value: lin3('#FFF4DE') }, uPxS: { value: 0.98 }, uA: { value: 1 } }, { depthTest: false });
  const lens = card(lensMat, 30.5); lens.userData.outlineOccluder = false;
  {
    const c = desk6.crop, cw = (c.z - c.x) * desk6.img.x, ch = (c.w - c.y) * desk6.img.y;
    lens.position.set((LR[0] + LR[2] / 2 - c.x * desk6.img.x) / cw - 0.5, 0.5 - (LR[1] + LR[3] / 2 - c.y * desk6.img.y) / ch, 0);
    lens.scale.set(LR[2] / cw, LR[3] / ch, 1);
  }
  desk6.group.add(lens);
  camAt(658);
  const lensW = pxToWorld(desk6, A09.lens_glint_px);
  const pg = project(cam, W, H, lensW);
  const PG = [pg.x / K, pg.y / K];

  // 光斑布局：衬衫 18 枚（A09），手上 5 枚（A13）；软边椭圆期的位置由哈希给（随叶影漂）
  const setSpotsU = (sp, list, rpx, seed) => {
    const S2 = sp.U.uLs.value, B = sp.U.uLsB.value;
    list.forEach((s, i) => {
      const R = mulberry(seed + i * 13);
      // fix1（story-10）：大小 ±15%、角度 ±10°、位置错开 ±10 px（顺着背和臂，不对齐成网格）；第一枚在 A 不动
      const jx = i === 0 ? 0 : (R() - 0.5) * 20, jy = i === 0 ? 0 : (R() - 0.5) * 20;
      S2[i].set(s.px[0] + jx, s.px[1] + jy, rpx * (i === 0 ? 1 : 0.85 + 0.30 * R()), -18 * DEG + (i === 0 ? 0 : (R() - 0.5) * 0.35));
      sp.userData_ls = sp.userData_ls || []; sp.userData_ls[i] = { x: S2[i].x, y: S2[i].y, r: S2[i].z };
      B[i].set(s.px[0] + (R() - 0.5) * 50, s.px[1] + (R() - 0.5) * 40, rpx * (0.5 + R() * 0.9), 0);
    });
  };
  setSpotsU(desk6, A09.light_spots, 30 * 1.05, 101);
  setSpotsU(mendR, A13.light_spots, 26, 202); setSpotsU(mendL, A13.light_spots, 26, 202);
  const dist0 = A09.light_spots.map(s => Math.hypot(s.px[0] - SH0[0], s.px[1] - SH0[1]));
  const dmax = Math.max(...dist0);

  const api = {
    PG,
    update(t) {
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      room.updateS6(t);
      setBook(BOOK6.x, BOOK6.z, BOOK6.rot);
      camAt(f);
      // 越肩背影（静止）
      desk6.group.visible = true;
      clearDeform(desk6);
      setRot(desk6, 0, [1132, 690], 40 * DEG, [1118, 540, 2100, 1100], 34);
      placeSprite(desk6, WA, q668, SH0, PPM);
      // 补书的双手（一拍二：整体 x ±4 px、转 ±0.8°，周期 1.2 s）
      const sw = Math.sin(tc / 1.2 * Math.PI * 2);
      const handD = 2.75, hS = 0.50 * HAND6.s, hPPM = 1 / (hS * handD / FPX40);
      const qh = q668.clone();
      const PR = screenToWorld(cam, W, H, (1700 + HAND6.R[0] + 4 * sw) * K, (1080 + HAND6.R[1]) * K, handD);
      mendR.group.visible = true; mendR.U.uLean.value = 0.8 * DEG * sw; mendR.U.uGlo.value.set(1210, 735, 1, 1);
      placeSprite(mendR, PR, qh, [1210, 745], hPPM);
      const PL = screenToWorld(cam, W, H, (1395 + HAND6.L[0] - 2 * sw) * K, (1085 + HAND6.L[1]) * K, handD + 0.05);
      mendL.group.visible = true; mendL.U.uLean.value = -0.5 * DEG * sw; mendL.U.uGlo.value.set(215, 745, 1, 1);
      placeSprite(mendL, PL, qh, [215, 755], hPPM * 1.02);
      // 光斑：漂（随叶影）→ f670–f674 成形为豹纹
      const drift = (i) => [Math.sin(0.9 * t + i * 1.7) * 9, Math.cos(0.7 * t + i * 2.3) * 6];
      // 第一枚先在 A 亮 2 帧，其余按到 A 的距离向外一圈圈成形
      // w3（qa2-06）：整张时间表提前 2 帧——原来 A 点四瓣环要到 f672（28.000 s）才成形，比 27.926 s 的重拍晚 2 帧；
      //   现在 f668 起变、f670 成形，正踩在重拍上
      const morph = (i, d) => clamp((f - 668 - (i === 0 ? 0 : 2 + 6 * d)) / 4);
      for (const [sp, list, D0] of [[desk6, A09.light_spots, dist0], [mendR, A13.light_spots, null], [mendL, A13.light_spots, null]]) {
        sp.U.uLsOn.value = 1;
        const S2 = sp.U.uLs.value, B = sp.U.uLsB.value;
        list.forEach((s, i) => {
          const d = D0 ? D0[i] / dmax : 0.5 + 0.1 * i;
          const m = morph(i, d);
          const [dx, dy] = drift(i);
          const base = mulberry((sp === desk6 ? 101 : 202) + i * 13);
          const bx = s.px[0] + (base() - 0.5) * 50 + dx * (1 - m), by = s.px[1] + (base() - 0.5) * 40 + dy * (1 - m);
          B[i].x = bx; B[i].y = by;
          // 成形后随叶影 ±2 px 微摆；轻微过冲 1.06 → 1.00
          const ov = m > 0 && m < 1 ? 1 + 0.06 * Math.sin(m * Math.PI) : 1;
          // 成形后随叶影摆动 ±7 px
          const L0 = sp.userData_ls[i];
          S2[i].x = L0.x + 7 * Math.sin(0.9 * t + i * 1.3) * ss(m); S2[i].y = L0.y + 6 * Math.cos(0.8 * t + i * 0.9) * ss(m);
          B[i].w = ss(m);
          S2[i].z = L0.r * ov;
        });
      }
      // 镜片外框弧（fix2，story-12）：闪光退去时（f659–f667）沿右镜片外框亮一道细金线（约 1/3 圈，3 px），和 T1 的光轮、豹眼的圆呼应。
      //   圆心 / 半径按 A09 镜片外缘点（最右点）往里一个镜片半径算，每帧按当时机位投影（后拉时跟着走）
      //   A09 里这段镜框是一道"("形的椭圆弧：中心 (946, 346)、横半径 28、竖半径 41（图像像素，按图里墨线量）
      //   fix3（story-12）：金线沿补全的整圈镜框走——f658.5 起从闪点所在的左缘向两边绕，f662 合成一圈，f663–f668 淡出
      //   （"豹眼的圆 → 镜片的圆"，和 T1 的光轮呼应）；闪光跟着镜片走（f658 仍在 P_g，与 T2 同点）
      const LC = [LENS.cx, LENS.cy];
      const pc = project(cam, W, H, pxToWorld(desk6, LC)), px1 = project(cam, W, H, pxToWorld(desk6, [LENS.cx - LENS.rx, LENS.cy])), py1 = project(cam, W, H, pxToWorld(desk6, [LENS.cx, LENS.cy - LENS.ry]));
      const rx = Math.hypot(px1.x - pc.x, px1.y - pc.y), ry = Math.hypot(py1.x - pc.x, py1.y - pc.y);
      lensMat.uniforms.uPxS.value = rx / K / LENS.rx;
      const arcK = seg(f, 658.5, 660) * (1 - seg(f, 663, 668));
      const arcHalf = lerp(0.35, 4.6, eo(seg(f, 658.5, 662)));
      const pgN = project(cam, W, H, pxToWorld(desk6, A09.lens_glint_px));
      const PGn = [pgN.x / K, pgN.y / K];
      return {
        fx: (ov) => {
          // 镜片闪：与 T2 同点同形同亮，f658 峰值，f665 衰减到 10%
          const k = 1 - 0.9 * eo(fseg(f, 658, 665));
          ov.glint(PGn[0], PGn[1], 600, k);
          ov.UA.uGlHalo.value = 1.2;
          if (arcK > 0) { ov.UA.uArc.value.set(pc.x / K, pc.y / K, rx / K, 0.95 * arcK); ov.UA.uArcB.value.set(Math.PI, arcHalf, 3, ry / rx); }
        },
      };
    },
  };
  return api;
}
