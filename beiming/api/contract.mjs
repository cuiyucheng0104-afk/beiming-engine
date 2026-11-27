// M1a HTTP 接口的单一来源合同：全部路由、方法、路径参数、请求与响应结构、各动词的 token 上限都只写在这里。
// openapi.json 由 buildOpenApi() 纯函数生成，不手改：node beiming/api/contract.mjs --write 重新生成，单测逐字节比对。
// 鉴权：account 是账户令牌；workspace 是这部片的工作区令牌；job 是作业所属那部片的工作区令牌。
import frozenEnvelope from '../kernel/contracts/envelope/schema/envelope.schema.json' with { type: 'json' };
import frozenFix from '../kernel/contracts/patch/schema/fix.schema.json' with { type: 'json' };
import frozenPatch from '../kernel/contracts/patch/schema/patch.schema.json' with { type: 'json' };
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const obj = (properties, required = [], extra = {}) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false, ...extra });
const looseObj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

const TIER = str({ enum: ['draft', 'final'] });
const SHOT_IDS = arr(str({ pattern: '^[a-z][a-z0-9_-]*$' }), { maxItems: 16 });
const FRAMES = arr(int({ minimum: 0 }), { maxItems: 64 });
// 核心帧源作业的预算：要渲的镜头里有 source: core 的必须给，入队之前判（sources/core/source.mjs 的 admitBudget）
const CORE_BUDGET = obj({ maxTriangles: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), spp: int({ minimum: 1, maximum: 2 ** 32 - 1 }), maxWallMs: int({ minimum: 1, maximum: 2 ** 31 - 1 }) },
  ['maxTriangles', 'spp', 'maxWallMs'], { description: '核心帧源作业的预算：场景包每帧画出来的三角形数上限、每像素采样数上限、整个作业的墙钟上限（毫秒）' });
const WAIT = int({ minimum: 0, maximum: 30, description: '同步等待作业结束的秒数，超时就先交回作业号' });
const COUNTED = (items) => looseObj({ expectedCount: int({ minimum: 0 }), actualCount: int({ minimum: 0 }), items }, ['expectedCount', 'actualCount']);
const JOB_DATA = looseObj({ job: str(), status: str({ enum: ['queued', 'running', 'succeeded', 'failed', 'canceled', 'stopped'] }), stage: { type: ['string', 'null'] } }, ['job', 'status']);

