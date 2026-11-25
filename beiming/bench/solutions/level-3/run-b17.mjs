// 标准工程的离线执行入口。交付卡只产生编码计划；本考试不把它当成已写出的媒体文件。
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { create as createEncoder } from '../../../cards/delivery/encode/comp.mjs';
import { validateSolutionFilm } from '../index.mjs';
import { scoreLevel3 } from '../../questions/level-3/evaluate-b17.mjs';
import { buildGeometryReading } from './geometry.mjs';
import { buildMixedReading } from './mixed.mjs';

const builders = new Map([['3-1', buildGeometryReading], ['31-1', buildMixedReading], ['1-2', buildGeometryReading]]);
export function readLevel3Film(question) {
  if (!builders.has(question.id)) throw new RangeError('不是已登记的三级题');
  const film = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, question.id, 'film.json'), 'utf8'));
  const checks = validateSolutionFilm(film);
  if (!checks.ok || film.exam !== question.id || !question.needs.every(c => checks.declaredCards.includes(c))) {
    throw new Error(`三级标准工程与题目或 film/3.0 契约不符：${question.id}`);
  }
  return film;
}

export function buildLevel3Reading(question, disabled = null, film = readLevel3Film(question)) {
  const build = builders.get(question.id);
  if (!build) throw new RangeError('三级题缺少测量器');
  const { output, ...reading } = build(question, film, disabled === 'deliver.encode' ? null : disabled);
  if (disabled === 'deliver.encode' || film.delivery?.card !== 'deliver.encode@1') return { delivery: null, ...reading };
  const encoder = createEncoder(output, film.delivery);
  try {
    return { delivery: { size: encoder.object.size, fps: encoder.object.fps, frames: output.frames, audio: output.audio }, ...reading };
  } finally { encoder.dispose(); }
}

export function runLevel3Controls(question) {
  const film = readLevel3Film(question);
  const score = disabled => scoreLevel3(question, buildLevel3Reading(question, disabled, film));
  const controls = [...new Set([...question.needs, ...film.shots.flatMap(s => (s.cards ?? []).map(c => c.use.split('@')[0]))])];
  if (question.id === '31-1') controls.push('cut');
  return { positive: score(null), negatives: Object.fromEntries(controls.map(card => [card, score(card)])) };
}

// 无参核验全部工程；--reference 题号只写标准输出，便于独立重生成某一份夹具。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const load = id => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'questions', 'level-3', `${id}.json`), 'utf8'));
  if (args.length === 2 && args[0] === '--reference' && builders.has(args[1])) {
    const question = load(args[1]);
    const ref = { question: question.id, kind: 'reference', readings: buildLevel3Reading(question) };
    // 几何帧或双机位采样向量各占一行；数值用 JSON 的无损表示，不四舍五入。
    const json = JSON.stringify(ref);
    console.log(ref.readings.takes ? json.replaceAll('],[', '],\n[') : json.replaceAll('},{"positions":', '},\n{"positions":'));
  } else if (!args.length) {
    for (const id of builders.keys()) {
      const { positive, negatives } = runLevel3Controls(load(id));
      console.log(JSON.stringify({ id, positive, negatives }));
      if (!positive.pass || positive.score !== 1 || Object.values(negatives).some(v => v.pass || v.score >= 1)) process.exitCode = 1;
    }
  } else {
    console.error('用法：node run-b17.mjs [--reference 题号]');
    process.exitCode = 2;
  }
}
