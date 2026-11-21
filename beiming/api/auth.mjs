// 两级令牌。账户令牌由管理员在服务器上签发（cli.mjs issue-token 或 issueAccountToken），能查卡、查资产、建工作区；
// 工作区令牌由 POST /v1/films 签发，只能动那一部片。令牌只存 SHA-256 摘要，明文只在签发时交回一次。
// 拒绝一律是 auth.base-readonly（errors.json 里唯一的 auth. 码），HTTP 403。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const digest = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const TOKEN_RE = /^bm(a|w)_[0-9a-f]{48}$/;

function load(file) {
  if (!existsSync(file)) return { format: 'api-auth/0.1', accounts: [], workspaces: {} };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data?.format !== 'api-auth/0.1' || !Array.isArray(data.accounts) || typeof data.workspaces !== 'object') throw new Error('令牌表损坏');
  return data;
}

function save(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** 令牌表文件放在数据目录下的 auth.json */
export const authFile = (dataDir) => join(dataDir, 'auth.json');

/** 管理员签发账户令牌：交回明文令牌（只这一次），表里只留摘要 */
export function issueAccountToken(dataDir, { name = 'account' } = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new TypeError('账户名只收 1 到 64 个 ASCII 字母、数字、_ . -');
  const file = authFile(dataDir);
  const data = load(file);
  const token = `bma_${randomBytes(24).toString('hex')}`;
  data.accounts.push({ name, sha256: digest(token) });
  save(file, data);
  return token;
}

/** 签发一部片的工作区令牌（建片时由服务器调用） */
export function issueWorkspaceToken(dataDir, filmId, { account } = {}) {
  const file = authFile(dataDir);
  const data = load(file);
  const token = `bmw_${randomBytes(24).toString('hex')}`;
  data.workspaces[filmId] = { sha256: digest(token), ...(account ? { account } : {}) };
  save(file, data);
  return token;
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/**
 * 认 Authorization 头。交回 { kind: 'account', name } 或 { kind: 'workspace', filmId }；认不出交回 null。
 * 每次都读盘：管理员用命令行新签的令牌不用重启服务。
 */
export function identify(dataDir, header) {
  const m = /^Bearer\s+(\S+)$/.exec(typeof header === 'string' ? header.trim() : '');
  if (!m || !TOKEN_RE.test(m[1])) return null;
  const token = m[1];
  const data = load(authFile(dataDir));
  const h = digest(token);
  if (token.startsWith('bma_')) {
    const hit = data.accounts.find((a) => same(a.sha256, h));
    return hit ? { kind: 'account', name: hit.name } : null;
  }
  for (const [filmId, w] of Object.entries(data.workspaces)) if (same(w.sha256, h)) return { kind: 'workspace', filmId };
  return null;
}

/**
 * 判一次调用能不能做：route.auth 是 account | workspace | job。filmId 是路径里的片子（job 路由是作业所属的片子）。
 * 交回 null 表示放行，否则交回拒绝原因（文字）。
 */
export function authorize(who, route, filmId) {
  if (!who) return '没有带有效的令牌（Authorization: Bearer <令牌>）';
  if (route.auth === 'account') return who.kind === 'account' ? null : '这个动词要账户令牌，工作区令牌不能用';
  if (who.kind !== 'workspace') return '这个动词要这部片的工作区令牌（POST /v1/films 交回的 token）';
  if (filmId === undefined || who.filmId !== filmId) return '工作区令牌只能访问它自己那部片';
  return null;
}
