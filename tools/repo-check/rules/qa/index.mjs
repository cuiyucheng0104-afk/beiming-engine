#!/usr/bin/env node
// 仓库规范检查 · QA 域规则（P07）。只读，不渲染、不起进程。
// 接口（交给 P02 的 repo-check 框架接线）：export const rules = [{ id, title, run({ root }) → findings[] }]，
//   finding = { level: 'error' | 'warn' | 'ok', message, file?, hint? }；任一 error 即这条规则不通过。
// 单独运行：node tools/repo-check/rules/qa/index.mjs [--json]（有 error 时 exit 4，用法错误 exit 2，与附录 C1 一致）。
//
//   qa.checks-documented     tools/qa 登记的每个检查 id 都写进 docs/quality/QA-GATE.md
//   qa.known-issues          docs/quality/known-issues.json 结构合格；放行（waived）的条目写明谁、原话、出处
//   qa.waivers               docs/quality/waivers/*.json 与 films/*/film.json 里生效的豁免字段齐全、不是 agent 自己批准的；待批准草稿只计数
//   qa.builtin-profiles      QA 内置档位与 D07 一致（6 个档位、默认档的尺寸 / 帧率 / 色彩 / 音频 / 响度）
//   qa.profiles-drift        engine/production/profiles.json（P05）与 QA 内置档位的关键数值不打架
//   qa.no-hardcoded-spec     tools/qa/checks/ 的代码里不写死画幅、帧数（期望值只能来自档位与作品描述）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../../../..');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const E = (message, extra = {}) => ({ level: 'error', message, ...extra });
const W = (message, extra = {}) => ({ level: 'warn', message, ...extra });
const OK = message => ({ level: 'ok', message });
const AGENT = /^(agent|ai|claude|assistant|bot|gpt|codex|代理|助手|智能体|机器人)\b/i;

async function qaModule(root, p) { return import(pathToFileURL(path.join(root, 'tools/qa', p)).href); }

// D07 与附录 C7：档位 id 与默认档的关键数值
const D07_IDS = ['web-1080p24', 'master-1080p24', 'uhd-2160p24', 'vertical-1080x1920-30', 'broadcast-1080p25', 'beiming-1040p24'];

