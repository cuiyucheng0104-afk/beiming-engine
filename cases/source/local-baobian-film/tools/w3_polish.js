export const meta = {
  name: 'baobian-w3-polish',
  description: '《豹变》第三轮：A、C、D 返修到交付线，B 修掉剩余 P2；D 先做返修规划并重出资产 → 对抗复核（最多三轮）→ 5090 出片 → 成片终检（不过线回炉一次）→ 四版横评',
  phases: [
    { title: 'Plan', detail: 'D 雾山：返修规划，定重出哪些资产、哪些镜头换画法' },
    { title: 'Asset', detail: 'D 雾山：按规划用 Magpie 重出角色与关键资产' },
    { title: 'Fix', detail: '按问题单逐条返修，门禁全绿' },
    { title: 'Verify', detail: '对抗式复核，按交付线判定' },
    { title: 'Render', detail: '5090 渲整片、配乐对位、封装' },
    { title: 'QA', detail: '从成片抽帧终检，和 v2 存档对比' },
    { title: 'Compare', detail: '四版横评，返回总结全文' },
  ],
}

const ROOT = '@@CASE_ROOT@@'
const VERSIONS = [
  { key: 'A_shuimo', name: 'A 水墨', rounds: 3, ids: ["v3-01","v3-02","v3-03","v3-04","v3-05","v3-06","v3-07","v3-08","v3-09","qa2-01","qa2-03","qa2-04","qa2-05","qa2-06","qa2-07","qa2-08","qa2-09","qa2-10","qa2-11","qa2-12","qa2-13","main3-01"] },
  { key: 'B_zhuangshi', name: 'B 装饰', rounds: 2, ids: ["self-08","v3-01","v3-02","v3-03","v3-04","qa2-01","qa2-02","qa2-03","qa2-04","qa2-05","qa2-06","zs-01"] },
  { key: 'C_qitan', name: 'C 奇谭', rounds: 3, ids: ["v2-08","v3-01","v3-02","v3-03","v3-04","v3-05","v3-06","qa2-01","qa2-02","qa2-04","qa2-05","qa2-06","qa2-07","qa2-08","qa2-09","qa2-10","zs-01","main3-01","main3-02"] },
  { key: 'D_wushan', name: 'D 雾山', rounds: 3, plan: true, ids: ["style-05","style-07","style-12","style-14","style-16","style-20","style-21","style-22","story-04","story-06","story-07","story-09","story-12","story-18","story-19","self-08","self-11","self-12","v1-06","v2-02","v2-06","v3-01","v3-02","v3-03","v3-04","v3-05","v3-06","v3-07","v3-08","v3-09","v3-10","v3-11","qa2-01","qa2-02","qa2-03","qa2-04","qa2-05","qa2-06","qa2-07","qa2-08","qa2-09","qa2-10","qa2-11","qa2-12","qa2-13","qa2-14","qa2-15","qa2-16","qa2-17","qa2-18","main3-01","main3-02"] },
]
const SC = ['style', 'toon', 'story', 'camera', 'composition', 'clean']

const AUDIO = (v) => `配乐对位口径：成片第 t 秒对应配乐文件第 t + offset 秒，offset 以 films/${v.key}/audio.json 为准（写的是 anchor 就用 .venv/bin/python tools/audio_align.py audio/${v.key}.wav --anchor <anchor> 算；没有 audio.json 就按 anchor 21.0 算）。audio/${v.key}_report.txt 第一行写着它是按哪个截取起点算的；和实际 offset 不一致时，用 .venv/bin/python tools/audio_report.py audio/${v.key}.wav --offset <offset> --png films/${v.key}/_work/audio_curve.png > films/${v.key}/_work/audio_report.txt 重出一份再用。片尾淡出参数（fade_out_st、fade_out_d、fade_out_curve）也写在 audio.json，见规范第五节。`

