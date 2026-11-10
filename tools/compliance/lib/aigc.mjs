// 北冥仓库 · AI 生成内容标识（决定 D11）：标识文字、成片隐式标识的写法与核对、底板来源链与 C2PA 检查、入口文档的措辞检查。
// 规范正文见 docs/rights/aigc.md。本模块只读，不改文件；读成片元数据时调用 ffprobe（可用 FFPROBE 环境变量指定）。
// 接口：
//   EXPLICIT：显式标识的固定文字 { visual: '含 AI 生成画面', voice: '配音为 AI 合成', music: '配乐含 AI 生成' }
//   implicitLabel({ producer, produceId, label, kinds, tools }) → 写进 mp4 comment 的字符串（AIGC{…} 后接一句人读说明）
//   ffmpegMetadataArgs(opts) → ['-metadata', 'comment=…']：编码器直接拼进 ffmpeg 参数
//   parseImplicitLabel(comment) → { ok, label, fields, statement, problems: [..] }
//   readMp4Comment(file, { ffprobe }) → { comment|null, error|null }
//   hasC2pa(buf) → 'png' | 'jpeg' | 'webp' | null：图片里是否嵌有 C2PA 清单（PNG caBX 块、JPEG APP11 JUMBF、WebP C2PA 块）
//   fileHasC2pa(path) → 同上，只读文件头部的块结构，不整读大图
//   platesProvenance(manifest, dir) → { record: 字段名|null, contains, plates: [{ file, c2pa, record }] }
//   docClaims(text) → [{ line, phrase }]：把 AI 生成的底板说成「手绘」「代码逐帧绘制」且同一行没有限定词的地方
// 隐式标识的字段名参照 GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》的文件元数据隐式标识（以标准正文为准）。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const EXPLICIT = Object.freeze({ visual: '含 AI 生成画面', voice: '配音为 AI 合成', music: '配乐含 AI 生成' });
export const LABELS = Object.freeze({ 1: '属于 AI 生成合成内容', 2: '可能为 AI 生成合成内容', 3: '疑似为 AI 生成合成内容' });
const FIELD_ORDER = ['Label', 'ContentProducer', 'ProduceID', 'ReservedCode1', 'ContentPropagator', 'PropagateID', 'ReservedCode2'];

// kinds：['visual','voice','music'] 中的若干；tools：生成工具清单（写进人读说明，便于追溯）
export function implicitLabel({ producer, produceId, label = '1', kinds = ['visual'], tools = [] } = {}) {
  if (!producer || !produceId) throw new Error('implicitLabel 需要 producer（制作方）与 produceId（作品 id 与运行 id）');
  if (!LABELS[label]) throw new Error(`Label 只能是 1 / 2 / 3，收到 ${label}`);
  const bad = kinds.filter(k => !EXPLICIT[k]);
  if (!kinds.length || bad.length) throw new Error(`kinds 只能取 ${Object.keys(EXPLICIT).join(' / ')}，收到 ${kinds.join(',') || '空'}`);
  const fields = { Label: String(label), ContentProducer: producer, ProduceID: produceId, ReservedCode1: '', ContentPropagator: '', PropagateID: '', ReservedCode2: '' };
  const statement = kinds.map(k => EXPLICIT[k]).join('；') + (tools.length ? `（生成工具：${tools.join('、')}）` : '');
  return `AIGC${JSON.stringify(fields, FIELD_ORDER)} ${statement}`;
}

export const ffmpegMetadataArgs = opts => ['-metadata', `comment=${implicitLabel(opts)}`];

