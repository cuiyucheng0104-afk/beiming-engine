import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

// 视频帧号从 0 起，按解码显示次序编号，保留可变帧率素材的原帧序。
async function command(tool, args, onLine) {
  const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', text => { diagnostic = (diagnostic + text).slice(-8192); });
  const closed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? accept() : reject(new Error(`${tool}: ${diagnostic}`)));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    await Promise.all([closed, (async () => { for await (const line of lines) onLine(line); })()]);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
  return diagnostic;
}

async function measure(name, unit, run) {
  const metric = `metric:${name}`;
  try { return { metric, unit, ...await run() }; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { metric, value: null, details: { code: 'tool-missing', tool: error.path }, unit };
  }
}

export function deliverSpec(filePath) {
  return measure('deliverSpec', 'spec', async () => {
    let output = '';
    await command('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
      'stream=width,height,avg_frame_rate,nb_read_frames,color_space,color_transfer,color_primaries,color_range',
      '-of', 'json', resolve(filePath)], line => { output += line; });
    const [stream] = JSON.parse(output).streams;
    if (!stream) throw new Error('缺少视频轨');
    const [num, den] = stream.avg_frame_rate.split('/').map(Number);
    const tags = {};
    for (const tag of ['color_space', 'color_transfer', 'color_primaries', 'color_range']) tags[tag] = stream[tag] ?? null;
    return { value: { width: stream.width, height: stream.height, fps: den ? num / den : null,
      frames: Number(stream.nb_read_frames), ...tags }, details: { frameRate: stream.avg_frame_rate } };
  });
}

export function audioLoudness(filePath) {
  return measure('audioLoudness', 'LUFS', async () => {
    const summary = await command('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', '-i', resolve(filePath),
      '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], () => {});
    const final = summary.slice(summary.lastIndexOf('Summary:'));
    const integrated = /\bI:\s*(-?[\d.]+|-inf) LUFS/.exec(final);
    const peak = /\bPeak:\s*(-?[\d.]+|-inf) dBFS/.exec(final);
    if (!integrated || !peak) throw new Error('缺少 EBU R128 汇总');
    const db = match => match[1] === '-inf' ? -Infinity : Number(match[1]);
    return { value: db(integrated), details: { truePeakDbtp: db(peak) } };
  });
}

function range(value, low, high, name, integer = false) {
  if (!Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) {
    throw new RangeError(`无效参数 ${name}`);
  }
  return value;
}

async function frames(file, filters, visit) {
  let frame = -1;
  let tags = new Map();
  await command('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolve(file), '-map', '0:v:0',
    '-vf', `${filters},metadata=print:file=-`, '-f', 'null', '-'], line => {
    if (line.startsWith('frame:')) {
      if (frame >= 0) visit(frame, tags);
      frame = Number(/^frame:(\d+)/.exec(line)[1]);
      tags = new Map();
    } else {
      const eq = line.indexOf('=');
      if (eq >= 0) tags.set(line.slice(0, eq), Number(line.slice(eq + 1)));
    }
  });
  if (frame < 0) throw new Error('缺少视频帧量测');
  visit(frame, tags);
}

export { frames as readSignalFrames };

function reading(tags, key) {
  const value = tags.get(key);
  if (!Number.isFinite(value)) throw new Error(`缺少帧量测 ${key}`);
  return value;
}

// 色差以 8 位 YUV 码值表示（默认 0.15 约合 -64.6 dB，区分 H.264 静止底噪与暗调慢推镜）。连续近似帧组成冻结段，起止均含端点。
export function blackFreezeDup(filePath, { blackLevel = 32, blackPercent = 98,
  freezeDiff = 0.15, freezeFrames = 3, duplicateDiff = 0 } = {}) {
  range(blackLevel, 0, 255, 'blackLevel', true);
  range(blackPercent, 0, 100, 'blackPercent', true);
  range(freezeDiff, 0, 255, 'freezeDiff');
  range(freezeFrames, 2, Infinity, 'freezeFrames', true);
  range(duplicateDiff, 0, 255, 'duplicateDiff');
  return measure('blackFreezeDup', 'frames', async () => {
    const black = [], duplicates = [], freezes = [];
    let start = 0, last = -1;
    function close(end) {
      if (end - start + 1 >= freezeFrames) freezes.push([start, end]);
    }
    await frames(filePath, `format=yuv444p,blackframe=amount=0:threshold=${blackLevel},signalstats`, (n, tags) => {
      if (reading(tags, 'lavfi.blackframe.pblack') >= blackPercent) black.push(n);
      const diff = Math.max(...['Y', 'U', 'V'].map(c => reading(tags, `lavfi.signalstats.${c}DIF`)));
      if (n > 0 && diff <= duplicateDiff) duplicates.push(n);
      if (n > 0 && diff > freezeDiff) { close(n - 1); start = n; }
      last = n;
    });
    close(last);
    return { value: { blackFrames: black.length, freezeSegments: freezes.length, duplicateFrames: duplicates.length },
      details: { black, freezes, duplicates } };
  });
}

// YDIF 为相邻帧的亮度码值平均绝对差。裁剪窗口单位为像素。
export function cutYdif(filePath, threshold = 24, crop) {
  range(threshold, 0, 255, 'threshold');
  let filter = 'format=yuv444p';
  if (crop) {
    for (const key of ['x', 'y', 'width', 'height']) range(crop[key], ['x', 'y'].includes(key) ? 0 : 1, Infinity, key, true);
    filter += `,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
  }
  return measure('cutYdif', 'frames', async () => {
    const value = [];
    await frames(filePath, `${filter},signalstats`, (n, tags) => {
      if (n > 0 && reading(tags, 'lavfi.signalstats.YDIF') > threshold) value.push(n);
    });
    return { value, details: { threshold, crop: crop ?? null } };
  });
}

// scdet 以百分数给分，接口阈值与输出的分数均用 0 至 1 的比例。
export function cutScene(filePath, threshold = 0.3) {
  range(threshold, 0, 1, 'threshold');
  return measure('cutScene', 'frames', async () => {
    const value = [];
    await frames(filePath, 'scdet', (n, tags) => {
      if (n > 0 && reading(tags, 'lavfi.scd.score') / 100 > threshold) value.push(n);
    });
    return { value, details: { threshold } };
  });
}