const HEAD = (role, v) => `你是《豹变》项目的子代理。角色：${role}；负责版本：${v.name}（目录 ${ROOT}/films/${v.key}/）。工程根目录 ${ROOT}。
开工前必须通读：${ROOT}/SUBAGENT_STANDARD.md（规范 v2.1，逐条遵守，第五、六、八节有第三轮的新规定）、${ROOT}/BRIEF.md、${ROOT}/films/${v.key}/STYLE.md、${ROOT}/films/${v.key}/DESIGN.md、${ROOT}/films/${v.key}/NOTES.md。参考静帧在 ${ROOT}/refs/${v.key}/（总览 ${ROOT}/refs/${v.key}_board.jpg）。
现在是第三轮。第二轮成片的冻结存档在 ${ROOT}/out/v2/：成片 out/v2/豹变_${v.key}_v2.mp4、逐 0.5 秒帧 out/v2/check_${v.key}/frames/s_<秒>.jpg、终检 out/v2/check_${v.key}/QA.md、四版总审 out/v2/SUMMARY.md。只读。全程中文。
${AUDIO(v)}`

async function run(prompt, opts) {
  const r = await agent(prompt, opts)
  if (r) return r
  log(`${opts.label} 没有返回结果，重跑一次`)
  return agent(`${prompt}

（接手说明：上一位担任这个角色的代理中途断开了，可能已经改过一部分文件、渲过一部分图。先看现有文件、NOTES.md 和 _work/ 里的东西，再接着做完。）`, { ...opts, label: `${opts.label}:retry` })
}

const SCORES = { type: 'object', properties: { style: { type: 'number' }, toon: { type: 'number' }, story: { type: 'number' }, camera: { type: 'number' }, composition: { type: 'number' }, clean: { type: 'number' } }, required: SC }
const SCORE_NOTES = { type: 'object', properties: { style: { type: 'string' }, toon: { type: 'string' }, story: { type: 'string' }, camera: { type: 'string' }, composition: { type: 'string' }, clean: { type: 'string' } }, required: SC }
const ISSUE = { type: 'object', properties: {
  id: { type: 'string' }, level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, time: { type: 'string' }, where: { type: 'string' },
  problem: { type: 'string' }, fix: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'level', 'time', 'problem', 'fix'] }

const PLAN = (v) => `${HEAD('返修规划（Rework Planner）', v)}

D 雾山前三轮返修没有收敛：复核六项只从 4–6 分升到 5.5–6.5 分，还剩 52 条问题，见 films/D_wushan/_work/w3/ISSUES.json（里面 main3-01、main3-02 是主会话这一轮的决定）。
你的任务：动手之前，定一份能在一轮里把 D 拉到交付线的返修方案，写到 films/D_wushan/_work/w3/PLAN.md。
1. 先看清现状：逐格看 out/v2/check_D_wushan/qa_sheet.jpg，用 sh tools/grab.sh out/v2/豹变_D_wushan_v2.mp4 <目录> <帧号…> 抽关键大图，和 refs/D_wushan/ 的参考静帧并排比（tools/compare.py）。读 DESIGN.md、NOTES.md 的返修记录、main.js 和 shots/ 的结构，弄清每条问题的根因在资产、着色器，还是镜头设计。
2. 把问题按根因归并成若干工作包。每个包写清：
   - 涉及的问题编号；
   - 根因；
   - 做法：改代码、重出资产，或整段换画法；
   - 验收标准：既要有能在 5090 静帧上量的指标（例如 5% 分位明度、浓墨占比、有没有直边），也要写一眼能读出的内容。
3. 资产清单：列出要重出的每一张图，每张写清：
   - 编号和用途；
   - 尺寸比例；
   - 提示词，中英文都给，末尾带规范要求的防崩约束；
   - 参考图：用 refs/D_wushan 的编号，2–4 张；
   - 是否透明底；
   - 锚点要求。
   出图顺序：角色先出设定图，再出姿态。陆蔚按雾山五行的人物画法，不要日系 TV 动画画法；豹按玄豹（金钱豹）的环斑来画，不要猎豹的泪痕纹和实心点斑。人物不出正脸。
4. 可以把某一段整段换成更可控的画法，但不能改任务书的七段结构和分镜要点，也不能减少转场。
5. 排优先级：先保住画风统一和母题清楚（墨渍→豹斑→光斑），再修技术瑕疵。估一下工作量，保证能在一轮返修里做完。
只写 PLAN.md，不改影片代码和资产。`

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plan_path: { type: 'string' },
    packages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, issue_ids: { type: 'array', items: { type: 'string' } }, approach: { type: 'string' }, acceptance: { type: 'string' } }, required: ['name', 'issue_ids', 'approach', 'acceptance'] } },
    assets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, purpose: { type: 'string' }, ratio: { type: 'string' }, refs: { type: 'string' }, transparent: { type: 'boolean' } }, required: ['id', 'purpose'] } },
    summary: { type: 'string' },
  },
  required: ['plan_path', 'packages', 'assets', 'summary'],
}

