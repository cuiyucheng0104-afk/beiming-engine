// 入口卡：GET /v1/guide 的正文。一段纯文本，动词总表直接由合同生成（不手抄），保证改合同后入口卡跟着变。
// 整个响应信封序列化之后按 estimateTokens 不超过 1500 token，由单测硬卡。
import { turntableShot } from './films.mjs';
import { ROUTES } from './contract.mjs';

/** 动词总表的一行：方法 路径（工作区令牌的路由带 W，作业路由带 J） */
const verbLine = (r) => `${r.method} ${r.path}${r.auth === 'workspace' ? ' W' : r.auth === 'job' ? ' J' : ''}`;

export const VERBS = Object.freeze(ROUTES.map((r) => `${r.method} ${r.path}`));

const THREE_SAMPLE = {
  id: 's01', in: 0, out: 60, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', seed: 1001,
  cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'RTX 5090', enter: 0, settleFrames: 0, heightFrac: 0.16 } }],
  roles: { hero: 'title' }, deliberate: [{ kind: 'freeze', in: 0, out: 60, why: 'hold' }],
};

const BLENDER_SAMPLE = turntableShot('s01', 0, 30, 1001);

/** 入口卡全文 */
export function guideText() {
  return [
    '# beiming M1a guide',
    '令牌：Authorization: Bearer <令牌>。账户令牌调前 6 个动词；POST /v1/films 交回工作区令牌，只管这一部片（W）和它的作业（J）。',
    '所有 JSON 响应是 envelope/0.1：先看 ok、error.code、diagnostics（fix 可直接当补丁）、next。',
    '## 动词',
    ...ROUTES.map(verbLine),
    '委托：POST films 带 mode=delegate、brief，可给 assets 和 budget（tokens 上限 120 万、gpuSeconds、wallSeconds）。用工作区令牌 GET jobs/{id}?wait=30；stopped 看 stoppedReason、stoppedAt、bestRev、cost。可选 L5 推迟到另行 POST review，不计入本次委托。',
    '## 作者模式',
    '默认 cards-data：只写 film.json 的数据（卡、参数、时刻），不交脚本；PUT files 交脚本会被拒（contract.unsupported-mode）。local-trusted 要服务器开启，入库前跑 L1 源码扫描。',
    '## 样例 three（cards-data）',
    JSON.stringify(THREE_SAMPLE),
    '## 样例 blender（建片时 template=turntable、asset=asset:rtx-card@1，cards-data）',
    JSON.stringify(BLENDER_SAMPLE),
    '## 闭环',
    '1 guide 2 POST films 3 assets/search 4 cards/search 5 GET cards/{id} 6 PUT film（补丁 patch/0.1 带 rev）看诊断 7 PUT film?applyFixes=machine 8 PUT files（cards-data 不用）9 render{tier:draft} 10 observe/query 11 verify 12 改了再验 13 observe/sheet{cuts:true} 14 deliver 15 GET jobs/{id}?wait=30 16 收获自动触发。',
    '补丁：{"format":"patch/0.1","rev":<当前>,"ops":[{"op":"set","path":"shots/s01/cards/title/params/text","value":"HELLO"}]}；路径不带前导 /，数组按 id（卡按 as）。',
    '入参：cards/search与assets/search用{"q":"...","limit":5}；POST films用{"template":"turntable","text":"RTX 5090","output":{"size":[1920,1080],"fps":"30/1","frames":300}}；observe/query用{"type":"framing","target":"hero"}或{"type":"entities","frame":0}；render/verify/deliver用{"wait":30}。',
    '## 预算与红线',
    '每个动词有 token 上限（openapi.json 的 x-token-limit），超了 data 被截短，全文挂在 outputs。render/verify/deliver 是作业：带 wait（≤30 秒）或轮询 GET /v1/jobs/{id}。',
    'rev 过期 → busy.rev-conflict（带 latestRev，重读再改）。predicates.base 和 exam 只读（auth.base-readonly）；不许删 floor@1、改主角、改阈值。',
    '审片（review）没配置模型时 status=not-run，从不冒充通过；L5 只是意见，不改硬门。只能调 /v1/*。',
  ].join('\n');
}

/** GET /v1/guide 的 data */
export function guideData() {
  return { guide: guideText(), verbs: [...VERBS], expectedCount: VERBS.length, actualCount: VERBS.length };
}
