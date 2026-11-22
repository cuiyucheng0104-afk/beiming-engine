// B3 二级第一批四道题的判分核验：把题目的基础谓词和 scoring[].args 里的阈值套到一份读数上。
//   evaluate(question, reading) → { score, pass, basePass, base: [{ predicate, pass, status, why, atFrame }], items: [{ metric, weight, pass, detail }] }
//   score 是过了的判分项的权重和；basePass 是基础谓词条条都过；pass 是 basePass 加每个判分项都过，差一项就判不合格。
//   基础谓词这里不另写判法：读数拼成片子描述和成片量测，逐条交给正式谓词核（verify/predicates.mjs 的 evaluateAssertion），它判 pass 才算过。
//   它回 skipped（缺量测）、要对镜头表而读数里没有成形的镜头表，都是没证据，不算过；不过的那条带 why 和反例帧 atFrame。
//   所以读数除了各题自己的表，还要带成片这一头的 colorTag、blackFrames、freezes、cuts 和工程的镜头表 shots。
//   读数不成形（不是 JSON 对象、缺子表、表里有空洞或混进非数、帧率和总帧数跟交付规格不一致）一律 0 分、不合格，原因写在 detail.invalid，不抛错。
//   读数的字段见 beiming/bench/refs/level-2-a/ 的夹具；时刻要么是整数帧，要么是整数毫秒，比较全用整数，不落在浮点误差上。
//   read27_1、read29_2、read23_2 从成片量读数，镜头表取工程的片子描述或事件表；readFilm 只量成片这一头；read30_1 静态扫工程目录，
//   要判基础谓词就把 readFilm 的结果并进去。机器上没有 ffmpeg/ffprobe（read30_1 是没装 eslint）回 { toolMissing }。
// shortcut: 命中率和随机基线（05 第 7.1 节的 metric:beat.onset-hit）观测层还没有，先在这里算；它进了 observe/metrics 就换成调它。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import nodeModule, { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expandEventFrames } from '../../../kernel/eval/events.mjs';
import { audioLoudness, blackFreezeDup, cutYdif, deliverSpec } from '../../../observe/metrics/index.mjs';
import { evaluateAssertion } from '../../../verify/predicates.mjs';

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
// 写死帧号的计数有两个名字，给了哪个算哪个
const hardcoded = (timeline) => [timeline.hardcodedFrames, timeline.hardcodedFrameCount].filter((count) => count !== undefined);
const rate = (fps) => {
  const [num, den] = typeof fps === 'string' ? fps.split('/').map(Number) : [];
  return num / den;
};

// 每道题的读数要长什么样；回空串是成形，否则回哪里不成形
const SHAPES = {
  '27-1': ({ cuts, loudnessLufs, truePeakDbtp }, { frames }) =>
    (ints(cuts, 0, frames) && rising(cuts) ? '' : 'cuts 要是片内严格递增的整数帧')
    || (finite(loudnessLufs, truePeakDbtp) ? '' : 'loudnessLufs、truePeakDbtp 要是有限数'),
  // 点击帧号出自事件表；那张表的 fps、frames 要和交付规格逐字相同（事件契约 EV6），不然帧号说的不是这条片子
  '29-2': ({ clicks, cuts, onsetsMs, eventsFps, eventsFrames }, { fps, frames, durationMs }) =>
    (eventsFps === fps && eventsFrames === frames ? '' : `事件表的 eventsFps、eventsFrames 要和交付规格一致（${fps}、${frames}）`)
    || ([clicks, cuts].every((list) => ints(list, 0, frames) && rising(list)) ? '' : 'clicks、cuts 要是片内严格递增的整数帧')
    || (ints(onsetsMs, 0, durationMs) && rising(onsetsMs) && onsetsMs.length ? '' : 'onsetsMs 要是不空的、片内严格递增的整数毫秒'),
  '23-2': ({ chaptersMs, strongOnsetsMs, beat }, { durationMs }) =>
    (ints(chaptersMs, 0, durationMs) && rising(chaptersMs) ? '' : 'chaptersMs 要是片内严格递增的整数毫秒')
    || (ints(strongOnsetsMs, 0, durationMs) && rising(strongOnsetsMs) && strongOnsetsMs.length ? '' : 'strongOnsetsMs 要是不空的、片内严格递增的整数毫秒')
    || (plain(beat) && ints([beat.periodMs], 1, Infinity) && ints([beat.phaseMs], 0, beat.periodMs) ? '' : 'beat 要有正整数 periodMs 和 [0, periodMs) 里的整数 phaseMs'),
  '30-1': ({ moments, timeline }, { frames }) =>
    (Array.isArray(moments) && Array.from(moments, (m) => plain(m) && typeof m.id === 'string' && m.id !== '' && ints([m.frame], 0, frames)).every(Boolean)
      && new Set(moments.map((m) => m.id)).size === moments.length ? '' : 'moments 每项要有不空、不重复的字符串 id 和片内的整数 frame')
    || (plain(timeline) && ints([timeline.beatConstantDefs], 0, Infinity) && hardcoded(timeline).length && ints(hardcoded(timeline), 0, Infinity)
      ? '' : 'timeline 的 beatConstantDefs、hardcodedFrames（也认 hardcodedFrameCount）要是非负整数')
    || ([timeline.bpm].every((v) => v === undefined || (Number.isFinite(v) && v > 0)) && (timeline.beatFrames === undefined || ints([timeline.beatFrames], 1, Infinity))
      ? '' : 'timeline 的 bpm 要是正数、beatFrames 要是正整数；没有节拍表就两个都不写'),
};

// 判分里帧和毫秒互换、片内范围都按题面的帧率和总帧数算，所以这两项对不上的读数不判，直接算不成形；画幅只在基础谓词里核
function malformed({ id, deliverable }, reading) {
  if (!plain(reading)) return '读数不是对象';
  if (reading.toolMissing) return `量不了：机器上没有 ${reading.toolMissing}`;
  if (reading.unreadable) return `读不了 ${reading.unreadable}`;
  const fps = rate(deliverable.fps), { frames } = deliverable;
  if (reading.fps !== fps || reading.frames !== frames) return `fps、frames 要和交付规格一致（${fps}、${frames}）`;
  return SHAPES[id](reading, { fps: deliverable.fps, frames, durationMs: (frames * 1000) / fps });
}

