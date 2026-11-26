# 装配排程与运动采样

`scheduleAssembly(parts, options)` 接收右手 Y-up 的已装好位姿。每个零件提供唯一 `id`、米制 `rest_pos` 和可选的 `group`、`order`、XYZ 欧拉角 `rest_rot_deg`（度）。排程依次按声明的组优先级、组名、`order`、距原点距离和实体 ID 排序。`start_frame`、`gap_frames`、`fly_frames` 都是镜头局部整帧。`fps` 接收正数或 `"30000/1001"` 形式的有理数。

```js
import { evalSnapMotion, scheduleAssembly } from './index.mjs';

const plan = scheduleAssembly([{ id: 'part.lid', rest_pos: [0, 0.2, 0] }], {
  fps: '24/1', seed: 42, shot: 's01', start_frame: 4, fly_frames: 12,
});
const pose = evalSnapMotion(9.5, plan.parts[0]);
```

`plan.parts` 的每一行都可以直接交给 `evalSnapMotion`。新增零件可能改变现有零件的出发帧，已有零件的起始偏移和朝向由各自的命名随机流决定。`plan.events` 是镜头局部到位事件表，按到位帧和事件 ID 排序，帧率写为最简分数。调用方负责把局部事件并入全片时间轴。使用卡文件的镜头由帧源按锁文件解析卡实现，`assembly.schedule@1` 的入口位于 Blender。

## 重放 Python E5

用 `startSamples` 传入按零件 ID 索引的 JSON 对象。每件依次提供三个方向扰动和三个旋转扰动的单位随机数，取值范围 `[0, 1)`。这六个数可用 Python `random.Random(f"{seed}/assembly/{part_id}")` 连续调用六次 `random()` 得到。JS 仍按零件输入计算组序、出发帧、到位事件和起始位姿。验收测试使用 Python E5 原始排程和采样器生成 `tracks/0.1`，逐个比较 JS 在整帧及分数帧算出的位姿。
