// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/records.wgsl，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// What more than one shader reads or writes, declared once. This file is part of the kernel (gpu.rs `KERNEL_FILES`),
// of the particle passes (`particle_source`, `gpu_particle_source`) and of the live passes (live/targets.rs
// `live_source`, build.rs).

// A triangle's shading attributes (scene.rs GpuTriAttr): normals (w: uv parts), uv parts (w: material index, bits),
// tangent (w: bitangent sign), x: (texel density, object (bits), a particle's area, its emitter entry + 1 (bits; 0: it
// is not light-sampled)).
struct TriAttr { n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32>, uv: vec4<f32>, t: vec4<f32>, x: vec4<f32> };

// （北冥：上游每个像素一个写死的 `Pixel`（5 个 vec4）换成了步长可变的输出缓冲 film，定义在 film.wgsl。）

// The light tiles (pathtrace.wgsl "Light tiles", live.wgsl `light_tiles`): a tile's side in traced pixels, the vec4s
// of its list (the last holds how many lights it lists), and the report of a pixel that found no light. (Indices and
// counts are stored as float values, not as their bits: a small integer's bits are a denormal float, which a driver
// may flush to zero. So a light-table index stays below LT_NONE, 2^24.)
const LT_TILE: u32 = 8u;
const LT_LIST: u32 = 64u;
const LT_NONE: u32 = 16777216u;
