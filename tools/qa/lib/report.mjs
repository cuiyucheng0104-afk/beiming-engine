// 北冥 QA · 报告：组装附录 C8 的 qa/report.json，校验报告结构，生成一页 markdown，给 run.json 的 technicalAcceptance 出值。
// 报告只说明「机器检查通过 / 不通过」；人工全速带声审片、用户认可另行记录，报告不能替代（状态三分离）。
//
//   buildReport({ film, input, profile, checks, groups, skipped, warnings, env, extra }) → 报告对象
//   validateReport(obj) → { ok, errors }（P05 的 validate-result 可直接调用，判定 technicalAcceptance.evidence 指向的报告是否可解析）
//   toMarkdown(report, { sheet }) → 一页中文说明
//   technicalAcceptanceFrom(report, reportPath) → { status: 'passed' | 'failed', evidence: [reportPath] }
//   REPORT_SCHEMA_VERSION = 1
export const REPORT_SCHEMA_VERSION = 1;
const STATUSES = ['pass', 'fail', 'warn', 'waived'];

export function buildReport({ film = null, input = null, profile, checks, groups = [], skipped = [], warnings = [], env = {}, extra = {} }) {
  const ok = !checks.some(c => c.status === 'fail');
  const count = s => checks.filter(c => c.status === s).length;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: 'beiming-qa', version: '1.0.0' },
    film: film ? { id: film.id, title: film.title, route: film.route, file: film.relFile ?? film.file ?? null, frameCount: film.frameCount ?? null } : null,
    input: input ? { path: input.path, sha256: input.sha256, bytes: input.bytes ?? null } : null,
    profile: profile ? { id: profile.id, source: profile.source } : null,
    groups,
    skipped,
    checks: checks.map(c => {
      const o = { id: c.id, group: c.group, title: c.title, severity: c.severity, status: c.status, value: c.value, expected: c.expected, evidence: c.evidence || {}, message: c.message || '' };
      if (c.findings?.length) o.findings = c.findings;
      if (c.waiver) o.waiver = c.waiver;
      if (c.hint) o.hint = c.hint;
      return o;
    }),
    summary: { pass: count('pass'), fail: count('fail'), warn: count('warn'), waived: count('waived'), hardFailures: checks.filter(c => c.status === 'fail').map(c => c.id) },
    ok,
    verdict: ok ? '机器检查通过（代理检查通过，不等于人工认可）' : '机器检查不通过',
    warnings,
    env,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

const isStr = v => typeof v === 'string' && v.length > 0;
export function validateReport(r) {
  const errors = [];
  const e = (p, m) => errors.push(`${p}：${m}`);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, errors: ['$：报告必须是 JSON 对象'] };
  if (r.schemaVersion !== REPORT_SCHEMA_VERSION) e('schemaVersion', `应为 ${REPORT_SCHEMA_VERSION}`);
  if (typeof r.ok !== 'boolean') e('ok', '必须是布尔值');
  if (r.film !== null && (typeof r.film !== 'object' || Array.isArray(r.film))) e('film', '必须是对象或 null');
  if (r.input !== null) {
    if (!r.input || typeof r.input !== 'object') e('input', '必须是对象或 null');
    else {
      if (!isStr(r.input.path)) e('input.path', '必须是非空字符串');
      if (!/^[0-9a-f]{64}$/.test(r.input.sha256 || '')) e('input.sha256', '必须是 64 位十六进制');
    }
  }
  if (!r.profile || !isStr(r.profile.id)) e('profile.id', '必须写明按哪个档位判定');
  if (!Array.isArray(r.checks) || !r.checks.length) e('checks', '必须是非空数组');
  else {
    const seen = new Set();
    r.checks.forEach((c, i) => {
      const p = `checks[${i}]`;
      if (!isStr(c.id)) e(`${p}.id`, '必须是非空字符串');
      else if (seen.has(c.id)) e(`${p}.id`, `重复的检查 ${c.id}`);
      else seen.add(c.id);
      if (!STATUSES.includes(c.status)) e(`${p}.status`, `只能是 ${STATUSES.join(' / ')}`);
      if (!('value' in c)) e(`${p}.value`, '缺字段');
      if (!('expected' in c)) e(`${p}.expected`, '缺字段');
      if (!('evidence' in c)) e(`${p}.evidence`, '缺字段');
      if (c.status === 'waived' && !(Array.isArray(c.waiver) && c.waiver.length)) e(`${p}.waiver`, 'waived 必须附豁免记录');
      for (const [j, f] of (c.findings || []).entries()) {
        if (!STATUSES.includes(f.status)) e(`${p}.findings[${j}].status`, `只能是 ${STATUSES.join(' / ')}`);
        if (f.status === 'waived' && !(f.waiver && isStr(f.waiver.approvedBy) && isStr(f.waiver.quote) && isStr(f.waiver.source))) e(`${p}.findings[${j}].waiver`, '豁免必须写明 approvedBy、quote、source');
      }
    });
    if (typeof r.ok === 'boolean' && r.ok !== !r.checks.some(c => c.status === 'fail')) e('ok', '与 checks 不一致：有 fail 时 ok 必须是 false');
  }
  return { ok: errors.length === 0, errors };
}

