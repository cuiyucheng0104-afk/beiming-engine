// 北冥仓库 · 作品描述的轻量规则：占位符、作品名与片名的写法、film.json（v1 / v2）的结构自检。
// new-film 生成前用它自检，repo-check 用它查模版与 films/；字段的完整语义校验以作品描述包的
// engine/production/film.js 为准（附录 C6），这里只拦「一眼就错」的结构问题，不重复实现那边的规则。
//
// 占位符 = 两层花括号包住的大写标识符，中间不能有空格：{{NAME}}、{{TITLE}}。
// 所以 JSX 的 style={{ color: P.ink }}、style={{}}、{{a}} 都不是占位符，不会被误报。
export const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
export const ALLOWED_PLACEHOLDERS = Object.freeze(['NAME', 'TITLE']);

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const UPSTREAM_NAME_RE = /raea/i;
const TITLE_FORBIDDEN = /["'`\\<>\u0000-\u001f\u007f\u2028\u2029]/;

/** 文本里所有占位符：[{ name, line }]（line 从 1 起）。 */
export function findPlaceholders(text) {
  const out = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) out.push({ name: m[1], line: text.slice(0, m.index).split('\n').length });
  return out;
}

/** 作品名（目录名、film.json 的 id、输出文件名、网址段）：返回问题描述，合格时返回 null。 */
export function nameProblem(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return '只用小写字母、数字、连字符，字母或数字开头，最长 64 个字符';
  if (WINDOWS_RESERVED.test(name)) return 'Windows 保留名（con、nul、com1 等）不能做目录名';
  if (UPSTREAM_NAME_RE.test(name)) return '不得含上游项目名（D04）：作品名用自己的名字';
  return null;
}

