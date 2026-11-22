import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual as same } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { createCardRegistry } from '../cards/index.mjs';
import { explainParam } from '../kernel/explain.mjs';
import { applyFilmWrite, parseRequestText } from '../kernel/patch-apply.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { scanShot } from '../verify/index.mjs';
import { appendExternalLedger, reviewerFromEnv } from './agents.mjs';
import { runDelegateOrchestrator } from './delegate.mjs';
import { searchAssets, uploadRef } from './assets.mjs';
import { identify, authorize, issueWorkspaceToken } from './auth.mjs';
import { artifactUrl } from './client.mjs';
import { matchRoute, ROUTES } from './contract.mjs';
import { ApiError, estimateTokens, fail, fitEnvelope, httpStatusOf, isRegistered, ok } from './envelope.mjs';
import { candidate, fixesIntoOps, hasStoredPath, scaffold, unknownKeyFixes, wholeFilmPatch } from './films.mjs';
import { guideData } from './guide.mjs';
import { layerL1 } from './pipeline.mjs';
import { ensureLut, loadCardLibrary, monotonicMs } from './runtime.mjs';
import { createStore } from './store.mjs';
import { createWork, planOf } from './work.mjs';

const bad = message => new ApiError('usage.bad-argument', message);
const missing = message => new ApiError('usage.bad-argument', message, { status: 404 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const counted = (items, expectedCount = items.length) => ({ items, expectedCount, actualCount: items.length });
const ajv = new Ajv2020({ strict: false, ownProperties: true });
const validators = new Map(ROUTES.filter(r => r.request).map(r => [r.id, ajv.compile(r.request)]));
const scriptPath = /^shots\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:py|mjs|js)$/;

async function readBody(req, route) {
  if (!route.request) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw bad('请求体超过 16 MiB');
    chunks.push(chunk);
  }
  if (!size && route.bodyRequired) throw bad('请求体不能为空');
  const bytes = Buffer.concat(chunks);
  let body = {};
  if (route.request.type === 'string') body = bytes.toString('utf8');
  else if (size) {
    const parsed = parseRequestText(bytes);
    if (!parsed.ok) throw bad(parsed.message);
    body = parsed.body;
  }
  if (route.id !== 'film-put') validateBody(route.id, body);
  return body;
}

function validateBody(id, body) {
  const validate = validators.get(id);
  if (!validate(body)) throw bad(ajv.errorsText(validate.errors));
}

function schemaData(contracts, name) {
  const contract = contracts.get(name);
  if (!contract) throw missing('找不到这个契约');
  const files = readdirSync(join(contract.dir, 'schema'));
  const primary = files.includes(`${name}.schema.json`) ? `${name}.schema.json` : files.find(f => f.endsWith('.schema.json'));
  if (!primary) throw missing('这个契约没有结构定义');
  const schema = readJson(join(contract.dir, 'schema', primary));
  const fields = Object.entries(schema.properties ?? {}).map(([key, v]) => ({ key, type: v.type ?? v.$ref ?? v.const ?? 'value', required: schema.required?.includes(key) ?? false }));
  const examples = readdirSync(join(contract.dir, 'examples')).filter(f => f.endsWith('.json') && f !== 'index.json');
  const example = readJson(join(contract.dir, 'examples', examples.includes('minimal.json') ? 'minimal.json' : examples[0]));
  return { name, fields, example: Object.fromEntries(Object.entries(example).map(([key, value]) => [key, Array.isArray(value) ? { count: value.length } : typeof value === 'object' && value ? Object.keys(value) : value])), expectedCount: fields.length, actualCount: fields.length };
}

function jobResult(work, id, job) {
  const { base, outcome } = work.view(id, job);
  return { ...outcome, data: { ...outcome?.data, ...base } };
}

