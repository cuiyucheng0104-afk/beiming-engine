// 北冥仓库 · agent 护栏策略（唯一数据源）
// 做什么：列出 agent 不许写的区域、不许跑的命令类别、临时解锁的办法和每条拒绝给出的中文下一步。
// 谁在用：.claude/hooks/guard.mjs（Claude Code 的 PreToolUse 钩子）、.githooks/pre-commit.mjs、
//         tools/repo-check/rules/agent/（规范检查）、tests/agent-layer/。改这里就同时改了三处的口径。
// 接口：ZONES、UNLOCK_ENV、unlockedZones(env)、zoneOf、zoneUnder、HOME_STYLE_DIRS、
//       UPSTREAM_STYLE_SKILL、VIDEO_SKILL_HINT、REPO_SKILL_PREFIX、MEMORY_FILE_NAMES、INSTRUCTION_FILE_NAMES、
//       LOCAL_ONLY_INSTRUCTION_FILES、isInstructionFile(rel)、
//       RULES（规则 id → 一句话原因 + 下一步）、ALWAYS_DENY_RULES、GIT_UNLOCK、LOG_ENV、DEFAULT_LOG。
// 只有数据和纯函数，不读写文件。

/** 临时解锁：由用户在启动 Claude Code 之前设置（或写进不入库的 .claude/settings.local.json 的 env），
 *  值是逗号分隔的区域 id，例如 BEIMING_GUARD_UNLOCK=src。agent 自己 export 不会影响钩子进程。 */
export const UNLOCK_ENV = 'BEIMING_GUARD_UNLOCK';

/** 钩子日志：默认写 <仓库>/out/agent-guard/guard.jsonl（out/ 已被 .gitignore 忽略）；设为 off 关闭，设为路径则改写到该文件。 */
export const LOG_ENV = 'BEIMING_GUARD_LOG';
export const DEFAULT_LOG = 'out/agent-guard/guard.jsonl';

/**
 * 受保护区域。prefixes 以 / 结尾表示目录；files 是单个文件。路径一律是仓库相对、正斜杠。
 * kind：archive 归档（只读资料）、baseline 视觉基准、license 许可、generated 工具生成、guard 护栏本身。
 */
export const ZONES = [
  {
    id: 'vendor', kind: 'archive', unlock: 'vendor',
    prefixes: ['cases/vendor/'], files: [],
    title: 'cases/vendor/ 是第三方风格库的固定快照（lock.json 逐字节校验），只读',
    next: '作品一律放 films/<名字>/（npm run new -- <a|b|c> <名字>）；要学某个风格，读 cases/vendor/…/STYLE.md 后在作品里自己实现，沿用代码时保留原作者 MIT 署名（THIRD-PARTY.md）。不要在快照里建 films/ 或 out/，也不要在快照目录里运行上游命令',
  },
  {
    id: 'source', kind: 'archive', unlock: 'source',
    prefixes: ['cases/source/'], files: [],
    title: 'cases/source/ 是历史源码归档（catalog.json 记录每个文件的哈希），只读',
    next: '要看或重跑历史作品：python3 tools/casebook.py restore <案例 id> --out out/casebook 还原到 out/ 再改；新作品放 films/<名字>/',
  },
  {
    id: 'src', kind: 'baseline', unlock: 'src',
    prefixes: ['src/'], files: [],
    title: 'src/ 是《北冥》10 秒样片：A 路线的参考实现与视觉基准，默认只读（改动会改变金标准像素）',
    next: '新作品放 films/<名字>/，模块实验放 lab/，共享能力加在 engine/ 对应层。用户明确要求改原片时，请用户设置 BEIMING_GUARD_UNLOCK=src 后再改，并按金标准流程逐帧比对',
  },
  {
    id: 'license', kind: 'license', unlock: 'license',
    prefixes: ['cases/licenses/', 'LICENSES/'], files: ['LICENSE'],
    title: '许可证与署名文件不得删改（THIRD-PARTY.md）',
    next: '需要更新许可或署名时，把要改的内容写给用户或维护者，由维护者处理',
  },
  {
    id: 'catalog', kind: 'generated', unlock: 'catalog',
    prefixes: [], files: ['cases/catalog.json'],
    title: 'cases/catalog.json 由案例库工具生成并被 casebook check 校验，不手改',
    next: '改案例目录请用 tools/casebook.py 的子命令，改完跑 python3 tools/casebook.py check',
  },
  {
    id: 'agent-layer', kind: 'guard', unlock: 'agent-layer',
    prefixes: ['.claude/hooks/', '.claude/skills/', '.githooks/'], files: ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'],
    title: '这是 agent 执行层本身（权限、PreToolUse 钩子、仓库 skill、git 钩子），agent 不得自行修改或关闭',
    next: '需要调整护栏时告诉用户；维护者可设置 BEIMING_GUARD_UNLOCK=agent-layer 后修改，并跑 node --test tests/agent-layer',
  },
];

