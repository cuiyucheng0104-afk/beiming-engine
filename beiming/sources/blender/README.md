# Blender 帧源

业务契约：[帧源接口](../../kernel/contracts/source/CONTRACT.md)、[场景包](../../kernel/contracts/scene-pack/CONTRACT.md)、[输出通道](../../kernel/contracts/passes/CONTRACT.md)、[目录归属](../../kernel/contracts/ownership/CONTRACT.md)。

## 两种作者模式

`host.mjs` 的 `startSource` 起常驻后台 Blender，交回 `caps`、`open`、`stop`。`caps.mjs` 声明能力；`planOpen`、`planRender` 不碰 Blender。`worker.py` 按行收 JSON，搭场景、渲各层、量元数据。

### `build-script`：镜头搭场景

不接卡、资产、叠加层。入口的 `build(ctx)` 设好透视相机，返回 `entities`。原有镜头不用改；也可用 `ctx.runtime`（同目录 `runtime.py`），额外交两个可选钩子：

```python
rt = ctx.runtime
line = rt.Timeline(ctx.fps, ctx.frames).segment('turn', 0, ctx.frames)
pins = rt.principled_indices(bsdf)
rt.set_socket(bsdf, pins['base_color'], (0.4, 0.5, 0.7, 1), 'RGBA')

def state(f):
    u = rt.trapezoid_profile(line.progress('turn', f), 0.25)
    return {'objects': {body: {'rotation_euler': (0, 0, 6.283185307 * u)}},
            'sockets': {(bsdf, pins['roughness'], 'VALUE'): 0.2 + 0.3 * u}}

return {'entities': [{'name': 'body', 'class': 'part', 'objects': [body]}],
        'state': state, 'meta': lambda f: {'readings': {'seconds': float(line.frame_to_seconds(f))}}}
```

- **时间**：`Timeline` 保留有理帧率；`segment(name,start,duration)` 是左闭右开段，`mark(name,frame)` 是一帧的标记。`span` 取两端，`frame_of` 取起点，`after(name,offset=0)` 从终点偏移。`progress` 首帧 0、末帧 1（单帧取 1），段外夹紧。另有 `smoothstep`、`ease_in_out`。`export_events(film_id)` 将各起点导成排序的 `events/0.1` 表（时间线以全片第 0 帧为原点时直接用）。
- **状态**：`state(f)` 不读上一帧、不改场景，每次交齐同一组通道的绝对值，须能算第 −1 帧与镜头末尾的后一帧。每镜头一个 `StateKernel(state)`；`write_state_keys(scene,f,kernel)` 只求 `f−1, f, f+1`，替换受管曲线，停到 `f`。物体用 Blender 局部 `location`、`rotation_euler`／`rotation_quaternion`、`scale` 或行优先 4×4 TRS `matrix`；可见性用 `hide_render`、`hide_viewport`。`to_blender`、`to_beiming` 给位置换轴。
- **材质**：`principled_indices(node)` 从实际节点的 RNA 标识和类型生成常用插口序号表，不依赖界面语言。`socket_in/out(node,idx,expected_type)`、`set_socket`、`link_sockets(tree,src,i,dst,j)` 遇到越界或错类型报 `ValueError`。
- **元数据**：`meta(f)` 只交 `texts: [{id?, text, bbox2d}]`（基准画幅像素）、`anchors: {'实体#锚点': [x,y,z]}`（北冥 Y-up 世界坐标）、`readings: {名称: 有限数}`，也可交 `MetaCollector`，用 `add_anchor(key,pos,blender=True)` 自动换轴。worker 按画幅缩放文字框，用实测相机投影锚点。`texts` 空时为 `null`。`origin.shot` 按帧标记 `entities.*.anchors`、`texts`、`readings`。

### `cards-data`：固定脚本装载

镜头不写代码。通过 `startSource({ cards })` 提供卡目录，才声明这个模式。node 检查输入、解参数和卡的次序，数据卡在求值核里跑；`loader.py` 与 `assets.py` 在 Blender 里完成其余步骤：

1. `assets`：载入镜头资产；别名是装配体，零件名为 `<别名>.<零件名>`。全片资产到卡调 `ctx.assets.load` 才载，零件不进实体表。
2. `tracks`：按书写顺序求数据轨道，目前只写 `tracks.camera`。相机样条的 `look` 写实体名时，先量逐帧世界包围盒，相机朝盒中心看。
3. `create`：按 `ports.order` 建卡；叠加层实例排在镜头自己的卡之后。
4. `collect`：选相机（轨道 → 相机类卡 → 宿主备的原点相机，朝 −Z，竖直视场角 40 度），汇总实体并标角色。
5. `state`：出第 f 帧现算相邻三个整帧的轨道，`blender.state-keys` 写键，`blender.cycles` 定渲染器、降噪器与快门起点。草稿低采样加降噪，终稿取 `tiers.final.samples`。
6. `meta`：量元数据并进卡读数。装载次序、相机来历、卡实例与合并后的名字记在 `ext["blender.load"]`。

检查次序见帧源接口 5.14：模式不支持报 `contract.unsupported-mode`，缺锁报 `env.lock-required`，卡、资产或轨道不合报 `contract.unsupported-input`。

## 场景查询

`session.query(f, q)` 在镜头局部整帧回答 `bbox3d`、`anchor`、`intersect`、`contact`、`belowGround`。用 `of: ['part.*']` 可检查装配，省略 `against` 时在组内两两量测。坐标用北冥 Y-up 米制，每次最多 50 项。见[量测、锚点与关节豁免细则](DETAILS.md)。

## 资产与自检

支持 `kit-spec/0.1`、glTF、STL 和 `.blend` 资产。见[资产装载细则](DETAILS.md#资产装载)。

`node --test beiming/sources/blender/*.test.mjs` 测装载、运行库与实渲；`node --test beiming/cards/blender-cards.test.mjs` 测机制卡与 `s01`。没有 Blender 只跳过实渲；按 `BEIMING_BLENDER`、macOS 应用目录、`PATH` 找可执行文件。
