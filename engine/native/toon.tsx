// 北冥引擎 · 原生层 · 卡通材质与程序化物体：原生 ToonMaterial 的参数组织、整模型的分材质覆盖、带材质的基本体。
//
// 与 A 路（engine/shade/toon.js）的关系：两套算法不同（A 是 three 着色器补丁的三色分档 + 双羽化 + 屏幕 ID 墨线，
// 原生是 Bevy 的分档 toon + rim + 描边，见 docs/raea/architecture.md），数值不能照搬。这里只对应**颜色语义**：
// 基色、阴影色、边缘光色、墨线色；强度与宽度由作品自己给，不做假的数值换算。
//
//   toonFromShade(shade, extra)   engine/shade 风格的参数对象 { color, shade1|shade2, rimColor, inkColor } → 原生 ToonMaterial 参数
//                                 shade2（更深的二档）优先作阴影色；extra 里给 steps / rim:{intensity,width} / outline:{width} 等
//   place(p, s = 1, r = [0,0,0])  位置 / 等比或三轴缩放 / XYZ 欧拉角（弧度）→ Transform
//   <ToonMesh name at size? scale? rotation? toon>{基本体}</ToonMesh>
//                                 一个带卡通材质的基本体（Cuboid / Sphere / Cylinder / Cone …作为 children）
//   <ToonBox name at size toon>   ToonMesh + Cuboid 的简写；size 为全尺寸 [x, y, z]
//   <ToonModel src … toon parts>  一个 GLB 模型：toon 覆盖全部材质，parts=[{ materials:[名字…], toon }] 按材质名单独覆盖
//                                 （覆盖时 GLB 的 baseColorTexture 与 COLOR_0 仍然生效；不要给带贴图的部位写 base_color）
//                                 其余属性（animation / time / loop / position / rotation / scale / name）原样交给 Model

import { Transform, Quat } from 'raea/transform';
import { Mesh3d, Cuboid } from 'raea/mesh';
import { ToonMaterial } from 'raea/pbr';
import { Model } from 'raea/3d';

export type Vec3 = number[];
export type ToonProps = Record<string, unknown>;

export const place = (p: Vec3, s: number | Vec3 = 1, r: Vec3 = [0, 0, 0]) =>
  Transform.fromXyz(p[0], p[1], p[2]).withScale(typeof s === 'number' ? [s, s, s] : s).withRotation(Quat.fromEuler('XYZ', r[0], r[1], r[2]));

export function toonFromShade(shade: { color?: string, shade1?: string | null, shade2?: string | null, rimColor?: string, inkColor?: string }, extra: ToonProps = {}): ToonProps {
  const out: ToonProps = { steps: 3 };
  if (shade.color) out.base_color = shade.color;
  const dark = shade.shade2 || shade.shade1;
  if (dark) out.shadow_color = dark;
  const rim = extra.rim as Record<string, unknown> | undefined, outline = extra.outline as Record<string, unknown> | false | undefined;
  Object.assign(out, extra);
  if (rim && shade.rimColor && rim.color === undefined) out.rim = { ...rim, color: shade.rimColor };
  if (outline && shade.inkColor && (outline as Record<string, unknown>).color === undefined) out.outline = { ...outline, color: shade.inkColor };
  return out;
}

export function ToonMesh({ name, at, scale = 1, rotation = [0, 0, 0], toon, children }: { name: string, at: Vec3, scale?: number | Vec3, rotation?: Vec3, toon: ToonProps, children?: unknown }) {
  return <Mesh3d name={name} transform={place(at, scale, rotation)}>{children}<ToonMaterial {...toon} /></Mesh3d>;
}

export function ToonBox({ name, at, size, toon }: { name: string, at: Vec3, size: Vec3, toon: ToonProps }) {
  return <ToonMesh name={name} at={at} toon={toon}><Cuboid half_size={size.map(x => x / 2)} /></ToonMesh>;
}

export function ToonModel({ toon, parts = [], ...model }: { toon?: ToonProps, parts?: { materials: string[], toon: ToonProps }[], [k: string]: unknown }) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(model)) if (v !== undefined) props[k] = v;
  return <Model {...props}>
    {toon && <ToonMaterial {...toon} />}
    {parts.flatMap(part => part.materials.map(material => <ToonMaterial key={material} material={material} {...part.toon} />))}
  </Model>;
}