/** 嵌套指令文件：Claude Code、Codex 等会沿目录自动加载这些文件当指令。本仓库只有根目录一份。 */
export const MEMORY_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md'];

/**
 * 子目录里新建会被自动加载的 agent 配置：嵌套的 .claude/（settings、skills、commands、agents……）与 .mcp.json。
 * rel 是仓库相对路径（正斜杠）；根目录的 .claude/ 不算（那里归 agent-layer 区域管）。
 */
export function isNestedAgentConfig(rel) {
  const r = String(rel ?? '').replace(/\\/g, '/');
  if (/^[^/]/.test(r) && /\/\.claude\//i.test(r) && !/^\.claude\/worktrees\//i.test(r)) return true;
  return /\/\.mcp\.json$/i.test(r);
}

/** 规范检查里算作"agent 指令文件"的文件名（任何目录）。.claude-plugin/ 下的 JSON 另按目录判断。 */
export const INSTRUCTION_FILE_NAMES = [...MEMORY_FILE_NAMES, 'SKILL.md', 'DIRECTOR.md', '.cursorrules', '.windsurfrules', '.clinerules', 'copilot-instructions.md'];

/** 个人本地配置：未跟踪时不算仓库的指令文件（入库了照样要登记）。仓库相对路径，小写比较。 */
export const LOCAL_ONLY_INSTRUCTION_FILES = ['.claude/settings.local.json', 'claude.local.md'];

const INSTRUCTION_NAMES_LC = new Set(INSTRUCTION_FILE_NAMES.map(n => n.toLowerCase()));

/**
 * 会被 agent 工具（Claude Code、Codex、Cursor、Gemini CLI 等）当成指令或配置自动加载的文件。
 * rel 是仓库相对路径（正斜杠或反斜杠都行）。规范检查 agent.instruction-files 与提交前检查 instructions 共用这一个判定。
 */
export function isInstructionFile(rel) {
  const r = String(rel ?? '').replace(/\\/g, '/');
  const base = (r.split('/').pop() ?? '').toLowerCase();
  if (INSTRUCTION_NAMES_LC.has(base)) return true;
  if (/(^|\/)\.claude-plugin\/[^/]+\.json$/i.test(r)) return true;
  if (/(^|\/)\.claude\/(settings(\.local)?\.json|agents\/.+\.md|commands\/.+\.md|rules\/.+|output-styles\/.+\.md)$/i.test(r)) return true;
  if (/(^|\/)\.mcp\.json$/i.test(r)) return true;
  if (/(^|\/)\.cursor\/rules\//i.test(r) || /(^|\/)\.codex\//i.test(r)) return true;
  return false;
}

/**
 * 上游风格库在家目录的默认副本（全局 skill 会克隆、更新、写入这里），在本仓库里不读、不写、不执行，没有例外。
 * 以前留过一条例外：把 ~/lemo-opuscar/.venv 当带 numpy / numba 的解释器执行。仓库自己的环境（npm run setup 建的 .venv，
 * tools/env/py.mjs 默认就找它）落地后删掉了：评测硬门 H4 按「没有访问 ~/lemo-*」判，护栏口径与它一致。
 * 用户确实要用别处的解释器时，由用户在启动前设 BEIMING_PYTHON（脚本经环境变量拿到，agent 的命令里不出现那个路径）。
 */
export const HOME_STYLE_DIRS = ['lemo-opuscar', 'lemo-my-styles'];

/** 全局安装的第三方风格库 skill（插件 skill 名形如 lemo-opuscar:lemo-opuscar）。在本仓库里拒绝调用。 */
export const UPSTREAM_STYLE_SKILL = /^(lemo-opuscar|sy-style-100)(:|$)/i;

/** 其他全局视频 / 动画类 skill：不拦，只提醒先走本仓库的 beiming-film。 */
export const VIDEO_SKILL_HINT = /(video|film|movie|anim|motion|reel|remotion|hyperframes|manim|lottie|render|doodle|cartoon|slideshow|3d|blender|三渲二|动画|短片|视频)/i;
export const REPO_SKILL_PREFIX = 'beiming-';

/** 拒绝时附在原因后面的说明。键是规则 id。 */
export const RULES = {
  'home-style-library': {
    title: '家目录下的上游风格库副本（~/lemo-opuscar、~/lemo-my-styles）在本仓库里不读不写：版本不固定，也绕开了快照、许可与验收',
    next: '风格只在仓库的固定快照里查：先读 routes/c-style/STYLES.md，再按其中链接读 cases/vendor/…/STYLE.md。需要带 numpy、numba 的 Python 时，用 npm run setup 建的仓库环境（.venv，node tools/env/py.mjs 会找到它），或用户在启动前设好的 BEIMING_PYTHON（命令里写 "$BEIMING_PYTHON"，不要写出它指向的家目录路径）',
  },
  'nested-instructions': {
    title: '子目录里的 AGENTS.md / CLAUDE.md / GEMINI.md、嵌套的 .claude/ 配置与 skill、.mcp.json 会被 agent 工具自动加载；本仓库只有根目录 AGENTS.md 一份指令',
    next: '子目录的说明写成 README.md；确需改变 agent 行为，把修改建议交给维护者写进根 AGENTS.md（维护者可设置 BEIMING_GUARD_UNLOCK=instructions）',
  },
  'archive-exec': {
    title: '不在 cases/vendor/、cases/source/ 里运行代码：上游的 make.js、build.sh、setup.sh 会把产物写进只读快照，setup.sh 还会克隆或 reset --hard 家目录里的上游库',
    next: '历史作品用 python3 tools/casebook.py restore <id> --out out/casebook 还原后在 out/casebook 里看；做片用本仓库的 npm run / engine/render 命令，产物只写 films/<名字>/out/',
  },
  'git-add-all': {
    title: '不用 git add -A / --all（git stage 同理）：整树暂存会把别人的改动、成片、媒体和客户材料一起带进提交',
    next: '只按文件名暂存本次改动的源码，例如 git add films/<名字>/film.json films/<名字>/main.js；先 git status 看清楚',
  },
  'git-add-dot': {
    title: '不用 git add . / * / :/（git stage 同理；整目录、整树的通配暂存）',
    next: '只按文件名暂存本次改动的源码；out/、帧序列、wav、mp4 不提交',
  },
  'git-add-update': {
    title: '不用不带路径的 git add -u：会暂存整个仓库里所有已跟踪文件的改动',
    next: '按文件名暂存；或给 -u 加上自己负责的路径（git add -u films/<名字>/）',
  },
  'git-add-force': {
    title: '不用 git add -f：被 .gitignore 忽略的文件（out/、成片、虚拟环境、密钥）不该入库',
    next: '确实需要入库的文件请告诉维护者，由集成负责人改 .gitignore',
  },
  'git-add-pathspec-file': {
    title: '不用 --pathspec-from-file：看不到具体会暂存哪些文件',
    next: '把要暂存的文件名直接写在命令里',
  },
  'git-commit-all': {
    title: '不用 git commit -a / --all 或 git commit .：会顺带提交所有已跟踪文件的改动',
    next: '先按文件名 git add，再 git commit -m "中文说明"',
  },
  'git-no-verify': {
    title: '不跳过 git 钩子，也不放行其中的检查（--no-verify / -n、设置 BEIMING_PRECOMMIT_ALLOW）：pre-commit 负责挡住快照改动、成片和大文件',
    next: '按 pre-commit 的报错修好再提交；确认是误报时告诉用户——放行只能由用户本人在 Claude Code 之外的终端里执行（Claude Code 发起的提交里 BEIMING_PRECOMMIT_ALLOW 本来也不生效）',
  },
  'git-hooks-bypass': {
    title: '不用 -c core.hooksPath=… 临时换掉或关掉 git 钩子',
    next: '按钩子的报错修好再提交',
  },
  'git-hooks-path': {
    title: '不把 core.hooksPath 改到别处、不取消它、不在 --global / --system 里改：那会关掉或替换提交前检查，还会影响本机所有仓库',
    next: '要启用本仓库的提交前检查，只用 git config core.hooksPath .githooks（只作用于本仓库）；停用或改到别处由用户自己执行',
  },
  'git-push-force': {
    title: '不强推（--force、-f、--force-with-lease、+refspec、--mirror）：不改写已公开的历史（决定 D02）',
    next: '先 git pull --rebase 或另开分支再推；确需改写历史只能由用户亲自操作',
  },
  'git-push-delete': {
    title: '不删除远端分支或标签（--delete、-d、:ref、--prune）：公开且不可逆的操作只能由用户执行',
    next: '把要删的分支或标签告诉用户，由用户自己执行',
  },
  'git-history-rewrite': {
    title: '不改写 git 历史（filter-branch、filter-repo）：用户已决定需要删除的内容只在新提交里删除（D02）',
    next: '在新提交里删除或修改文件',
  },
  'git-reset-hard': {
    title: '不用 git reset --hard：会丢掉工作区里所有未提交的改动，包括别的代理正在做的',
    next: '丢弃自己的改动请按文件 git restore <文件>；要换基线请另开工作树',
  },
  'git-clean': {
    title: '不用 git clean -f：会删掉所有未跟踪文件，包括别人的新作品和渲染产物',
    next: '先 git clean -n 看清楚，再只清自己的目录：git clean -fd films/<名字>/out/（带路径且不碰只读区域时放行）',
  },
  'git-discard-all': {
    title: '不整树丢弃改动（git checkout -- . / git checkout -f / git restore .）：会覆盖别人未提交的工作',
    next: '按文件 git restore <文件> 丢弃自己的改动',
  },
  'skill-upstream-style-library': {
    title: '在本仓库里不调用全局的第三方风格库 skill（lemo-opuscar、sy-style-100）：它们会克隆或更新家目录里版本不固定的副本，把作品带出仓库',
    next: '用仓库自带的 beiming-film skill：读 routes/README.md 选路线，风格在 routes/c-style/STYLES.md 里查',
  },
  'publish-irreversible': {
    title: '删除 Release、删库、改仓库可见性或改名是公开且不可逆的操作，只能在用户明确授权后由用户执行',
    next: '把要执行的命令和影响写给用户，由用户自己执行（维护者可设置 BEIMING_GUARD_UNLOCK=publish）',
  },
};

/**
 * 命令规则分两档：
 *   ALWAYS_DENY_RULES 永远拒绝，同时写在 .claude/settings.json 的 permissions.deny 里（整树暂存、强推）；
 *   其余 git-* 规则保护的是工作区里别人未提交的改动与提交前检查，维护者可设置 BEIMING_GUARD_UNLOCK=git 解锁。
 * 只改本仓库工作区的规则（暂存、提交、reset、clean、checkout、restore、rm、mv、config）只在命令落在本仓库里时生效；
 * 推送与删除远端影响公开仓库，在哪里执行都管。
 */
export const ALWAYS_DENY_RULES = new Set(['git-add-all', 'git-add-dot', 'git-push-force']);
export const GIT_UNLOCK = 'git';

/** 解析解锁环境变量，返回小写区域 id 集合。不支持 all：每个区域必须点名。 */
export function unlockedZones(env = process.env) {
  const raw = String(env?.[UNLOCK_ENV] ?? '').toLowerCase();
  return new Set(raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
}

/** 仓库相对路径（正斜杠）→ 命中的区域；ci 为真时按大小写不敏感比较（macOS、Windows 的默认文件系统）。 */
export function zoneOf(rel, { ci = false } = {}) {
  if (rel == null) return null;
  const norm = s => (ci ? s.toLowerCase() : s);
  const r = norm(rel.replace(/\\/g, '/').replace(/^\.\//, ''));
  for (const z of ZONES) {
    if (z.files.some(f => norm(f) === r)) return z;
    for (const p of z.prefixes) {
      const pp = norm(p);
      if (r === pp.slice(0, -1) || r.startsWith(pp)) return z;
    }
  }
  return null;
}

/** rel 是否是某个区域的上级目录（含仓库根 ''）：递归删除或移动它会连带区域。返回被连带的第一个区域。 */
export function zoneUnder(rel, { ci = false } = {}) {
  if (rel == null) return null;
  const norm = s => (ci ? s.toLowerCase() : s);
  let r = norm(rel.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, ''));
  for (const z of ZONES) {
    for (const p of [...z.prefixes, ...z.files]) {
      const pp = norm(p);
      if (r === '' || pp.startsWith(r + '/')) return z;
    }
  }
  return null;
}