// 每道题一组判法，次序和题目文件的 scoring 一一对应；进来的读数都过了上面的成形检查
const RULES = {
  '27-1': [
    ({ gridFrames, shotBeats, firstCut }, { cuts, frames }) => {
      const stray = cuts.filter((frame) => frame % gridFrames !== 0);
      // 片尾不足一拍的零头算最后一个镜头的收尾，不计拍数
      const edges = [0, ...cuts, frames - (frames % gridFrames)];
      const beats = edges.slice(1).map((frame, i) => (frame - edges[i]) / gridFrames);
      // 切点表严格递增，cuts[0] 就是第一个换镜头：它前面再切一刀，第 firstCut 帧就不是首切了
      return { pass: cuts.length > 0 && cuts[0] === firstCut && stray.length === 0 && beats.every((n) => shotBeats.includes(n)),
        cuts: cuts.length, firstCut: cuts[0] ?? null, offGrid: stray, beats };
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
    ({ bpm, minCount, tolFrames, minHitRate }, { fps, moments, timeline }) => {
      // 落拍按工程自己那张节拍表算，不拿题面的 BPM 代它；表里写了的 bpm、beatFrames 都要和题面对上，两个都没写就是没有表
      const want = (fps * 60) / bpm;
      const beatFrames = timeline.beatFrames ?? (timeline.bpm === undefined ? null : (fps * 60) / timeline.bpm);
      const asAsked = Number.isInteger(want) && beatFrames === want && (timeline.bpm ?? bpm) === bpm;
      const hit = share(beatFrames === null ? 0 : moments.filter(({ frame }) => offGrid(frame, beatFrames) <= tolFrames).length, moments.length);
      return { pass: asAsked && moments.length >= minCount && hit.hitRate >= minHitRate, ...hit, beatFrames, bpm: timeline.bpm ?? null };
    },
    ({ maxBeatConstantDefs, maxHardcodedFrames }, { timeline }) => {
      // 节拍表得真有：别处的一个节拍常量凑出来的「定义一次」不算
      const table = timeline.bpm !== undefined || timeline.beatFrames !== undefined;
      const { beatConstantDefs } = timeline, hardcodedFrames = Math.max(...hardcoded(timeline));
      return { pass: table && beatConstantDefs >= 1 && beatConstantDefs <= maxBeatConstantDefs && hardcodedFrames <= maxHardcodedFrames,
        table, beatConstantDefs, hardcodedFrames };
    },
  ],
};

// 首尾相接、盖满全片的镜头表
const shotTable = (shots, frames) => Array.isArray(shots) && shots.length > 0 && Array.from(shots, plain).every(Boolean)
  && shots.every((shot, i) => Number.isSafeInteger(shot.out) && shot.in === (i ? shots[i - 1].out : 0) && shot.out > shot.in) && shots.at(-1).out === frames;

// 基础谓词的判法：读数拼成正式谓词核的两份输入（映射照出片链的成片量测），一条一条交给它
function basis({ deliverable: { size, fps, frames } }, reading) {
  const film = { output: { size, fps, frames }, shots: reading.shots };
  // 读数的 fps 是数，成形检查核过它等于交付规格，这里换回正式谓词核要的分数写法
  const measured = { output: { size: [reading.width, reading.height], fps, frames: reading.frames, colorTag: reading.colorTag },
    blackFrames: reading.blackFrames, freezes: reading.freezes, cuts: reading.cuts,
    audio: { loudnessLufs: reading.loudnessLufs, truePeakDbtp: reading.truePeakDbtp } };
  // 片子描述里没有镜头时正式谓词核把「对镜头表」当成没什么可对、判过；这里读数拿不出镜头表就是没证据
  return (predicate) => (/\bshots\b/.test(predicate) && !shotTable(reading.shots, frames)
    ? { status: 'skipped', reason: '读数里没有首尾相接、盖满全片的镜头表 shots' } : evaluateAssertion(predicate, film, measured));
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
  const judge = invalid ? () => ({ status: 'skipped', reason: invalid }) : basis(question, reading);
  const base = question.basePredicates.map((predicate) => {
    const { status, reason, expected, counterexampleFrame } = judge(predicate);
    return { predicate, pass: status === 'pass', status, ...(status === 'pass' ? {} : { why: reason ?? expected, atFrame: counterexampleFrame ?? null }) };
  });
  const items = question.scoring.map(({ metric, weight, args }, i) => {
    const { pass, ...detail } = invalid ? { pass: false, invalid } : rules[i](args, reading);
    return { metric, weight, pass, detail };
  });
  const basePass = base.every((item) => item.pass);
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
// 成片这一头正式谓词核要的量测：画幅、帧率、帧数、色彩标签、黑帧、冻结段（半开区间）、换镜头帧；crop 只看画面的一块认切点
async function filmed(file, crop) {
  const [spec, still, cuts] = await Promise.all([metric(deliverSpec(file)), metric(blackFreezeDup(file)), metric(cutYdif(file, 24, crop))]);
  const { width, height, fps, frames, color_space: colorTag } = spec.value;
  return { width, height, fps, frames, colorTag, blackFrames: still.details.black,
    freezes: still.details.freezes.map(([from, to]) => ({ in: from, out: to + 1 })), cuts: cuts.value };
}
export const readFilm = orMissing((file) => filmed(file));

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

// 27-1：交付量测、换镜头帧、响度和真峰值从成片量；镜头表取工程的片子描述
export const read27_1 = orMissing(async (file, film) => {
  const [seen, loud] = await Promise.all([filmed(file), metric(audioLoudness(file))]);
  return { ...seen, shots: film?.shots, loudnessLufs: loud.value, truePeakDbtp: loud.details.truePeakDbtp };
});

// 29-2：事件表（events/0.1）给点击（名字以 click 开头的命名条目）、镜头表（切点条目就是镜头的交界）和它自己的时间基准；
// 切点从画面量（crop 只看画面的一块），起音从声轨量
export const read29_2 = orMissing(async (file, events, { crop, jump = 0.25 } = {}) => {
  const seen = await filmed(file, crop);
  const at = (keep) => (Array.isArray(events?.events) ? events.events.filter((entry) => plain(entry) && keep(entry)).map((entry) => entry.frame) : []);
  const edges = [0, ...at((entry) => entry.kind === 'cut'), events?.frames];
  return { ...seen, eventsFps: events?.fps, eventsFrames: events?.frames, shots: edges.slice(1).map((out, i) => ({ in: edges[i], out })),
    clicks: at((entry) => entry.kind === 'named' && /^click/.test(entry.id)), onsetsMs: onsets(file, jump) };
});

// 23-2：章节起点读成片的章节元数据，强起音和拍子从声轨量；镜头表取工程的片子描述
export const read23_2 = orMissing(async (file, film, { jump = 0.35 } = {}) => {
  const seen = await filmed(file);
  const { chapters } = JSON.parse(run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', resolve(file)]));
  const strongOnsetsMs = onsets(file, jump);
  return { ...seen, shots: film?.shots, chaptersMs: chapters.map((chapter) => Math.round(Number(chapter.start_time) * 1000)), beat: beatOf(strongOnsetsMs), strongOnsetsMs };
});

// 30-1：静态扫工程目录。片子描述 film.json（film/3.0）是时间的出处：timeline 是节拍表，原样读出它的 bpm、beatFrames；
// events 是命名时刻，照片子描述契约 5.3 展开，event(m01) + 18、cut(180) + 12 这样的算式和整数帧一样算；shots 是镜头表。
// 写死的帧号（第 0 帧不算）有两处来源。片子描述里别处把时间键写成整数（卡参数里相机关键帧的 f、片名入场的 enter 都在内；
// 镜头的出入点、转场的 at、刻意区间契约只许写整数，不算）。镜头代码里认四种写法：
//   帧的线性式跟常数比（数在哪边都算）、switch 帧的线性式里的 case、名字以 frame 结尾的量赋成整数、对象里时间键写成两位以上的整数。
// JS、TS 源码解析成语法树，按词法作用域认哪个量是帧（scanTree），换行、注释、字符串、同名的别的量都不改结论：
//   帧 = 名字以 frame 结尾的量和属性（frame、localFrame、ctx.frame）；叫 f、t 的量和属性；
//     对象和类里的帧回调（render、state、meta、apply、evaluate，写成方法、属性、obj.state = …、点名的函数 state: tick）的第一个形参，
//     叫 i、cursor、ctx 都算；从帧名解构改的名（const { frame: n } = ctx）；
//     没人在文件里调用的函数：自己叫帧回调名字的取第一个形参，形参表是 (ctx, 名字) 的取第二个；
//     文件里有调用点的函数（点名调用，或函数写出来当场调用）：哪个形参是帧，只看调用处传进来的实参，形参叫 ctx 也一样。
//     同一次调用的几个实参配成一组，函数体照每一组各算一遍：ge(frame, at.m01) 和 ge(width, 640) 不会配出 frame >= 640。
//     形参的默认值只在那一次调用没传这一位时才用（没写、写 undefined 或 void 0，隔一层辅助函数原样传下来的也算没传）：
//     ge(frame, at.m01) 和靠默认值 640 的 ge(width) 也配不到一起。函数体里的兜底值（min ?? 640、min || 640、min ??= 640）和默认值一个口径。
//     展开的实参摊平了再按位配：ge(frame, ...[at.m01])、先存成数组再展开（const args = [frame, at.m01]; ge(...args)）和直接写一样是传了这一位，
//     摊出来没有这一位（...[]、数组里的空位）才算没传；剩余形参（...pair）收下剩下的几位，pair[0]、解构、再展开传下去都照这几位认。
//     调用回出来的函数（柯里化 ge(432)(frame)、先存成量 const late = ge(432)、三元挑出来的）带着外层那次调用的实参，和里层这次的实参配成一组。
//     文件里有调用点、文件外也有人调用的函数（导出的、交出去的、帧回调），文件外那次调用另算一组：
//     实参不知道，各位都可能没传，导出的照名字认帧。
//   帧的线性式 = 帧和常数只做加减、乘除常数得来的式子，赋给变量照样跟着走（声明、赋值、形参默认值都算，定义写在用处后面也传得到）；
//     同文件的函数回出来的也跟着走（offset(frame) 回 n - 432 就是 frame - 432），逗号、await 包一层照样算；
//     写成语句块的函数走得到末尾、写了不带值的 return，算它还回一个 undefined（传给带默认值的形参，默认值就生效），每条路都回了值的不算；
//     写在文件里的对象、数组上取一格和直接点名一样（timing.offset(frame)、cfg.min、steps[0]、const { offset } = timing），
//     后来赋上去的属性、展开抄来的对象、工厂回出来的对象都算；
//     三元两支都算得出来就都算，有一支算不出来（命名时刻）时另一支只留带着帧的式子，常数不知道配谁、不算。
//     从对象或数组解构时，只有空槽或显式 undefined 会启用常数默认值。别名和工厂回值保留容器记录及创建环境。
//   比较时折回帧上再看门槛：f - 432 >= 0、f / 24 >= 18、f >= 18 * 24、f >= 0x1b0 都是第 432 帧。门槛两位以上才算（x > 1 这样的
//   归一化比较不算），式子里有名字以 frame 结尾的一位数也算。减去命名时刻（f - at('m02')）、除以总长这样带别的量的式子不是线性式，不算。
// Python 和解析不了的 JS（语法错、Node 抹不掉的 TS 写法）先把注释、字符串抹成空格，再用正则整份文件一起认（hardcodedLines）。
// 节拍常量的定义数 = 节拍表（有就算 1）+ 别处再给 bpm、tempo、beat* 赋数的次数；节拍表在不在看读数里有没有 bpm、beatFrames。
// shortcut: 只扫 JS、TS、Python 源码，film.json 以外的 JSON 不看；只在上面四种写法里认帧号，拿帧做算术不比较的
// （(f - 432) / 216、clamp(f, 432, 648)、f % 24）不认；帧经类的方法、this、回调、摊不开的展开实参（...view.rest，从它起往后当没传）、
// 别的文件传进辅助函数的不跟，内置对象和别的文件的函数回出来的值（Math.max(f, 432)）、第三方函数间接调用回调的实参也不跟。真片上漏了再补规则。
// shortcut: 容器跟踪限于同一文件的字面量与静态键，外部对象、类的实例和 getter 的值未知。会被改写的数组不按固定元组展开。
// 带标号的块、有出口的循环拿不准，算走得到函数末尾；几个互相递归的函数经对象属性回值（i = scan(src, i + 1).end）时环境一圈多一种，
// 靠 spent、LIMIT 收住，六个一环的实测 3 秒。镜头真这么写了再补
// shortcut: 左边算不出来的兜底常数不算（view.start ?? 432 和 at.m02 ?? 0 分不开）；外部配置无法解析时不推测其常数默认值；
// 模块入口只认 ESM 导出，外部调用认名字；已知数组遍历回调按元素处理。a && b 不算；
// 实参写 null、false 不算没值（min ?? 432 配 ge(frame, null)）。镜头真这么写了再补
// shortcut: 实参只在调用之间按组配，函数里面不分先后和分支：一个量先后赋过的几种值都算；值经外面的量带出函数的（since = v - 432）
// 取各调用点的并集，不按组配；多次执行同一工厂调用点时，共用该调用点的对象身份。镜头真这么写了再接数据流分析
// shortcut: 正则那一路不解析语法：帧名按整份文件算、不分作用域，帧回调的第一个形参叫 i、w 这类名字的不认，算术里藏的帧号、
// 十六进制也不认，模板字符串 ${} 里再套花括号、正则字面量里带引号的那一行会认错。Python 镜头多起来就接 Python 的语法树
const TIME_KEYS = ['in', 'out', 'frame', 'at', 'start', 'end', 'f', 'enter', 'exit'];
// 比较号：不是箭头、移位的一半
const CMP = String.raw`(?<![<>=!])(?:[<>]=?|[!=]==?)(?![<>=])`;
const BEAT_DEF = /\b(?:bpm|tempo|beat\w*)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:[;,)}\]]|$)/gim;
// 注释和字符串：JS 的块注释、行注释、模板、两种引号；Python 的三引号、# 注释、行尾续行的反斜杠、两种引号。写成一条正则，谁先开头谁算数
const NOISE = {
  js: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
  py: /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|\\(?=\r?\n)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
};
// 抹成空格、留着换行，行号不变。只有一个词的字符串原样留下（带引号的键）；模板字符串 ${} 里的是代码，留下
const codeOf = (text, py) => text.replace(py ? NOISE.py : NOISE.js, (noise) => (/^(["'])\w+\1$/.test(noise) ? noise
  : noise[0] === '`' ? noise.replace(/(\$\{[^}]*\})|[^\n]/g, (char, kept) => kept ?? ' ') : noise.replace(/[^\n]/g, ' ')));
const FRAME_NAMED = String.raw`[\w$]*[Ff]rame`;
// 叫这些名字的形参是上下文、像素、下标，不当帧
const NOT_FRAME = /^(?:ctx|w|h|x|y|z|i|j|width|height|size|aspect|index|count)$/;
// 整条取值链，末段是 names 里的名字；后面跟着 . [ ( 的是没取完的链，不算
const chain = (names) => String.raw`(?<![\w$.\])])(?:[\w$]+\.)*(?:${names})(?![\w$.\[(])`;
// 帧回调叫这几个名字
const HOOKS = 'render|state|meta|apply|evaluate';
// 对象里点名当帧回调的函数：state: tick
const HOOK_ALIAS = new RegExp(String.raw`\b(?:${HOOKS})\s*:\s*(?!(?:null|undefined|true|false)\b)([A-Za-z_$][\w$]*)\s*[,}]`, 'g');
// 一个量的声明和初值（const 后面逗号连着的也算）。初值到分号、花括号、括号外的逗号为止；
// 换行只在算式没写完时接着读：等号后面、上一行以 + - ( , 结尾、下一行以 + - ) 开头
const DECLARED = /(?:\b(?:const|let|var)\s+|,\s*)([\w$]+)\s*(?::[^=;\n]*)?(?<![<>!=])=(?![=>])\s*((?:[^;{},()\n]|\((?:[^()]|\([^()]*\))*\)|(?<=[-+(,]\s*)\n|\n(?=\s*[-+)]))*)/g;
// 这份代码里哪些名字是帧：固定的几种加帧形参，再加从它们只做加减得来的量（一遍遍认到不再多出来，定义写在用处后面也传得到）
function frameNames(code) {
  const names = new Set(['f', 't']);
  const escaped = (name) => name.replaceAll('$', String.raw`\$`);
  const add = (name) => { if (!NOT_FRAME.test(name)) names.add(escaped(name)); };
  // 帧形参只取帧回调的第一个形参。随手赋给一个名字的箭头函数（const wide = pixels => pixels >= 640）不是帧回调
  const hooks = [HOOKS, ...Array.from(code.matchAll(HOOK_ALIAS), ([, name]) => escaped(name))].join('|');
  const entry = new RegExp(String.raw`(?<![\w$])(?:${hooks})\s*(?:(?:[:=]\s*(?:async\s+)?(?:function\b\s*[\w$]*\s*)?)?\(\s*([\w$]+)[^)]*\)\s*(?:=>|[{:])|[:=]\s*(?:async\s+)?([\w$]+)\s*=>)`, 'g');
  for (const [, first, bare] of code.matchAll(entry)) add(first ?? bare);
  for (const [, name] of code.matchAll(/\(\s*ctx\s*,\s*([\w$]+)/g)) add(name);
  const all = () => [FRAME_NAMED, ...names].join('|');
  for (let known = -1; known !== names.size;) {
    known = names.size;
    const framed = new RegExp(chain(all()));
    for (const [, name, init] of code.matchAll(DECLARED)) if (!/[*/%?<>=!&|]/.test(init) && framed.test(init)) add(name);
  }
  return all();
}
// 一份代码里写死的帧号各在第几行
function hardcodedLines(code) {
  const named = chain(FRAME_NAMED), any = chain(frameNames(code));
  const one = String.raw`[1-9][\d_]*\b(?!\.\d)`, two = String.raw`[1-9][\d_]+\b(?!\.\d)`, left = String.raw`(?<![\w$.])`;
  // 帧表达式放在环视里不吃掉，Python 的 432 <= t < 648 才能两头各认一处
  const literal = new RegExp([
    String.raw`(?<=${named}\s*)${CMP}\s*${one}`, String.raw`${left}${one}\s*${CMP}(?=\s*${named})`,
    String.raw`(?<=${any}\s*)${CMP}\s*${two}`, String.raw`${left}${two}\s*${CMP}(?=\s*${any})`,
    String.raw`${named}\s*[:=]\s*${one}`,
    String.raw`(?<=\bswitch\s*\(\s*${any}\s*\)\s*\{[^}]*)\bcase\s+${one}\s*:`,
    String.raw`(?<=[{,]\s*["']?)(?:${TIME_KEYS.join('|')})["']?\s*:\s*${two}`,
  ].join('|'), 'g');
  return Array.from(code.matchAll(literal), ({ index }) => code.slice(0, index).split('\n').length);
}

// ── JS、TS 源码走语法树 ──
// 解析器 espree 和作用域分析 eslint-scope 用 eslint 自带的（仓库的开发依赖），不另加依赖；头一回扫到 JS 才载入
let toolkit;
function parser() {
  if (!toolkit) {
    let load;
    try { load = createRequire(createRequire(import.meta.url).resolve('eslint/package.json')); } catch { throw absent('eslint'); }
    toolkit = { espree: load('espree'), analyze: load('eslint-scope').analyze };
  }
  return toolkit;
}
// 解析成语法树和作用域表，模块、脚本两种读法都试；带类型标注的让 Node 把类型抹成空格（行号不变）再试。都不行回 null
function parse(text) {
  const { espree, analyze } = parser();
  // 只有语法错算解析不了；作用域分析出错是这里的毛病，照抛，不混成解析不了去走正则
  const tree = (source) => {
    for (const sourceType of ['module', 'script']) {
      let ast;
      // range 是作用域分析要的
      try { ast = espree.parse(source, { ecmaVersion: 'latest', sourceType, loc: true, range: true, ecmaFeatures: { jsx: true } }); } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      return { ast, manager: analyze(ast, { ecmaVersion: espree.latestEcmaVersion, sourceType, childVisitorKeys: espree.VisitorKeys }) };
    }
    return null;
  };
  const plainly = tree(text);
  if (plainly) return plainly;
  // stripTypeScriptTypes 在 Node 22.13 以后才有；没有、或者遇到抹不掉的写法（enum、TSX），都当解析不了
  let typeless;
  try { typeless = nodeModule.stripTypeScriptTypes(text); } catch { return null; }
  return tree(typeless);
}
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const COMPARES = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
const HOOK = new RegExp(`^(?:${HOOKS})$`), BEAT_NAME = /^(?:bpm|tempo|beat\w*)$/i, SLOT = /^(?:Property|MethodDefinition|PropertyDefinition)$/;
// 一棵语法树里写死的帧号各在第几行、给节拍常量赋数有几处
export function scanTree(text) {
  const tree = parse(text);
  if (!tree) return null;
  const { ast, manager } = tree, { VisitorKeys } = parser().espree;
  // visit 的第二个参数是这个节点落在哪个函数里，顶层是 null
  const each = (node, visit, within = null) => {
    visit(node, within);
    const inner = FUNCTIONS.has(node.type) ? node : within;
    for (const key of VisitorKeys[node.type] ?? []) for (const child of [node[key]].flat()) if (child) each(child, visit, inner);
  };
  // 每个标识符落在哪个绑定上，声明处和引用处都记；同名不同作用域是不同的绑定
  const variables = manager.scopes.flatMap((scope) => scope.variables), bound = new Map();
  for (const variable of variables) for (const id of variable.identifiers) bound.set(id, variable);
  for (const scope of manager.scopes) for (const ref of scope.references) if (ref.resolved) bound.set(ref.identifier, ref.resolved);
  // 绑定上的函数（function 声明，或初值是函数的量）、函数归哪个绑定；calls 是文件里对一个函数的直接调用（点名调用，或函数写出来当场调用），
  // inside 是函数和调用点各落在哪个函数里
  const functionsOf = (variable) => (variable?.defs ?? []).map((def) => (def.type === 'FunctionName' ? def.node : def.node.init)).filter((node) => FUNCTIONS.has(node?.type));
  // 具名函数表达式（const late = function inner() {}）归外面那个量，不归它自己的名字
  const owner = new Map(variables.filter((variable) => variable.scope.type !== 'function-expression-name')
    .flatMap((variable) => functionsOf(variable).map((fn) => [fn, variable]))), calls = new Map(), inside = new Map();
  // shortcut: 一个量最多留 LIMIT 种式子、一个函数最多留 LIMIT 个环境、一串派生量或调用最多追 DEEP 层，再多的不看；互相递归的一组函数
  // 记不下结果、每条路都要重走，这样白算过 LIMIT 回（spent）就不再展开。正常的工程到不了，真撞到再放宽
  const LIMIT = 10000, DEEP = 400, NONE = [];
  // 没传的实参、undefined 记成常数 NaN：拿它做算术还是 NaN，跟谁比都不成立，传给下一层照旧是没传。CUT 是递归绕回来的那一支：不添东西，和算不出来（空表）不是一回事
  const VOID = [{ k: 0, c: NaN }], CUT = [], isVoid = (a) => !a.k && Number.isNaN(a.c), sure = (a) => a.k || isVoid(a);
  // 函数各回哪几个式子：箭头函数直接回的那个，或函数体里自己的 return。不带值的 return、走得到函数末尾的，另算回一个 undefined（VOID_NODE），
  // 和三元里写 undefined 一个口径；生成器调用回的是迭代器，不算
  const VOID_NODE = { type: 'UnaryExpression', operator: 'void', argument: { type: 'Literal', value: 0 } };
  // 循环、switch 里有没有跳得出它的 break：这一层不带标号的，或带标号的（跳到哪不追，一律算）；里层函数的不算
  const escapes = (node, nested = false) => {
    if (FUNCTIONS.has(node.type)) return false;
    if (node.type === 'BreakStatement') return !nested || Boolean(node.label);
    const deeper = nested || /^(?:For|ForIn|ForOf|While|DoWhile|Switch)Statement$/.test(node.type);
    return (VisitorKeys[node.type] ?? []).some((key) => [node[key]].flat().some((child) => child && escapes(child, deeper)));
  };
  // 一条语句是不是一定走不到它后面：return、throw，或每条路都这样（if 两支、try 两头、带 default 又没有 break 的 switch、没有出口的死循环）。
  // 拿不准的（带标号的块、普通循环）算走得到
  const ends = (node) => ({
    ReturnStatement: () => true, ThrowStatement: () => true, BlockStatement: () => node.body.some(ends),
    IfStatement: () => ends(node.consequent) && ends(node.alternate),
    TryStatement: () => ends(node.finalizer) || (ends(node.block) && (!node.handler || ends(node.handler.body))),
    SwitchStatement: () => node.cases.some((branch) => !branch.test) && node.cases.at(-1).consequent.some(ends) && !node.cases.some((branch) => branch.consequent.some((part) => escapes(part))),
    WhileStatement: () => node.test.type === 'Literal' && Boolean(node.test.value) && !escapes(node.body),
    DoWhileStatement: () => node.test.type === 'Literal' && Boolean(node.test.value) && !escapes(node.body),
    ForStatement: () => !node.test && !escapes(node.body),
  }[node?.type]?.() ?? false);
  // 属性名写死的才认：点号后面的名字、方括号里的字符串、数、不带 ${} 的模板
  const keyOf = (key, computed) => (key.type === 'Identifier' ? (computed ? null : key.name) : key.type === 'Literal' ? String(key.value)
    : key.type === 'TemplateLiteral' && !key.expressions.length ? key.quasis[0].value.cooked : null);
  // 每个字面量只有一份属性表或元组记录。引用这个记录的值另带创建环境，工厂的两次调用可以有不同的元素值。
  const parents = new Map(), records = new Map(), literalProperties = new Set(), writes = [], sites = [], returns = new Map();
  each(ast, (node, within) => {
    inside.set(node, within);
    for (const key of VisitorKeys[node.type] ?? []) for (const child of [node[key]].flat()) if (child) parents.set(child, node);
    if (node.type === 'ReturnStatement' && within) returns.set(within, [...(returns.get(within) ?? []), node.argument ?? VOID_NODE]);
    if (node.type === 'ObjectExpression') {
      records.set(node, { kind: 'object', node, properties: node.properties, assigned: new Map() });
      for (const prop of node.properties) literalProperties.add(prop);
    }
    if (FUNCTIONS.has(node.type) || /^Class(?:Declaration|Expression)$/.test(node.type)) {
      const methods = node.type.startsWith('Class') ? node.body.body.filter((item) => item.type === 'MethodDefinition') : [];
      const prototype = { type: 'ObjectExpression', properties: methods.filter((item) => !item.static) };
      records.set(prototype, { kind: 'object', node: prototype, properties: prototype.properties, assigned: new Map() });
      records.set(node, { kind: 'object', node, prototype, properties: methods.filter((item) => item.static), assigned: new Map() });
    }
    if (node.type === 'ArrayExpression') records.set(node, { kind: 'array', node, elements: node.elements, mutable: false });
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      sites.push(node);
    }
    const target = { AssignmentExpression: node.left, UpdateExpression: node.argument, UnaryExpression: node.operator === 'delete' && node.argument }[node.type];
    if (target?.type === 'MemberExpression') writes.push({ target, rhs: node.operator === '=' ? node.right : null });
  });
  const falls = new Map();
  const returnsOf = (fn) => {
    if (fn.body.type !== 'BlockStatement') return [fn.body];
    if (!falls.has(fn)) falls.set(fn, fn.generator ? [] : [...(returns.get(fn) ?? []), ...(ends(fn.body) ? [] : [VOID_NODE])]);
    return falls.get(fn);
  };
  // 一个式子的值可能原样取自哪几个子式：三元的两支、?? || && 的两边、逗号的最后一个、await 等的那个、?. 链包着的那个
  const parts = (node) => ({ ConditionalExpression: [node.consequent, node.alternate], LogicalExpression: [node.left, node.right],
    SequenceExpression: node.expressions?.slice(-1), AwaitExpression: [node.argument], ChainExpression: [node.expression] }[node.type]);
  // 一个式子可能是文件里写的哪几个函数、对象、数组：写在原地的、点名的量的初值（const late = ge(432)、const timing = { offset }）、
  // 上面那几种子式、调用回出来的（柯里化、工厂）、对象和数组上取的一格（timing.offset、steps[0]）、解构出来的名字。
  // 函数值和容器记录都带定义处环境，工厂回出来的值带的是外层那次调用的环境；
  // 剩余形参收下的几位记成 { row }。
  // env 给 null 时只认是谁、不算环境。trail 记正在看的节点，绕回来就停；同一个函数走两条路（三元两支出自同一个工厂）各算各的，一共看过 LIMIT 个节点就不再看
  const changedRest = new Set(), inputSites = new Map(), structuralInputs = new Set();
  const fresh = () => ({ on: new Set(), steps: 0 });
  const isShape = (env) => !env || env.shape;
  const isFreeze = (site) => site.callee?.object?.name === 'Object' && !bound.has(site.callee.object) && keyOf(site.callee.property, site.callee.computed) === 'freeze';
  function shapeBinding(fn, site, from, base) {
    const env = new Map(base);
    env.shape = true;
    fn.params.forEach((param, i) => {
      const variable = bound.get(param.left ?? param);
      if (variable) env.set(variable, { input: { node: site.arguments[i] ?? param.right ?? VOID_NODE, env: from } });
    });
    return env;
  }
  const valuesOf = (node, env, trail = fresh()) => {
    if (!node || trail.on.has(node) || trail.steps++ >= LIMIT) return [];
    if (node.type === 'SlotDefault') {
      const { slot, fallback } = node;
      const values = valuesOf(slot.node, slot.env, trail);
      if (slot === missing || values.some((value) => value.absent) || (!isShape(env) && lin(slot.node, slot.env).some(isVoid))) {
        return [...values.filter((value) => !value.absent), ...valuesOf(fallback, env, trail)];
      }
      return values;
    }
    if (node.operator === 'void' || (node.name === 'undefined' && !bound.has(node))) return [{ absent: true }];
    if (FUNCTIONS.has(node.type)) return [{ fn: node, record: records.get(node), env }];
    if (records.has(node)) return [{ record: records.get(node), env }];
    trail.on.add(node);
    const variable = node.type === 'Identifier' && bound.get(node);
    let found;
    if (variable) {
      const entry = env?.get(variable);
      const inputs = entry?.input ? valuesOf(entry.input.node, entry.input.env, trail) : [];
      const slots = [...(isShape(env) && !entry?.input ? inputSites.get(variable) ?? [] : [])];
      if (entry?.fallback) slots.push({ node: entry.fallback, env });
      for (const def of variable.defs) {
        if (def.type === 'Variable') slots.push(...sourcesOf(def, env, trail));
        if (def.type === 'FunctionName' || def.type === 'ClassName') slots.push({ node: def.node, env });
      }
      for (const ref of variable.references) {
        if (!ref.isWrite() || ref.init) continue;
        const projection = projections.get(ref.identifier);
        if (projection && ref.partial) slots.push(...project({ node: projection.input, env }, projection.path, env, trail));
        else if (!projection && !ref.partial) slots.push({ node: ref.writeExpr, env });
      }
      found = [...(entry?.fallback ? inputs.filter((value) => !value.absent) : inputs), ...slots.flatMap((slot) => valuesOf(slot.node, slot.env, trail))];
      if (entry?.rest && !changedRest.has(variable)) found.push({ row: entry.rest });
    } else if (node.type === 'NewExpression') {
      found = valuesOf(node.callee, env, trail).flatMap((value) => valuesOf(value.record?.prototype, value.env, trail));
    } else if (isFreeze(node)) {
      found = valuesOf(node.arguments[0], env, trail);
    } else if (node.type === 'CallExpression') {
      found = closuresOf(node.callee, env, trail).flatMap(({ fn, env: base }) => {
        const bindings = isShape(env) ? [shapeBinding(fn, node, env, base)] : bind(fn, node, env, base, trail);
        const values = bindings.flatMap((made) => returnsOf(fn).flatMap((result) => valuesOf(result, made, trail)));
        return values.map((value) => !value.origin && inside.get(value.record?.node) === fn ? { ...value, origin: node } : value);
      });
    } else if (node.type === 'MemberExpression') {
      const slots = slotsOf(node.object, keyOf(node.property, node.computed), env, trail);
      found = slots.flatMap((slot) => valuesOf(slot.node, slot.env, trail));
    } else found = (parts(node) ?? []).flatMap((part) => valuesOf(part, env, trail));
    trail.on.delete(node);
    return found;
  };
  const closuresOf = (node, env, trail) => valuesOf(node, env, trail).filter((value) => value.fn);
  // 实参表、数组字面量的元素按位排开，每一位记成 { node, env }（在哪个环境里算），空位是 undefined。展开的数组摊平接上，
  // 有几种可能（三元挑的）就排几行，最多 ROWS 行；摊不开的展开从它起往后对不上号，这一行到此为止（cut）。只要前 most 位时排够就停（几万个数的表不整张排）
  const ROWS = 64;
  const rowsOf = (items, env, trail, most = Infinity) => {
    let rows = [[]];
    for (const item of items) {
      if (rows.every((row) => row.cut || row.length >= most)) break;
      if (item?.type === 'SpreadElement') {
        const more = valuesOf(item.argument, env, trail).flatMap((value) => laid(value, trail));
        rows = rows.flatMap((row) => (row.cut ? [row] : more.length ? more.map((tail) => Object.assign([...row, ...tail], { cut: tail.cut })) : [Object.assign(row, { cut: true })])).slice(0, ROWS);
      } else for (const row of rows) if (!row.cut) row.push({ node: item ?? VOID_NODE, env });
    }
    return rows;
  };
  // 一个数组摊成的几行：剩余形参收下的那一行，或字面量的元素排开（展开的是自己时绕回来就停）
  const laid = (value, trail, most) => {
    const { record, env, row } = value;
    if (row) return [row];
    if (record?.kind !== 'array' || record.mutable || trail.on.has(record)) return [];
    trail.on.add(record);
    const rows = rowsOf(record.elements, env, trail, most);
    trail.on.delete(record);
    return rows;
  };
  // 空槽和来源不明的槽必须分开。展开时只有空槽继续向前找；取值时空槽读作 undefined。
  const missing = { node: VOID_NODE }, unknown = { node: null }, externalArg = { node: null };
  const slotsOf = (object, key, env, trail = fresh()) => {
    const values = key === null ? [] : valuesOf(object, env, trail);
    return values.length ? values.flatMap((value) => readSlot(value, key, trail, object)) : [unknown];
  };
  function readSlot(value, key, trail, at) {
    const { record, env } = value;
    if (value.absent || ((value.row || record?.kind === 'array') && !/^\d+$/.test(key))) return [missing];
    if (record?.kind !== 'object') {
      const rows = /^\d+$/.test(key) ? laid(value, trail, Number(key) + 1) : [];
      return rows.length ? rows.map((row) => row[key] ?? (row.cut ? unknown : missing)) : [unknown];
    }
    if (trail.on.has(record)) return [unknown];
    trail.on.add(record);
    let slots = key === 'prototype' && record.prototype ? [{ node: record.prototype, env }] : [missing];
    for (const prop of record.properties) {
      if (prop.type === 'SpreadElement') {
        const copied = prop.argument.type === 'Literal' && prop.argument.value === null ? [missing] : slotsOf(prop.argument, key, env, trail);
        slots = copied.includes(missing) ? [...copied.filter((slot) => slot !== missing), ...slots] : copied;
      } else if (keyOf(prop.key, prop.computed) === key) slots = [prop.kind === 'init' || prop.kind === 'method' ? { node: prop.value, env } : unknown];
      else if (keyOf(prop.key, prop.computed) === null) slots.push(unknown);
    }
    for (const write of record.assigned.get(key) ?? []) {
      if (write.origin && write.origin !== value.origin) continue;
      if (at && inside.get(at) === inside.get(write.target) && at.start < write.target.end) continue;
      if (!write.conditional) slots = [];
      slots.push({ node: write.rhs, env });
    }
    trail.on.delete(record);
    return slots;
  }
  // 声明、再赋值、形参使用同一份解构路径，默认值在它所在的层级读取。
  const projections = new Map(), parameters = new Map();
  function patternPaths(pattern, path = [], entries = []) {
    if (pattern?.type === 'Identifier') entries.push({ id: pattern, path });
    else if (pattern?.type === 'AssignmentPattern') patternPaths(pattern.left, [...path, pattern.right], entries);
    else if (pattern?.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        const key = prop.type === 'Property' ? keyOf(prop.key, prop.computed) : null;
        if (key !== null) patternPaths(prop.value, [...path, key], entries);
      }
    } else if (pattern?.type === 'ArrayPattern') pattern.elements.forEach((item, i) => patternPaths(item, [...path, String(i)], entries));
    return entries;
  }
  each(ast, (node) => {
    if (FUNCTIONS.has(node.type)) for (const param of node.params) {
      if (/^(?:Object|Array)Pattern$/.test((param.left ?? param).type)) parameters.set(param, patternPaths(param));
    }
    const pattern = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' && node.left;
    if (/^(?:Object|Array)Pattern$/.test(pattern?.type)) {
      for (const { id, path } of patternPaths(pattern)) projections.set(id, { path, input: node.init ?? node.right });
    }
  });
  const project = (slot, path, env, trail) => path.reduce((slots, step) => typeof step === 'string'
    ? slots.flatMap((one) => one === externalArg ? [externalArg, missing] : slotsOf(one.node, step, one.env, trail))
    : slots.map((one) => one === externalArg ? one : { node: { type: 'SlotDefault', slot: one, fallback: step }, env }), [slot]);
  const sourcesOf = (def, env, trail = fresh()) => project({ node: def.node.init, env }, projections.get(def.name)?.path ?? [], env, trail);
  // 把赋值连到接收对象上。左边可能经过另一次赋值（如 api.group.check = fn），直到没有新的属性边为止。
  let changed;
  do {
    changed = false;
    for (const write of writes) {
      const { target, rhs } = write;
      const key = keyOf(target.property, target.computed);
      for (const { record, origin } of valuesOf(target.object, null)) {
        if (record?.kind === 'array') record.mutable = true;
        if (record?.kind !== 'object' || !rhs || key === null) continue;
        if (!record.assigned.has(key)) record.assigned.set(key, []);
        const entries = record.assigned.get(key);
        if (entries.some((entry) => entry.target === target && entry.origin === origin)) continue;
        let conditional = false;
        for (let outer = parents.get(target); outer && !FUNCTIONS.has(outer.type); outer = parents.get(outer)) {
          if (/^(?:If|For|While|DoWhile|Switch|Try)|^(?:Conditional|Logical)Expression$/.test(outer.type)) conditional = true;
        }
        entries.push({ ...write, origin, conditional });
        entries.sort((a, b) => a.target.start - b.target.start);
        changed = true;
      }
    }
  } while (changed);
  // 枚举导出对象的可见键，再按普通读取的覆盖顺序取值，避免沿已被覆盖的属性走出去。
  function keysOf(record, seen = new Set()) {
    if (seen.has(record)) return [];
    seen.add(record);
    const keys = [...record.assigned.keys()];
    if (record.prototype) keys.push('prototype');
    for (const prop of record.properties) {
      if (prop.type === 'SpreadElement') {
        for (const value of valuesOf(prop.argument, null)) if (value.record?.kind === 'object') keys.push(...keysOf(value.record, seen));
      } else keys.push(keyOf(prop.key, prop.computed));
    }
    return new Set(keys.filter((key) => key !== null));
  }
  // 从外部入口沿返回值、属性和元素走闭包。入队的是同一份记录，环上的对象和函数各走一次。
  const memberEntries = new Set();
  function reachableFrom(roots, mayMutate = false, rootEnv = null, observe) {
    const found = new Set(), seen = new Map(), todo = roots.map((node) => ({ node, env: rootEnv }));
    while (todo.length) {
      const { node, env, member } = todo.pop();
      for (const value of valuesOf(node, env)) {
        const { fn, record, origin } = value;
        if (member && fn && !mayMutate) memberEntries.add(fn);
        if (!record) continue;
        if (fn) observe?.(fn, value.env);
        if (!seen.has(record)) seen.set(record, new Set());
        if (seen.get(record).has(origin)) continue;
        seen.get(record).add(origin);
        if (fn) {
          found.add(fn);
          const bodyEnv = isShape(value.env) ? value.env : bind(fn, null, value.env, value.env)[0];
          for (const result of returnsOf(fn)) todo.push({ node: result, env: bodyEnv });
        }
        if (record.kind === 'array') {
          if (mayMutate) record.mutable = true;
          for (const item of record.elements) if (item) todo.push({ node: item.type === 'SpreadElement' ? item.argument : item, env: value.env, member: true });
        } else for (const key of keysOf(record)) {
          for (const slot of readSlot(value, key, fresh())) todo.push({ ...slot, member: true });
        }
      }
    }
    return found;
  }
  const exportRoots = ast.body.filter((node) => /^Export(?:Named|Default)Declaration$/.test(node.type)).flatMap((node) => {
    const decl = node.declaration;
    if (decl?.type === 'VariableDeclaration') return manager.getDeclaredVariables(decl).flatMap((variable) => variable.identifiers);
    return [decl, ...(node.source ? [] : (node.specifiers ?? []).map((specifier) => specifier.local))];
  });
  const exportedReachable = reachableFrom(exportRoots), executable = new Set([null, ...exportedReachable]);
  const elementCallbacks = new Set(), externalCallbacks = new Set();
  // 只从实际可执行的调用点交出回调。每次新发现一个外部入口，它自己调用的局部函数也随之可达。
  // 高阶函数里的调用目标也可能来自另一个调用点；每条实参边只登记一次。
  const pending = new Map(sites.map((site) => [site, new Set()]));
  do {
    changed = false;
    for (const [site, called] of pending) {
      for (const { fn } of closuresOf(site.callee, null)) {
        if (called.has(fn)) continue;
        called.add(fn);
        calls.set(fn, [...(calls.get(fn) ?? []), site]);
        for (const row of rowsOf(site.arguments, null, fresh())) fn.params.forEach((param, i) => {
          const variable = bound.get(param.left ?? param);
          if (!variable || !row[i]) return;
          if (!inputSites.has(variable)) inputSites.set(variable, []);
          inputSites.get(variable).push(row[i]);
        });
        changed = true;
      }
    }
  } while (changed);
  for (const slots of inputSites.values()) for (const slot of slots) {
    if (valuesOf(slot.node, slot.env).some((value) => value.record)) structuralInputs.add(slot.node);
  }
  do {
    changed = false;
    for (const [site, called] of pending) {
      if (!executable.has(inside.get(site))) continue;
      pending.delete(site);
      changed = true;
      for (const fn of called) executable.add(fn);
      if (called.size || isFreeze(site)) continue;
      const member = site.callee.type === 'MemberExpression' && site.callee;
      const method = member && keyOf(member.property, member.computed);
      const elements = /^(?:some|every|map|filter|forEach|find|findIndex|findLast|findLastIndex|reduce|reduceRight|flatMap|sort|toSorted)$/.test(method);
      const arrayFrom = method === 'from' && member.object.name === 'Array' && !bound.has(member.object);
      if (member && (!elements || method === 'sort') && !arrayFrom && !/^\d+$/.test(method)) {
        if (bound.has(member.object)) changedRest.add(bound.get(member.object));
        for (const { record } of valuesOf(member.object, null)) if (record?.kind === 'array') record.mutable = true;
      }
      const callbackIndex = elements ? 0 : arrayFrom ? 1 : -1;
      const args = rowsOf(site.arguments, null, fresh()).flatMap((row) => (callbackIndex < 0 ? row : row.slice(callbackIndex, callbackIndex + 1)).map((slot) => slot.node));
      for (const fn of reachableFrom(args, true)) {
        (callbackIndex < 0 ? externalCallbacks : elementCallbacks).add(fn);
        executable.add(fn);
      }
    }
  } while (changed);
  const stepped = new Map();
  each(ast, (node) => {
    // n ??= 432、n ||= 432 记成 n ?? 432、n || 432
    if (node.type === 'AssignmentExpression' && node.operator !== '=') {
      const operator = node.operator.slice(0, -1);
      stepped.set(node.left, { type: /^(?:\?\?|\|\||&&)$/.test(operator) ? 'LogicalExpression' : 'BinaryExpression', operator, left: node.left, right: node.right });
    }
  });
  // 「名字、值」的几种写法：声明、赋值、形参默认值、对象和类里的属性与方法
  const pair = (node) => (node.type === 'VariableDeclarator' ? [node.id, node.init]
    : (node.type === 'AssignmentExpression' && node.operator === '=') || node.type === 'AssignmentPattern' ? [node.left, node.right]
      : SLOT.test(node.type) && !node.computed ? [node.key, node.value] : []);
  const nameOf = (node) => (/^(?:Private)?Identifier$/.test(node?.type) ? node.name : node?.type === 'MemberExpression' && !node.computed ? node.property.name
    : node?.type === 'Literal' && typeof node.value === 'string' ? node.value : '');
  // 帧的线性式记成 帧 × k + c，named 是式子里有名字以 frame 结尾的；k 是 0 的是常数。一个量可能取到的几种式子都留着，
  // 局部常量（const delay = 432）和直接写数一样算
  const gather = (forms, into = new Map()) => {
    for (const a of forms) if (into.size < LIMIT) into.set(`${a.k}:${a.c}:${Boolean(a.named)}`, a);
    return into;
  };
  const byName = (name) => (/[Ff]rame$/.test(name) ? [{ k: 1, c: 0, named: true }] : /^[ft]$/.test(name) ? [{ k: 1, c: 0 }] : NONE);
  const scaled = (a, by) => ({ ...a, k: a.k * by, c: a.c * by });
  // seeds 是不看别处就认成帧的绑定，paramOf 是有调用点的函数的形参各归哪个函数。认不认帧都不看绑定自己叫什么，叫 ctx 的也一样。
  // outside 是文件里有调用点、文件外也有人调用的函数（导出的、交出去的、帧回调）：文件外那次调用另算一个环境；
  // defaults 是形参默认值里的那个形参名
  const seeds = new Map(), paramOf = new Map(), outside = new Set(), defaults = new Set();
  const seed = (param, forms = [{ k: 1, c: 0 }]) => {
    const variable = bound.get(param?.type === 'AssignmentPattern' ? param.left : param);
    if (variable) seeds.set(variable, gather(forms, seeds.get(variable)));
  };
  each(ast, (node) => {
    const named = owner.get(node);
    if (FUNCTIONS.has(node.type)) {
      const called = calls.has(node), external = exportedReachable.has(node) || externalCallbacks.has(node), [first, second] = node.params;
      for (const param of node.params) {
        if (parameters.has(param)) {
          for (const { id } of parameters.get(param)) {
            defaults.add(id);
            if (called) paramOf.set(bound.get(id), node);
          }
        } else if (param.type === 'AssignmentPattern') defaults.add(param.left);
        // 有调用点的函数，形参是什么看传进来的实参（contextsOf）
        if (called && bound.has(param.left ?? param)) paramOf.set(bound.get(param.left ?? param), node);
      }
      if (external && (!elementCallbacks.has(node) || memberEntries.has(node) || externalCallbacks.has(node))) {
        for (const param of node.params) seed(param, byName(nameOf(param.left ?? param)));
        if (first?.type === 'Identifier' && first.name === 'ctx' && second?.type === 'Identifier' && !NOT_FRAME.test(second.name)) seed(second);
      }
      // 自己叫帧回调名字的函数取第一个形参
      if (HOOK.test(named?.name ?? '') && (!called || external)) seed(first);
      if (external || elementCallbacks.has(node)) outside.add(node);
    }
    // 对象、类里的帧回调（方法、属性、obj.state = …），值是函数或点名的函数：第一个形参就是帧
    const [key, value] = pair(node);
    if ((SLOT.test(node.type) || key?.type === 'MemberExpression') && HOOK.test(nameOf(key))) {
      for (const fn of FUNCTIONS.has(value?.type) ? [value] : functionsOf(bound.get(value))) {
        seed(fn.params[0]);
        outside.add(fn);
      }
    }
    // 从帧名解构改的名：const { frame: n } = ctx
    if (node.type === 'ObjectPattern') {
      for (const prop of node.properties) if (prop.type === 'Property' && !prop.computed) seed(prop.value, byName(nameOf(prop.key)));
    }
  });
  // 环境 = 一次调用里各形参收到的线性式（绑定 → 式子表）。函数体照它的每个环境各算一遍，同一次调用的几个实参这才配成一组：
  // ge(frame, at.m01) 和 ge(width, 640) 是两个环境，这处的帧配不上那处的 640。没有调用点的函数用外层函数的环境，顶层是空环境
  const NO_ENV = new Map(), TOP = [NO_ENV], ids = new Map(variables.map((variable, i) => [variable, i]));
  const contexts = new Map(), open = new Map(), states = new WeakMap(), loops = new Set();
  // envs 让内容相同的环境共用一份，算过的不重算；sights 是每个函数看得见的作用域；results、running 是函数的返回值算过的和正在算的
  const envs = new Map([['', NO_ENV]]), sights = new Map(), results = new Map(), running = new Map();
  const digging = new Set(), unpacking = new Map();
  let depth = 0, spent = 0, dug = 0;
  // 一次调用的环境：base（函数定义处的环境）里这个函数看得见的外层形参原样带进来，闭包里用的是外层那一次调用的实参；
  // 形参各收到这次的实参，没传的记成 VOID，可能没传的那一位才换成默认值（默认值里看得见前面的形参）。实参先摊平成行（rowsOf）再按位配：
  // 展开的数组摊得开就和直接写一样，摊出几行就回几个环境；摊不开的展开后面的几位对不上号，当没传。剩余形参收下这一行剩下的几位（不是线性式，
  // 记在 rest 上，按下标取、解构、再展开时照这几位认）。site 给 null 是文件外的那次调用：实参不知道，照名字认的种子算数，各位都可能没传
  const tags = new WeakMap();
  let tagged = 0;
  const tag = (slot) => `${slot.node.range ?? 'void'}@${tags.get(slot.env) ?? tags.set(slot.env, ++tagged).get(slot.env)}`;
  function bind(fn, site, from, base, trail) {
    if (!sights.has(fn)) {
      const visible = new Set();
      for (let scope = manager.acquire(fn); scope; scope = scope.upper) visible.add(scope);
      sights.set(fn, visible);
    }
    const kept = [...base].filter(([variable]) => sights.get(fn).has(variable.scope));
    return (site ? rowsOf(site.arguments, from, trail ?? fresh()) : [[]]).map((row) => {
      const env = new Map(kept);
      fn.params.forEach((param, i) => {
        if (parameters.has(param)) {
          for (const { id, path } of parameters.get(param)) {
            const scope = new Map(env);
            const slots = project(row[i] ?? missing, path, scope, trail ?? fresh());
            if (!site) slots.push(...project(externalArg, path, scope, trail ?? fresh()));
            env.set(bound.get(id), [...gather(slots.flatMap((slot) => lin(slot.node, slot.env))).values()]);
          }
          return;
        }
        const rest = param.type === 'RestElement', variable = bound.get(rest ? param.argument : param.left ?? param);
        if (!variable) return;
        const given = rest ? Object.assign([], { rest: Object.assign(row.slice(i), { cut: row.cut }) })
          : row[i] ? lin(row[i].node, row[i].env) : [...(site ? NONE : seeds.get(variable)?.values() ?? NONE), ...VOID];
        // 默认值在环境的抄本里算：这时后面的形参还没绑上，算到一半的不留在环境的账上
        const fallback = param.right && given.some(isVoid) ? param.right : null;
        const forms = fallback ? [...given.filter((a) => !isVoid(a)), ...lin(fallback, new Map(env))] : given;
        const entry = rest ? given : [...gather(forms).values()];
        if (fallback) entry.fallback = fallback;
        if (!rest && structuralInputs.has(row[i]?.node)) entry.input = row[i];
        env.set(variable, entry);
      });
      const key = Array.from(env, ([variable, forms]) => `${ids.get(variable)}=${forms.rest ? `[${forms.rest.map(tag)}]${forms.rest.cut ? '?' : ''}` : [...gather(forms).keys()].sort()}${forms.input ? `@${tag(forms.input)}` : ''}${forms.fallback ? '?' : ''}`).sort().join(';');
      if (!envs.has(key)) envs.set(key, env);
      return envs.get(key);
    });
  }
  const exportBases = new Map();
  const contextsOf = (fn) => {
    if (!fn) return TOP;
    const sites = calls.get(fn);
    if (!sites && !outside.has(fn)) return contextsOf(inside.get(fn));
    const known = contexts.get(fn) ?? open.get(fn);
    if (known) {
      if (open.has(fn)) loops.add(fn);
      return known;
    }
    // 白算的回数用完以后，绕在圈里的不再往下算；圈外不相干的函数照常
    if (depth >= DEEP || (spent >= LIMIT && open.size)) return TOP;
    const found = new Set();
    depth++;
    // 递归的调用点拿上一遍算出的环境，展开一层就停，所以调用点谁先谁后不改结论；没人绕回来就只算一遍
    for (let pass = 0; pass < 2 && (!pass || loops.has(fn)); pass++) {
      open.set(fn, [...found]);
      for (const site of sites ?? []) {
        for (const from of contextsOf(inside.get(site))) {
          for (const { fn: made, env: base } of closuresOf(site.callee, from)) if (made === fn) for (const env of bind(fn, site, from, base)) if (found.size < LIMIT) found.add(env);
        }
      }
      if (outside.has(fn)) for (const from of exportBases.get(fn) ?? contextsOf(inside.get(fn))) found.add(bind(fn, null, from, from)[0]);
    }
    const all = found.size ? [...found] : TOP;
    depth--;
    open.delete(fn);
    loops.delete(fn);
    if (!loops.size) contexts.set(fn, all);
    else spent++;
    return all;
  };
  // 一个函数在一个环境里回的线性式。递归绕回自己时里面那一层照算，再绕回来的那一支回 CUT，展开一层就停；这时算到一半的不记
  const returned = (fn, env) => {
    const known = results.get(fn)?.get(env);
    if (known) return known;
    const outer = running.get(fn);
    if (outer?.again) {
      loops.add(outer);
      return CUT;
    }
    if (spent >= LIMIT && running.size) return NONE;
    if (outer) outer.again = true;
    else running.set(fn, {});
    const all = returnsOf(fn).map((result) => lin(result, env)), forms = all.length && all.every((made) => made === CUT) ? CUT : [...gather(all.flat()).values()];
    if (outer) outer.again = false;
    else {
      loops.delete(running.get(fn));
      running.delete(fn);
    }
    if (!loops.size) results.set(fn, (results.get(fn) ?? new Map()).set(env, forms));
    else spent++;
    return forms;
  };
  // 一个绑定在一个环境里可能取到的线性式：种子，加赋进来的值（解构、for-of 这样只拿到一部分的不算），加这个环境给它的实参；
  // 环境里没有的形参（值经外面的量带出函数：since = v - 432）取它各调用点的并集。用到才算，算完记下，定义写在用处后面也一样。
  // 绕回自己（n = n - 432、递归）时只拿已经算出的那几种，展开一层就停；这时算到一半的别的量不记，等绕完了重算
  const formsOf = (variable, env) => {
    if (!states.has(env)) states.set(env, { settled: new Map(), busy: new Map() });
    const { settled, busy } = states.get(env), known = settled.get(variable) ?? busy.get(variable);
    if (known) {
      if (busy.has(variable)) loops.add(known);
      return [...known.values()];
    }
    if (depth >= DEEP) return NONE;
    // 环境里有的形参只看这次调用给的：照名字认的种子归文件外那次调用的环境（bind）
    const forms = gather(env.has(variable) ? NONE : seeds.get(variable)?.values() ?? NONE);
    busy.set(variable, forms);
    depth++;
    // 实参先于函数体里的赋值：x = x - 432 绕回来时拿得到传进来的那个帧
    gather(env.get(variable) ?? contextsOf(paramOf.get(variable)).flatMap((other) => other.get(variable) ?? NONE), forms);
    // 环境里有的形参，默认值用没用上那次调用已经定了（bind），这里不再并进来
    const destructured = new Map();
    for (const ref of variable.references) {
      if (!ref.isWrite()) continue;
      const projection = projections.get(ref.identifier);
      if (projection) { destructured.set(ref.identifier, projection); continue; }
      if (!ref.partial && !(defaults.has(ref.identifier) && env.has(variable))) gather(lin(stepped.get(ref.identifier) ?? ref.writeExpr, env), forms);
    }
    // 从文件里写的对象、数组解构出来的量（const { min } = cfg、const [d] = [frame - 432]）取那一格的式子
    // 递归的函数回对象、调用处解构（const { end } = read(src, i + 1); i = end）每绕一圈是一个新环境，和 returned 一个口径：里面那一层照算，
    // 再绕回来的那一支不添东西（不然循环下标一路累加到几百，被当成写死的数）
    for (const [id, { input, path }] of destructured) {
      const outer = unpacking.get(id);
      if (outer?.again) { loops.add(outer.forms); continue; }
      if (outer) outer.again = true;
      else unpacking.set(id, { forms });
      for (const slot of project({ node: input, env }, path, env, fresh())) gather(lin(slot.node, slot.env), forms);
      if (outer) outer.again = false;
      else unpacking.delete(id);
    }
    depth--;
    busy.delete(variable);
    loops.delete(forms);
    if (!loops.size) settled.set(variable, forms);
    return [...forms.values()];
  };
  // 一个式子在一个环境里可能取到的几种线性式；算不成线性式的回空表
  function lin(node, env) {
    if (node?.type === 'Literal') return typeof node.value === 'number' ? [{ k: 0, c: node.value }] : NONE;
    if (node?.type === 'ChainExpression') return lin(node.expression, env);
    if (node?.type === 'AwaitExpression') return lin(node.argument, env);
    if (node?.type === 'Identifier') {
      if (node.name === 'undefined' && !bound.has(node)) return VOID;
      // 落在文件里某个绑定上的名字，是不是帧看这个绑定；f、t 这样的短名只在没有绑定时照拼写认，名字以 frame 结尾的没收到帧也照旧是帧
      const variable = bound.get(node), forms = variable ? formsOf(variable, env) : NONE;
      return forms.some((a) => a.k) || (variable && !/[Ff]rame$/.test(node.name)) ? forms : [...byName(node.name), ...forms];
    }
    // 文件里写的对象、数组上取一格，照那一格的式子算（cfg.min 是 432、box[0] 是 frame - 432）；属性名是帧的照旧也算帧。
    // 一格的式子里又取别的格，层层套着算过 LIMIT 回（dug）就只照名字认
    if (node?.type === 'MemberExpression') {
      const named = node.computed ? NONE : byName(node.property.name);
      if (depth >= DEEP || digging.has(node) || (digging.size && dug++ >= LIMIT)) return named;
      digging.add(node);
      depth++;
      const forms = slotsOf(node.object, keyOf(node.property, node.computed), env).flatMap((slot) => lin(slot.node, slot.env));
      depth--;
      digging.delete(node);
      return forms.length ? [...gather([...named, ...forms]).values()] : named;
    }
    if (node?.type === 'UnaryExpression') {
      const sign = { '+': 1, '-': -1 }[node.operator];
      const inner = sign ? lin(node.argument, env) : NONE;
      return inner === CUT ? CUT : sign ? inner.map((a) => scaled(a, sign)) : node.operator === 'void' ? VOID : NONE;
    }
    if (node?.type === 'SequenceExpression') return lin(node.expressions.at(-1), env);
    // 三元：两支都算得出来才并起来。有一支算不出来（比如命名时刻），另一支里的常数就不知道是配谁的（px ? 640 : min、ready ? at.m02 : 0），
    // 只留带着帧的式子和「可能没传」；递归绕回来的那一支不添东西
    if (node?.type === 'ConditionalExpression') {
      const [a, b] = [lin(node.consequent, env), lin(node.alternate, env)];
      return a === CUT ? b : b === CUT ? a : a.length && b.length ? [...gather([...a, ...b]).values()] : [...a, ...b].filter(sure);
    }
    // a ?? b、a || b：a 可能没值（没传；|| 还算上 0）才轮到 b，和形参默认值一个口径；a 算不出来时 b 里的常数也不知道用没用上
    // （at.m02 ?? 0），只留带着帧的式子。&& 不算
    if (node?.type === 'SlotDefault' || node?.type === 'LogicalExpression') {
      if (node.operator === '&&') return NONE;
      const left = node.slot ? lin(node.slot.node, node.slot.env) : lin(node.left, env);
      const right = () => lin(node.fallback ?? node.right, env);
      const empty = (a) => isVoid(a) || (node.operator === '||' && !a.k && !a.c);
      if (left === CUT || !left.some(empty)) return left.length ? left : right().filter(sure);
      return [...gather([...left.filter((a) => !empty(a)), ...right()]).values()];
    }
    // 调用文件里的函数：实参绑成这一次调用的环境，取函数在这个环境里回的式子
    if (node?.type === 'CallExpression') {
      // 解析实参会经 valuesOf → bind 再次遇到同一个调用，返回值递归则由 returned 按环境展开。
      if (digging.has(node)) return CUT;
      if (depth >= DEEP) return NONE;
      depth++;
      digging.add(node);
      const targets = closuresOf(node.callee, env).flatMap(({ fn, env: base }) => bind(fn, node, env, base).map((made) => ({ fn, made })));
      digging.delete(node);
      const all = targets.map(({ fn, made }) => returned(fn, made));
      depth--;
      return all.length && all.every((forms) => forms === CUT) ? CUT : [...gather(all.flat()).values()];
    }
    if (node?.type !== 'BinaryExpression') return NONE;
    const sign = { '+': 1, '-': -1 }[node.operator], left = lin(node.left, env), right = lin(node.right, env), mixed = new Map();
    // 递归绕回来的那一支参与的算式，也是不添东西
    if (left === CUT || right === CUT) return CUT;
    for (const a of left) {
      if (mixed.size >= LIMIT) break;
      gather(right.map((b) => {
        if (sign) return { k: a.k + sign * b.k, c: a.c + sign * b.c, named: a.named || b.named };
        if (node.operator === '*' && !(a.k && b.k)) return scaled(a.k ? a : b, a.k ? b.c : a.c);
        return node.operator === '/' && !b.k && b.c ? scaled(a, 1 / b.c) : null;
      }).filter(Boolean), mixed);
    }
    return [...mixed.values()];
  }
  reachableFrom(exportRoots, false, NO_ENV, (fn, base) => {
    if (!exportBases.has(fn)) exportBases.set(fn, new Set());
    exportBases.get(fn).add(base);
  });
  contexts.clear();
  const lines = [];
  let beatDefs = 0;
  // 帧的线性式跟常数比，折回帧上的门槛够不够大；一边有几种式子时，有一对够就算
  const past = (moving, fixed, least) => moving.some((a) => a.k && fixed.some((b) => !b.k && (b.c - a.c) / a.k >= (least ?? (a.named ? 1 : 10))));
  each(ast, (node, within) => {
    // 两边在同一个环境里算了再比；所在函数有几个环境，有一个认出来就算这一处
    const envs = contextsOf(within), some = (test) => envs.some(test);
    if (node.type === 'BinaryExpression' && COMPARES.has(node.operator)) {
      const hit = (env) => {
        const left = lin(node.left, env), right = lin(node.right, env);
        return past(left, right) || past(right, left);
      };
      if (some(hit)) lines.push(node.loc.start.line);
    } else if (node.type === 'SwitchStatement') {
      for (const branch of node.cases) if (some((env) => past(lin(node.discriminant, env), lin(branch.test, env), 1))) lines.push(branch.loc.start.line);
    } else {
      // 每个「名字、值」都照写的先后算一遍并记下，一长串派生量（v1 = v0 + 1、v2 = v1 + 1……）这样才不用从末尾一路追回头
      const [key, value] = pair(node), name = nameOf(key), fixed = envs.map((env) => lin(value, env).filter((a) => !isVoid(a))).filter((forms) => forms.length && !forms.some((a) => a.k));
      if (!fixed.length) return;
      // 节拍常量只数直接写数的定义：从别的常量算出来的量（beatSeconds = 60 / BPM）不是另一处定义
      let literal = BEAT_NAME.test(name);
      if (literal) each(value, (part) => { literal &&= part.type !== 'Identifier'; });
      if (literal) beatDefs++;
      // 解构只读时间键，写在对象字面量里的时间键才计数。
      const least = /[Ff]rame$/.test(name) ? 1 : literalProperties.has(node) && TIME_KEYS.includes(name) ? 10 : Infinity;
      if (fixed.some((forms) => forms.some((a) => Number.isInteger(a.c) && a.c >= least))) lines.push(node.loc.start.line);
    }
  });
  return { lines: lines.sort((a, b) => a - b), beatDefs };
}
// 抹掉注释和字符串的源码用正则认：Python，和解析不了的 JS
const scanText = (code) => ({ lines: hardcodedLines(code), beatDefs: code.match(BEAT_DEF)?.length ?? 0 });