/** 片名（会原样写进 JSON、HTML、JS / TSX 字符串、Python 文档串与脚本注释）：返回问题描述，合格时返回 null。 */
export function titleProblem(title) {
  if (typeof title !== 'string' || !title.trim()) return '不能为空';
  if ([...title].length > 80) return '最长 80 个字';
  if (TITLE_FORBIDDEN.test(title)) return '不能含 " \' ` \\ < > 与换行等控制字符（会破坏 JSON / HTML / 脚本里的字符串）；书名号、引号请用「」《》';
  if (title.includes('{{') || title.includes('}}')) return '不能含 {{ 或 }}（会和占位符混淆）';
  return null;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 一行写法：{ "a": 1, "b": [1, 2] }（值为 undefined 的键省略）。 */
function compact(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(compact).join(', ')}]` : '[]';
  if (isObj(v)) {
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    return keys.length ? `{ ${keys.map(k => `${JSON.stringify(k)}: ${compact(v[k])}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v ?? null);
}

/**
 * film.json 的稳定排版：顶层逐键换行；放得进 width 列的数组与对象写成一行，放不下才展开（两格缩进），末尾一个换行。
 * 与作品描述包 engine/production/io.js 的 formatJson 是同一条排版规则（tests/cli/new-film.test.mjs 在两者都在时逐字节比对），
 * 所以 new-film 写出的文件与 film.js retime / upgrade 回写的文件一致，不会因为重新排版产生无关的 diff。
 */
export function formatFilmJson(value, { width = 160 } = {}) {
  const fmt = (v, indent, prefix, top) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
    const c = compact(v);
    if (!top && indent + prefix + c.length <= width) return c;
    const pad = ' '.repeat(indent + 2), end = ' '.repeat(indent);
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => pad + fmt(x, indent + 2, 0, false)).join(',\n')}\n${end}]` : '[]';
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (!keys.length) return '{}';
    return `{\n${keys.map(k => { const key = JSON.stringify(k); return `${pad}${key}: ${fmt(v[k], indent + 2, key.length + 2, false)}`; }).join(',\n')}\n${end}}`;
  };
  return `${fmt(value, 0, 0, true)}\n`;
}

const evenSide = v => Number.isInteger(v) && v >= 16 && v % 2 === 0;
const posInt = v => Number.isInteger(v) && v > 0;

/**
 * film.json 结构自检。mode = 'template'（模版：title 必须是 "{{TITLE}}"，v2 的 id 必须是 "{{NAME}}"）
 * 或 'film'（作品：标题非空、不残留占位符，v2 的 id 等于目录名 dirName）。routeIds 是注册表里的全部 id。
 * 返回问题列表（字符串），空数组 = 合格。
 */
export function filmJsonProblems(j, { mode, routeIds, route, dirName } = {}) {
  const p = [];
  if (!isObj(j)) return ['顶层必须是对象'];
  const v2 = j.schemaVersion === 2;
  if (j.schemaVersion !== undefined && !v2) p.push(`schemaVersion 只认 2（不写则按 v1 处理），现在是 ${JSON.stringify(j.schemaVersion)}`);
  if (route ? j.route !== route : !(routeIds || []).includes(j.route)) {
    p.push(`route 应为 ${route ? `"${route}"` : (routeIds || []).map(r => `"${r}"`).join(' / ')}（路线注册表 routes/routes.json 的 id），现在是 ${JSON.stringify(j.route)}`);
  }
  if (mode === 'template') {
    if (j.title !== '{{TITLE}}') p.push(`title 应为 "{{TITLE}}"（由 new-film 替换），现在是 ${JSON.stringify(j.title)}`);
    if (v2 && j.id !== '{{NAME}}') p.push(`id 应为 "{{NAME}}"（由 new-film 替换），现在是 ${JSON.stringify(j.id)}`);
  } else {
    if (typeof j.title !== 'string' || !j.title.trim() || /\{\{/.test(j.title)) p.push(`title 应为非空片名，现在是 ${JSON.stringify(j.title)}`);
    if (v2 && dirName !== undefined && j.id !== dirName) p.push(`id 应等于作品目录名 "${dirName}"，现在是 ${JSON.stringify(j.id)}`);
  }
  if (j.next !== undefined && !(Array.isArray(j.next) && j.next.every(isObj))) p.push('next（模版声明的下一步命令）要写成步骤对象数组，格式同 routes/routes.json 的 next');
  if (!v2) {
    if (!(typeof j.dur === 'number' && Number.isFinite(j.dur) && j.dur > 0)) p.push(`dur 应为正数（秒），现在是 ${JSON.stringify(j.dur)}`);
    if (!posInt(j.fps)) p.push(`fps 应为正整数，现在是 ${JSON.stringify(j.fps)}`);
    if (!(Array.isArray(j.size) && j.size.length === 2 && j.size.every(evenSide))) p.push(`size 应为 [宽, 高]，都是 ≥16 的偶数（H.264 yuv420p 要求），现在是 ${JSON.stringify(j.size)}`);
    return p;
  }
  const o = j.output;
  if (!isObj(o)) { p.push('output 缺失：v2 要写 { profile, width, height, fps, frameCount }'); return p; }
  if (typeof o.profile !== 'string' || !o.profile) p.push('output.profile 要写交付档位（D07 默认 web-1080p24）');
  if (!evenSide(o.width) || !evenSide(o.height)) p.push(`output.width / height 都要是 ≥16 的偶数，现在是 ${JSON.stringify([o.width, o.height])}`);
  if (!posInt(o.fps)) p.push(`output.fps 应为正整数，现在是 ${JSON.stringify(o.fps)}`);
  if (!posInt(o.frameCount)) p.push(`output.frameCount 应为正整数，现在是 ${JSON.stringify(o.frameCount)}`);
  if (typeof j.backend !== 'string' || !j.backend) p.push('backend 不能为空（取注册表里这条路线的 backend）');
  if (j.deliveries !== undefined && !(Array.isArray(j.deliveries) && j.deliveries.length && j.deliveries.every(d => typeof d === 'string' && d))) p.push('deliveries 要写成非空的档位 id 数组');
  if (j.aigc !== undefined && !(isObj(j.aigc) && typeof j.aigc.contains === 'boolean')) p.push('aigc 要写 { contains: true|false, note }（D11）');
  // v1 兼容镜像（现有出片脚本读 dur / fps / size）：写了就必须和 output 一致
  if (j.fps !== undefined && j.fps !== o.fps) p.push(`fps（兼容字段）= ${JSON.stringify(j.fps)} 与 output.fps = ${o.fps} 不一致：两处一起改`);
  if (j.size !== undefined && !(Array.isArray(j.size) && j.size[0] === o.width && j.size[1] === o.height)) p.push(`size（兼容字段）= ${JSON.stringify(j.size)} 与 output 的 ${o.width}×${o.height} 不一致：两处一起改`);
  if (j.dur !== undefined && posInt(o.fps) && !(typeof j.dur === 'number' && Math.round(j.dur * o.fps) === o.frameCount)) p.push(`dur（兼容字段）= ${JSON.stringify(j.dur)} 秒与 output.frameCount = ${o.frameCount} 帧（${o.fps} fps）不一致：两处一起改`);
  return p;
}
