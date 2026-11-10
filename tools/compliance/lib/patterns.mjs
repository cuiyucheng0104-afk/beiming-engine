// 北冥仓库 · 合规扫描的内容规则：密钥与令牌、敏感文件名、本机路径、内网地址、带签名的链接、个人邮箱、FSL 文本误入 MIT 目录。
// 接口：
//   CONTENT_RULES：[{ id, title, hint, scan(text, rel) → [{ index, length, level, message, redacted }] }]
//     level 是在仓库主体（tree）里的级别；归档区（cases/source、cases/vendor）一律降为 warn，由调用方处理。
//   checkFileName(rel) → [{ level, message, hint }]：敏感文件名（.env、私钥、证书包）。
//   redact(s)：遮蔽令牌，只保留前 4 个字符与长度。
// 所有规则都不输出密钥原文、签名参数值与完整个人邮箱。规则源码里的关键字用拼接写法，避免扫描器扫到自己。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

export const redact = s => (s.length <= 6 ? '*'.repeat(s.length) : `${s.slice(0, 4)}…(${s.length} 字符，已遮蔽)`);

const mixedEnough = s => /[0-9]/.test(s) && /[A-Za-z]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);

// ── 密钥与令牌 ──
// 高置信度：格式本身就能认出来的令牌。命中即 error（归档区 warn）。
const SECRET_PATTERNS = [
  { name: 'OpenAI / Anthropic 风格 API 密钥', re: /\bsk-(?:proj-|ant-[a-z]+\d*-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    ok: m => mixedEnough(m.replace(/^sk-[a-z]+-/, '')) },
  { name: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'AWS AccessKeyId', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: '阿里云 AccessKeyId', re: /\bLTAI[0-9A-Za-z]{12,30}\b/g },
  { name: '火山引擎 AccessKeyId', re: /\bAKLT[0-9A-Za-z_-]{20,}\b/g },
  { name: '腾讯云 SecretId', re: /\bAKID[0-9A-Za-z]{13,40}\b/g, ok: mixedEnough },
  { name: 'Google API 密钥', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack 令牌', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'Stripe 正式环境密钥', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { name: 'Hugging Face 令牌', re: /\bhf_[A-Za-z0-9]{34,}\b/g, ok: mixedEnough },
  { name: 'JWT（含载荷的令牌）', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: '私钥', re: new RegExp('-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?' + 'PRIVATE KEY(?: BLOCK)?-----', 'g') },
];
// 低置信度：形如 api_key = "…" 的赋值，值看起来像随机串。只给 warn，避免把示例和测试当成泄露。
const GENERIC_ASSIGN = /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["']([A-Za-z0-9/+_=.-]{20,})["']/gi;
const BEARER = /\bAuthorization["']?\s*[:=]?\s*["']?Bearer\s+([A-Za-z0-9._~+/=-]{24,})/g;
const PLACEHOLDER = /^(?:x+|\*+|your|example|changeme|placeholder|dummy|test|fake|sample|redacted|<|\$\{|\$[A-Z_])/i;

function scanSecrets(text) {
  const out = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    for (let m; (m = p.re.exec(text));) {
      if (p.ok && !p.ok(m[0])) continue;
      out.push({ index: m.index, length: m[0].length, level: 'error', message: `疑似${p.name}：${redact(m[0])}`, redacted: redact(m[0]) });
    }
  }
  for (const re of [GENERIC_ASSIGN, BEARER]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      const v = m[2] || m[1];
      if (PLACEHOLDER.test(v) || !mixedEnough(v)) continue;
      out.push({ index: m.index, length: m[0].length, level: 'warn', message: `疑似写在源码里的凭据（${re === BEARER ? 'Bearer 令牌' : m[1]}）：${redact(v)}`, redacted: redact(v) });
    }
  }
  return out;
}

// ── 敏感文件名 ──
const ENV_OK = /^\.env\.(example|sample|template|dist)$/i;
export function checkFileName(rel) {
  const base = rel.split('/').pop();
  const lower = base.toLowerCase();
  const hit = (message) => [{ level: 'error', message, hint: '从仓库删除这个文件（新提交里 git rm --cached），凭据立即作废重发；忽略规则交集成负责人加进 .gitignore' }];
  if (/^\.env(\..+)?$/i.test(base) && !ENV_OK.test(base)) return hit(`环境变量文件 ${base} 不应入库（常含密钥）`);
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i.test(lower) && !/\.pub\.(asc|gpg)$/i.test(lower)) return hit(`证书或私钥类文件 ${base} 不应入库`);
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower)) return hit(`SSH 私钥文件 ${base} 不应入库`);
  if (['.netrc', '.git-credentials', '.pypirc', 'credentials.json', 'service-account.json'].includes(lower)) return hit(`凭据文件 ${base} 不应入库`);
  return [];
}
// .npmrc 只在写了令牌时算敏感（内容规则里查）。
const NPMRC_TOKEN = /_authToken\s*=\s*(?!\$\{)[^\s]+/g;

// ── 本机绝对路径 ──
const HOME_PLACEHOLDER = new Set(['shared', 'someone', 'you', 'me', 'user', 'username', 'name', 'xxx', 'example', 'runner',
  'your-name', 'yourname', 'your_name', 'foo', 'bar', 'admin', 'ubuntu', 'test', 'demo', '<user>', '<you>', '<name>', '$user', '${user}', '%username%', '*']);
// 尖括号占位（<you>、<用户名>、<名> 等，任何语言）不会是真实账号：macOS 与 Linux 的账号名都不能含尖括号
const isHomePlaceholder = name => HOME_PLACEHOLDER.has(name.toLowerCase()) || /^<[^<>/]+>$/.test(name);
const WIN_SYSTEM = /^(windows|program files|programdata)(?![\w-])/i;
const REGEX_ESC = /^[sdwbSDWBntrfv0]([+*?{}()[\]|^$\\.,:;'"`)\s]|$)/;
const PATH_RULES = [
  { re: /\/Users\/([A-Za-z0-9._$<>{}%*-][^/\s"'`()\[\]|\\]*)\//g, check: m => !isHomePlaceholder(m[1]), what: m => `macOS 用户目录（/Users/${m[1].slice(0, 2)}…）` },
  { re: /(?<![\w.])\/home\/([a-z_][a-z0-9_.-]*)\//g, check: m => !isHomePlaceholder(m[1]), what: () => 'Linux 用户目录（/home/…）' },
  { re: /\/(?:private\/)?tmp\/claude-[\w.-]*/g, what: () => 'Claude 会话临时目录（/tmp/' + 'claude-…）' },
  { re: /\/private\/var\/folders\/[\w+]{2}\//g, what: () => 'macOS 用户临时目录（/private/var/folders/…）' },
  { re: /(?<![\w$])~\/(?:\.claude|\.ssh|Desktop|Documents|Downloads|Library\/Mobile Documents)(?=[/\s"'`)]|$)/g, what: m => `家目录下的个人目录（${m[0]}）` },
  { re: /(?:\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[\\/](?:Desktop|Documents|Downloads|\.ssh|\.claude)\b/gi, what: m => `家目录下的个人目录（${m[0]}）` },
  { re: /(?<![\w/])\/mnt\/[a-z]\/(?=\S)/g, what: () => 'WSL 挂载的本机盘符（/mnt/<盘>/）' },
  { re: /\\\\wsl(?:\$|\.localhost)\\/gi, what: () => 'WSL 网络路径（\\\\' + 'wsl$…）' },
  { // Windows 盘符路径：盘符加冒号再接反斜杠或斜杠（D 盘下的项目目录、C 盘的 Users 目录等）。系统目录（Windows、Program Files）不算本机隐私。
    re: /(?<![A-Za-z0-9_])([A-Za-z]):(?:\\\\|\\|\/)(?!\/)([^\\/\s"'`<>|?*\]),;]+)((?: [^\\/"'`<>|?*\]),;]+)*)/g,
    check: m => {
      const seg = m[2];
      if (WIN_SYSTEM.test((m[2] + (m[3] || '')).trim())) return false;
      if (REGEX_ESC.test(seg)) return false;                 // 正则里的 I:\s+ 之类
      if (/^\d/.test(seg) && m[0].includes('/')) return false; // 时间、比例写法
      if (WIN_SYSTEM.test(seg)) return false;
      if (/^users$/i.test(seg)) return true;
      return /[\p{L}\p{N}_]/u.test(seg[0]) && seg.length >= 2;
    },
    what: m => `Windows 本机路径（${m[1]}:\\${m[2].slice(0, 12)}）`,
  },
];
function scanLocalPaths(text) {
  const out = [];
  for (const r of PATH_RULES) {
    r.re.lastIndex = 0;
    for (let m; (m = r.re.exec(text));) {
      if (r.check && !r.check(m)) continue;
      out.push({ index: m.index, length: m[0].length, level: 'error', message: `本机路径：${r.what(m)}` });
    }
  }
  return out;
}

// ── 内网地址与拓扑 ──
const IPV4 = /(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.]*\d)/g;
function privateKind(ip) {
  const p = ip.split('.').map(Number);
  if (p.some(n => n > 255)) return null;
  if (p[0] === 10) return '10.0.0.0/8';
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return '172.16.0.0/12';
  if (p[0] === 192 && p[1] === 168) return '192.168.0.0/16';
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return '100.64.0.0/10（CGNAT / Tailscale）';
  if (p[0] === 169 && p[1] === 254) return '169.254.0.0/16（链路本地）';
  return null;
}
// 标准网段的名字本身（如 RFC 1918 的三段、CGNAT、链路本地，写成「网络地址/前缀」）是公开常识，不是拓扑泄露，不报；
// 具体的主机地址与非标准的子网（如某个 /24）照报。
const CANONICAL_RANGES = new Set([[10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16], [100, 64, 0, 0, 10], [169, 254, 0, 0, 16]]
  .map(([a, b, c, d, n]) => `${a}.${b}.${c}.${d}/${n}`));
const ULA6 = /(?<![0-9a-f:])fd[0-9a-f]{2}:[0-9a-f]{0,4}:[0-9a-f:]*[0-9a-f](?![0-9a-f:])/gi;
const TAILNET = /\b[a-z0-9-]+\.(?:[a-z0-9-]+\.)?ts\.net\b/gi;
// 局域网主机名：只认地址里的写法（user@主机、//主机），免得把 settings.local.json 这类文件名当成主机
const LAN_HOST = /(?:@|\/\/)([a-z0-9][a-z0-9-]*\.(?:local|lan|internal|intranet|corp|home\.arpa))(?![\w.-])/gi;
const SSH_TARGET = /\b(?:ssh|scp|rsync|sftp)\s+(?:-[A-Za-z]+(?:\s+\S+)?\s+)*([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/g;
function scanPrivateNetwork(text) {
  const out = [];
  IPV4.lastIndex = 0;
  for (let m; (m = IPV4.exec(text));) {
    const kind = privateKind(m[1]);
    const cidr = /^\/(\d{1,2})(?!\d)/.exec(text.slice(m.index + m[1].length, m.index + m[1].length + 4));
    if (cidr && CANONICAL_RANGES.has(`${m[1]}/${cidr[1]}`)) continue;
    if (kind) out.push({ index: m.index, length: m[1].length, level: 'error', message: `内网地址 ${m[1].split('.').slice(0, 2).join('.')}.x.x（${kind}）` });
  }
  ULA6.lastIndex = 0;
  for (let m; (m = ULA6.exec(text));) {
    if ((m[0].match(/:/g) || []).length >= 2) out.push({ index: m.index, length: m[0].length, level: 'error', message: '内网 IPv6 地址（fd00::/8，常见于 Tailscale）' });
  }
  TAILNET.lastIndex = 0;
  for (let m; (m = TAILNET.exec(text));) out.push({ index: m.index, length: m[0].length, level: 'error', message: 'Tailscale 内网主机名（*.ts.net）' });
  LAN_HOST.lastIndex = 0;
  for (let m; (m = LAN_HOST.exec(text));) out.push({ index: m.index, length: m[0].length, level: 'error', message: `局域网主机名（*.${m[1].split('.').slice(1).join('.')}）` });
  SSH_TARGET.lastIndex = 0;
  for (let m; (m = SSH_TARGET.exec(text));) {
    const host = m[2].toLowerCase();
    if (/^(example\.(com|org)|host|server|localhost|<.*)$/.test(host) || /^(user|you|me|git)$/i.test(m[1])) continue;
    out.push({ index: m.index, length: m[0].length, level: 'warn', message: `SSH 登录目标写进了仓库（${m[1].slice(0, 2)}…@${host.slice(0, 3)}…）` });
  }
  return out;
}

// ── 带签名查询串的链接 ──
const URL_RE = /https?:\/\/[^\s"'<>`\\)\]]+/g;
const SIGN_PARAMS = ['OSSAccessKeyId', 'AccessKeyId', 'Signature', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token',
  'X-Goog-Signature', 'X-Goog-Credential', 'x-oss-signature', 'x-oss-credential', 'X-Tos-Signature', 'X-Tos-Credential',
  'q-signature', 'auth_key'];
const SIGN_SET = new Set(SIGN_PARAMS);
export function signedUrlInfo(url) {
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = url.slice(q + 1).split(/&(?:amp;)?/).map(kv => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  });
  const names = params.map(([k]) => k);
  const signed = names.filter(n => SIGN_SET.has(n));
  const azure = names.includes('sig') && (names.includes('se') || names.includes('sv'));
  if (!signed.length && !azure) return null;
  const get = n => (params.find(([k]) => k === n) || [])[1];
  let expires = null;
  const ex = get('Expires') || get('x-oss-expires');
  if (ex && /^\d{9,11}$/.test(ex)) expires = new Date(Number(ex) * 1000);
  const amzDate = get('X-Amz-Date'), amzExp = get('X-Amz-Expires');
  if (!expires && amzDate && /^\d{8}T\d{6}Z$/.test(amzDate) && /^\d+$/.test(amzExp || '')) {
    const d = amzDate;
    expires = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15)) + Number(amzExp) * 1000);
  }
  if (!expires && azure && get('se')) { const t = Date.parse(decodeURIComponent(get('se'))); if (!Number.isNaN(t)) expires = new Date(t); }
  let host = '';
  try { host = new URL(url).host; } catch { host = url.slice(0, q).replace(/^https?:\/\//, '').split('/')[0]; }
  return { host, params: azure ? [...signed, 'sig'] : signed, queryStart: q, expires };
}
function scanSignedUrls(text, rel, { now = Date.now() } = {}) {
  const out = [];
  URL_RE.lastIndex = 0;
  for (let m; (m = URL_RE.exec(text));) {
    const info = signedUrlInfo(m[0]);
    if (!info) continue;
    const state = info.expires ? (info.expires.getTime() < now ? `已于 ${info.expires.toISOString().slice(0, 10)} 过期` : `有效期到 ${info.expires.toISOString().slice(0, 10)}，尚未过期`) : '看不出有效期';
    out.push({ index: m.index, length: m[0].length, level: 'error', message: `带签名查询串的链接：${info.host}（${info.params.join('、')}；${state}）`,
      meta: { host: info.host, params: info.params, expires: info.expires ? info.expires.toISOString() : null, expired: info.expires ? info.expires.getTime() < now : null, queryOffset: m.index + info.queryStart } });
  }
  return out;
}

// ── 个人邮箱 ──
const PERSONAL_DOMAINS = /@(gmail|googlemail|qq|foxmail|163|126|yeah|sina|sohu|aliyun|139|189|outlook|hotmail|live|msn|icloud|me|mac|yahoo|proton|protonmail|gmx|yandex)\.(com|cn|net|me|ch|ru|de|com\.cn|co\.jp)\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
export const maskEmail = e => { const [u, d] = e.split('@'); return `${u.slice(0, 2)}…@${d}`; };
export const isPersonalEmail = e => PERSONAL_DOMAINS.test(e) && !/noreply|no-reply/i.test(e);
// GitHub noreply 地址要带账号数字 ID（<数字>+<用户名>@users.noreply.github.com）才会关联到账号；不带 ID 的旧写法给提示。
export const isUnlinkedNoreply = e => /@users\.noreply\.github\.com$/i.test(e || '') && !/^\d+\+/.test(e);
// 许可与署名文件里的作者邮箱是署名义务的一部分（OFL 等要求原样保留版权行），不报。
const ATTRIBUTION_FILE = /(^|\/)([^/]*OFL[^/]*\.(txt|md)|LICEN[CS]E[^/]*|COPYING[^/]*|NOTICE[^/]*|AUTHORS[^/]*|CREDITS[^/]*|CONTRIBUTORS[^/]*)$/i;
function scanEmails(text, rel) {
  const out = [];
  if (ATTRIBUTION_FILE.test(rel)) return out;
  EMAIL_RE.lastIndex = 0;
  for (let m; (m = EMAIL_RE.exec(text));) {
    if (isPersonalEmail(m[0])) out.push({ index: m.index, length: m[0].length, level: 'error', message: `个人邮箱：${maskEmail(m[0])}` });
  }
  return out;
}

// ── FSL 文本 / 上游 FSL 版权行出现在 MIT 目录的代码里 ──
const CODE_EXT = /\.(m?js|cjs|jsx|ts|tsx|py|rs|wgsl|wesl|glsl|vert|frag|sh|ps1|toml)$/i;
// 关键字一律拼接书写：本文件自己也是 MIT 目录里的代码，不能让扫描器扫到自己。
const FSL_MARKERS = [
  { re: new RegExp('Functional ' + 'Source License', 'g'), what: 'FSL 许可正文标题', verbatim: false },
  { re: new RegExp('\\bFSL-1\\.1-(?:ALv2|MIT|Apache-2\\.0)\\b', 'g'), what: 'FSL 许可标识', verbatim: false },
  { re: new RegExp('Copy' + 'right 2026 Shane' + ' Murphy', 'g'), what: '上游 RAEA 的版权行', verbatim: false },
  { re: new RegExp('A Competing' + ' Use means', 'g'), what: 'FSL「Competing Use」条款原文', verbatim: true },
];
const FSL_HEADER = new RegExp('SPDX-' + 'License-Identifier:\\s*LicenseRef-' + 'FSL-1\\.1-ALv2');
// 上游 RAEA 是 Rust + WESL 写的；本仓库自己没有 Rust / WESL 代码，出现这类文件先确认是不是搬了上游源码。
const UPSTREAM_SHAPE = /\.(rs|wesl)$|(^|\/)Cargo\.(toml|lock)$/i;
function scanFsl(text, rel) {
  const out = [];
  const code = CODE_EXT.test(rel);
  if (FSL_HEADER.test(text)) return out;     // 已按派生代码单独标注许可
  if (UPSTREAM_SHAPE.test(rel)) {
    out.push({ index: 0, length: 0, level: 'error', message: '仓库主体出现 Rust / WESL 源码或 Cargo 清单：本仓库自己不写这类代码，先确认不是搬进来的上游 RAEA 源码',
      hint: '是上游源码就删掉（运行时与 SDK 不随本仓库分发，见 docs/rights/fsl-boundary.md）；确是自己写的，在文件头写 SPDX 许可与版权两行，并在允许清单里登记理由' });
  }
  for (const f of FSL_MARKERS) {
    f.re.lastIndex = 0;
    for (let m; (m = f.re.exec(text));) {
      // 文档里讨论 FSL 是允许的（许可说明、署名区块）；只有逐字搬运的条款原文在文档里给 warn。
      if (code) out.push({ index: m.index, length: m[0].length, level: 'error', message: `MIT 目录的代码里出现${f.what}` });
      else if (f.verbatim) out.push({ index: m.index, length: m[0].length, level: 'warn', message: `文档里逐字出现${f.what}` });
    }
  }
  return out;
}

export const CONTENT_RULES = [
  { id: 'comp.secrets', title: '密钥、令牌与私钥', scan: (t, rel) => {
      const out = scanSecrets(t);
      if (rel.split('/').pop() === '.npmrc') { NPMRC_TOKEN.lastIndex = 0; for (let m; (m = NPMRC_TOKEN.exec(t));) out.push({ index: m.index, length: m[0].length, level: 'error', message: '.npmrc 里写了 _authToken' }); }
      return out;
    },
    hint: '把凭据移到环境变量或本机配置（不入库），并立即作废重发；历史里已公开的按 SECURITY.md 处理（D02：不改写历史）' },
  { id: 'comp.local-paths', title: '本机绝对路径', scan: scanLocalPaths,
    hint: '改成仓库相对路径、环境变量（如 $BEIMING_ROOT、$RAEA_BIN）或占位符（如 /path/to/…）；示例写 /Users/<you>/…' },
  { id: 'comp.private-network', title: '内网地址与内网主机', scan: scanPrivateNetwork,
    hint: '改用环境变量或占位符（如 $RTX_HOST、<工作站地址>）；工作站的真实地址只放本机配置' },
  { id: 'comp.signed-urls', title: '带签名查询串的链接', scan: scanSignedUrls,
    hint: '去掉 ? 之后的查询串（签名、AccessKeyId、Expires），只留对象地址；需要可下载时改用 Release 或仓库清单里的地址' },
  { id: 'comp.personal-email', title: '个人邮箱', scan: scanEmails,
    hint: '删掉或改成 GitHub noreply 地址（<id>+<用户名>@users.noreply.github.com）；署名用名字即可' },
  { id: 'comp.fsl-boundary', title: 'FSL 文本误入 MIT 目录', scan: scanFsl,
    hint: '不要把上游原生运行时 RAEA 的源码或许可正文搬进本仓库；确属派生的文件要加 LicenseRef 形式的 FSL 许可头并登记，写法见 docs/rights/fsl-boundary.md' },
];
export const NAME_RULE = { id: 'comp.sensitive-files', title: '不应入库的敏感文件',
  hint: '从仓库删除（新提交里 git rm --cached <文件>），凭据作废重发；忽略规则交集成负责人加进 .gitignore' };