/** 启动一个使用独立数据目录的 HTTP 服务。port 为 0 时由系统分配。 */
export async function startServer({ dataDir = '.beiming-api', host = '127.0.0.1', port = 0, localTrusted = false, reviewer, scheduler, delegate = {} } = {}) {
  const env = process.env;
  const model = {
    endpoint: delegate.endpoint ?? env.BEIMING_AGENT_ENDPOINT, apiKey: delegate.apiKey ?? env.BEIMING_AGENT_API_KEY,
    directorModel: delegate.directorModel ?? (env.BEIMING_DIRECTOR_MODEL || env.BEIMING_AGENT_MODEL), workerModel: delegate.workerModel ?? (env.BEIMING_WORKER_MODEL || env.BEIMING_AGENT_MODEL),
    ...(delegate.reserveTokens !== undefined && { reserveTokens: delegate.reserveTokens }),
  };
  dataDir = resolve(dataDir);
  const store = createStore(dataDir);
  const library = loadCardLibrary();
  const cards = Object.fromEntries(Object.entries(library).map(([id, item]) => [id, item.card]));
  const registry = createCardRegistry(Object.values(cards), { allowReproduced: true });
  const frozen = await loadContracts();
  let url;
  const work = createWork({ store, library, scheduler, reviewer: reviewer === undefined ? reviewerFromEnv({ ledgerPath: join(dataDir, 'external-ledger.jsonl') }) : reviewer });

  async function commit(id, film, rev, files = {}) {
    return store.commit(id, film, rev, { files, library, lut: await ensureLut(dataDir) });
  }

  async function createFilm(body, who, bearer) {
    const delegated = body.mode === 'delegate';
    if (delegated && !body.brief?.trim()) throw bad('委托模式要 brief（需求原文）');
    if (delegated && !(model.endpoint && model.apiKey && model.directorModel && model.workerModel)) {
      throw new ApiError('env.missing-tool', '服务端没配委托模型', { hint: '设 BEIMING_AGENT_ENDPOINT、BEIMING_AGENT_API_KEY、BEIMING_AGENT_MODEL 后重启服务' });
    }
    let question = body.question;
    if (body.exam && !question) {
      const dir = join(frozen.contracts.get('question-file').dir, 'examples');
      question = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readJson(join(dir, n))).find(q => q.id === body.exam);
      if (!question) throw bad('未登记的考题，请同时提交 question');
    }
    if (question) {
      const result = frozen.validate(question);
      if (result.contract !== 'question-file' || result.schemaErrors.length || Object.keys(result.violations).length || (body.exam && body.exam !== question.id)) throw bad('考题未通过冻结契约或题号不一致');
    }
    const id = store.nextFilmId();
    const { film, files, assetRef } = scaffold({ ...body, id, question });
    const check = frozen.validate(film);
    if (check.schemaErrors.length || Object.keys(check.violations).length) throw new ApiError('contract.bad-value', '脚手架未通过片子契约', { data: check });
    store.workspace(id);
    const { diagnostics } = await commit(id, film, 1, files);
    store.writeMeta(id, { template: body.template ?? 'title', brief: body.brief, question, assets: question?.assets ?? {}, assetRef, managedFiles: Object.keys(files).filter(p => scriptPath.test(p)) });
    const token = issueWorkspaceToken(dataDir, id, { account: who.name });
    if (!delegated) return { data: { film: id, token, rev: 1, scaffold: 'film.json', base: film.predicates.base }, diagnostics };
    const job = work.submitDelegate(id, ({ signal, onTokens }) => runDelegateOrchestrator({
      ...model, baseUrl: url, accountToken: bearer, workspaceToken: token, filmId: id,
      brief: body.brief, assets: body.assets, budget: body.budget, signal,
      onUsage: entry => {
        onTokens?.((entry.inputTokens ?? 0) + (entry.outputTokens ?? 0));
        appendExternalLedger(join(dataDir, 'external-ledger.jsonl'), { film: id, ...entry });
      },
    }));
    return { data: { film: id, token, rev: 1, scaffold: 'film.json', base: film.predicates.base, job }, diagnostics, next: [{ verb: `GET /v1/jobs/${job}?wait=30`, why: '委托编排在后台跑，长轮询看它停在哪' }] };
  }

  async function writeFilm(id, body, machine) {
    const rev = store.rev(id);
    if (!Number.isSafeInteger(body.rev) || body.rev < 0) throw bad('rev 必须是非负安全整数');
    if (body.rev !== rev) throw new ApiError('busy.rev-conflict', '修订号已过期', { data: { latestRev: rev } });
    // 内核按 errors §5.6 判补丁的只读键与结构，其他正文用路由合同。
    if (body.format !== 'patch/0.1') validateBody('film-put', body);
    const stored = store.readFilm(id);
    const meta = store.readMeta(id);
    let patch = body.format === 'film/3.0' ? wholeFilmPatch(stored, body, rev) : body;
    if (body.format === 'film/3.0' && !patch.ops.length) {
      // 旧版工作区可能没有正式锁；重新签发一个有锁的修订。
      const lock = statSync(join(store.filmDir(id), 'film.lock'), { throwIfNoEntry: false });
      if (lock?.isFile()) return { data: { rev, applied: 0, lock: 'film.lock' } };
      await commit(id, stored, rev + 1);
      return { data: { rev: rev + 1, applied: 0, lock: 'film.lock' } };
    }
    if (!body.format) {
      if (!machine || meta.pending?.rev !== rev) throw bad('当前修订没有待应用的机器修法');
      patch = meta.pending;
    }
    if (Array.isArray(patch.ops) && patch.ops.some(o => [o?.path, o?.to].some(p => typeof p === 'string' && p.split('/').some(k => ['__proto__', 'constructor', 'prototype'].includes(k))))) throw new ApiError('contract.bad-path', '补丁路径非法');
    if (Array.isArray(patch.ops) && (stored.exam || meta.question)) {
      const examAliases = Object.keys(meta.question?.assets ?? {});
      const badSyntax = (p) => !p || p.startsWith('/') || p.endsWith('/') || p.includes('//') || /[#\s]/.test(p);
      for (const o of patch.ops) {
        if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.path !== 'string' || badSyntax(o.path)) continue;
        const parent = o.path.includes('/') ? o.path.slice(0, o.path.lastIndexOf('/')) : '';
        const to = o.op === 'rename' && typeof o.to === 'string' && !o.to.includes('/') && !badSyntax(o.to) ? o.to : '';
        // 严格遵循 errors §5.6 第 2 步书写顺序：若当前 op 命中冻结只读键 id/exam 或 predicates/base，交由 applyFilmWrite 报对应码，绝不抢占后续 op。
        if (o.path === 'id' || o.path === 'exam' || (parent === '' && (to === 'id' || to === 'exam'))) break;
        if (o.path === 'predicates' || o.path === 'predicates/base' || (parent === 'predicates' && to === 'base') || (parent === '' && to === 'predicates')) break;
        const dest = to ? (parent ? `${parent}/${to}` : to) : '';
        const paths = [o.path, ...(dest ? [dest] : [])];
        if (meta.question?.deliverable && paths.some(p => p === 'output' || p.startsWith('output/'))) {
          throw new ApiError('auth.base-readonly', '考题交付规格只读');
        }
        if (meta.question?.deliverable?.audio === 'none' && paths.some(p => p === 'audio' || p.startsWith('audio/') || /^events\/[^/]+\/audio$/.test(p))) {
          throw new ApiError('auth.base-readonly', '考题无声交付规格只读');
        }
        for (const alias of examAliases) {
          if (paths.some(p => p === `assets/${alias}` || p.startsWith(`assets/${alias}/`) || (o.op === 'remove' && p === 'assets')
            || new RegExp(`^shots/[^/]+/(?:assets/${alias}(?:/|$)|roles/hero(?:/|$))`).test(p))) {
            throw new ApiError('auth.base-readonly', `考题主体资产 ${alias} 只读`);
          }
        }
      }
    }
    let result = applyFilmWrite(stored, patch, { rev });
    let applied = 0;
    if (result.ok || ['contract.unknown-key', 'contract.bad-value'].includes(result.code)) {
      const inspected = result.ok ? result.film : candidate(stored, patch.ops);
      const l1 = layerL1(inspected, null, rev, meta.question);
      const l1Fixes = l1.fixes.filter(f => f.applicability === 'machine');
      const kernelFixes = result.ok ? [] : unknownKeyFixes(patch.ops, result.diagnostics);
      const fixes = [...l1Fixes, ...kernelFixes.filter(k => !l1Fixes.some(f => f.op === k.op && f.path === k.path))];
      if (machine && fixes.length) {
        let nextOps = fixesIntoOps(patch.ops, fixes);
        result = applyFilmWrite(stored, { ...patch, ops: nextOps }, { rev });
        applied = fixes.length;
        // applyFilmWrite 在第 4 步遇到第一个未知键即停止；若一次补丁含多个未知键，继续改写直到全部清除。
        for (let i = 0; i < (patch.ops?.length ?? 0) && !result.ok && result.code === 'contract.unknown-key'; i++) {
          const more = unknownKeyFixes(nextOps, result.diagnostics);
          if (!more.length) break;
          nextOps = fixesIntoOps(nextOps, more);
          result = applyFilmWrite(stored, { ...patch, ops: nextOps }, { rev });
          applied += more.length;
        }
      } else if (!l1.ok || !result.ok) {
        if (fixes.length) store.updateMeta(id, m => { m.pending = patch; });
        const resultByKey = new Map((result.diagnostics ?? []).map(d => [`${d.code}:${d.at ?? ''}`, d]));
        const l1Keys = new Set(l1.diagnostics.map(d => `${d.code}:${d.at ?? ''}`));
        const merged = [
          ...l1.diagnostics,
          ...(result.ok ? [] : (result.diagnostics ?? []).filter(d => !l1Keys.has(`${d.code}:${d.at ?? ''}`))),
        ];
        const diagnostics = merged.map(d => {
          if (d.fix?.op === 'rename' && hasStoredPath(stored, d.fix.path)) return d;
          if (d.fix?.op === 'rename') {
            const { fix, ...rest } = d;
            return { ...rest, hint: `将 ${fix.path} 的键名改为 ${fix.to} 后重交，或使用 applyFixes=machine` };
          }
          if (!d.hint && !d.fix) {
            const kd = resultByKey.get(`${d.code}:${d.at ?? ''}`) ?? (result.diagnostics ?? []).find(r => r.code === d.code && r.at === d.at);
            if (kd?.hint) return { ...d, hint: kd.hint };
          }
          return d;
        });
        throw new ApiError(result.code ?? 'contract.bad-value', result.message ?? 'L1 写入检查失败', { diagnostics });
      }
    }
    if (!result.ok) throw new ApiError(result.code, result.message, { diagnostics: result.diagnostics });
    for (const shot of result.film.shots) {
      const renderer = shot.renderer ?? shot;
      if (!renderer.entry) continue;
      if (!scriptPath.test(renderer.entry)) throw new ApiError('contract.bad-path', '镜头入口必须位于 shots 目录');
      store.workspace(id).resolve(renderer.entry);
      if (!localTrusted && !meta.managedFiles?.includes(renderer.entry)) throw new ApiError('contract.unsupported-mode', '此工作区只接受 cards-data 或模板自带入口');
    }
    const checked = layerL1(result.film, store.filmDir(id), rev, meta.question);
    if (!checked.ok) throw new ApiError('contract.bad-value', 'L1 写入检查失败', { diagnostics: checked.diagnostics });
    if (meta.question?.basePredicates?.some(text => stored.predicates.extra?.includes(text) && !result.film.predicates.extra?.includes(text))) {
      throw new ApiError('auth.base-readonly', '考题必验断言只读');
    }
    if ((stored.exam || meta.question) && meta.question?.deliverable && !same(result.film.output, stored.output)) {
      throw new ApiError('auth.base-readonly', '考题交付规格只读');
    }
    if ((stored.exam || meta.question) && meta.question?.deliverable?.audio === 'none') {
      if ((result.film.audio && result.film.audio.mode !== 'none') || (result.film.events ?? []).some(e => e.audio !== undefined)) {
        throw new ApiError('auth.base-readonly', '考题无声交付规格只读');
      }
    }
    if ((stored.exam || meta.question) && meta.question?.deliverable?.audio && meta.question.deliverable.audio !== 'none') {
      if (!result.film.audio || result.film.audio.mode === 'none') {
        throw new ApiError('auth.base-readonly', '考题有声交付规格只读');
      }
    }
    for (const alias of Object.keys(meta.question?.assets ?? {})) {
      const boundRef = stored.assets?.[alias] ?? stored.shots.find(s => s.assets && Object.hasOwn(s.assets, alias))?.assets[alias];
      if (!boundRef) continue;
      if (stored.assets && Object.hasOwn(stored.assets, alias) && result.film.assets?.[alias] !== boundRef) {
        throw new ApiError('auth.base-readonly', `考题主体资产 ${alias} 只读`);
      }
      if (result.film.assets && Object.hasOwn(result.film.assets, alias) && result.film.assets[alias] !== boundRef) {
        throw new ApiError('auth.base-readonly', `考题主体资产 ${alias} 只读`);
      }
      for (const s of stored.shots) {
        if (!s.assets || !Object.hasOwn(s.assets, alias)) continue;
        const ns = result.film.shots.find(x => x.id === s.id);
        if (!ns || ns.assets?.[alias] !== s.assets[alias] || (s.roles?.hero === alias && ns.roles?.hero !== alias)) {
          throw new ApiError('auth.base-readonly', `考题镜头主体 ${alias} 只读`);
        }
      }
    }
    const saved = await commit(id, result.film, result.rev);
    store.updateMeta(id, m => { delete m.pending; });
    return { data: { rev: result.rev, applied, lock: 'film.lock' }, diagnostics: [...checked.diagnostics, ...saved.diagnostics] };
  }

  async function dispatch(route, params, query, body, who, id, bearer) {
    const job = params.id;
    switch (route.id) {
      case 'guide': return { data: guideData() };
      case 'cards-search': {
        const items = registry.searchCards({ ...body, q: body.q ?? body.need });
        return { data: counted(items.slice(0, body.limit ?? 5), items.length) };
      }
      case 'card-get': {
        const card = registry.getCard(params.id);
        if (!card) throw missing('卡不存在');
        return { data: { card } };
      }
      case 'schema-get': return { data: schemaData(frozen.contracts, params.name) };
      case 'assets-search': {
        const { items, expectedCount } = searchAssets(body);
        return { data: counted(items, expectedCount) };
      }
      case 'films-create': return createFilm(body, who, bearer);
      case 'film-get': return { data: { rev: store.rev(id), film: store.readFilm(id) } };
      case 'film-put': return store.serial(id, () => writeFilm(id, body, query.get('applyFixes') === 'machine'));
      case 'film-files':
      case 'film-assets': return store.serial(id, async () => {
        let path, bytes;
        if (route.id === 'film-files') {
          if (!localTrusted) throw new ApiError('contract.unsupported-mode', '此工作区只接受 cards-data，请提交卡参数');
          path = params.path;
          if (!scriptPath.test(path)) throw new ApiError('contract.bad-path', '源码必须放在 shots 目录');
          const scan = scanShot({ [path]: body });
          if (scan.wallClock.length || scan.unseededRandom.length) throw new ApiError('contract.bad-value', 'L1 源码扫描未通过', { data: scan });
          bytes = Buffer.from(body);
        } else {
          path = `assets/${body.name}`;
          bytes = Buffer.from(body.data, 'base64');
          if (!bytes.length || bytes.toString('base64') !== body.data) throw bad('资产内容必须是有效的 base64');
        }
        store.workspace(id).resolve(path);
        const rev = store.rev(id) + 1;
        const { diagnostics } = await commit(id, store.readFilm(id), rev, { [path]: bytes });
        return { data: { rev, bytes: bytes.length, sha256: sha256(bytes), ...(route.id === 'film-assets' ? { asset: path, ref: uploadRef(body.name), kind: body.name.split('.').at(-1) } : { path }) }, diagnostics };
      });
      case 'explain': {
        const film = store.readFilm(id), path = query.get('path');
        const cardDefault = {}, coupling = {};
        for (const shot of film.shots) for (const instance of shot.cards ?? []) {
          const def = cards[instance.use.split('@')[0]];
          for (const [key, param] of Object.entries(def?.params ?? {})) {
            const address = `shots/${shot.id}/cards/${instance.as}/params/${key}`;
            cardDefault[address] = { from: instance.use, value: param.default, unit: param.unit };
            if (param.coupling && param.coupling !== 'none') coupling[address] = [param.coupling];
          }
        }
        return { data: explainParam(film, path, { cards, cardDefault, coupling, rev: store.rev(id) }) };
      }
      case 'render': case 'verify': case 'deliver': {
        const tier = body.tier ?? (route.id === 'deliver' ? 'final' : 'draft');
        const film = store.readFilm(id);
        if (route.id === 'verify') planOf(film, { shots: body.shots, tier: 'draft' });
        if (route.id === 'deliver' && (!film.delivery.web || !film.delivery.contact)) throw new ApiError('contract.delivery-mismatch', '六件套要求启用 delivery.web 和 delivery.contact');
        const plan = route.id === 'render' ? planOf(film, { ...body, tier }) : undefined;
        const waitSec = body.wait ?? (query.has('wait') ? Number(query.get('wait')) : 0);
        if (!Number.isInteger(waitSec) || waitSec < 0 || waitSec > 30) throw bad('wait 应为 0 到 30 秒');
        const jobId = work.submit(id, route.id, { ...body, tier, rev: store.rev(id), ...(plan && { plan }) });
        await work.wait(id, jobId, waitSec);
        return jobResult(work, id, jobId);
      }
      case 'job-get': {
        const seconds = Number(query.get('wait') ?? 0);
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw bad('wait 应为 0 到 30 秒');
        await work.wait(id, job, seconds, 'change');
        return jobResult(work, id, job);
      }
      case 'job-delete': return { data: { job, status: await work.cancel(id, job) } };
      case 'observe-query': return work.observeQuery(id, body);
      case 'observe-sheet': return work.observeSheet(id, body);
      case 'observe-metrics': return work.observeMetrics(id, body);
      case 'review': return work.review(id, body);
      case 'harvest': return { data: counted([]) };
      case 'ledger': return { data: counted(store.readLedger(id).reverse()) };
      default: throw missing('找不到这个动词');
    }
  }

  const server = createServer(async (req, res) => {
    const start = monotonicMs();
    let route, id, result, status = 200;
    try {
      const target = new URL(req.url, 'http://localhost');
      const match = matchRoute(req.method, target.pathname);
      route = match.route;
      if (!route) {
        if (!match.allowed.length) throw missing('路由不存在');
        res.setHeader('Allow', match.allowed.join(', '));
        throw new ApiError('usage.bad-argument', '此路径不支持该方法', { status: 405 });
      }
      const who = identify(dataDir, req.headers.authorization);
      const owner = route.auth === 'job' ? store.filmOfJob(match.params.id) : match.params.id;
      const denied = authorize(who, route, owner);
      if (denied) throw new ApiError('auth.base-readonly', denied);
      if (route.auth !== 'account') id = owner;
      if (route.binary) {
        const file = store.workspace(id).resolve(`deliver/${match.params.name}`);
        const stat = statSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) throw missing('产物文件不存在');
        res.writeHead(200, { 'content-type': /\.(json|lock)$/i.test(file) ? 'application/json; charset=utf-8' : 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'private, no-store' });
        await pipeline(createReadStream(file), res);
        return;
      }
      const body = await readBody(req, route);
      result = await dispatch(route, match.params, target.searchParams, body, who, id, /^Bearer\s+(\S+)$/.exec(req.headers.authorization?.trim() ?? '')?.[1]);
      if (route.id === 'films-create') id = result.data.film;
      if (result.ok === false) status = httpStatusOf(result.code);
    } catch (e) {
      if (res.headersSent || res.destroyed) return;
      const code = isRegistered(e.code) ? e.code : 'usage.bad-argument';
      status = e.status ?? (isRegistered(e.code) || e instanceof TypeError ? httpStatusOf(code) : 500);
      result = { ok: false, code, message: status === 500 ? '服务端处理失败' : e.message, hint: e.hint, data: e.data, diagnostics: e.diagnostics };
    }
    const wallMs = Math.round(monotonicMs() - start);
    const opts = { ...result, cost: { ...result.cost, wallMs } };
    let env = result.ok === false ? fail(result.code, result.message, opts) : ok(opts);
    const limit = route?.tokens ?? 600;
    const spill = id ? full => {
      const bytes = JSON.stringify(full);
      const name = `response-${sha256(bytes)}.json`;
      const file = store.workspace(id).resolve(`deliver/${name}`);
      writeFileSync(file, bytes);
      return { kind: 'response', url: artifactUrl(ROUTES, id, name) };
    } : undefined;
    // 留足 cost.tokens 的位数，再用最终序列化字节数回填。
    env.cost.tokens = limit;
    env = fitEnvelope(env, limit, spill);
    if (estimateTokens(env) > limit) {
      // 长错误文字或多件输出仍可能溢出，留下全文引用与可继续轮询的作业号。
      const full = env.outputs.find(o => o.kind === 'response');
      const summary = {
        cost: env.cost, outputs: full ? [full] : [],
        data: env.data.job ? { job: env.data.job, status: env.data.status } : { truncated: true },
      };
      env = env.ok ? ok(summary) : fail(env.error.code, env.error.code, summary);
      if (estimateTokens(env) > limit) env.outputs = [];
    }
    env.cost.tokens = estimateTokens(env);
    env.cost.tokens = estimateTokens(env);
    if (id) store.ledger(id, { step: route.id, ok: env.ok, wallMs, gpuSeconds: 0, tokens: env.cost.tokens, modelTokens: result.tokens ?? 0, frames: result.frames ?? 0 });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' });
    res.end(JSON.stringify(env));
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  const address = server.address();
  url = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  async function close() {
    const closed = new Promise((done, reject) => server.close(err => err ? reject(err) : done()));
    await work.cancelAll();
    await closed;
  }
  return { server, url, port: address.port, close };
}
