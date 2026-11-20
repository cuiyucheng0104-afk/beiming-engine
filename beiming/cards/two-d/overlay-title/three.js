// overlay.title 在 three 帧源里的实现：一行片名，5 × 7 点阵字，每个亮点一个小方片，拼成一张正对相机的平面网格。
// 字形是这个文件自带的，不读系统字体：同样的参数在哪台机器上拼出来的网格都一样，文字框从网格的尺寸直接算，不靠量像素。
// 和宿主的约定（卡文件的 ports.requires 里也写了）：Handle.object 挂在透视相机下面，它的局部坐标就是相机空间：米，右手系，Y 向上，−Z 朝前。
// 颜色：ink 是显示空间的颜色，写进颜色层的是它解码到线性光之后的值，预乘透明度。

const ROWS = 7, COLS = 5;
// 相邻两个字的起点隔几格：字宽 5 格加 1 格间距
const ADVANCE = 6;
// 每个字 7 行、每行 5 位，从上到下、从左到右，1 是亮点
const GLYPHS = {
  ' ': '00000 00000 00000 00000 00000 00000 00000',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  0: '01110 10001 10011 10101 11001 10001 01110',
  1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010',
  5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110',
  7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100',
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
};

/**
 * ctx：镜头契约的 ctx，用到 THREE 和 size。params（卡文件里声明的六个）：
 *   text 片名；enter 入场的时刻（镜头局部帧号）；settleFrames 入场用几帧落定；ink 字的颜色（显示空间）；
 *   heightFrac 字高占画面高的比例；distance 平面离相机多远（米）。
 * 入场：从 enter 起 settleFrames 帧里，不透明度从 0 到 1、位置从低半个字高处升到位，按 1 − (1 − p)³ 缓出；
 * 落定之后每一帧的状态完全相同。enter 之前不画。
 */
export function create(ctx, params) {
  const { THREE } = ctx, [width, height] = ctx.size;
  // 亮点的格子坐标 [列, 行]，行从上往下数
  const dots = [];
  [...params.text].forEach((ch, i) => {
    const glyph = GLYPHS[ch]?.replaceAll(' ', '');
    if (!glyph) throw new Error(`overlay.title 的字形表里没有 ${JSON.stringify(ch)}：只有大写字母、数字、空格和 - . :`);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (glyph[r * COLS + c] === '1') dots.push([i * ADVANCE + c, r]);
  });
  if (!dots.length) throw new Error('overlay.title 的 text 里没有一个亮点');

  // 整行以墨迹的水平中心、字格的竖直中心对到原点。一格的边长是 1，y 向上；真实大小在 apply 里按相机的视场角缩放
  const cols = dots.map(([c]) => c), rows = dots.map(([, r]) => r);
  const cx = (Math.min(...cols) + Math.max(...cols) + 1) / 2, cy = ROWS / 2;
  // 墨迹外框，格子单位
  const ink = { x0: Math.min(...cols) - cx, x1: Math.max(...cols) + 1 - cx, y0: cy - Math.max(...rows) - 1, y1: cy - Math.min(...rows) };
  const position = [], normal = [];
  for (const [c, r] of dots) {
    const x0 = c - cx, x1 = x0 + 1, y1 = cy - r, y0 = y1 - 1;
    position.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
    for (let i = 0; i < 6; i++) normal.push(0, 0, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(params.ink), transparent: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'overlay.title';

  const projection = () => {
    if (!mesh.parent?.isPerspectiveCamera) throw new Error('overlay.title 的 object 必须挂在透视相机下面');
    return mesh.parent.projectionMatrix.elements;
  };
  /** t = f + sub 时刻的摆法：一格的边长（米）、竖直偏移（米）、不透明度 */
  function pose(t) {
    // 离相机 distance 米处画面的高是 2 × distance ÷ 投影矩阵第 6 个数（米）；七格字高占其中的 heightFrac
    const cell = (params.heightFrac * 2 * params.distance) / projection()[5] / ROWS;
    const p = t < params.enter ? 0 : params.settleFrames === 0 ? 1 : Math.min(1, (t - params.enter) / params.settleFrames);
    const eased = 1 - (1 - p) ** 3;
    return { cell, lift: (eased - 1) * 0.5 * ROWS * cell, opacity: eased };
  }

  return {
    object: mesh,
    entities: { plane: { object: mesh, root: true } },

    apply(f, sub) {
      const s = pose(f + sub);
      mesh.visible = s.opacity > 0;
      mesh.scale.set(s.cell, s.cell, 1);
      mesh.position.set(0, s.lift, -params.distance);
      material.opacity = s.opacity;
    },

    /** 文字框：墨迹外框投到屏幕，像素，原点在左上角，y 向下。还没入场的帧不交 */
    meta(f) {
      const s = pose(f);
      if (!(s.opacity > 0)) return { texts: [] };
      const proj = projection();
      const sx = (x) => ((proj[0] * x) / params.distance + 1) / 2 * width, sy = (y) => (1 - (proj[5] * y) / params.distance) / 2 * height;
      return { texts: [{ id: 'line', text: params.text, bbox2d: [sx(ink.x0 * s.cell), sy(ink.y1 * s.cell + s.lift), sx(ink.x1 * s.cell), sy(ink.y0 * s.cell + s.lift)] }] };
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