export const rules = [
  {
    id: 'qa.checks-documented',
    title: 'tools/qa 的每个检查 id 都写进 docs/quality/QA-GATE.md',
    async run({ root }) {
      const doc = path.join(root, 'docs/quality/QA-GATE.md');
      if (!fs.existsSync(doc)) return [E('缺 docs/quality/QA-GATE.md', { hint: 'QA 门的说明（每项检查的判据与修法）必须随工具一起维护' })];
      const text = fs.readFileSync(doc, 'utf8');
      const { CHECKS } = await qaModule(root, 'lib/checks.mjs');
      const missing = Object.keys(CHECKS).filter(id => !text.includes(`\`${id}\``));
      return missing.length
        ? missing.map(id => E(`检查 ${id} 没写进 QA-GATE.md`, { file: 'docs/quality/QA-GATE.md', hint: '在 §4 对应的表里加一行：级别、判据、怎么修' }))
        : [OK(`${Object.keys(CHECKS).length} 个检查都有说明`)];
    },
  },
  {
    id: 'qa.known-issues',
    title: '已知问题台账结构合格',
    run({ root }) {
      const f = path.join(root, 'docs/quality/known-issues.json');
      if (!fs.existsSync(f)) return [E('缺 docs/quality/known-issues.json')];
      let doc;
      try { doc = readJson(f); } catch (e) { return [E(`known-issues.json 不是合法 JSON：${e.message}`, { file: rel(root, f) })]; }
      const out = [];
      if (!Array.isArray(doc.issues)) return [E('known-issues.json 缺 issues 数组', { file: rel(root, f) })];
      const seen = new Set();
      for (const [i, it] of doc.issues.entries()) {
        const at = `issues[${i}]${it?.id ? `（${it.id}）` : ''}`;
        if (!it || typeof it !== 'object') { out.push(E(`${at} 不是对象`)); continue; }
        if (!/^QA-[A-Z](-[A-Z])?-\d{3}$/.test(it.id || '')) out.push(E(`${at} 的 id 要写成 QA-<路线>-<三位序号>（模版写 QA-T-<路线>-…）`));
        else if (seen.has(it.id)) out.push(E(`${at} 的 id 重复`));
        seen.add(it.id);
        if (!['P0', 'P1', 'P2', 'P3'].includes(it.severity)) out.push(E(`${at} 的 severity 只能是 P0–P3`));
        if (!['open', 'waived', 'fixed'].includes(it.status)) out.push(E(`${at} 的 status 只能是 open / waived / fixed`));
        for (const k of ['title', 'symptom', 'rootCause', 'evidence', 'owner']) if (typeof it[k] !== 'string' || !it[k].trim()) out.push(E(`${at} 缺 ${k}`));
        if (!it.regression || typeof it.regression.command !== 'string' || !it.regression.command.trim()) out.push(E(`${at} 缺 regression.command（修好后怎么复验）`));
        if (it.film !== null && typeof it.film !== 'string') out.push(E(`${at} 的 film 要写作品 id，或 null（路线模版、工具链的问题）`));
        if (it.film === null && !it.scope) out.push(E(`${at} 的 film 为 null 时要写 scope（问题在哪个目录）`));
        if (it.status === 'waived') {
          const r = it.release || {};
          for (const k of ['approvedBy', 'quote', 'source', 'date']) if (typeof r[k] !== 'string' || !r[k].trim()) out.push(E(`${at} 已放行，但 release 缺 ${k}`, { hint: '放行要写谁批准、原话、出处、日期（D08）' }));
          if (AGENT.test(String(r.approvedBy || '').trim())) out.push(E(`${at} 由 agent 自己放行，无效（D08）`));
        }
        if (it.status === 'fixed' && !it.fixedIn) out.push(W(`${at} 标了 fixed，建议写 fixedIn（修复所在提交）`));
      }
      return out.length ? out.map(x => ({ file: rel(root, f), ...x })) : [OK(`${doc.issues.length} 条台账结构合格`)];
    },
  },
  {
    id: 'qa.waivers',
    title: '生效的豁免字段齐全、不是 agent 自己批准的',
    async run({ root }) {
      const { validateWaiver } = await qaModule(root, 'lib/waivers.mjs');
      const out = [];
      const files = [];
      const wd = path.join(root, 'docs/quality/waivers');
      if (fs.existsSync(wd)) for (const n of fs.readdirSync(wd)) if (n.endsWith('.json')) files.push({ f: path.join(wd, n), pick: d => (Array.isArray(d) ? d : d.waivers || []) });
      const fd = path.join(root, 'films');
      if (fs.existsSync(fd)) for (const n of fs.readdirSync(fd)) {
        const f = path.join(fd, n, 'film.json');
        if (fs.existsSync(f)) files.push({ f, pick: d => (d?.qa?.waivers) || [] });
      }
      let active = 0, proposed = 0;
      for (const { f, pick } of files) {
        let list;
        try { list = pick(readJson(f)); } catch (e) { out.push(E(`${rel(root, f)} 不是合法 JSON：${e.message}`, { file: rel(root, f) })); continue; }
        if (!Array.isArray(list)) { out.push(E(`${rel(root, f)} 的豁免要是数组`, { file: rel(root, f) })); continue; }
        for (const w of list) {
          if (w && w.status === 'proposed') { proposed++; continue; }
          const probs = validateWaiver(w);
          if (probs.length) out.push(E(`${rel(root, f)} 里的豁免（${w?.check || '?'}${w?.target ? ` / ${w.target}` : ''}）：${probs.join('；')}`, { file: rel(root, f), hint: '用户还没批准的写成 "status": "proposed"' }));
          else active++;
        }
      }
      if (proposed) out.push(W(`有 ${proposed} 条待用户批准的豁免草稿（不生效）`));
      if (!out.some(x => x.level === 'error')) out.push(OK(`${active} 条生效的豁免都合格`));
      return out;
    },
  },
  {
    id: 'qa.builtin-profiles',
    title: 'QA 内置档位与 D07 一致',
    run({ root }) {
      const f = path.join(root, 'tools/qa/profiles.builtin.json');
      let doc;
      try { doc = readJson(f); } catch (e) { return [E(`tools/qa/profiles.builtin.json 读不出来：${e.message}`)]; }
      const out = [];
      const ids = Object.keys(doc.profiles || {});
      for (const id of D07_IDS) if (!ids.includes(id)) out.push(E(`内置档位缺 ${id}（D07 / 附录 C7）`));
      const d = doc.defaults || {}, web = doc.profiles?.['web-1080p24'] || {};
      const want = [
        ['web-1080p24 宽高', `${web.width}x${web.height}`, '1920x1080'], ['web-1080p24 帧率', web.fps, 24],
        ['像素格式', d.video?.pixFmt, 'yuv420p'], ['色彩范围', d.video?.colorRange, 'tv'], ['矩阵', d.video?.colorSpace, 'bt709'],
        ['原色', d.video?.colorPrimaries, 'bt709'], ['传递函数', d.video?.colorTransfer, 'bt709'],
        ['音频编码', d.audio?.codec, 'aac'], ['采样率', d.audio?.sampleRate, 48000], ['声道', d.audio?.channels, 2],
        ['积分响度', d.audio?.integratedLufs, -14], ['真峰值上限', d.audio?.truePeakMaxDbtp, -1],
        ['broadcast 响度', doc.profiles?.['broadcast-1080p25']?.audio?.integratedLufs, -23],
      ];
      for (const [k, got, exp] of want) if (got !== exp) out.push(E(`内置档位的${k}是 ${got}，D07 要求 ${exp}`, { file: 'tools/qa/profiles.builtin.json' }));
      if (!(d.audio?.lufsTolerance > 0 && d.audio.lufsTolerance <= 1)) out.push(E(`响度容差 ${d.audio?.lufsTolerance} 超出 D07 的 ±1 LU`));
      return out.length ? out : [OK('内置档位与 D07 一致')];
    },
  },
  {
    id: 'qa.profiles-drift',
    title: 'P05 的权威档位表与 QA 内置档位不打架',
    async run({ root }) {
      const f = path.join(root, 'engine/production/profiles.json');
      if (!fs.existsSync(f)) return [W('engine/production/profiles.json 还不存在（P05）：QA 用内置档位并在报告里逐项标 warn')];
      const { loadProfiles } = await qaModule(root, 'lib/profiles.mjs');
      let ext, builtin;
      try { ext = loadProfiles({ root, file: f }); builtin = loadProfiles({ root: path.join(root, '__no_such_dir__') }); } catch (e) { return [E(`档位表读不出来：${e.message}`, { file: 'engine/production/profiles.json' })]; }
      const out = [];
      for (const [id, p] of ext.profiles) {
        const b = builtin.profiles.get(id);
        if (!b || p.source === 'tools/qa/profiles.builtin.json') continue;
        for (const [k, a, c] of [['宽', p.width, b.width], ['高', p.height, b.height], ['帧率', p.fps, b.fps], ['响度', p.audio.integratedLufs, b.audio.integratedLufs], ['真峰值', p.audio.truePeakMaxDbtp, b.audio.truePeakMaxDbtp], ['色彩范围', p.video.colorRange, b.video.colorRange]]) {
          if (String(a) !== String(c)) out.push(W(`档位 ${id} 的${k}：P05 表是 ${a}，QA 内置是 ${c}——以 P05 表为准，同步改 tools/qa/profiles.builtin.json`, { file: 'engine/production/profiles.json' }));
        }
      }
      return out.length ? out : [OK('两份档位的关键数值一致')];
    },
  },
  {
    id: 'qa.no-hardcoded-spec',
    title: 'QA 检查代码里不写死画幅与帧数',
    run({ root }) {
      const dir = path.join(root, 'tools/qa/checks');
      const out = [];
      for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!n.endsWith('.mjs')) continue;
        const lines = fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
          if (/(^|[^\w.])(1920|1080|1040|2160|3840|2080|240)(?![\w.])/.test(code)) out.push(E(`tools/qa/checks/${n}:${i + 1} 写死了画幅或帧数：${line.trim().slice(0, 100)}`, { file: `tools/qa/checks/${n}`, hint: '期望值从档位（profile）或作品描述（film）取' }));
        });
      }
      return out.length ? out : [OK('没有写死的画幅与帧数')];
    },
  },
];

