# beiming/：新系统的根目录

新系统在这个目录里开发。旧链的作品与工具继续从原有入口运行。

## 目录

| 目录 | 管什么 |
|---|---|
| [kernel](kernel/README.md) | 契约、时间线、事件、随机流、插值 |
| [sources](sources/README.md)、[host](host/README.md) | 帧源与宿主 |
| [comp](comp/README.md)、[observe](observe/README.md)、[verify](verify/README.md) | 合成、感知、验收 |
| [cards](cards/README.md)、[harvest](harvest/README.md) | 技术卡及可复用经验 |
| [calib](calib/README.md)、[bench](bench/README.md) | 校准场景与考题 |
| [api](api/README.md)、[jobs](jobs/README.md) | 协议与作业 |
| [crew](crew/README.md) | 派工总则、角色、任务书模板和配置 |

一级组件由[目录归属表](kernel/contracts/ownership/ownership.json)登记。每个组件的 `README.md` 随实现更新，入口预算为 1500 token，按 UTF-8 字节数除以 3.5 向上取整。CI 通过 `npm run check` 执行这项检查，本地可单跑 `npm run check:repo -- --only core.component-docs`。

## 三条依赖规则

1. `kernel` 不依赖任何帧源和渲染库。
2. 新旧目录之间禁止互相引用。[依赖检查](kernel/guard.mjs)暂时保留六条核心工具引用和八条已锁定卡片的自测引用。
3. 跨组件只通过契约说话。要别的组件改东西，提变更单，不直接改。

CI 执行 `node beiming/kernel/guard.mjs`。拆仓验收用 `node beiming/kernel/guard.mjs --standalone`，逐条报告仍需迁移的引用。
