# beiming/：新系统的根目录

新系统在这个目录里旁建，旧目录（`engine/`、`tools/`、`routes/`、`films/` 等）冻结不动。

## 目录

| 目录 | 管什么 |
|---|---|
| `kernel/contracts/` | 契约：全系统唯一的统一点。写法约定见 [kernel/contracts/CONVENTIONS.md](kernel/contracts/CONVENTIONS.md) |
| `kernel/eval/` | 求值核：时间线、事件、随机流、插值 |
| `sources/` | 帧源：只有它接触渲染器 |
| `comp/`、`observe/`、`verify/`、`cards/`、`bench/`、`harvest/`、`api/`、`jobs/` | 合成收尾、感知、验收、技术卡、考题、收获、协议、作业 |
| `calib/` | 校准场景 |
| `crew/` | 多代理施工：总则、角色提示词、任务书模板、配置表。见 [crew/README.md](crew/README.md) |

每个目录归谁、谁能改，以 `kernel/contracts/` 里的目录归属表为准。

## 三条依赖规则

1. `kernel` 不依赖任何帧源和渲染库。
2. 新目录只能引用旧目录的白名单模块；旧目录不引用新目录。
3. 跨组件只通过契约说话。要别的组件改东西，提变更单，不直接改。
