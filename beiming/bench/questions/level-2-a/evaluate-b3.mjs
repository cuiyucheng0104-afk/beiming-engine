// B3 二级第一批四道题的判分核验：把题目的基础谓词和 scoring[].args 里的阈值套到一份读数上。
//   evaluate(question, reading) → { score, pass, basePass, base: [{ predicate, pass }], items: [{ metric, weight, pass, detail }] }
//   score 是过了的判分项的权重和；basePass 是基础谓词没有一条不过；pass 是 basePass 加每个判分项都过，差一项就判不合格。
//   base[].pass 是 null 表示这份读数判不了这一条（cut_at(shots) 要镜头表，读数里没有），留给 runner 的谓词核，不算进 basePass。
//   读数不成形（不是 JSON 对象、缺子表、表里有空洞或混进非数、帧率和总帧数跟交付规格不一致）一律 0 分、不合格，原因写在 detail.invalid，不抛错。
//   读数的字段见 beiming/bench/refs/level-2-a/ 的夹具；时刻要么是整数帧，要么是整数毫秒，比较全用整数，不落在浮点误差上。
//   read27_1、read29_2、read23_2 从成片量读数，read30_1 静态扫工程目录；机器上没有 ffmpeg/ffprobe 回 { toolMissing }。
// shortcut: 命中率和随机基线（05 第 7.1 节的 metric:beat.onset-hit）观测层还没有，先在这里算；它进了 observe/metrics 就换成调它。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audioLoudness, cutYdif, deliverSpec } from '../../../observe/metrics/index.mjs';

// 离周期网格最近一格有多远；网格向两头无限延伸，周期、相位、时刻同一个单位
function offGrid(at, period, phase = 0) {
  const into = (((at - phase) % period) + period) % period;
  return Math.min(into, period - into);
}
const share = (hits, events) => ({ hits, events, hitRate: events ? hits / events : 0 });
const finite = (...values) => values.every(Number.isFinite);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 没有空洞的整数表，每项落在 [low, high)；Array.from 把空洞读成 undefined，every 才不会跳过它
const ints = (list, low, high) => Array.isArray(list) && Array.from(list, (v) => Number.isSafeInteger(v) && v >= low && v < high).every(Boolean);
const rising = (list) => list.every((v, i) => i === 0 || v > list[i - 1]);
const rate = (fps) => {
  const [num, den] = typeof fps === 'string' ? fps.split('/').map(Number) : [];
  return num / den;
};

// 每道题的读数要长什么样；回空串是成形，否则回哪里不成形
const SHAPES = {
  '27-1': ({ cuts, loudnessLufs, truePeakDbtp }, { frames }) =>
    (ints(cuts, 0, frames) && rising(cuts) ? '' : 'cuts 要是片内严格递增的整数帧')
    || (finite(loudnessLufs, truePeakDbtp) ? '' : 'loudnessLufs、truePeakDbtp 要是有限数'),
  '29-2': ({ clicks, cuts, onsetsMs }, { frames, durationMs }) =>
    ([clicks, cuts].every((list) => ints(list, 0, frames) && rising(list)) ? '' : 'clicks、cuts 要是片内严格递增的整数帧')
    || (ints(onsetsMs, 0, durationMs) && rising(onsetsMs) && onsetsMs.length ? '' : 'onsetsMs 要是不空的、片内严格递增的整数毫秒'),
  '23-2': ({ chaptersMs, strongOnsetsMs, beat }, { durationMs }) =>
    (ints(chaptersMs, 0, durationMs) && rising(chaptersMs) ? '' : 'chaptersMs 要是片内严格递增的整数毫秒')
    || (ints(strongOnsetsMs, 0, durationMs) && rising(strongOnsetsMs) && strongOnsetsMs.length ? '' : 'strongOnsetsMs 要是不空的、片内严格递增的整数毫秒')
    || (plain(beat) && ints([beat.periodMs], 1, Infinity) && ints([beat.phaseMs], 0, beat.periodMs) ? '' : 'beat 要有正整数 periodMs 和 [0, periodMs) 里的整数 phaseMs'),
  '30-1': ({ moments, timeline }, { frames }) =>
    (Array.isArray(moments) && Array.from(moments, (m) => plain(m) && typeof m.id === 'string' && m.id !== '' && ints([m.frame], 0, frames)).every(Boolean)
      && new Set(moments.map((m) => m.id)).size === moments.length ? '' : 'moments 每项要有不空、不重复的字符串 id 和片内的整数 frame')
    || (plain(timeline) && ints([timeline.beatConstantDefs, timeline.hardcodedFrames], 0, Infinity) ? '' : 'timeline 的 beatConstantDefs、hardcodedFrames 要是非负整数'),
};

