// 北冥引擎 · 原生层 · 色板：颜色从作品自己的数据文件读（palette.json），组件只拿名字取色，不在代码里手抄色值。
//
//   palette(data)        校验后冻结：每个值必须是 #RGB / #RRGGBB / #RRGGBBAA；返回同一个对象（只读）
//                        用法：import data from './palette.json'; const P = palette(data); P.sky
//   pick(P, name)        按名字取色；名字不存在时直接报错（防止拼错名字后静默落到默认色）
//   rgb(hex)             '#RRGGBB' → [r, g, b]（sRGB 0..1），给 WESL 着色器的 vec3 参数用

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function palette<T extends Record<string, string>>(data: T): Readonly<T> {
  if (!data || typeof data !== 'object') throw new TypeError('palette: 需要一个 { 名字: "#RRGGBB" } 对象');
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('$')) continue;                      // "$note" 之类的说明字段
    if (typeof v !== 'string' || !HEX.test(v)) throw new TypeError(`palette: ${k} 不是十六进制颜色：${JSON.stringify(v)}`);
  }
  return Object.freeze(data);
}

export function pick(P: Record<string, string>, name: string): string {
  const v = P[name];
  if (v === undefined) throw new RangeError(`palette: 没有名为 ${name} 的颜色（现有：${Object.keys(P).join(', ')}）`);
  return v;
}

export function rgb(hex: string): [number, number, number] {
  if (!HEX.test(hex)) throw new TypeError(`rgb: 不是十六进制颜色：${hex}`);
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}