const ASSET = (v) => `${HEAD('资产（Asset）', v)}

按 films/D_wushan/_work/w3/PLAN.md 里的资产清单，用 Magpie 重出资产，遵守规范第二节第 10 条。
- 先用 ToolSearch 加载：select:mcp__magpie-image__generate_image,mcp__magpie-image__generation_result。
- 角色先出设定图，用 Read 亲眼看过、满意以后，再拿设定图当 reference_images 出其余姿态，保证是同一个角色。豹要读得出是玄豹：环斑，没有泪痕纹。陆蔚是雾山五行的画法，不出正脸。
- 每张图都要等结果出来、用 Read 看过。需要透明底的，确认确实是透明底，没有白边，也没有棋盘格。不满意就改提示词重出；同样的失败出现两次就换思路。
- 新图存到 films/D_wushan/assets/，文件名用 ASCII 小写字母加下划线。旧图不要删，改名后移到 films/D_wushan/_work/w3/asset_replaced/。更新 assets/manifest.json，每条写用途、尺寸、锚点和提示词。
- 拼一张新资产总览：films/D_wushan/_work/w3/assets_sheet.jpg。
不改影片代码，接入资产是返修代理的事。汇报写清：每张新图的路径、锚点、透明底检查结果，以及没出好的图。`

const ASSET_SCHEMA = {
  type: 'object',
  properties: {
    assets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } }, required: ['id', 'path', 'ok'] } },
    sheet: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['assets', 'sheet', 'summary'],
}

const listText = (v, k, openIds, newIssues, notes) => k === 1 && !newIssues.length
  ? `问题单文件 films/${v.key}/_work/w3/ISSUES.json 里的全部 ${openIds.length} 条。`
  : `问题单文件 films/${v.key}/_work/w3/ISSUES.json 里编号为 ${JSON.stringify(openIds)} 的条目，以及下面这些新问题（JSON）：
${JSON.stringify(newIssues)}
上一轮复核对没修好的条目是这样说的：${JSON.stringify(notes)}`

const FIX = (v, k, list, extra) => `${HEAD(`返修（第三轮第 ${k} 次，总第 ${3 + k} 轮）`, v)}

本次要处理的问题：${list}
问题编号的来源见规范第八节。${v.plan ? '\nD 版这一次按 films/D_wushan/_work/w3/PLAN.md 里的工作包做。新资产已由资产代理出好：清单在 assets/manifest.json，总览图是 _work/w3/assets_sheet.jpg。' : ''}${extra || ''}
要做的事：
1. 先合并重复的问题，再按 P0 → P1 → P2 → P3 排序。目标是交付线（规范第四节）：六项都在 8 分以上，没有 P0、P1。
   - P0、P1、P2 都要修好。
   - P3 尽量修，先修复核扣分理由里点到的。
   - 同一条修了两次还没改好，就换思路，并在返修记录里写明。
2. 每修一批，就在 5090 上渲出相关时刻：sh tools/rog_stills.sh films/${v.key} ... --tag w3fix${k}_<名字>。用 Read 亲眼确认已经改好，再和 v2 基线同一时刻的帧对比，确认没有改坏别处。
3. 需要重出资产时用 Magpie，遵守规范第二节第 10 条：
   - 角色先出设定图，再出姿态；
   - 新图用 Read 看过、透明底查过，再更新 manifest.json 和代码里的锚点。
   改了配乐或 audio.json 的，按配乐口径重出 _work/audio_report.txt，并量最后 3 秒的瞬时响度。
4. 最后跑 sh tools/gate.sh films/${v.key}，必须全部 PASS。再渲一张整片接触印样：--range 0:29.5:0.5 --tag w3fix${k}_final。
5. 在 NOTES.md 的「返修记录」里追加这一次的记录。逐条写：问题编号、处理结果（已修 / 部分修 / 未修）、怎么改的、证据图路径；未修的写原因。
只改 films/${v.key}/；配乐只改 audio/${v.key}*。汇报：逐条处理结果、门禁结果、整片印样路径。`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    gate_pass: { type: 'boolean' },
    sheet: { type: 'string' },
    results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'partial', 'not_fixed'] }, how: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'status', 'how'] } },
    summary: { type: 'string' },
  },
  required: ['gate_pass', 'sheet', 'results', 'summary'],
}

