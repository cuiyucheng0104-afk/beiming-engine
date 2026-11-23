// B3 二级第一批四道题（27-1、29-2、23-2、30-1）的判分核验：把题目的基础谓词和 scoring[].args 里的阈值套到一份读数上。
//   evaluate(question, reading) → { score, pass, basePass, base: [{ predicate, pass, status, why, atFrame }], items: [{ metric, weight, pass, detail }] }
//   score 是过了的判分项的权重和；basePass 是基础谓词条条都过；pass 是 basePass 加每个判分项都过，差一项就判不合格。
//   基础谓词这里不另写判法：读数拼成片子描述和成片量测，逐条交给正式谓词核（verify/predicates.mjs 的 evaluateAssertion），它判 pass 才算过。
//   它回 skipped（缺量测）、要对镜头表而读数里没有成形的镜头表，都是没证据，不算过；不过的那条带 why 和反例帧 atFrame。
//   所以读数除了各题自己的表，还要带成片这一头的 colorTag、blackFrames、freezes、cuts 和工程的镜头表 shots。
//   读数不成形（不是 JSON 对象、缺子表、表里有空洞或混进非数、帧率和总帧数跟交付规格不一致）一律 0 分、不合格，原因写在 detail.invalid，不抛错。
//   读数的字段见 beiming/bench/refs/level-2-a/ 的夹具；23-2 的章节起点收片内非负有限毫秒数，其余时刻是整数帧或整数毫秒。
//   read27_1、read29_2、read23_2 从成片量读数，镜头表取工程的片子描述或事件表；readFilm 只量成片这一头；
//   read30_1 对时间线求值回调在 baseBpm 与 probeBpm 下做纯行为重求值观测（零源码分析）。机器上没有 ffmpeg/ffprobe 时真片读数回 { toolMissing }。
// shortcut: 命中率和随机基线（05 第 7.1 节的 metric:beat.onset-hit）观测层还没有，先在这里算；它进了 observe/metrics 就换成调它。
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { evaluate as evaluateTimeline } from '../../../cards/time/timeline/evaluate.mjs';
import { audioLoudness, blackFreezeDup, cutScene, cutYdif, deliverSpec } from '../../../observe/metrics/index.mjs';
import { evaluateAssertion } from '../../../verify/predicates.mjs';

