// baseline.manifests：回归基线清单 tests/golden/<平台键>/manifest.json 是工具生成的合法清单（QUAL-01、GAP-12）：
//   结构与摘要对得上（防手改）、目录名就是平台键、每个集合都在 sets.json 里、没有本机绝对路径、来自已提交的代码；
//   待审批的候选（capture --platform 写的，status=candidate）不能入库：审批人用 golden approve 转正；
//   集合定义改了而清单没更新 → 提示；旧布局 tests/golden/manifests/ → 错误（迁移到每个平台一份 manifest.json）。
import fs from 'node:fs';
import { setHash } from '../../../baseline/lib/sets.mjs';
import { GOLDEN_DIR, PK_RE, platformRel, validatePlatform } from '../../../baseline/lib/manifest.mjs';
import { LOCAL_PATH, loadSets } from './_shared.mjs';

export default {
  id: 'baseline.manifests',
  title: '回归基线清单由工具生成、与集合定义一致、没有未审批的候选',
  run(ctx) {
    const out = [];
    if (!ctx.isDir(GOLDEN_DIR)) return out;
    const { sets } = loadSets(ctx);
    if (ctx.isDir(`${GOLDEN_DIR}/manifests`)) {
      out.push({ level: 'error', file: `${GOLDEN_DIR}/manifests`, message: '旧布局：清单应放在 tests/golden/<平台键>/manifest.json（一个平台一份，含该平台全部集合）', hint: '用 golden update 在新位置重新登记，或把各集合原样并进 manifest.json 的 sets 后删掉旧目录' });
    }
    for (const name of fs.readdirSync(ctx.abs(GOLDEN_DIR)).sort()) {
      const relFile = `${GOLDEN_DIR}/${name}/manifest.json`;
      if (!ctx.isDir(`${GOLDEN_DIR}/${name}`) || !ctx.exists(relFile)) continue;
      if (!PK_RE.test(name)) { out.push({ level: 'error', file: relFile, message: `目录名 ${name} 不是平台键（<系统>-<后端>，如 darwin-metal、linux-swiftshader）` }); continue; }
      let doc, text;
      try { text = ctx.read(relFile); doc = JSON.parse(text); } catch (e) { out.push({ level: 'error', file: relFile, message: `读不出来（${e.message}）` }); continue; }
      for (const e of validatePlatform(doc, name)) {
        const candidate = /候选/.test(e);
        out.push({ level: 'error', file: relFile, message: e,
          hint: candidate ? `审批人看过画面后：node tools/baseline/golden.mjs approve --platform ${name} --set <集合> --by <审批人> --reason <理由> [--commit <提交>]`
            : '清单只能由 node tools/baseline/golden.mjs update / approve 生成，不要手改；手改了就 git checkout 还原' });
      }
      if (LOCAL_PATH.test(text)) out.push({ level: 'error', file: relFile, message: '清单里有本机绝对路径', hint: '用 golden update 重新生成；清单只记相对信息' });
      if (!sets) continue;
      for (const [set, m] of Object.entries(doc?.sets || {})) {
        if (!sets.sets[set]) out.push({ level: 'error', file: relFile, message: `tools/baseline/sets.json 里没有集合 ${set}`, hint: '集合删了就把它从清单里一起删（并在审批记录里写明）' });
        else if (m?.setHash && m.setHash !== setHash(sets, set)) out.push({ level: 'warn', file: relFile, message: `集合 ${set} 的定义改过，${platformRel(name)} 还是旧定义`, hint: `审批后：node tools/baseline/golden.mjs update --set ${set} --by <审批人> --reason <理由> --commit HEAD` });
      }
    }
    return out;
  },
};
