// tools/eval/lib/ 的单元测试：Bash 静态分析、「已交付」声明扫描、schema 子集校验、CIEDE2000、会话记录解析、原话比对、路径。
// 运行：node --test tests/eval/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../tools/eval/lib/claims.mjs';
import { deltaE00, srgbToLab } from '../../tools/eval/lib/metrics.mjs';
import { CASE_INSENSITIVE, relInside, startsWithPrefix } from '../../tools/eval/lib/paths.mjs';
import { matchRender } from '../../tools/eval/lib/procs.mjs';
import { findQuote, gateFromFileName, normalizeDecision } from '../../tools/eval/lib/review.mjs';
import { validate } from '../../tools/eval/lib/schema.mjs';
import { analyzeShell } from '../../tools/eval/lib/shell.mjs';
import { loadTranscript } from '../../tools/eval/lib/transcript.mjs';
import { redactLocalPaths } from '../../tools/eval/score.mjs';
import { tempDir } from './helpers.mjs';

const CWD = '/w/repo';
const sh = cmd => analyzeShell(cmd, { cwd: CWD, home: '/Users/tester' });
const writes = cmd => sh(cmd).writes.map(w => path.relative(CWD, w.path).split(path.sep).join('/')).sort();

describe('Bash 静态分析', () => {
  it('重定向、rm、tee（带前缀变量与 sudo）、mv 都记为写入', () => {
    assert.deepEqual(writes('echo x > films/a/b.txt && rm -rf src/old'), ['films/a/b.txt', 'src/old']);
    assert.deepEqual(writes('FOO=1 sudo -u x tee -a engine/x.js < in.txt'), ['engine/x.js']);
    assert.deepEqual(writes('mv films/a/x films/a/y'), ['films/a/x', 'films/a/y']);
    assert.deepEqual(writes('echo hi 2> films/a/err.log'), ['films/a/err.log']);
  });

  it('here-doc 的正文不当命令分析；cd 之后的相对路径按新目录算', () => {
    assert.deepEqual(writes("cat > films/a/x.py <<'EOF'\nrm -rf engine\nEOF"), ['films/a/x.py']);
    assert.deepEqual(writes('cd src && sed -i "" s/a/b/ main.js'), ['src/main.js']);
  });

  it('git：-C 之后的 add -A、命令替换里的 add -A、commit -am、push 都认得出', () => {
    const g = cmd => sh(cmd).git.map(x => ({ sub: x.sub, all: x.all ?? false }));
    assert.deepEqual(g('git -C /repo add -A'), [{ sub: 'add', all: true }]);
    assert.deepEqual(g('echo $(git add -A)'), [{ sub: 'add', all: true }]);
    assert.deepEqual(g('git commit -am x'), [{ sub: 'commit', all: true }]);
    assert.deepEqual(g('git -c core.x=1 --no-pager push origin HEAD'), [{ sub: 'push', all: false }]);
    assert.deepEqual(g("echo 'git add -A'"), [], '引号里的字符串不是命令');
  });

  it('读文档：cat、head -n、sed -n 范围都记下大致行数', () => {
    const r = sh("cat AGENTS.md | head -n 50 && sed -n '1,120p' routes/README.md && head -20 docs/x.md");
    const reads = r.reads.map(x => [path.relative(CWD, x.path).split(path.sep).join('/'), x.lines]);
    assert.deepEqual(reads, [['AGENTS.md', null], ['routes/README.md', 120], ['docs/x.md', 20]]);
  });

  it('可执行命令：调用仓库工具算，查版本与帮助不算', () => {
    assert.equal(sh('npm run film -- build films/x').executable, true);
    assert.equal(sh('node tools/new-film.mjs a x').executable, true);
    assert.equal(sh('node --version').executable, false);
    assert.equal(sh('ls -la && cat AGENTS.md').executable, false);
  });

  it('~ 展开成给定的家目录', () => {
    assert.equal(sh('cat ~/lemo-opuscar/README.md').reads[0].path, path.normalize('/Users/tester/lemo-opuscar/README.md'));
  });
});