// 离周期网格最近一格有多远；网格向两头无限延伸，周期、相位、时刻同一个单位
function offGrid(at, period, phase = 0) {
  const into = (((at - phase) % period) + period) % period;
  return Math.min(into, period - into);
}
const share = (hits, events) => ({ hits, events, hitRate: events ? hits / events : 0 });
const finite = (...values) => values.every(Number.isFinite);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 没有空洞的整数表 / 有限数表，每项落在 [low, high)；Array.from 把空洞读成 undefined，every 才不会跳过它
const ints = (list, low, high) => Array.isArray(list) && Array.from(list, (v) => Number.isSafeInteger(v) && v >= low && v < high).every(Boolean);
const times = (list, low, high) => Array.isArray(list) && Array.from(list, (v) => typeof v === 'number' && Number.isFinite(v) && v >= low && v < high).every(Boolean);
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
  // 点击帧号出自事件表；那张表的 fps、frames 要和交付规格逐字相同（事件契约 EV6），不然帧号说的不是这条片子
  '29-2': ({ clicks, cuts, onsetsMs, eventsFps, eventsFrames }, { fps, frames, durationMs }) =>
    (eventsFps === fps && eventsFrames === frames ? '' : `事件表的 eventsFps、eventsFrames 要和交付规格一致（${fps}、${frames}）`)
    || ([clicks, cuts].every((list) => ints(list, 0, frames) && rising(list)) ? '' : 'clicks、cuts 要是片内严格递增的整数帧')
    || (ints(onsetsMs, 0, durationMs) && rising(onsetsMs) && onsetsMs.length ? '' : 'onsetsMs 要是不空的、片内严格递增的整数毫秒'),
  '23-2': ({ chaptersMs, strongOnsetsMs, beat }, { durationMs }) =>
    (times(chaptersMs, 0, durationMs) && rising(chaptersMs) ? '' : 'chaptersMs 要是片内严格递增的毫秒数')
    || (ints(strongOnsetsMs, 0, durationMs) && rising(strongOnsetsMs) && strongOnsetsMs.length ? '' : 'strongOnsetsMs 要是不空的、片内严格递增的整数毫秒')
    || (plain(beat) && ints([beat.periodMs], 1, Infinity) && ints([beat.phaseMs], 0, beat.periodMs) ? '' : 'beat 要有正整数 periodMs 和 [0, periodMs) 里的整数 phaseMs'),
  '30-1': ({ baseBpm, probeBpm, beatEvents, probeBeatEvents, absoluteEvents, probeAbsoluteEvents, loudnessLufs, truePeakDbtp }, { frames }) => {
    const eventList = (list, allowEmpty = false) => Array.isArray(list)
      && (allowEmpty || list.length > 0)
      && Array.from(list, (e) => plain(e)
        && typeof e.id === 'string' && e.id.trim().length > 0
        && Number.isSafeInteger(e.frame) && e.frame >= 0 && e.frame < frames).every(Boolean)
      && new Set(list.map((e) => e.id)).size === list.length;
    const sameIds = (a, b) => {
      const ids = new Set(b.map((e) => e.id));
      return a.length === b.length && a.every((e) => ids.has(e.id));
    };
    if (!finite(baseBpm, probeBpm) || baseBpm <= 0 || probeBpm <= 0 || baseBpm === probeBpm) {
      return 'baseBpm、probeBpm 要是不相等的有限正数';
    }
    if (!eventList(beatEvents) || !eventList(probeBeatEvents) || !sameIds(beatEvents, probeBeatEvents)) {
      return 'beatEvents、probeBeatEvents 要是无空洞、id 唯一一致、帧号在 [0, frames) 内的非空事件表';
    }
    if (absoluteEvents !== undefined || probeAbsoluteEvents !== undefined) {
      const beatIds = new Set(beatEvents.map((e) => e.id));
      if (!eventList(absoluteEvents, true) || !eventList(probeAbsoluteEvents, true)
        || !sameIds(absoluteEvents, probeAbsoluteEvents)
        || absoluteEvents.some((e) => beatIds.has(e.id))) {
        return 'absoluteEvents、probeAbsoluteEvents 要同构合法且不与 beatEvents 重名';
      }
    }
    return finite(loudnessLufs, truePeakDbtp) ? '' : 'loudnessLufs、truePeakDbtp 要是有限数';
  },
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
      // 一帧是 1000 / 帧率 毫秒，保留亚毫秒精度比较，给 1e-3 容忍分数帧长换算的十纳秒尾差
      const onBeat = offBeatMs.every((ms) => ms * fps <= tolFrames * 1000 + 1e-3);
      return { pass: beat.periodMs * bpm === 60000 && chaptersMs.length === count && onBeat, chapters: chaptersMs.length, offBeatMs };
    },
    ({ bpm, tolMs, minHitRate }, { strongOnsetsMs, beat }) => {
      const hit = share(strongOnsetsMs.filter((ms) => offGrid(ms, beat.periodMs, beat.phaseMs) <= tolMs).length, strongOnsetsMs.length);
      return { pass: beat.periodMs * bpm === 60000 && hit.hitRate >= minHitRate, ...hit };
    },
  ],
  '30-1': [
    ({ bpm, minBeatEvents, tolFrames, minHitRate, minLift, phaseFrames = 0, requiredEventIds }, { fps, frames, baseBpm, beatEvents }) => {
      const periodFrames = (fps * 60) / bpm;
      const onBeat = (frame) => periodFrames > 0 && offGrid(frame, periodFrames, phaseFrames) <= tolFrames + 1e-9;
      const hit = share(beatEvents.filter(({ frame }) => onBeat(frame)).length, beatEvents.length);
      const distinctFrames = new Set(beatEvents.map(({ frame }) => frame)).size;
      const byId = new Map(beatEvents.map((e) => [e.id, e]));
      const hasReq = Array.isArray(requiredEventIds) && requiredEventIds.length > 0;
      const missingIds = hasReq
        ? requiredEventIds.filter((id) => typeof id !== 'string' || !byId.has(id))
        : [];
      const randomBaseline = Array.from({ length: frames }, (_, frame) => frame).filter(onBeat).length / frames;
      const lift = hit.hitRate - randomBaseline;
      const reqHit = hasReq && missingIds.length === 0
        ? share(requiredEventIds.filter((id) => onBeat(byId.get(id).frame)).length, requiredEventIds.length)
        : null;
      const reqOk = !hasReq || (missingIds.length === 0 && reqHit.hitRate >= minHitRate && reqHit.hitRate - randomBaseline >= minLift);
      const offBeatIds = beatEvents.filter(({ frame }) => !onBeat(frame)).map(({ id }) => id);
      return {
        pass: baseBpm === bpm
          && beatEvents.length >= minBeatEvents
          && reqOk
          && hit.hitRate >= minHitRate
          && lift >= minLift,
        ...hit,
        distinctFrames,
        periodFrames,
        randomBaseline,
        lift,
        baselineFrames: [0, frames],
        offBeatIds,
        missingIds,
        ...(reqHit ? { requiredHitRate: reqHit.hitRate } : {}),
      };
    },
    ({ baseBpm, probeBpm, tolFrames, minMovedRatio, minMovableRatio = 0.5, requiredEventIds }, { baseBpm: readBaseBpm, probeBpm: readProbeBpm, beatEvents, probeBeatEvents }) => {
      // 只核对声明要跟拍的 beatEvents 与 probeBeatEvents，absoluteEvents 按绝对时间走、不查跟拍位移
      const baseById = new Map(beatEvents.map((e) => [e.id, e.frame]));
      const probeById = new Map(probeBeatEvents.map((e) => [e.id, e.frame]));
      const hasReq = Array.isArray(requiredEventIds) && requiredEventIds.length > 0;
      const missingIds = hasReq
        ? requiredEventIds.filter((id) => typeof id !== 'string' || !baseById.has(id) || !probeById.has(id))
        : [];
      const ratio = baseBpm / probeBpm;
      const movableIds = new Set();
      const unfollowedIds = [];
      let followed = 0;
      let movableCount = 0;
      for (const { id, frame: baseFrame } of beatEvents) {
        const probeFrame = probeById.get(id);
        const expectedFrame = Math.round(baseFrame * ratio);
        const lo = (baseFrame - 0.5) * ratio;
        const hi = (baseFrame + 0.5) * ratio;
        const disjoint = Number.isFinite(ratio) && (hi <= baseFrame - 0.5 + 1e-9 || lo >= baseFrame + 0.5 - 1e-9);
        const mustMove = Math.abs(expectedFrame - baseFrame) >= tolFrames + 1 || disjoint;
        if (mustMove) {
          movableCount++;
          movableIds.add(id);
        }
        const ok = Math.abs(probeFrame - expectedFrame) <= tolFrames && (!mustMove || probeFrame !== baseFrame);
        if (ok) followed++;
        else unfollowedIds.push(id);
      }
      const followedRatio = beatEvents.length ? followed / beatEvents.length : 0;
      const bpmMatched = readBaseBpm === baseBpm && readProbeBpm === probeBpm;
      const reqMovableCount = hasReq && missingIds.length === 0
        ? requiredEventIds.filter((id) => movableIds.has(id)).length
        : 0;
      const reqFollowedCount = hasReq && missingIds.length === 0
        ? requiredEventIds.filter((id) => !unfollowedIds.includes(id)).length
        : 0;
      const reqFollowedRatio = hasReq && requiredEventIds.length ? reqFollowedCount / requiredEventIds.length : 1;
      const enoughMovable = movableCount >= Math.ceil(beatEvents.length * minMovableRatio)
        && (!hasReq || (missingIds.length === 0 && reqMovableCount >= Math.ceil(requiredEventIds.length * minMovableRatio)));
      return {
        pass: bpmMatched
          && missingIds.length === 0
          && enoughMovable
          && followedRatio >= minMovedRatio
          && (!hasReq || reqFollowedRatio >= minMovedRatio),
        followed,
        events: beatEvents.length,
        followedRatio,
        movableCount,
        unfollowedIds,
        missingIds,
      };
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
async function filmed(file, crop, cutThreshold = 24) {
  const [spec, still, cuts] = await Promise.all([metric(deliverSpec(file)), metric(blackFreezeDup(file)), metric(cutYdif(file, cutThreshold, crop))]);
  const { width, height, fps, frames, color_space: colorTag } = spec.value;
  return { width, height, fps, frames, colorTag, blackFrames: still.details.black,
    freezes: still.details.freezes.map(([from, to]) => ({ in: from, out: to + 1 })), cuts: cuts.value };
}
export const readFilm = orMissing((file, { crop, cutThreshold = 24 } = {}) => filmed(file, crop, cutThreshold));

// 起音：声轨解成 16 千赫单声道，每 10 毫秒一格算均方根音量的常用对数（满幅是 0，静音压到 -4），
// 连续越过 jump 的 10 毫秒窗归成同一次起音、取跳变最大的那一窗，避免同一个渐起音头被重复计数；
// 同时用 ffprobe 读音视频流 start_time 换算到与视频第 0 帧同一播放时间轴，并裁掉片外越界项。
function onsets(file, jump, { minGapMs = 0, durationMs } = {}) {
  const resolved = resolve(file);
  const { streams = [] } = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', resolved]));
  const startOf = (type) => {
    const sec = Number(streams.find((stream) => stream.codec_type === type)?.start_time);
    return Number.isFinite(sec) ? sec : undefined;
  };
  const offsetMs = Math.round(((startOf('audio') ?? 0) - (startOf('video') ?? 0)) * 1000);
  const bytes = run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolved, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  // 拷一份对齐到 2 字节的再按 16 位读
  const pcm = new Int16Array(new Uint8Array(bytes.subarray(0, bytes.length & ~1)).buffer);
  const levels = [];
  for (let w = 0; (w + 1) * 160 <= pcm.length; w++) {
    let sum = 0;
    for (let k = w * 160; k < (w + 1) * 160; k++) sum += pcm[k] * pcm[k];
    levels.push(Math.max(-4, Math.log10(Math.sqrt(sum / 160) / 32768)));
  }
  const deltas = levels.map((lv, w) => Math.max(0, lv - (w > 0 ? levels[w - 1] : offsetMs >= 10 ? -4 : lv)));
  const found = [];
  for (let w = 0; w < deltas.length;) {
    if (deltas[w] <= jump) { w++; continue; }
    let best = w;
    while (w < deltas.length && deltas[w] > jump) {
      if (deltas[w] >= deltas[best]) best = w;
      w++;
    }
    const ms = best * 10 + offsetMs;
    if (ms >= 0 && (durationMs === undefined || ms < durationMs) && (found.length === 0 || ms - found.at(-1) >= minGapMs)) {
      found.push(ms);
    }
  }
  return found;
}

// 拍子：先对相邻起音间隔及相邻两步均值做容差聚类定粗拍长，再在附近扫周期与相位找落拍数最多、平方偏差最小的网格；起音不到两个回 null
// shortcut: 切分远多于正拍的配乐仍可能聚到半拍或两拍；后续进了观测层再统一替换
function beatOf(onsetsMs) {
  if (onsetsMs.length < 2) return null;
  const diffs = onsetsMs.slice(1).map((ms, i) => ms - onsetsMs[i]);
  const step = onsetsMs.every((ms) => ms % 10 === 0) ? 10 : 1;
  const seeds = [...new Set([...diffs, ...diffs.slice(1).map((d, i) => Math.round((d + diffs[i]) / (2 * step)) * step)])].filter((c) => c > 0);
  const bestSeed = seeds.map((c) => {
    const members = diffs.filter((d) => Math.abs(d - c) <= Math.max(30, Math.round(c * 0.15)));
    const mean = Math.round(members.reduce((s, d) => s + d, 0) / (members.length * step)) * step || c;
    const err = members.reduce((s, d) => s + Math.abs(d - c), 0) / members.length;
    return { c, count: members.length, err, mean };
  }).sort((a, b) => b.count - a.count || a.err - b.err || a.c - b.c)[0];
  if (!bestSeed) return null;

  const rough = bestSeed.mean;
  const tol = Math.min(30, Math.floor(rough / 4));
  let best = null;
  for (let p = Math.max(1, rough - 30); p <= rough + 30; p++) {
    const q = p % step === 0 ? step : 1;
    const phases = p / q <= 500 ? Array.from({ length: Math.ceil(p / q) }, (_, i) => i * q)
      : [...new Set(onsetsMs.flatMap((ms) => [-2 * step, -step, 0, step, 2 * step].map((d) => (((ms + d) % p) + p) % p)))].sort((a, b) => a - b);
    for (const ph of phases) {
      let hits = 0, sq = 0, exact = 0;
      for (const ms of onsetsMs) {
        const d = offGrid(ms, p, ph);
        if (d <= tol) { hits++; sq += d * d; if (d === 0) exact++; }
      }
      const cand = { p, ph, hits, sq, exact, dist: Math.abs(p - rough) };
      if (!best
        || cand.hits > best.hits
        || (cand.hits === best.hits && cand.sq < best.sq)
        || (cand.hits === best.hits && cand.sq === best.sq && cand.exact > best.exact)
        || (cand.hits === best.hits && cand.sq === best.sq && cand.exact === best.exact && (cand.dist < best.dist || (cand.dist === best.dist && (cand.p < best.p || (cand.p === best.p && cand.ph < best.ph)))))) {
        best = cand;
      }
    }
  }
  return { periodMs: best.p, phaseMs: best.ph };
}

// 逐帧亮度差（异步流式读取）：用于同时提取候选切点与判别是否为局部孤立尖峰（硬切在切点帧孤立跳变，连续快摇在相邻多帧维持高帧差平台）
async function ydifs(file) {
  const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolve(file),
    '-map', '0:v:0', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const closed = new Promise((accept, reject) => {
    child.once('error', (err) => reject(err?.code === 'ENOENT' ? absent('ffmpeg') : err));
    child.once('close', (code) => (code === 0 ? accept() : reject(new Error(`ffmpeg: ${stderr}`))));
  });
  const values = [];
  let frame = -1;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    await Promise.all([closed, (async () => {
      for await (const line of lines) {
        if (line.startsWith('frame:')) frame = Number(/^frame:(\d+)/.exec(line)?.[1] ?? -1);
        else if (frame >= 0 && line.startsWith('lavfi.signalstats.YDIF=')) values[frame] = Number(line.slice(23));
      }
    })()]);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
  return values;
}

// 27-1：交付量测、换镜头帧、响度和真峰值从成片量；双栏或低反差硬切用 YDIF 孤立峰突出度 + scdet 联合判别，避免平滑快摇误检或弱硬切漏检
export const read27_1 = orMissing(async (file, film, { crop, cutThreshold = 13, sceneThreshold = 0.025, peakRatio = 1.3 } = {}) => {
  const strongThreshold = Math.max(32, cutThreshold);
  if (crop || sceneThreshold <= 0) {
    const [seen, loud] = await Promise.all([filmed(file, crop, cutThreshold), metric(audioLoudness(file))]);
    return { ...seen, shots: film?.shots, loudnessLufs: loud.value, truePeakDbtp: loud.details.truePeakDbtp };
  }
  const [spec, still, ydif, loud, scene] = await Promise.all([
    metric(deliverSpec(file)),
    metric(blackFreezeDup(file)),
    ydifs(file),
    metric(audioLoudness(file)),
    metric(cutScene(file, sceneThreshold)),
  ]);
  const { width, height, fps, frames, color_space: colorTag } = spec.value;
  const cuts = [];
  for (let frame = 1; frame < ydif.length; frame++) {
    const cur = ydif[frame] ?? 0;
    if (!(cur > cutThreshold)) continue;
    const neighbor = Math.max(ydif[frame - 1] ?? 0, ydif[frame + 1] ?? 0);
    if (cur >= neighbor * peakRatio
      && (cur > strongThreshold || scene.value.includes(frame))
      && (cuts.length === 0 || cuts.at(-1) < frame - 1)) {
      cuts.push(frame);
    }
  }
  return {
    width, height, fps, frames, colorTag,
    blackFrames: still.details.black,
    freezes: still.details.freezes.map(([from, to]) => ({ in: from, out: to + 1 })),
    cuts, shots: film?.shots, loudnessLufs: loud.value, truePeakDbtp: loud.details.truePeakDbtp,
  };
});

// 29-2：事件表（events/0.1）给点击（兼容 overlay.cursor 的 audio='click' / sync='onset' 及 click* 命名）；
// 提供了工程 film.shots 时完整保留（含 deliberate 刻意冻结声明），否则从事件表 cut 条目拼镜头表；
// 切点默认按阈值 15 量（兼容上半裁框弱切点），配乐起音优先读独立分轨 musicFile 以防混音点击音效干扰。
export const read29_2 = orMissing(async (file, events, { crop, jump = 0.25, cutThreshold = 15, minGapMs = 0, musicFile, film, shots } = {}) => {
  const seen = await filmed(file, crop, cutThreshold);
  const durationMs = seen.fps > 0 && seen.frames > 0 ? (seen.frames * 1000) / seen.fps : undefined;
  const at = (keep) => (Array.isArray(events?.events) ? events.events.filter((entry) => plain(entry) && keep(entry)).map((entry) => entry.frame) : []);
  const edges = [0, ...at((entry) => entry.kind === 'cut'), events?.frames];
  const givenShots = film?.shots ?? shots;
  const isClick = (entry) => entry.kind === 'named'
    && (entry.audio === 'click' || entry.sync === 'onset' || (typeof entry.id === 'string' && /^click/i.test(entry.id)));
  return { ...seen, eventsFps: events?.fps, eventsFrames: events?.frames,
    shots: givenShots !== undefined ? givenShots : edges.slice(1).map((out, i) => ({ in: edges[i], out })),
    clicks: at(isClick), onsetsMs: onsets(musicFile ?? file, jump, { minGapMs, durationMs }) };
});

// 23-2：章节起点按章节元数据的精确时间基换算毫秒（不四舍五入成整毫秒），强起音和拍子从声轨量；镜头表取工程的片子描述
export const read23_2 = orMissing(async (file, film, { crop, cutThreshold = 24, jump = 0.35, minGapMs = 0 } = {}) => {
  const seen = await filmed(file, crop, cutThreshold);
  const durationMs = seen.fps > 0 && seen.frames > 0 ? (seen.frames * 1000) / seen.fps : undefined;
  const { chapters } = JSON.parse(run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', resolve(file)]));
  const chapterMs = (chapter) => {
    const [num, den] = typeof chapter.time_base === 'string' ? chapter.time_base.split('/').map(Number) : [];
    const raw = Number.isFinite(chapter.start) && num > 0 && den > 0
      ? (den % 1000 === 0 ? (chapter.start * num) / (den / 1000) : (chapter.start * num * 1000) / den)
      : Number(chapter.start_time) * 1000;
    return Math.round(raw * 1e5) / 1e5;
  };
  const strongOnsetsMs = onsets(file, jump, { minGapMs, durationMs });
  return { ...seen, shots: film?.shots, chaptersMs: chapters.map(chapterMs), beat: beatOf(strongOnsetsMs), strongOnsetsMs };
});

// 30-1：纯行为 BPM 扰动探针——以 baseBpm 与 probeBpm 两次调用时间线求值回调（结合 time.timeline 的 beatFrames 换算），收集跟拍与绝对时间事件读数
export async function read30_1(options = {}, extra = {}) {
  const cfg = typeof options === 'function' ? { ...(plain(extra) ? extra : {}), resolveEvents: options } : (plain(options) ? options : {});
  const qSpec = plain(cfg.question?.deliverable) ? cfg.question.deliverable : null;
  const qFollowArgs = plain(cfg.question?.scoring?.[1]?.args) ? cfg.question.scoring[1].args : null;
  const {
    resolveEvents,
    baseBpm = qFollowArgs?.baseBpm ?? 80,
    probeBpm = qFollowArgs?.probeBpm ?? 96,
    filmMeta,
  } = cfg;
  const givenMeta = plain(filmMeta) ? filmMeta : {};
  if (typeof givenMeta.toolMissing === 'string' && givenMeta.toolMissing.length > 0) {
    return { toolMissing: givenMeta.toolMissing };
  }
  const parseFpsVal = (v) => (typeof v === 'string' ? (/^\d+\/\d+$/.test(v) ? rate(v) : NaN) : v);
  const hasFps = Object.hasOwn(givenMeta, 'fps');
  const fps = hasFps ? parseFpsVal(givenMeta.fps) : undefined;
  const frames = Object.hasOwn(givenMeta, 'frames') ? givenMeta.frames : undefined;
  const width = Object.hasOwn(givenMeta, 'width')
    ? givenMeta.width
    : (Array.isArray(givenMeta.size) ? givenMeta.size[0] : undefined);
  const height = Object.hasOwn(givenMeta, 'height')
    ? givenMeta.height
    : (Array.isArray(givenMeta.size) ? givenMeta.size[1] : undefined);

  // 仅透传调用方显式提供的成片与工程量测证据，绝不私填画幅、帧率、帧数、色彩标签、黑帧、冻结、切点、镜头表或响度默认值
  const measuredMeta = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(frames !== undefined ? { frames } : {}),
    ...(Object.hasOwn(givenMeta, 'colorTag') ? { colorTag: givenMeta.colorTag } : {}),
    ...(Object.hasOwn(givenMeta, 'blackFrames') ? { blackFrames: givenMeta.blackFrames } : {}),
    ...(Object.hasOwn(givenMeta, 'freezes') ? { freezes: givenMeta.freezes } : {}),
    ...(Object.hasOwn(givenMeta, 'cuts') ? { cuts: givenMeta.cuts } : {}),
    ...(Object.hasOwn(givenMeta, 'shots') ? { shots: givenMeta.shots } : {}),
    ...(Object.hasOwn(givenMeta, 'loudnessLufs') ? { loudnessLufs: givenMeta.loudnessLufs } : {}),
    ...(Object.hasOwn(givenMeta, 'truePeakDbtp') ? { truePeakDbtp: givenMeta.truePeakDbtp } : {}),
  };

  const rawProbeFps = hasFps ? givenMeta.fps : (qSpec?.fps ?? '24/1');
  const probeFps = typeof rawProbeFps === 'string' ? rate(rawProbeFps) : rawProbeFps;
  const probeFrames = frames !== undefined ? frames : (qSpec?.frames ?? 2160);

  if (typeof resolveEvents !== 'function') {
    return { ...measuredMeta, baseBpm, probeBpm, unreadable: '30-1 缺少行为求值函数 resolveEvents' };
  }
  if (!finite(baseBpm, probeBpm, probeFps) || baseBpm <= 0 || probeBpm <= 0 || probeFps <= 0 || baseBpm === probeBpm
    || !Number.isSafeInteger(probeFrames) || probeFrames <= 0) {
    return { ...measuredMeta, baseBpm, probeBpm, unreadable: '30-1 行为探针参数不合法' };
  }
  const fpsFraction = typeof givenMeta.fpsFraction === 'string'
    ? givenMeta.fpsFraction
    : (typeof rawProbeFps === 'string' && /^\d+\/\d+$/.test(rawProbeFps) ? rawProbeFps : `${probeFps}/1`);
  const evalAtBpm = async (bpm) => {
    const beatFrames = (probeFps * 60) / bpm;
    const step = evaluateTimeline({ fps: fpsFraction, shot: { in: 0 } }, { holdFrames: 1, beatFrames }, 1, 0).time;
    const timelineAt = (frame, sub = 0) => evaluateTimeline(
      { fps: fpsFraction, shot: { in: 0 } },
      { holdFrames: 1, beatFrames },
      frame,
      sub,
    ).time;
    const frameAtBeat = (beat, offsetFrames = 0) => Math.round(beat / step.beat) + offsetFrames;
    const frameAtSeconds = (seconds) => Math.round(seconds / step.seconds);
    return snapshot(await resolveEvents({
      bpm,
      fps: probeFps,
      fpsFraction,
      frames: probeFrames,
      beatFrames,
      timelineAt,
      frameAtBeat,
      frameAtSeconds,
    }));
  };
  try {
    const baseOut = await evalAtBpm(baseBpm);
    const probeOut = await evalAtBpm(probeBpm);
    if (!plain(baseOut) || !plain(probeOut)) {
      return { ...measuredMeta, baseBpm, probeBpm, unreadable: '30-1 行为求值未返回事件对象' };
    }
    const reading = {
      ...measuredMeta,
      baseBpm,
      probeBpm,
      beatEvents: baseOut.beatEvents,
      probeBeatEvents: probeOut.beatEvents,
    };
    if (baseOut.absoluteEvents !== undefined || probeOut.absoluteEvents !== undefined) {
      reading.absoluteEvents = baseOut.absoluteEvents;
      reading.probeAbsoluteEvents = probeOut.absoluteEvents;
    }
    return reading;
  } catch {
    return { ...measuredMeta, baseBpm, probeBpm, unreadable: '30-1 行为求值回调异常' };
  }
}