const VERIFY = (v, k, list, fix) => `${HEAD(`复核（对抗式，第三轮第 ${k} 次，总第 ${3 + k} 轮）`, v)}

返修声称做了这些（JSON）：
${JSON.stringify(fix)}
本轮问题单：${list}
你的立场：默认不相信"已修"。
- 逐条在 5090 上重新渲相关时刻：sh tools/rog_stills.sh films/${v.key} <时刻...> --tag w3verify${k}_<编号>。
- 亲眼核实，并和 v2 基线（out/v2/check_${v.key}/frames/ 里同一时刻的帧）对比。
- 每条给出结论：resolved（确实修好）、unresolved（没修好或修得不对）、regressed（改出了新问题）。本轮问题单里的每一条都要有结论。
然后用 --range 0:29.5:0.5 --tag w3verify${k}_full 渲一张整片接触印样，从头挑新问题，编号写成 r${3 + k}-01 这样。特别留意返修有没有把 v2 里原本好的地方改坏。
最后跑 sh tools/gate.sh films/${v.key}，核对门禁。
按规范第四节给六项打分（1–10）：
- 打分前把本片大图和参考静帧并排比过。
- 分数按第四节表里的描述对号入座，不凭印象。
- 每一项写一句扣分理由（score_notes）。
- 分数要诚实，宁严勿松；已经达到参考水平的，也照实给到。
交付线：六项都在 8 分以上，门禁全部通过，并且没有剩余的 P0 或 P1。达到才算 pass=true。`

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    gate_pass: { type: 'boolean' },
    scores: SCORES,
    score_notes: SCORE_NOTES,
    verdicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['resolved', 'unresolved', 'regressed'] }, note: { type: 'string' } }, required: ['id', 'verdict'] } },
    new_issues: { type: 'array', items: ISSUE },
    summary: { type: 'string' },
  },
  required: ['pass', 'gate_pass', 'scores', 'score_notes', 'verdicts', 'new_issues', 'summary'],
}

const RENDER = (v) => `${HEAD('渲染（Renderer）', v)}

执行正式出片：cd ${ROOT} && sh tools/finish.sh ${v.key}
这个脚本会依次做这些事：
- 整片渲染全局排队，另一版在渲时它会等锁；
- 增量同步到 5090，用 6 个 worker 渲 720 帧，渲染期间持有本片的锁；
- 配乐对位后截取 30 秒，按 audio.json 做淡入淡出；
- 线性响度封装成 out/豹变_${v.key}.mp4（有限范围 BT.709）；
- 写 out/check_${v.key}/report.txt 和 tile.jpg。
Bash 单次最长 10 分钟：用 run_in_background 跑，等完成通知；或者把超时设成 600000，超时后接着查进度。
如果失败，读报错。页面在 5090 上报错、超时之类的问题，可以改 films/${v.key}/ 里的代码，改完重跑门禁和 finish。不要改 tools/ 和 engine/，不要动 5090 上别人的进程，不要动 out/v2/。
完成后核对 report.txt：
- nb_read_frames=720，duration=30.000；
- I 在 −14 LUFS 左右，真峰值不超过 −1 dBTP；
- yuv420p、tv、bt709；
- 没有长黑场。
再用 Read 看 tile.jpg。`

const RENDER_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, mp4: { type: 'string' }, frames: { type: 'number' }, duration: { type: 'number' }, lufs: { type: 'string' }, render_seconds: { type: 'string' }, notes: { type: 'string' } },
  required: ['ok', 'mp4', 'notes'],
}

