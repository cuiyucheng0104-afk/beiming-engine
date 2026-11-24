# beiming-tsl 的正负触发评测

每个文件一份用例：frontmatter 的 `description`（一句话）、`tags`（`positive` / `negative` 二选一）、正例另有 `covers`（引用 [../references/subject-routing.md](../references/subject-routing.md) 的主题 id）、`expected_outcome`（skill 应否触发、触发后落在哪里）；正文是用户口径的需求原文。

- **正例（13）**：每个主题一个，`covers` 合起来必须覆盖 subject-routing 总表的全部主题 id——`tests/offscreen/tsl-skill.test.mjs` 校验完备性与结构。
- **负例（5）**：容易误触发的请求——纯 Canvas 2D、音频、普通脚本、Shadertoy GLSL 移植、改风格基线越权。

改 SKILL.md 的触发边界时同步改这里；跑校验：`node --test tests/offscreen/tsl-skill.test.mjs`。