/** 全部路由。tokens 是这个动词响应信封序列化之后的 token 上限（null：返回的是文件字节，不是信封） */
export const ROUTES = Object.freeze([
  { id: 'guide', method: 'GET', path: '/v1/guide', auth: 'account', tokens: 1500, summary: '入口卡：动词总表、作者模式、两个最小样例、预算与红线',
    response: looseObj({ guide: str(), verbs: arr(str()), expectedCount: int(), actualCount: int() }, ['guide', 'verbs']) },
  { id: 'cards-search', method: 'POST', path: '/v1/cards/search', auth: 'account', tokens: 1500, perItemTokens: 300, summary: '查技术卡：最多 5 张摘要，每张不超过 300 token',
    request: obj({ q: str(), need: str(), kind: str(), livesIn: str(), source: str(), minLevel: int({ minimum: 0 }), limit: int({ minimum: 1, maximum: 5 }) }),
    response: COUNTED(arr(looseObj({ id: str(), version: str(), kind: str(), title: str(), intent: str() }))) },
  { id: 'card-get', method: 'GET', path: '/v1/cards/{id}', auth: 'account', tokens: 1500, summary: '卡全文：参数、单位、耦合、适用条件、入口、验证',
    params: { id: str({ description: '卡名，或 卡名@主版本' }) }, response: looseObj({ card: looseObj() }, ['card']) },
  { id: 'schema-get', method: 'GET', path: '/v1/schema/{name}', auth: 'account', tokens: 1500, summary: '冻结契约或谓词登记表的字段定义与正例摘要',
    params: { name: str({ description: '契约目录名（film、patch、envelope…）或 predicates' }) }, response: looseObj({ name: str(), fields: arr(looseObj()), example: {} }, ['name', 'fields']) },
  { id: 'assets-search', method: 'POST', path: '/v1/assets/search', auth: 'account', tokens: 600, summary: '查内置资产：资产编号、零件数、包围盒',
    request: obj({ q: str(), limit: int({ minimum: 1, maximum: 5 }) }), response: COUNTED(arr(looseObj({ id: str(), parts: int(), bbox: arr({ type: 'number' }) }))) },
  { id: 'films-create', method: 'POST', path: '/v1/films', auth: 'account', tokens: 600, summary: '建工作区：脚手架 film.json（rev 1）、注入 floor@1、交回工作区令牌；mode=delegate 要 brief，另交回编排作业号',
    request: obj({ mode: str({ enum: ['hands-on', 'delegate'] }), template: str({ enum: ['title', 'turntable'] }), exam: str({ pattern: '^[1-9][0-9]*-[1-9][0-9]*$' }),
      question: looseObj(), title: str(), brief: str(), asset: str(), assets: arr(str(), { maxItems: 16 }), text: str(),
      output: obj({ size: arr(int({ minimum: 2 }), { minItems: 2, maxItems: 2 }), fps: str(), frames: int({ minimum: 2 }) }),
      budget: obj({ tokens: int({ minimum: 1, maximum: 1200000, description: '委托模式单片 token 硬上限 120 万' }), gpuSeconds: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), wallSeconds: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }) }),
    response: looseObj({ film: str(), token: str(), rev: int(), scaffold: str(), base: arr(str()), job: str({ description: '委托模式的编排作业号' }) }, ['film', 'token', 'rev', 'base']) },
  { id: 'film-assets', method: 'POST', path: '/v1/films/{id}/assets', auth: 'workspace', tokens: 300, summary: '上传 .glb / .stl 网格资产到工作区 assets/',
    params: { id: str() }, bodyRequired: true, request: obj({ name: str({ pattern: '^[A-Za-z0-9_-]+\\.(glb|stl)$' }), data: str({ contentEncoding: 'base64' }) }, ['name', 'data']),
    response: looseObj({ asset: str(), ref: str(), bytes: int(), sha256: str(), kind: str() }, ['asset', 'bytes', 'sha256']) },
  { id: 'film-get', method: 'GET', path: '/v1/films/{id}/film', auth: 'workspace', tokens: 1500, summary: '读当前的片子描述和修订号',
    params: { id: str() }, response: looseObj({ rev: int(), film: looseObj() }, ['rev']) },
  { id: 'film-put', method: 'PUT', path: '/v1/films/{id}/film', auth: 'workspace', tokens: 800, summary: '交整份 film/3.0 或 patch/0.1（都带 rev）；L1 即检；签发这个修订号的 film.lock',
    params: { id: str() }, bodyRequired: true, query: { applyFixes: str({ enum: ['machine'] }) },
    request: { oneOf: [{ ...frozenPatch, $id: undefined },
      looseObj({ format: str({ const: 'film/3.0' }), rev: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, ['format', 'rev']), obj({ rev: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, ['rev'])] },
    response: looseObj({ rev: int(), latestRev: int(), lock: str(), applied: int() }) },
  { id: 'film-files', method: 'PUT', path: '/v1/films/{id}/files/{path}', auth: 'workspace', tokens: 800, summary: '交镜头脚本（按作者模式开放；默认只开 cards-data）',
    params: { id: str(), path: str({ description: '工作区里的相对路径，可以带 /' }) }, bodyRequired: true, request: str(), response: looseObj({ path: str(), bytes: int() }) },
  { id: 'explain', method: 'GET', path: '/v1/films/{id}/explain', auth: 'workspace', tokens: 300, summary: '一个参数的值从哪来：四层值、耦合、影响范围',
    params: { id: str() }, query: { path: str() }, requiredQuery: ['path'], response: looseObj() },
  { id: 'render', method: 'POST', path: '/v1/films/{id}/render', auth: 'workspace', tokens: 600, summary: '渲指定镜头和帧：进作业队列，完成后交每帧摘要',
    params: { id: str() }, query: { wait: WAIT }, request: obj({ shots: SHOT_IDS, frames: FRAMES, tier: TIER, wait: WAIT, budget: CORE_BUDGET }), response: JOB_DATA },
  { id: 'observe-query', method: 'POST', path: '/v1/films/{id}/observe/query', auth: 'workspace', tokens: 400, summary: '空间查询：entities、framing、texts、stats',
    params: { id: str() }, bodyRequired: true, request: obj({ type: str({ enum: ['entities', 'framing', 'texts', 'stats'] }), target: str({ minLength: 1 }), frame: int({ minimum: 0 }), tier: TIER }, ['type']), response: looseObj() },
  { id: 'observe-sheet', method: 'POST', path: '/v1/films/{id}/observe/sheet', auth: 'workspace', tokens: 300, summary: '联系表与切点条带',
    params: { id: str() }, request: obj({ cuts: { type: 'boolean' }, count: int({ minimum: 1, maximum: 24 }), tier: TIER }), response: looseObj() },
  { id: 'observe-metrics', method: 'POST', path: '/v1/films/{id}/observe/metrics', auth: 'workspace', tokens: 600, summary: '成片量测：交付规格、响度、黑帧冻结、切点、噪点残差与边缘锯齿',
    params: { id: str() }, request: obj({ metrics: arr(str({ enum: ['deliverSpec', 'audioLoudness', 'blackFreezeDup', 'cutYdif', 'cutScene', 'noiseResidual', 'aliasEdge'] })) }), response: looseObj() },
  { id: 'verify', method: 'POST', path: '/v1/films/{id}/verify', auth: 'workspace', tokens: 1000, summary: 'L1 → L2（纯函数门、编号层包围盒 IoU ≥ 0.95）→ L3（floor@1 与模板谓词、防削弱），先列判不过的和修法',
    params: { id: str() }, query: { wait: WAIT }, request: obj({ shots: SHOT_IDS, tier: TIER, wait: WAIT }), response: JOB_DATA },
  { id: 'review', method: 'POST', path: '/v1/films/{id}/review', auth: 'workspace', tokens: 1000, summary: 'L5 审片：异族视觉模型的意见与建议谓词；没配置时 status 是 not-run，不覆盖硬门',
    params: { id: str() }, request: obj({ brief: str() }), response: looseObj({ status: str({ enum: ['ok', 'not-run', 'failed'] }) }, ['status']) },
  { id: 'deliver', method: 'POST', path: '/v1/films/{id}/deliver', auth: 'workspace', tokens: 600, summary: '终渲全部镜头、出六件套，自动再过 L2–L5 写进 report.json',
    params: { id: str() }, query: { wait: WAIT }, request: obj({ tier: str({ enum: ['final'] }), wait: WAIT }), response: JOB_DATA },
  { id: 'harvest', method: 'POST', path: '/v1/films/{id}/harvest', auth: 'workspace', tokens: 600, summary: '收获：M1a 返回空候选列表',
    params: { id: str() }, request: obj({}), response: COUNTED(arr(looseObj())) },
  { id: 'ledger', method: 'GET', path: '/v1/films/{id}/ledger', auth: 'workspace', tokens: 600, summary: '账本：分步墙钟、显卡秒、token、帧数',
    params: { id: str() }, response: COUNTED(arr(looseObj())) },
  { id: 'artifacts', method: 'GET', path: '/v1/films/{id}/artifacts/{name}', auth: 'workspace', tokens: null, binary: true, summary: '只读产物文件（成片、联系表、报告、帧）',
    params: { id: str(), name: str({ description: '产物相对路径，可以带 /' }) } },
  { id: 'job-get', method: 'GET', path: '/v1/jobs/{id}', auth: 'job', tokens: 500, summary: '作业状态、阶段、最近 5 条事件、累计成本；?wait=30 长轮询',
    params: { id: str() }, query: { wait: int({ minimum: 0, maximum: 30 }) }, response: JOB_DATA },
  { id: 'job-delete', method: 'DELETE', path: '/v1/jobs/{id}', auth: 'job', tokens: 100, summary: '取消作业',
    params: { id: str() }, response: JOB_DATA },
]);

/** 路由里可以吃掉余下全部路径段的参数（带 / 的路径） */
const REST_PARAMS = new Set(['path', 'name']);

/** 按方法和路径找路由：返回 { route, params } 或 { route: null, allowed: [方法…] }（allowed 不空是路径对、方法不对） */
export function matchRoute(method, pathname) {
  const segs = pathname.split('/').slice(1);
  const allowed = [];
  for (const route of ROUTES) {
    const params = matchPath(route.path.split('/').slice(1), segs);
    if (!params) continue;
    if (route.method === method) return { route, params };
    allowed.push(route.method);
  }
  return { route: null, allowed };
}

function matchPath(want, segs) {
  const params = {};
  for (let i = 0; i < want.length; i++) {
    const m = /^\{(\w+)\}$/.exec(want[i]);
    if (m && REST_PARAMS.has(m[1]) && i === want.length - 1) {
      const rest = segs.slice(i);
      if (!rest.length || rest.some((s) => !s)) return null;
      try { params[m[1]] = rest.map((s) => decodeURIComponent(s)).join('/'); } catch { return null; }
      return params;
    }
    if (segs[i] === undefined || segs[i] === '') return null;
    if (m) {
      try { params[m[1]] = decodeURIComponent(segs[i]); } catch { return null; }
    } else if (segs[i] !== want[i]) return null;
  }
  return segs.length === want.length ? params : null;
}

const ENVELOPE_REF = { $ref: '#/components/schemas/Envelope' };

// 把冻结契约的相对引用换成独立 OpenAPI 文档内的引用。
const { $id: envelopeId, ...ENVELOPE_SCHEMA } = structuredClone(frozenEnvelope);
ENVELOPE_SCHEMA.properties.diagnostics.items.properties.fix = { $ref: '#/components/schemas/Fix' };
const { $id: fixId, ...FIX_SCHEMA } = frozenFix;

/** 纯函数：由 ROUTES 生成 OpenAPI 3.1 描述对象 */
export function buildOpenApi() {
  const paths = {};
  for (const r of ROUTES) {
    const params = [
      ...Object.entries(r.params ?? {}).map(([name, schema]) => ({ name, in: 'path', required: true, schema })),
      ...Object.entries(r.query ?? {}).map(([name, schema]) => ({ name, in: 'query', required: r.requiredQuery?.includes(name) ?? false, schema })),
    ];
    const op = {
      operationId: r.id, summary: r.summary, ...(r.response === JOB_DATA && { description: 'status 表示队列执行状态。succeeded 表示执行结束，核验或交付的业务结果见信封 ok、error 和 data.layers。' }), security: [{ bearer: [] }],
      'x-auth': r.auth, 'x-token-limit': r.tokens, ...(r.perItemTokens ? { 'x-item-token-limit': r.perItemTokens } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(r.request ? { requestBody: { required: Boolean(r.bodyRequired), content: r.request.type === 'string' ? { 'text/plain': { schema: r.request } } : { 'application/json': { schema: r.request } } } } : {}),
      responses: r.binary
        ? { 200: { description: '文件字节', content: { 'application/octet-stream': { schema: str({ format: 'binary' }) }, 'application/json': { schema: {} } } }, default: { description: '失败信封', content: { 'application/json': { schema: ENVELOPE_REF } } } }
        : { 200: { description: '成功信封', content: { 'application/json': { schema: { allOf: [ENVELOPE_REF, { properties: { data: { anyOf: [r.response, looseObj({ truncated: { const: true } }, ['truncated'])] } } }] } } } }, default: { description: '失败信封', content: { 'application/json': { schema: ENVELOPE_REF } } } },
      ...(r.response ? { 'x-data-schema': r.response } : {}),
    };
    paths[r.path] ??= {};
    paths[r.path][r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'beiming M1a HTTP API', version: '0.1.0', description: '北冥 M1a 动词。所有 JSON 响应是 envelope/0.1 信封；错误码只取 errors.json 里登记过的。由 beiming/api/contract.mjs 生成，不要手改。' },
    servers: [{ url: 'http://127.0.0.1:0' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Envelope: ENVELOPE_SCHEMA, Fix: FIX_SCHEMA } },
    paths,
  };
}

/** openapi.json 的字节：两格缩进加结尾换行 */
export const openApiText = () => `${JSON.stringify(buildOpenApi(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(new URL('./openapi.json', import.meta.url), openApiText());
}