const QA = (v) => `${HEAD('终检（Final QA）', v)}

成片是 ${ROOT}/out/豹变_${v.key}.mp4（第三轮），已经封装好，不要再改影片代码。
1. 从成片里每 0.5 秒抽一帧：滤镜里加 scale=flags=accurate_rnd+full_chroma_int,format=rgb24，或者用 tools/grab.sh。文件命名成 s_<秒>.jpg，放到 out/check_${v.key}/frames/。用 tools/sheet.py 拼成 out/check_${v.key}/qa_sheet.jpg，逐格用 Read 看。再抽 6 张全尺寸大图看细节。
2. 和 films/${v.key}/_work/gate/main/ 里同一时刻的门禁静帧对比，确认成片和门禁时的画面一致：没有编码块、色偏或掉帧。
3. 和 out/v2/check_${v.key}/frames/ 里同一时刻的 v2 帧逐格对比，写清哪里变好了、哪里变差了。变差的当问题报。
4. 查声音：用 ebur128 和 astats 看响度、峰值、开头和结尾的淡入淡出，最后 3 秒的瞬时响度要平稳往下走；按配乐口径核实关键动作是不是踩在音乐点上。
5. 查封装：yuv420p、tv、bt709 标记，720 帧，30.000 秒。
6. 写 out/check_${v.key}/QA.md（覆盖旧的），内容包括：逐段观感、和 v2 相比的变化、剩余瑕疵（按 P0–P3）、六项打分、一句话卖点（这版最打动人的地方）。`

const QA_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, scores: SCORES, remaining: { type: 'array', items: ISSUE }, vs_v2: { type: 'string' }, pitch: { type: 'string' }, summary: { type: 'string' } },
  required: ['ok', 'scores', 'remaining', 'vs_v2', 'pitch', 'summary'],
}

const meets = (vd) => !!vd && vd.pass && vd.gate_pass && SC.every(s => (vd.scores?.[s] ?? 0) >= 8)
const qaBad = (q) => !q || !q.ok || SC.some(s => (q.scores?.[s] ?? 0) < 8) || (q.remaining || []).some(i => i.level === 'P0' || i.level === 'P1')

