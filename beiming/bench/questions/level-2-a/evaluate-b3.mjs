// B3 二级第一批四道题的判分核验：把题目 scoring[].args 里的阈值套到一份读数上，回每项过没过和加权得分。
//   evaluate(question, reading) → { score, pass, items: [{ metric, weight, pass, detail }] }
//   score 是过了的项的权重和；pass 是每一项都过（满分），差一项就判不合格。
//   读数的字段见 beiming/bench/refs/level-2-a/ 的夹具；时刻要么是整数帧，要么是整数毫秒，比较全用整数，不落在浮点误差上。
// shortcut: 命中率和随机基线（05 第 7.1 节的 metric:beat.onset-hit）观测层还没有，先在这里算；它进了 observe/metrics 就换成调它。

// 离周期网格最近一格有多远；网格向两头无限延伸，周期、相位、时刻同一个单位
function offGrid(at, period, phase = 0) {
  const into = (((at - phase) % period) + period) % period;
  return Math.min(into, period - into);
}
const share = (hits, events) => ({ hits, events, hitRate: events ? hits / events : 0 });
const finite = (...values) => values.every(Number.isFinite);

// 每道题一组判法，次序和题目文件的 scoring 一一对应
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
      pass: finite(loudnessLufs, truePeakDbtp) && loudnessLufs >= low && loudnessLufs <= high && truePeakDbtp <= maxTruePeakDbtp,
      loudnessLufs,
      truePeakDbtp,
    }),
  ],
  '29-2': [
    ({ count, lagFrames }, { clicks, cuts }) => {
      const uncut = clicks.filter((frame) => !cuts.includes(frame + lagFrames));
      return { pass: clicks.length === count && uncut.length === 0, clicks: clicks.length, uncut };
    },
    ({ tolFrames, minHitRate, minLift }, { fps, frames, clicks, onsetsMs }) => {
      // 帧号 × 1000 和 起音毫秒 × 帧率 都是整数，相差不超过 容差帧 × 1000 就算踩上
      const onOnset = (frame) => onsetsMs.some((ms) => Math.abs(frame * 1000 - ms * fps) <= tolFrames * 1000);
      const hit = share(clicks.filter(onOnset).length, clicks.length);
      // 随机基线：同一条音轨上任取一帧的命中率
      const randomBaseline = Array.from({ length: frames }, (_, frame) => frame).filter(onOnset).length / frames;
      return { pass: hit.hitRate >= minHitRate && hit.hitRate - randomBaseline >= minLift, ...hit, randomBaseline };
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
      pass: finite(beatConstantDefs, hardcodedFrames) && beatConstantDefs >= 1 && beatConstantDefs <= maxBeatConstantDefs && hardcodedFrames <= maxHardcodedFrames,
      beatConstantDefs,
      hardcodedFrames,
    }),
  ],
};

export function evaluate(question, reading) {
  const rules = RULES[question.id];
  if (!rules || rules.length !== question.scoring.length) throw new Error(`题目 ${question.id} 没有和 scoring 对得上的判法`);
  const items = question.scoring.map(({ metric, weight, args }, i) => {
    const { pass, ...detail } = rules[i](args, reading);
    return { metric, weight, pass, detail };
  });
  return { score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: items.every((item) => item.pass), items };
}