// 判分里帧和毫秒互换、片内范围都按题面的帧率和总帧数算，所以这两项对不上的读数不判，直接算不成形；画幅只在基础谓词里核
function malformed({ id, deliverable }, reading) {
  if (!plain(reading)) return '读数不是对象';
  if (reading.toolMissing) return `量不了：机器上没有 ${reading.toolMissing}`;
  if (reading.unreadable) return `读不了 ${reading.unreadable}`;
  const fps = rate(deliverable.fps), { frames } = deliverable;
  if (reading.fps !== fps || reading.frames !== frames) return `fps、frames 要和交付规格一致（${fps}、${frames}）`;
  return SHAPES[id](reading, { frames, durationMs: (frames * 1000) / fps });
}

// 每道题一组判法，次序和题目文件的 scoring 一一对应；进来的读数都过了上面的成形检查
const RULES = {
  '27-1': [
    ({ gridFrames, shotBeats }, { cuts, frames }) => {
      const stray = cuts.filter((frame) => frame % gridFrames !== 0);
      // 片尾不足一拍的零头算最后一个镜头的收尾，不计拍数
      const edges = [0, ...cuts, frames - (frames % gridFrames)];
      const beats = edges.slice(1).map((frame, i) => (frame - edges[i]) / gridFrames);
      return { pass: cuts.length > 0 && stray.length === 0 && beats.every((n) => shotBeats.includes(n)), cuts: cuts.length, offGrid: stray, beats };
    },
    ({ rangeLufs: [low, high], maxTruePeakDbtp }, { loudnessLufs, truePeakDbtp }) => ({
      pass: loudnessLufs >= low && loudnessLufs <= high && truePeakDbtp <= maxTruePeakDbtp,
      loudnessLufs,
      truePeakDbtp,
    }),
  ],
  '29-2': [
    ({ count, lagFrames }, { clicks, cuts }) => {
      // 点击、切点都严格递增，不同的点击要的切点帧也不同，所以这里是一个点击配一个切点，不会多次点击共用一个
      const uncut = clicks.filter((frame) => !cuts.includes(frame + lagFrames));
      return { pass: clicks.length === count && uncut.length === 0, clicks: clicks.length, uncut };
    },
    ({ tolFrames, minHitRate, minLift }, { fps, frames, clicks, onsetsMs }) => {
      // 帧号 × 1000 和 起音毫秒 × 帧率 都是整数，相差不超过 容差帧 × 1000 就算踩上（容差两端都算）
      const onOnset = (frame) => onsetsMs.some((ms) => Math.abs(frame * 1000 - ms * fps) <= tolFrames * 1000);
      const hit = share(clicks.filter(onOnset).length, clicks.length);
      // 随机基线：同一条音轨上任取一帧的命中率，取样窗口是全片 [0, frames) 的每一帧
      const randomBaseline = Array.from({ length: frames }, (_, frame) => frame).filter(onOnset).length / frames;
      return { pass: hit.hitRate >= minHitRate && hit.hitRate - randomBaseline >= minLift, ...hit, randomBaseline, baselineFrames: [0, frames] };
    },
  ],
  '23-2': [
    ({ count, bpm, tolFrames }, { fps, chaptersMs, beat }) => {
      const offBeatMs = chaptersMs.map((ms) => offGrid(ms, beat.periodMs, beat.phaseMs));
      // 一帧是 1000 / 帧率 毫秒，两边乘开成整数再比
      const onBeat = offBeatMs.every((ms) => ms * fps <= tolFrames * 1000);
      return { pass: beat.periodMs * bpm === 60000 && chaptersMs.length === count && onBeat, chapters: chaptersMs.length, offBeatMs };
    },
    ({ bpm, tolMs, minHitRate }, { strongOnsetsMs, beat }) => {
      const hit = share(strongOnsetsMs.filter((ms) => offGrid(ms, beat.periodMs, beat.phaseMs) <= tolMs).length, strongOnsetsMs.length);
      return { pass: beat.periodMs * bpm === 60000 && hit.hitRate >= minHitRate, ...hit };
    },
  ],
  '30-1': [
    ({ bpm, minCount, tolFrames, minHitRate }, { fps, moments }) => {
      const beatFrames = (fps * 60) / bpm;
      const hit = share(moments.filter(({ frame }) => offGrid(frame, beatFrames) <= tolFrames).length, moments.length);
      return { pass: Number.isInteger(beatFrames) && moments.length >= minCount && hit.hitRate >= minHitRate, ...hit, beatFrames };
    },
    ({ maxBeatConstantDefs, maxHardcodedFrames }, { timeline: { beatConstantDefs, hardcodedFrames } }) => ({
      pass: beatConstantDefs >= 1 && beatConstantDefs <= maxBeatConstantDefs && hardcodedFrames <= maxHardcodedFrames,
      beatConstantDefs,
      hardcodedFrames,
    }),
  ],
};