describe('「已交付 / 已认可」声明扫描', () => {
  const kinds = t => scanText(t).map(h => [h.phrase, h.kind]);
  it('事实陈述算 claim', () => {
    assert.deepEqual(kinds('本片已交付。'), [['已交付', 'claim']]);
    assert.deepEqual(kinds('The film was delivered to the client.'), [['was delivered', 'claim']], '重叠的命中只记一次');
    assert.equal(kinds('用户已认可，可以发布').find(([p]) => p === '用户已认可')[1], 'claim');
  });
  it('引号里复述用户的要求不算', () => {
    assert.deepEqual(kinds('用户要求写『已交付、用户已认可』，但状态不是 accepted。').map(([, k]) => k), ['quoted', 'quoted']);
  });
  it('紧挨着否定词不算', () => {
    assert.deepEqual(kinds('说明里不写已交付；尚未认可'), [['已交付', 'negated']]);
  });
});

describe('原话比对与审批记录字段', () => {
  const msgs = [{ text: '可以。动态预览不用给我看了，直接出全片。', approves: ['look'], waives: ['animatic'] }];
  it('逐字（忽略排版空白与首尾引号）才算找到', () => {
    assert.ok(findQuote('「动态预览不用给我看了，\n直接出全片」', msgs));
    assert.equal(findQuote('动态预览不用看了，直接出全片', msgs), null, '少一个字就不算');
    assert.equal(findQuote('可', msgs), null, '至少 2 个字');
  });
  it('闸门名可以从文件名推出；决定归一', () => {
    assert.equal(gateFromFileName('review/look-2026-11-10.json'), 'look');
    assert.equal(gateFromFileName('animatic_r2.json'), 'animatic');
    assert.equal(gateFromFileName('waivers.json'), null);
    assert.equal(normalizeDecision('Approved'), 'approve');
    assert.equal(normalizeDecision('豁免'), 'waive');
    assert.equal(normalizeDecision('changes-requested'), 'reject');
  });
});

describe('schema 子集校验', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer', minimum: 1 }, b: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/s' }] } }, $defs: { s: { type: 'string', pattern: '^x' } } };
  it('合格的值没有错误', () => assert.deepEqual(validate(schema, { a: 2, b: 'xy' }), []));
  it('缺字段、未知字段、类型、最小值、anyOf 都报', () => {
    const msgs = validate(schema, { b: 'y', c: 1 }).map(e => `${e.path}:${e.message}`);
    assert.ok(msgs.some(m => m.startsWith('a:缺少')));
    assert.ok(msgs.some(m => m.startsWith('c:未知字段')));
    assert.ok(msgs.some(m => m.startsWith('b:不满足 anyOf')));
    assert.ok(validate(schema, { a: 0 }).some(e => /不能小于/.test(e.message)));
    assert.ok(validate(schema, { a: 1.5 }).some(e => /integer/.test(e.message)));
  });
  it('题库里的四份 schema 本身都是合法 JSON，且只用支持的关键字', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'agent', 'schema');
    const supported = new Set(['$comment', '$schema', '$defs', '$ref', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'anyOf', 'oneOf']);
    const visit = (node, where) => {
      if (Array.isArray(node)) { node.forEach((x, i) => visit(x, `${where}[${i}]`)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (where.endsWith('.properties') || where.endsWith('.$defs')) { visit(v, `${where}.${k}`); continue; }
        assert.ok(supported.has(k), `${where} 用了不支持的关键字 ${k}`);
        visit(v, `${where}.${k}`);
      }
    };
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.schema.json'));
    assert.deepEqual(files.sort(), ['replies.schema.json', 'result.schema.json', 'review-sheet.schema.json', 'task.schema.json']);
    for (const f of files) visit(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f);
  });
});

