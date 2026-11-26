# 求值核与契约

这里维护跨组件的数据格式、整数帧时间线和与渲染器无关的求值逻辑。新增字段先在相应契约中定义，再同步校验器与调用方。

- [契约写法](contracts/CONVENTIONS.md) 指明如何修改格式和版本。[目录归属](contracts/ownership/CONTRACT.md) 说明各组件的写入范围。
- [求值入口](eval/index.mjs) 提供镜头输入、事件、插值和命名随机流，见[求值说明](eval/README.md)。
- [片子描述](contracts/film/CONTRACT.md) 定义帧号、档位和镜头输入。[补丁应用](patch-apply.mjs) 写入描述，[锁生成](lock-gen.mjs) 固定可复跑的输入。
- [一致性测试](conformance/README.md) 以契约和校准结果核对帧源的输出。

```sh
node --test beiming/kernel/eval/eval.test.mjs beiming/kernel/contracts/validate.test.mjs
```