async function loop(v, start, openIds, newIssues, notes, maxK, extra) {
  const history = []
  let verdict = null
  for (let k = start; k < start + maxK; k++) {
    const list = listText(v, k, openIds, newIssues, notes)
    const fix = await run(FIX(v, k, list, k === start ? extra : ''), { label: `fix:${v.key}:r${3 + k}`, phase: 'Fix', schema: FIX_SCHEMA })
    if (!fix) { log(`${v.key} 第 ${3 + k} 轮返修没有结果，停止返修`); break }
    verdict = await run(VERIFY(v, k, list, fix), { label: `verify:${v.key}:r${3 + k}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    history.push({ round: 3 + k, fix, verdict })
    if (!verdict) { log(`${v.key} 第 ${3 + k} 轮复核没有结果，停止返修`); break }
    if (meets(verdict)) { log(`${v.key} 第 ${3 + k} 轮复核达到交付线 ${JSON.stringify(verdict.scores)}`); break }
    const bad = (verdict.verdicts || []).filter(x => x.verdict !== 'resolved')
    const open = new Set(bad.map(x => x.id))
    notes = Object.fromEntries(bad.map(x => [x.id, x.note || '']))
    openIds = openIds.filter(id => open.has(id))
    newIssues = newIssues.filter(i => open.has(i.id)).concat(verdict.new_issues || [])
    log(`${v.key} 第 ${3 + k} 轮复核未达交付线 ${JSON.stringify(verdict.scores)}，剩 ${openIds.length + newIssues.length} 条`)
  }
  return { history, verdict, openIds, newIssues, notes, next: start + history.length }
}

const results = await pipeline(
  VERSIONS,
  async (v) => {
    if (!v.plan) return {}
    const plan = await run(PLAN(v), { label: `plan:${v.key}`, phase: 'Plan', schema: PLAN_SCHEMA })
    if (!plan) { log(`${v.key} 返修规划没有结果，直接按问题单返修`); return {} }
    log(`${v.key} 返修规划：${plan.packages.length} 个工作包、${plan.assets.length} 张资产`)
    const asset = plan.assets.length ? await run(ASSET(v), { label: `asset:${v.key}`, phase: 'Asset', schema: ASSET_SCHEMA }) : null
    if (asset) log(`${v.key} 资产重出 ${asset.assets.filter(a => a.ok).length}/${asset.assets.length} 张合格`)
    return { plan, asset }
  },
  async (prev, v) => {
    const r = await loop(v, 1, v.ids.slice(), [], {}, v.rounds, '')
    if (!meets(r.verdict)) log(`${v.key} 第三轮返修 ${r.history.length} 次后仍未达到交付线，带着剩余问题出片`)
    return { ...prev, ...r }
  },
  (prev, v) => run(RENDER(v), { label: `render:${v.key}`, phase: 'Render', schema: RENDER_SCHEMA }).then(x => ({ ...prev, render: x })),
  async (prev, v) => {
    if (!prev.render || !prev.render.ok) { log(`${v.key} 出片没有成功，跳过终检`); return prev }
    let qa = await run(QA(v), { label: `qa:${v.key}`, phase: 'QA', schema: QA_SCHEMA })
    const extraRound = { ...prev, qa }
    if (!qaBad(qa) && meets(prev.verdict)) return extraRound
    // 回炉一次：终检或复核没过线
    log(`${v.key} 终检或复核未过线，回炉一次`)
    const qaIssues = ((qa && qa.remaining) || []).map((i, n) => ({ ...i, id: `qa3-${String(n + 1).padStart(2, '0')}` }))
    const extra = `\n这一次是终检后的回炉：终检（从第三轮成片抽帧）报告在 out/check_${v.key}/QA.md，它提的问题已经编成 qa3- 开头放进本次的新问题里。`
    const r2 = await loop(v, prev.next, prev.openIds, prev.newIssues.concat(qaIssues), prev.notes, 1, extra)
    const render2 = await run(RENDER(v), { label: `render:${v.key}:again`, phase: 'Render', schema: RENDER_SCHEMA })
    if (!render2 || !render2.ok) { log(`${v.key} 回炉后出片失败，保留第一次的成片`); return { ...extraRound, again: { ...r2, render: render2 } } }
    const qa2 = await run(QA(v), { label: `qa:${v.key}:again`, phase: 'QA', schema: QA_SCHEMA })
    return { ...prev, qa_first: qa, history: prev.history.concat(r2.history), verdict: r2.verdict || prev.verdict, render: render2, qa: qa2 }
  },
)

phase('Compare')
const brief = VERSIONS.map((v, i) => {
  const x = results[i] || {}
  return { version: v.key, name: v.name, verdict: x.verdict && { pass: meets(x.verdict), scores: x.verdict.scores, score_notes: x.verdict.score_notes }, rounds: (x.history || []).map(h => h.round), qa: x.qa && { scores: x.qa.scores, remaining: x.qa.remaining, vs_v2: x.qa.vs_v2, pitch: x.qa.pitch }, render: x.render && { ok: x.render.ok, mp4: x.render.mp4, lufs: x.render.lufs } }
})
const compare = await run(`你是《豹变》项目的总审（第三轮）。工程在 ${ROOT}。
- 四版第三轮成片：out/豹变_<版本>.mp4；
- 各版终检：out/check_<版本>/QA.md、tile.jpg、qa_sheet.jpg；
- 第二轮存档：out/v2/（成片 豹变_<版本>_v2.mp4，另有 check_<版本>/、SUMMARY.md、compare/）。
开工前先读 ${ROOT}/SUBAGENT_STANDARD.md 和 ${ROOT}/BRIEF.md。下面是各版复核和终检的结构化结果：
${JSON.stringify(brief)}
1. 逐版用 Read 看 tile.jpg 和 qa_sheet.jpg。每版用 tools/grab.sh 从成片抽同一批时刻的大图：8.0、17.5、25.0、29.0 秒，即第 192、420、600、696 帧。拼一张四版对比总图 out/compare/compare_grid.jpg（out/v2/compare/ 里有第二轮的存档，可以覆盖 out/compare/ 下的旧图）。再拼入书、集市、豹眼变镜片三段的逐帧序列。
2. 每版和 v2 对比：哪些问题修掉了，哪些地方变好了，有没有变差。
3. 把总结全文作为你的最后一条消息返回，不要自己写 SUMMARY.md，主会话会存。总结用中文，简洁，内容包括：
   - 四版成片路径和一句话定位；
   - 推荐看片顺序；
   - 每版的亮点、和 v2 相比的变化、剩余问题（按 P0–P3）；
   - 四版六项打分表：复核分、终检分、你看片给的分，三行都列；
   - 推荐哪一版作为正片方向，理由是什么；
   - 做成 3 分钟正片还需要补什么。
不改任何影片、工具和配乐。`, { label: 'compare:all', phase: 'Compare' })

return { versions: VERSIONS.map((v, i) => ({ version: v.key, ...(results[i] || { failed: true }) })), compare }