export async function runAll({ root = DEFAULT_ROOT } = {}) {
  const res = [];
  for (const r of rules) {
    let findings;
    try { findings = await r.run({ root }); } catch (e) { findings = [E(`规则本身出错：${e.message}`)]; }
    res.push({ id: r.id, title: r.title, ok: !findings.some(f => f.level === 'error'), findings });
  }
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const bad = args.filter(a => !['--json', '--help', '-h'].includes(a));
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('用法：node tools/repo-check/rules/qa/index.mjs [--json]\n只读检查 QA 域的仓库规范：' + rules.map(r => r.id).join('、') + '。有 error 时退出码 4。\n');
    process.exit(0);
  }
  if (bad.length) { process.stderr.write(`未知参数 ${bad.join(' ')}\n下一步：node tools/repo-check/rules/qa/index.mjs --help\n`); process.exit(2); }
  const res = await runAll();
  const ok = res.every(r => r.ok);
  const code = ok ? 0 : 4;
  if (args.includes('--json')) {
    const errs = res.flatMap(r => r.findings.filter(f => f.level === 'error'));
    process.stdout.write(JSON.stringify({ ok, exitCode: code, command: 'repo-check qa', error: ok ? null : { code: 'repo-check.qa', message: errs[0].message, hint: errs[0].hint ?? null }, outputs: [], runJson: null, warnings: res.flatMap(r => r.findings.filter(f => f.level === 'warn').map(f => f.message)), result: res }) + '\n');
  } else {
    for (const r of res) {
      process.stdout.write(`${r.ok ? '✔' : '✘'} ${r.id.padEnd(22)} ${r.title}\n`);
      for (const f of r.findings.filter(x => x.level !== 'ok')) process.stdout.write(`    ${f.level === 'error' ? '错误' : '提示'}：${f.message}\n`);
    }
  }
  process.exitCode = code;
}
