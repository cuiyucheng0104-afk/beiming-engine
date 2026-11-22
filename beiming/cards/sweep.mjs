import { URL } from 'node:url';
import { estimateTokens } from './registry.mjs';
import { resolveParams } from './runtime.mjs';
import { parseVersion } from './status.mjs';
import { digest, encodeCells, prepareOutDir, writeCells } from './sweep-artifacts.mjs';
import { measure } from './sweep-metrics.mjs';
import { dataValidators } from './sweep-schema.mjs';

export const SWEEP_TOKEN_LIMIT = 800;
export const MAX_SWEEP_CELLS = 64;
export const MAX_SWEEP_TIMES = 6;

const bad = message => Object.assign(new Error(message), { code: 'usage.bad-argument' });
const badValue = message => Object.assign(new Error(message), { code: 'contract.bad-value' });

function diagnostic(error) {
  if (error?.syscall || error?.code === 'ERR_MODULE_NOT_FOUND') return '无法访问所需的文件或目录';
  if (typeof error === 'string') return error;
  return typeof error?.message === 'string' ? error.message : '操作失败';
}
const isPlain = v => v !== null && typeof v === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(v));
const named = v => typeof v === 'string' && v.trim().length > 0;

function list(value, name, max = Infinity) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw bad(`${name} 的项数无效`);
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw bad(`${name} 含空洞`);
  return value;
}

function checkValue(value) {
  if (['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) checkValue(item);
  } else if (isPlain(value)) {
    for (const item of Object.values(value)) checkValue(item);
  } else throw bad('参数值须为非 null 的有限 JSON 数据');
}

/** 与 lookdev 相同的 name=JSON,JSON 语法，由 JSON 解析器处理嵌套括号与引号。 */
export function parseSweepAxis(spec) {
  const equal = typeof spec === 'string' ? spec.indexOf('=') : -1;
  const param = equal > 0 ? spec.slice(0, equal).trim() : '';
  if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)*$/.test(param)) throw bad('轴须写成 参数名=值,值');
  let values;
  try { values = JSON.parse(`[${spec.slice(equal + 1)}]`); } catch { throw bad(`${param} 的取值须为 JSON`); }
  list(values, param, MAX_SWEEP_CELLS).forEach(checkValue);
  return { param, values };
}

function prepare(card, request, timing) {
  const { params, axes, baseParams = {} } = request;
  if ((axes === undefined) === (params === undefined)) throw bad('须给出 axes 或 params 其中一个');
  if (!isPlain(baseParams) || (params !== undefined && !isPlain(params))) throw bad('params 与 baseParams 须为普通对象');
  checkValue(baseParams);
  const specs = axes === undefined ? Object.entries(params).map(([param, values]) => ({ param, values })) : axes;
  const names = new Set();
  let combos = [baseParams];
  for (const spec of list(specs, '参数轴')) {
    const axis = typeof spec === 'string' ? parseSweepAxis(spec) : spec;
    if (!isPlain(axis) || !named(axis.param) || names.has(axis.param) || !Object.hasOwn(card.params, axis.param)) {
      throw bad('需要有效且不重复的卡参数轴');
    }
    const { param, values } = axis;
    list(values, param, Math.floor(MAX_SWEEP_CELLS / combos.length)).forEach(checkValue);
    names.add(param);
    combos = combos.flatMap(combo => values.map(v => ({ ...combo, [param]: v })));
  }
  const validators = dataValidators(card);
  const cells = combos.map(params => {
    const resolvedParams = resolveParams(card, params, timing);
    for (const [name, validate] of validators) {
      if (!validate(resolvedParams[name])) throw bad(`参数 ${name} 不符合卡声明的 schema`);
    }
    return { params: globalThis.structuredClone(params), resolvedParams };
  });
  return { axisNames: [...names], cells };
}

function sampling({ frames, times, fps = 24 }) {
  if (frames !== undefined && times !== undefined) throw bad('frames 与 times 只能给一组');
  if (!Number.isFinite(fps) || fps <= 0) throw bad('fps 须为有限正数');
  const seconds = times !== undefined;
  const values = seconds ? times : frames === undefined ? [0] : frames;
  const steps = list(values, '采样时刻', MAX_SWEEP_TIMES).map(value => {
    const frame = seconds ? Math.round(value * fps) : value;
    const time = seconds ? value : frame / fps;
    if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(time) || time < 0) throw bad('采样时刻或帧号无效');
    return { frame, time };
  });
  return { steps, stepCol: seconds ? 'time' : 'frame' };
}