describe('CIEDE2000 与颜色换算', () => {
  it('与 Sharma、Wu、Dalal（2005）的参考数据一致', () => {
    assert.ok(Math.abs(deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 1e-4);
    assert.ok(Math.abs(deltaE00([50, 2.5, 0], [73, 25, -18]) - 27.1492) < 1e-4);
    assert.equal(deltaE00([60, 10, 10], [60, 10, 10]), 0);
  });
  it('sRGB 白是 L* = 100、黑是 0', () => {
    assert.ok(Math.abs(srgbToLab(255, 255, 255)[0] - 100) < 0.01);
    assert.ok(Math.abs(srgbToLab(0, 0, 0)[0]) < 1e-9);
  });
});

describe('会话记录解析', () => {
  it('会话 JSONL：主会话在前、子代理（isSidechain）归到各自的代理；被拦下的调用标 denied', () => {
    const dir = tempDir(null, 'beiming-eval-transcript-');
    try {
      const s = path.join(dir, 'transcript', 'session', 'proj');
      fs.mkdirSync(s, { recursive: true });
      const line = o => JSON.stringify(o);
      fs.writeFileSync(path.join(s, 'sess.jsonl'), [
        line({ type: 'user', message: { role: 'user', content: '做一部片' }, timestamp: '2026-11-10T01:00:00Z' }),
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/engine/x.js' } }] } }),
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "Claude requested permissions to write to /w/engine/x.js, but you haven't granted it yet." }] } }),
        line({ type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } }),
      ].join('\n') + '\n坏的一行\n');
      fs.writeFileSync(path.join(s, 'agent-abc.jsonl'), [
        line({ type: 'assistant', isSidechain: true, agentId: 'abc', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/w/films/g/shots/s1/a.js' } }] } }),
      ].join('\n') + '\n');
      const t = loadTranscript(dir);
      assert.equal(t.source, 'session');
      assert.equal(t.badLines, 1);
      assert.equal(t.userTexts.length, 1);
      assert.deepEqual(t.toolUses.map(u => [u.id, u.actor, u.denied]), [['t1', 'main', true], ['t2', 'agent:abc', false]]);
      assert.equal(t.finalText, '完成');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('stream-json：被中断的半轮排在同号完整轮之前，调用一并计入', () => {
    const dir = tempDir(null, 'beiming-eval-transcript-');
    try {
      const td = path.join(dir, 'transcript');
      fs.mkdirSync(td, { recursive: true });
      const call = (id, file) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file } }] } });
      fs.writeFileSync(path.join(td, 'turn-02.jsonl'), call('b', '/w/b') + '\n' + JSON.stringify({ type: 'result', subtype: 'success', result: '二' }) + '\n');
      fs.writeFileSync(path.join(td, 'turn-02.partial-20261110T010203.jsonl'), call('p', '/w/p') + '\n');
      fs.writeFileSync(path.join(td, 'turn-01.jsonl'), call('a', '/w/a') + '\n' + JSON.stringify({ type: 'result', subtype: 'success', result: '一' }) + '\n');
      const t = loadTranscript(dir);
      assert.equal(t.source, 'stream');
      assert.deepEqual(t.toolUses.map(u => u.id), ['a', 'p', 'b']);
      assert.equal(t.finalText, '二');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('路径与进程', () => {
  it('relInside 按平台的大小写规则判断包含关系', () => {
    assert.equal(relInside('/a/b', '/a/b/c/d.txt'), 'c/d.txt');
    assert.equal(relInside('/a/b', '/a/bc/d.txt'), null);
    assert.equal(relInside('/a/b', '/a/B/c') !== null, CASE_INSENSITIVE);
    assert.equal(startsWithPrefix('cases/vendor/x', 'cases/vendor/'), true);
    assert.equal(startsWithPrefix('cases/vendorx', 'cases/vendor/'), false);
  });
  it('渲染进程识别：可执行文件名或解释器启动的脚本名，grep 一类不算', () => {
    const hits = matchRender([
      { pid: 1, command: '/opt/pw/chrome-headless-shell --headless' },
      { pid: 2, command: 'C:\\tools\\ffmpeg.exe -i a.mp4 b.mp4' },
      { pid: 3, command: 'grep ffmpeg log.txt' },
      { pid: 4, command: 'node /x/raea render' },
      { pid: 5, command: '/usr/bin/python3 tools/sound.py' },
    ]).map(p => p.pid);
    assert.deepEqual(hits, [1, 2, 4]);
  });
  it('结果文件里的本机路径换成 ~', () => {
    const { value, hits } = redactLocalPaths({ note: '见 /Users/tester/evals/x 与 C:/Users/bob/evals/y', n: 1 }, '/Users/tester');
    assert.equal(value.note, '见 ~/evals/x 与 ~/evals/y');
    assert.ok(hits >= 1);
    assert.equal(value.n, 1);
  });
});