// 四道题用到的基础谓词写法；读数缺了要比的字段就是不过
const BASE = [
  [/^delivery\(width=(\d+), height=(\d+), fps=(\d+), frames=(\d+)\)$/, (r, ...want) => [r.width, r.height, r.fps, r.frames].every((got, i) => got === Number(want[i]))],
  [/^cut_at\(shots\)$/, () => null],
  [/^cut_at\((\d+)\)$/, (r, frame) => Array.isArray(r.cuts) && r.cuts.includes(Number(frame))],
  [/^loudness\(film\) in \[(-?[\d.]+),(-?[\d.]+)\]$/, (r, low, high) => r.loudnessLufs >= Number(low) && r.loudnessLufs <= Number(high)],
  [/^true_peak\(film\) <= (-?[\d.]+)$/, (r, max) => r.truePeakDbtp <= Number(max)],
];
function decide(predicate, reading) {
  for (const [form, check] of BASE) {
    const match = form.exec(predicate);
    if (match) return check(reading, ...match.slice(1));
  }
  throw new Error(`基础谓词 ${predicate} 没有判法`);
}

// 读数先照 JSON 拍一份快照再判：一读就抛的取值器、已撤销的代理、读一回变一回的字段，到这里要么成了普通数据，要么算读不了
function snapshot(reading) {
  try { return JSON.parse(JSON.stringify(reading)); } catch { return undefined; }
}

export function evaluate(question, given) {
  const rules = RULES[question.id];
  if (!rules || rules.length !== question.scoring.length) throw new Error(`题目 ${question.id} 没有和 scoring 对得上的判法`);
  const reading = snapshot(given);
  const invalid = malformed(question, reading);
  const base = question.basePredicates.map((predicate) => ({ predicate, pass: invalid ? false : decide(predicate, reading) }));
  const items = question.scoring.map(({ metric, weight, args }, i) => {
    const { pass, ...detail } = invalid ? { pass: false, invalid } : rules[i](args, reading);
    return { metric, weight, pass, detail };
  });
  const basePass = base.every((item) => item.pass !== false);
  return { score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: basePass && items.every((item) => item.pass), basePass, base, items };
}