export function technicalAcceptanceFrom(report, reportPath) {
  return { status: report.ok ? 'passed' : 'failed', evidence: [reportPath] };
}

const ICON = { pass: '通过', fail: '**不通过**', warn: '注意', waived: '已豁免' };
const cell = v => (v === null || v === undefined ? '—' : String(typeof v === 'object' ? JSON.stringify(v) : v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(r, { sheet = null } = {}) {
  const L = [];
  const title = r.film?.title || r.film?.id || (r.input ? r.input.path.split(/[\\/]/).pop() : '页面');
  L.push(`# 机器 QA 报告 · ${title}`);
  L.push('');
  L.push(`- 结论：**${r.ok ? '机器检查通过' : '机器检查不通过'}**（硬门失败 ${r.summary.fail} 项、注意 ${r.summary.warn} 项、已豁免 ${r.summary.waived} 项、通过 ${r.summary.pass} 项）`);
  if (r.input) L.push(`- 文件：\`${r.input.path}\`　sha256 \`${r.input.sha256}\``);
  L.push(`- 档位：\`${r.profile?.id}\`（来源 \`${r.profile?.source}\`）`);
  if (r.film) L.push(`- 作品：\`${r.film.id}\`${r.film.route ? `，路线 ${r.film.route}` : ''}${r.film.frameCount ? `，${r.film.frameCount} 帧` : ''}`);
  L.push(`- 检查组：${r.groups.join('、') || '—'}${r.skipped.length ? `；未执行：${r.skipped.map(s => `${s.group}（${s.reason}）`).join('；')}` : ''}`);
  L.push('');
  L.push('> 这份报告只回答「机器能判定的项是否达标」。全速带声的完整观看、画面与声音好不好，由用户或指定审片人判断并记录原话；');
  L.push('> 报告通过只能写「代理检查通过」，不能写成「已交付」「用户已认可」（D08、状态三分离）。评分口径见 docs/quality/RUBRIC.md。');
  L.push('');
  const bad = r.checks.filter(c => c.status === 'fail');
  if (bad.length) {
    L.push('## 必须先修的问题');
    L.push('');
    for (const c of bad) {
      L.push(`### ${c.id} · ${c.title}`);
      L.push('');
      L.push(`实测：${cell(c.value)}；期望：${cell(c.expected)}`);
      L.push('');
      for (const f of (c.findings || []).filter(x => x.status === 'fail').slice(0, 8)) {
        L.push(`- ${f.message}${f.hint ? `\n  - 怎么修：${f.hint}` : ''}`);
      }
      if (c.hint) L.push(`- 怎么修：${c.hint}`);
      L.push('');
    }
  }
  L.push('## 全部检查');
  L.push('');
  L.push('| 检查 | 级别 | 结果 | 实测 | 期望 |');
  L.push('|---|---|---|---|---|');
  for (const c of r.checks) L.push(`| \`${c.id}\` | ${c.severity === 'hard' ? '硬门' : '软项'} | ${ICON[c.status]} | ${cell(c.value)} | ${cell(c.expected)} |`);
  L.push('');
  const warns = r.checks.filter(c => c.status === 'warn');
  if (warns.length) {
    L.push('## 需要人看一眼的项');
    L.push('');
    for (const c of warns) for (const f of (c.findings || []).filter(x => x.status === 'warn').slice(0, 5)) L.push(`- \`${c.id}\`：${f.message}${f.hint ? `（${f.hint}）` : ''}`);
    L.push('');
  }
  const waived = r.checks.flatMap(c => (c.findings || []).filter(f => f.status === 'waived').map(f => ({ c, f })));
  if (waived.length) {
    L.push('## 已豁免（谁批准、原话、出处）');
    L.push('');
    for (const { c, f } of waived) L.push(`- \`${c.id}\`：${f.message} —— ${f.waiver.approvedBy}：「${f.waiver.quote}」（${f.waiver.source}；记录在 \`${f.waiver.origin}\`）`);
    L.push('');
  }
  if (sheet) {
    L.push('## 联系表');
    L.push('');
    L.push(`![联系表](${sheet.file})`);
    L.push('');
    L.push(`共 ${sheet.cells.length} 格，按帧号排列；标签：帧号、时间码、镜头号，CUT = 镜头表切点，! = 有发现的帧。`);
    L.push('');
  }
  if (r.warnings.length) {
    L.push('## 运行提示');
    L.push('');
    for (const w of r.warnings) L.push(`- ${w}`);
    L.push('');
  }
  L.push(`生成：${r.generatedAt}；工具 ${r.tool.name} ${r.tool.version}${r.env?.ffmpeg ? `；FFmpeg ${r.env.ffmpeg}` : ''}${r.env?.node ? `；Node ${r.env.node}` : ''}`);
  return L.join('\n') + '\n';
}
