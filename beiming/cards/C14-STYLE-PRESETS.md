# C14 北冥画风预设

四张 post 数据卡分别保存 beiming-original@v1 的 wide、actor、hero、hero-sunrise。通过注册表按主版本读取，例如 `post.beiming-look-actor@1`。卡的 data 入口每次返回独立的 `lookPreset` 对象，内含原预设引用、无镜头覆盖时 resolveLook 的完整结果，以及按旧校验器次序合并的覆盖路径规则。actor 的 outline 为 false，hero-sunrise 单独保存日光态的 toonGlobals。

运行 `node --test beiming/cards/c14-style-presets.test.mjs tests/style/c14-style-presets.test.mjs`。卡自测验证 C1、注册表回读及数据入口，外侧测试用原画风锁和 `resolveLook` 逐字段核对预设与覆盖范围。生产入口只读同目录 preset.json。每张卡处于 read 状态，按 ID 可读，代理搜索隐藏。渲染接入、画面对拍和创作签认另行记录。

`tracks.lookPreset` 按卡文件契约 §3 的 `tracks.*` 命名规则传递 JSON 对象。通过卡声明的 evaluate 入口和 lookPreset 输出端口取值。此切片的消费者是读取预设的调用方，未接入影片的浮点轨道编码与后期渲染链。