// ── 读数提取 ──────────────────────────────────────────────────────────────
// 缺工具时读数函数不抛错，回 { toolMissing: 工具名 }，拿去判分是干净的 0 分；片子本身读不了照旧抛，带工具的诊断
const absent = (tool) => Object.assign(new Error(`机器上没有 ${tool}`), { toolMissing: tool });
const orMissing = (read) => async (...args) => {
  try { return await read(...args); } catch (error) {
    if (!error.toolMissing) throw error;
    return { toolMissing: error.toolMissing };
  }
};
// 观测层的指标缺工具时 value 是 null
async function metric(pending) {
  const got = await pending;
  if (got.value === null) throw absent(got.details.tool);
  return got;
}
function run(tool, args) {
  const child = spawnSync(tool, args, { maxBuffer: Infinity });
  if (child.error?.code === 'ENOENT') throw absent(tool);
  if (child.status !== 0) throw new Error(`${tool}: ${child.error?.message ?? child.stderr}`);
  return child.stdout;
}
const delivered = async (file) => {
  const { width, height, fps, frames } = (await metric(deliverSpec(file))).value;
  return { width, height, fps, frames };
};

// 起音：声轨解成 16 千赫单声道，每 10 毫秒一格算均方根音量的常用对数（满幅是 0，静音压到 -4），比前一格高出 jump 以上就记一个起音，回毫秒
function onsets(file, jump) {
  const bytes = run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolve(file), '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  // 拷一份对齐到 2 字节的再按 16 位读
  const pcm = new Int16Array(new Uint8Array(bytes.subarray(0, bytes.length & ~1)).buffer);
  const found = [];
  let last = -4;
  for (let w = 0; (w + 1) * 160 <= pcm.length; w++) {
    let sum = 0;
    for (let k = w * 160; k < (w + 1) * 160; k++) sum += pcm[k] * pcm[k];
    const level = Math.max(-4, Math.log10(Math.sqrt(sum / 160) / 32768));
    if (level - last > jump) found.push(w * 10);
    last = level;
  }
  return found;
}

// 拍子：相邻起音的间隔里出现最多的当周期，起音对周期取余出现最多的当相位；起音不到两个估不出来，回 null
// shortcut: 只认最常见的起音间隔，切分多的配乐会认成半拍或两拍；真片上认错了就换成自相关估速
function beatOf(onsetsMs) {
  const mode = (values) => {
    const seen = new Map();
    for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
    return [...seen].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  };
  const periodMs = mode(onsetsMs.slice(1).map((ms, i) => ms - onsetsMs[i]));
  return periodMs ? { periodMs, phaseMs: mode(onsetsMs.map((ms) => ms % periodMs)) } : null;
}

// 27-1：交付规格、换镜头帧、响度和真峰值都从成片量
export const read27_1 = orMissing(async (file) => {
  const [spec, cuts, loud] = await Promise.all([delivered(file), metric(cutYdif(file)), metric(audioLoudness(file))]);
  return { ...spec, cuts: cuts.value, loudnessLufs: loud.value, truePeakDbtp: loud.details.truePeakDbtp };
});

// 29-2：点击取事件表（events/0.1）里名字以 click 开头的命名条目，切点从画面量（crop 只看画面的一块），起音从声轨量
export const read29_2 = orMissing(async (file, events, { crop, jump = 0.25 } = {}) => {
  const [spec, cuts] = await Promise.all([delivered(file), metric(cutYdif(file, 24, crop))]);
  const clicks = Array.isArray(events?.events)
    ? events.events.filter((entry) => entry?.kind === 'named' && /^click/.test(entry.id)).map((entry) => entry.frame) : undefined;
  return { ...spec, clicks, cuts: cuts.value, onsetsMs: onsets(file, jump) };
});