export function parseImplicitLabel(comment) {
  const problems = [];
  if (comment == null || comment === '') return { ok: false, label: null, fields: null, statement: '', problems: ['成片没有 comment 元数据（隐式标识缺失）'] };
  const at = comment.indexOf('AIGC{');
  if (at < 0) return { ok: false, label: null, fields: null, statement: comment, problems: ['comment 里没有 AIGC{…} 隐式标识'] };
  // 取与开头大括号配对的 JSON（字符串里的括号不算）
  let depth = 0, inStr = false, end = -1;
  for (let i = at + 4; i < comment.length; i++) {
    const c = comment[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { ok: false, label: null, fields: null, statement: '', problems: ['AIGC{…} 没有闭合'] };
  let fields;
  try { fields = JSON.parse(comment.slice(at + 4, end + 1)); } catch (e) { return { ok: false, label: null, fields: null, statement: '', problems: [`AIGC{…} 不是合法 JSON：${e.message}`] }; }
  const label = fields && typeof fields.Label === 'string' ? fields.Label : null;
  if (!LABELS[label]) problems.push(`Label 应为 "1"、"2" 或 "3"，现在是 ${JSON.stringify(fields && fields.Label)}`);
  for (const k of ['ContentProducer', 'ProduceID']) if (!fields || typeof fields[k] !== 'string' || !fields[k].trim()) problems.push(`缺 ${k}`);
  const statement = comment.slice(end + 1).trim();
  if (!Object.values(EXPLICIT).some(s => statement.includes(s))) problems.push(`AIGC{…} 后面要跟一句人读说明（${Object.values(EXPLICIT).join(' / ')}）`);
  return { ok: problems.length === 0, label, fields, statement, problems };
}

export function readMp4Comment(file, { ffprobe = process.env.FFPROBE || 'ffprobe' } = {}) {
  if (!fs.existsSync(file)) return { comment: null, error: { code: 'missing', message: `文件不存在：${file}` } };
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
  if (r.error && r.error.code === 'ENOENT') return { comment: null, error: { code: 'env', message: `找不到 ffprobe（${ffprobe}）` } };
  if (r.error && r.error.code === 'ETIMEDOUT') return { comment: null, error: { code: 'timeout', message: `ffprobe 超过 30 秒没有返回：${file}` } };
  if (r.status !== 0) return { comment: null, error: { code: 'probe', message: `ffprobe 读不了 ${file}：${(r.stderr || '').trim().split('\n')[0]}` } };
  try {
    const tags = (JSON.parse(r.stdout).format || {}).tags || {};
    const key = Object.keys(tags).find(k => k.toLowerCase() === 'comment');
    return { comment: key ? tags[key] : null, error: null };
  } catch (e) { return { comment: null, error: { code: 'probe', message: `ffprobe 输出看不懂：${e.message}` } }; }
}

// ── C2PA：只看块结构，不解析清单内容 ──
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function hasC2pa(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    for (let p = 8; p + 8 <= buf.length;) {
      const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
      if (type === 'caBX') return 'png';
      if (type === 'IEND') break;
      p += 12 + len;
    }
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let p = 2; p + 4 <= buf.length;) {
      if (buf[p] !== 0xff) break;
      const marker = buf[p + 1];
      if (marker === 0xda || marker === 0xd9) break;          // 图像数据开始或结束：后面不会再有 APP 段
      const len = buf.readUInt16BE(p + 2);
      if (marker === 0xeb) {                                    // APP11：JUMBF 盒子里带 c2pa 标签
        const seg = buf.subarray(p + 4, Math.min(buf.length, p + 2 + len));
        if (seg.includes('jumb') && seg.includes('c2pa')) return 'jpeg';
      }
      p += 2 + len;
    }
    return null;
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    for (let p = 12; p + 8 <= buf.length;) {
      const type = buf.toString('latin1', p, p + 4), len = buf.readUInt32LE(p + 4);
      if (type === 'C2PA') return 'webp';
      p += 8 + len + (len & 1);
    }
  }
  return null;
}

// 逐块读文件头，跳过图像数据，几 MB 的底板也只读几十 KB。
export function fileHasC2pa(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, n) => { const b = Buffer.alloc(Math.max(0, Math.min(n, size - pos))); fs.readSync(fd, b, 0, b.length, pos); return b; };
    const head = read(0, 16);
    if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) {
      for (let p = 8; p + 8 <= size;) {
        const h = read(p, 8);
        const len = h.readUInt32BE(0), type = h.toString('latin1', 4, 8);
        if (type === 'caBX') return 'png';
        if (type === 'IEND') break;
        p += 12 + len;
      }
      return null;
    }
    // JPEG 与 WebP 的元数据段都在文件前部：读前 4 MB 足够（C2PA 清单通常几十 KB）
    return hasC2pa(read(0, 4 * 1024 * 1024));
  } finally { fs.closeSync(fd); }
}

// 底板清单的来源链：清单级的生成记录 + 逐张的 C2PA 或来源记录。
export const RECORD_KEYS = ['生成', '来源', 'aigc', 'provenance'];
export function platesProvenance(manifest, dir) {
  const record = RECORD_KEYS.find(k => manifest && manifest[k] != null && manifest[k] !== '') || null;
  const aigc = manifest && typeof manifest.aigc === 'object' ? manifest.aigc : null;
  const contains = aigc && typeof aigc.contains === 'boolean' ? aigc.contains : true;   // 没写就按「含 AI 生成」从严
  const plates = (Array.isArray(manifest && manifest.plates) ? manifest.plates : []).filter(p => p && p.file).map(p => {
    const file = path.join(dir, p.file);
    return { file: p.file, exists: fs.existsSync(file), c2pa: fs.existsSync(file) ? fileHasC2pa(file) : null, record: RECORD_KEYS.find(k => p[k] != null && p[k] !== '') || null };
  });
  return { record, contains, plates };
}

// ── 入口文档的措辞：AI 生成的底板不能写成「手绘」「代码逐帧绘制」──
const CLAIM = /手绘(?:的)?底板|底板[^。\n]{0,24}?(?:由代码|代码)逐帧绘制/g;
const QUALIFIER = /AI|AIGC|生成|Midjourney|GPT Image|Qwen/;
export function docClaims(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (QUALIFIER.test(line)) return;
    CLAIM.lastIndex = 0;
    for (let m; (m = CLAIM.exec(line));) out.push({ line: i + 1, phrase: m[0] });
  });
  return out;
}
