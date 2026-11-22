// 校准场景的统一入口：按引用取场景；给带镜头入口的场景备好 three、Blender 两个帧源的镜头输入。
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shotInput } from '../kernel/eval/input.mjs';
import { CALIB_DIR, loadScenes } from './check.mjs';

/** 公开合成校准场景：零外部素材，各带两个帧源的镜头入口（场景目录里的 shot.three.js、shot.blender.py） */
export const PUBLIC_CALIB_SCENES = Object.freeze(['calib/hdr-post@1', 'calib/studio-balls@1', 'calib/boxes-explode@1', 'calib/mech-head-proxy@1']);

// 场景名就是目录名，只有一段：小写字母、数字、连字符，可带 @版本。斜杠、反斜杠、点、控制字符都进不来
const ID = /^[a-z0-9]+(-[a-z0-9]+)*(@[1-9][0-9]*)?$/;
const RENDERERS = {
  three: { source: 'three', host: 'page', mode: 'native-code', entry: 'shot.three.js' },
  blender: { source: 'blender', host: 'cycles', mode: 'build-script', entry: 'shot.blender.py' },
};
const SEED = 20261122;

function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.freeze(v); Object.values(v).forEach(deepFreeze); }
  return v;
}

/** ref 写 'calib/<场景名>' 或 '<场景名>'。返回深冻结的 { ref, id, dir, scenePath, scene }；不是字符串抛 TypeError，没有这个场景抛 RangeError */
export function resolveCalibScene(ref) {
  if (typeof ref !== 'string') throw new TypeError(`校准场景引用必须是字符串，给的是 ${ref === null ? 'null' : typeof ref}`);
  const id = ref.startsWith('calib/') ? ref.slice('calib/'.length) : ref;
  const dir = join(CALIB_DIR, id), scenePath = join(dir, 'scene.json');
  if (!ID.test(id) || !existsSync(scenePath)) throw new RangeError(`没有校准场景 ${JSON.stringify(ref)}`);
  return deepFreeze({ ref: `calib/${id}`, id, dir, scenePath, scene: JSON.parse(readFileSync(scenePath, 'utf8')) });
}

/** 默认列四个公开场景；includeProbes 时后面接七个 probe-* 探针场景 */
export function listCalibScenes({ includeProbes = false } = {}) {
  const refs = [...PUBLIC_CALIB_SCENES, ...(includeProbes ? loadScenes().map((s) => s.name) : [])];
  return Object.freeze(refs.map(resolveCalibScene));
}

/**
 * 备好一个场景在两个帧源上的镜头输入，片子描述写到 outDir/film.json。source 是 both、three、blender；size 是输出画幅 [宽, 高]，不写用规格相机的。
 * 返回 { film, filmDir, threeShotInput?, blenderShotInput? }：镜头输入直接交给帧源的 open(input, { lock: null, tier, workspace, filmDir })。
 * filmDir 是场景目录不是 outDir：页面宿主只放行 beiming/ 下的入口文件，镜头入口随场景入库，不往 outDir 抄。
 * 片子只有一个镜头 s01（两个帧源各渲同一段，帧号都从 0 起）：film 里写的是 three 那一套，只要 Blender 时写 Blender 的。
 * 快门不写（0 度）：标准答案都是针孔、sub = 0，Blender 开着原生运动模糊也交不出辅助层。
 */
export async function materializeCalibWorkspace(ref, outDir, { source = 'both', size } = {}) {
  const { id, dir, scene } = resolveCalibScene(ref);
  // 先判类型：['three'] 这类值拿去查表会被悄悄转成字符串
  if (typeof source !== 'string' || !(source === 'both' || Object.hasOwn(RENDERERS, source))) throw new RangeError(`source 只能是 both、three、blender，给的是 ${JSON.stringify(source)}`);
  const wanted = source === 'both' ? ['three', 'blender'] : [source];
  const missing = wanted.find((name) => !existsSync(join(dir, RENDERERS[name].entry)));
  if (missing) throw new RangeError(`校准场景 ${id} 没有 ${missing} 的镜头入口 ${RENDERERS[missing].entry}`);
  if (size !== undefined && !(Array.isArray(size) && size.length === 2 && size.every((n) => Number.isInteger(n) && n >= 1))) throw new RangeError('size 必须是 [宽, 高] 两个正整数');
  const frames = scene.frameRange.endFrame + 1;
  const filmFor = (name) => ({
    format: 'film/3.0',
    id: `calib-${id.replace('@', '-v')}`,
    title: scene.title,
    output: { size: size ?? [scene.camera.widthPx, scene.camera.heightPx], fps: `${scene.frameRateFps}/1`, frames },
    shots: [{ id: 's01', in: 0, out: frames, ...RENDERERS[name], colorRef: 'scene', seed: SEED }],
    style: { view: { scene: 'agx-mhc', display: 'srgb' } },
    predicates: { base: ['floor@1'] },
    delivery: { master: 'h264-crf14-bt709' },
  });
  const film = filmFor(wanted[0]);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'film.json'), `${JSON.stringify(film, null, 2)}\n`);
  return { film, filmDir: dir, ...Object.fromEntries(wanted.map((name) => [`${name}ShotInput`, shotInput(filmFor(name), 's01')])) };
}