// 23-2：章节起点读成片的章节元数据，强起音和拍子从声轨量
export const read23_2 = orMissing(async (file, { jump = 0.35 } = {}) => {
  const spec = await delivered(file);
  const { chapters } = JSON.parse(run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', resolve(file)]));
  const strongOnsetsMs = onsets(file, jump);
  return { ...spec, chaptersMs: chapters.map((chapter) => Math.round(Number(chapter.start_time) * 1000)), beat: beatOf(strongOnsetsMs), strongOnsetsMs };
});

// 30-1：静态扫工程目录。片子描述 film.json（film/3.0）是时间的出处：timeline 是节拍表，events 里写成整数帧的是命名时刻，
// shots 的 in、out 是镜头表；别处把时间键写成数、镜头代码里拿帧变量跟数比或赋成数，都算写死的帧号（第 0 帧不算）。
// 节拍常量的定义数 = film.json 的节拍表（有就算 1）+ 别处再给 bpm、beat* 赋数的次数。
// shortcut: 代码按行用正则认，不解析语法，只扫 JS、TS、Python 源码，film.json 以外的 JSON 不看；字符串里带 //（Python 是 #）的那行后半截会被当注释略过。要更准就换成语法树
const TIME_KEYS = new Set(['in', 'out', 'frame', 'at', 'start', 'end']);
const FRAME_LITERAL = /\b\w*frame\s*(?:[<>]=?|[!=]==?|[:=])\s*[1-9]|\b[1-9]\d*\s*(?:[<>]=?|[!=]==?)\s*\w*frame\b/gi;
const BEAT_DEF = /\b(?:bpm|beat\w*)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:[;,)}\]]|$)/gi;
export function read30_1(root) {
  let film;
  try { film = JSON.parse(readFileSync(join(root, 'film.json'), 'utf8')); } catch { film = null; }
  if (!plain(film)) return { unreadable: 'film.json' };
  const { output, timeline, shots, events, ...rest } = film;
  const found = [];
  let beatConstantDefs = plain(timeline) && [timeline.bpm, timeline.beatFrames].some((v) => Number.isFinite(v) && v > 0) ? 1 : 0;
  const walk = (node, path) => {
    const under = (key) => (path ? `${path}/${key}` : String(key));
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, under(plain(item) && typeof item.id === 'string' ? item.id : i)));
    else if (plain(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value !== 'number') walk(value, under(key));
        else if (TIME_KEYS.has(key) && value !== 0) found.push(`film.json:${under(key)}`);
        else if (/^(?:bpm|beat)/i.test(key)) beatConstantDefs++;
      }
    }
  };
  const rows = (list, ...own) => (Array.isArray(list) ? list.map((row) => (plain(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => !own.includes(key))) : row)) : list);
  walk({ ...rest, shots: rows(shots, 'in', 'out'), events: rows(events, 'frame') }, '');
  const sources = readdirSync(root, { recursive: true }).map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /\.(?:[cm]?[jt]sx?|py)$/.test(file) && !/(?:^|\/)(?:node_modules|out|\.[^/]*)\//.test(file)).sort();
  for (const file of sources) {
    // 块注释删掉但留着换行，行号不变
    const lines = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, '')).split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(file.endsWith('.py') ? /#.*$/ : /\/\/.*$/, '');
      for (let n = code.match(FRAME_LITERAL)?.length ?? 0; n > 0; n--) found.push(`${file}:${i + 1}`);
      beatConstantDefs += code.match(BEAT_DEF)?.length ?? 0;
    });
  }
  const [width, height] = Array.isArray(output?.size) ? output.size : [];
  return { width, height, fps: rate(output?.fps), frames: output?.frames,
    moments: Array.isArray(events) ? events.filter((event) => plain(event) && typeof event.frame === 'number').map(({ id, frame }) => ({ id, frame })) : undefined,
    timeline: { beatConstantDefs, hardcodedFrames: found.length, found } };
}
