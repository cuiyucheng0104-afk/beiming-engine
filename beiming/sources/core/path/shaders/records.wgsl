// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/records.wgsl，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// What more than one shader reads or writes, declared once. This file is part of the kernel (gpu.rs `KERNEL_FILES`),
// of the particle passes (`particle_source`, `gpu_particle_source`) and of the live passes (live/targets.rs
// `live_source`, build.rs).

// A triangle's shading attributes (scene.rs GpuTriAttr): normals (w: uv parts), uv parts (w: material index, bits),
// tangent (w: bitangent sign), x: (texel density, object (bits), a particle's area, its emitter entry + 1 (bits; 0: it
// is not light-sampled)).
struct TriAttr { n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32>, uv: vec4<f32>, t: vec4<f32>, x: vec4<f32> };

// A sample the kernel leaves in `accum`. Live: color = diffuse lighting at the first hit (w: first-hit distance, 0 =
// sky), emit = what the camera ray sees directly (emission, sky; kept out of the denoiser; w: first-hit roughness),
// spec = specular lighting at the first hit (w: distance to what the first specular bounce hit, for the reflections'
// reprojection), normal.w = the media before the first hit (`media_composite`: 0.5 = none). Offline: color / albedo /
// normal sums.
struct Pixel { color: vec4<f32>, albedo: vec4<f32>, normal: vec4<f32>, emit: vec4<f32>, spec: vec4<f32> };

// The light tiles (pathtrace.wgsl "Light tiles", live.wgsl `light_tiles`): a tile's side in traced pixels, the vec4s
// of its list (the last holds how many lights it lists), and the report of a pixel that found no light. (Indices and
// counts are stored as float values, not as their bits: a small integer's bits are a denormal float, which a driver
// may flush to zero. So a light-table index stays below LT_NONE, 2^24.)
const LT_TILE: u32 = 8u;
const LT_LIST: u32 = 64u;
const LT_NONE: u32 = 16777216u;