export function read30_1(root) {
  let film, frameOf;
  try { film = JSON.parse(readFileSync(join(root, 'film.json'), 'utf8')); } catch { film = null; }
  if (!plain(film)) return { unreadable: 'film.json' };
  // 镜头表不首尾相接、算式引用了没定义的事件或者成环，求值核都拒收，这个工程就读不了
  try { frameOf = expandEventFrames(film); } catch (error) { return { unreadable: `film.json（${error.message}）` }; }
  const { output, timeline, shots, transitions, events, ...rest } = film;
  const table = Object.fromEntries(['bpm', 'beatFrames'].filter((key) => plain(timeline) && Number.isFinite(timeline[key]) && timeline[key] > 0).map((key) => [key, timeline[key]]));
  const found = [];
  let beatConstantDefs = Object.keys(table).length ? 1 : 0;
  const walk = (node, path) => {
    const under = (key) => (path ? `${path}/${key}` : String(key));
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, under(plain(item) && typeof (item.id ?? item.as) === 'string' ? item.id ?? item.as : i)));
    else if (plain(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value !== 'number') walk(value, under(key));
        else if (TIME_KEYS.includes(key) && Number.isInteger(value) && value !== 0) found.push(`film.json:${under(key)}`);
        else if (/^(?:bpm|tempo|beat)/i.test(key)) beatConstantDefs++;
      }
    }
  };
  const rows = (list, ...own) => (Array.isArray(list) ? list.map((row) => (plain(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => !own.includes(key))) : row)) : list);
  walk({ ...rest, shots: rows(shots, 'in', 'out', 'deliberate'), transitions: rows(transitions, 'at'), events: rows(events, 'frame') }, '');
  const sources = readdirSync(root, { recursive: true }).map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /\.(?:[cm]?[jt]sx?|py)$/.test(file) && !/(?:^|\/)(?:node_modules|out|\.[^/]*)\//.test(file)).sort();
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8'), py = file.endsWith('.py');
    let scan;
    try { scan = py ? null : scanTree(text); } catch (error) {
      if (error.toolMissing) return { toolMissing: error.toolMissing };
      return { unreadable: file };
    }
    const { lines, beatDefs } = scan ?? scanText(codeOf(text, py));
    for (const line of lines) found.push(`${file}:${line}`);
    beatConstantDefs += beatDefs;
  }
  const [width, height] = Array.isArray(output?.size) ? output.size : [];
  return { width, height, fps: rate(output.fps), frames: output.frames, shots,
    moments: (events ?? []).map(({ id }) => ({ id, frame: frameOf[id] })), timeline: { ...table, beatConstantDefs, hardcodedFrames: found.length, found } };
}