async function dataEvaluator(card, inputs) {
  const entry = card.impl?.find(i => i.livesIn === 'data' && i.shape === 'evaluate')?.entry;
  if (!/^cards\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/evaluate\.mjs$/.test(entry) || entry.split('/')[1] !== card.kind) {
    throw bad('此卡需要提供 evaluateCell');
  }
  const { evaluate } = await import(new URL(`../${entry}`, import.meta.url));
  return ({ resolvedParams, frame }) => evaluate(inputs, resolvedParams, frame, 0);
}

const compact = v => typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v;

function table(card, columns, rows, artifacts) {
  const result = { ok: true, card, columns, rows: [], totalCells: rows.length, truncated: false };
  if (artifacts) result.artifacts = artifacts;
  let bytes = estimateTokens(result);
  for (const row of rows) {
    const next = row.map(compact);
    bytes += estimateTokens(next) + Number(result.rows.length > 0);
    if (bytes > SWEEP_TOKEN_LIMIT) break;
    result.rows.push(next);
  }
  if (result.rows.length < rows.length) {
    result.truncated = true;
    result.omittedRows = rows.length - result.rows.length;
    while (result.rows.length && estimateTokens(result) > SWEEP_TOKEN_LIMIT) {
      result.rows.pop();
      result.omittedRows++;
    }
  }
  if (estimateTokens(result) > SWEEP_TOKEN_LIMIT) {
    throw badValue('列名与固定字段已超过 800 字节');
  }
  return result;
}

/** 在同一组输入与采样时刻上，先校验全部组合，再依次求值。 */
export async function sweepCard(card, request, options = {}) {
  try {
    if (![card, request, options, card?.params].every(isPlain)) throw bad('卡、请求与选项须为普通对象');
    const version = parseVersion(card.version);
    if (!named(card.id) || !version) throw bad('需要卡名与三段版本号');
    const ref = `${card.id}@${version[0]}`;
    const { events = [], shotIn = 0, inputs = {} } = request;
    if (!Array.isArray(events) || !Number.isSafeInteger(shotIn) || !isPlain(inputs)) throw bad('卡输入或事件时刻无效');
    for (const event of events) if (!isPlain(event) || !Number.isSafeInteger(event.frame)) throw bad('事件须给出整数帧号');
    const { steps, stepCol } = sampling(request);
    const metrics = [...list(request.metrics, 'metrics')];
    if (!metrics.every(named) || new Set(metrics).size !== metrics.length) throw bad('metrics 须为不重复的指标名');
    const { cells, axisNames } = prepare(card, request, { events, shotIn });
    const columns = [...axisNames, ...(steps.length > 1 ? [stepCol] : []), ...metrics];
    const outDir = request.outDir === undefined ? undefined : prepareOutDir(request.outDir);
    const evaluateCell = options.evaluateCell === undefined ? await dataEvaluator(card, inputs) : options.evaluateCell;
    if (typeof evaluateCell !== 'function') throw bad('evaluateCell 须为函数');
    const rows = [], records = [];
    for (const [cellIndex, cell] of cells.entries()) {
      const samples = [];
      for (const step of steps) {
        let output;
        try { output = await evaluateCell({ card, inputs, ...globalThis.structuredClone(cell), cellIndex, ...step }); }
        catch (error) { throw badValue(`evaluateCell failed: ${diagnostic(error)}`); }
        const readings = measure(output, metrics);
        rows.push([...axisNames.map(k => cell.params[k]), ...(steps.length > 1 ? [step[stepCol]] : []), ...metrics.map(k => readings[k])]);
        if (outDir !== undefined) samples.push({ ...step, readings });
      }
      if (outDir !== undefined) {
        const record = { cellIndex, params: cell.params, samples };
        records.push({ ...record, sha256: digest(JSON.stringify(record)) });
      }
    }
    const file = outDir === undefined ? undefined : encodeCells(ref, columns, rows, records);
    const result = table(ref, columns, rows, file?.artifacts);
    if (file) writeCells(outDir, file);
    return result;
  } catch (error) {
    const code = error?.code === 'contract.bad-value' ? error.code : 'usage.bad-argument';
    // 每个 UTF-16 码元在 JSON 内最多占 6 字节，给错误信封保留余量。
    return { ok: false, error: { code, message: diagnostic(error).slice(0, 110) } };
  }
}
