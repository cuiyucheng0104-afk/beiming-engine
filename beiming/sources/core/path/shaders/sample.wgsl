// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/sample.wgsl，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// The kernel's random numbers: shuffled, Owen-scrambled Sobol (Burley 2020; Cycles' Sobol-Burley). Four dimensions,
// more by padding: each decision has a dimension id that seeds the scramble. renderer/src/sample.rs: the same on the CPU.

// Sobol dimensions 1-3 (Joe & Kuo, bit-reversed) of a 16-bit bit-reversed index, unrolled. Dimension 0: reverseBits.
fn sobol_d1(x: u32) -> u32 {
    var r = 0u;
    r ^= select(0u, 0x00000001u, (x & 0x80000000u) != 0u);
    r ^= select(0u, 0x00000003u, (x & 0x40000000u) != 0u);
    r ^= select(0u, 0x00000005u, (x & 0x20000000u) != 0u);
    r ^= select(0u, 0x0000000fu, (x & 0x10000000u) != 0u);
    r ^= select(0u, 0x00000011u, (x & 0x08000000u) != 0u);
    r ^= select(0u, 0x00000033u, (x & 0x04000000u) != 0u);
    r ^= select(0u, 0x00000055u, (x & 0x02000000u) != 0u);
    r ^= select(0u, 0x000000ffu, (x & 0x01000000u) != 0u);
    r ^= select(0u, 0x00000101u, (x & 0x00800000u) != 0u);
    r ^= select(0u, 0x00000303u, (x & 0x00400000u) != 0u);
    r ^= select(0u, 0x00000505u, (x & 0x00200000u) != 0u);
    r ^= select(0u, 0x00000f0fu, (x & 0x00100000u) != 0u);
    r ^= select(0u, 0x00001111u, (x & 0x00080000u) != 0u);
    r ^= select(0u, 0x00003333u, (x & 0x00040000u) != 0u);
    r ^= select(0u, 0x00005555u, (x & 0x00020000u) != 0u);
    r ^= select(0u, 0x0000ffffu, (x & 0x00010000u) != 0u);
    return r;
}
fn sobol_d2(x: u32) -> u32 {
    var r = 0u;
    r ^= select(0u, 0x00000001u, (x & 0x80000000u) != 0u);
    r ^= select(0u, 0x00000003u, (x & 0x40000000u) != 0u);
    r ^= select(0u, 0x00000006u, (x & 0x20000000u) != 0u);
    r ^= select(0u, 0x00000009u, (x & 0x10000000u) != 0u);
    r ^= select(0u, 0x00000017u, (x & 0x08000000u) != 0u);
    r ^= select(0u, 0x0000003au, (x & 0x04000000u) != 0u);
    r ^= select(0u, 0x00000071u, (x & 0x02000000u) != 0u);
    r ^= select(0u, 0x000000a3u, (x & 0x01000000u) != 0u);
    r ^= select(0u, 0x00000116u, (x & 0x00800000u) != 0u);
    r ^= select(0u, 0x00000339u, (x & 0x00400000u) != 0u);
    r ^= select(0u, 0x00000677u, (x & 0x00200000u) != 0u);
    r ^= select(0u, 0x000009aau, (x & 0x00100000u) != 0u);
    r ^= select(0u, 0x00001601u, (x & 0x00080000u) != 0u);
    r ^= select(0u, 0x00003903u, (x & 0x00040000u) != 0u);
    r ^= select(0u, 0x00007706u, (x & 0x00020000u) != 0u);
    r ^= select(0u, 0x0000aa09u, (x & 0x00010000u) != 0u);
    return r;
}
fn sobol_d3(x: u32) -> u32 {
    var r = 0u;
    r ^= select(0u, 0x00000001u, (x & 0x80000000u) != 0u);
    r ^= select(0u, 0x00000003u, (x & 0x40000000u) != 0u);
    r ^= select(0u, 0x00000004u, (x & 0x20000000u) != 0u);
    r ^= select(0u, 0x0000000au, (x & 0x10000000u) != 0u);
    r ^= select(0u, 0x0000001fu, (x & 0x08000000u) != 0u);
    r ^= select(0u, 0x0000002eu, (x & 0x04000000u) != 0u);
    r ^= select(0u, 0x00000045u, (x & 0x02000000u) != 0u);
    r ^= select(0u, 0x000000c9u, (x & 0x01000000u) != 0u);
    r ^= select(0u, 0x0000011bu, (x & 0x00800000u) != 0u);
    r ^= select(0u, 0x000002a4u, (x & 0x00400000u) != 0u);
    r ^= select(0u, 0x0000079au, (x & 0x00200000u) != 0u);
    r ^= select(0u, 0x00000b67u, (x & 0x00100000u) != 0u);
    r ^= select(0u, 0x0000101eu, (x & 0x00080000u) != 0u);
    r ^= select(0u, 0x0000302du, (x & 0x00040000u) != 0u);
    r ^= select(0u, 0x00004041u, (x & 0x00020000u) != 0u);
    r ^= select(0u, 0x0000a0c3u, (x & 0x00010000u) != 0u);
    return r;
}

// Owen scrambling of a bit-reversed integer (Vegdahl 2021's hash, a better Laine-Karras permutation).
fn owen_rev(n_in: u32, seed: u32) -> u32 {
    var n = n_in;
    n ^= n * 0x3d20adeau;
    n += seed;
    n *= (seed >> 16u) | 1u;
    n ^= n * 0x05526c56u;
    n ^= n * 0x53a22864u;
    return n;
}

fn hash_hp(x: u32) -> u32 {
    var i = x;
    i ^= i >> 16u;
    i *= 0x21f0aaadu;
    i ^= i >> 15u;
    i *= 0xd35a2d97u;
    i ^= i >> 15u;
    return i ^ 0xe6fe3bebu;
}

// One dimension (0-3) of the Sobol point at a bit-reversed index, Owen-scrambled.
fn sobol_owen(rev_index: u32, dim: u32, seed: u32) -> f32 {
    var r = 0u;
    if (dim == 0u) {
        r = reverseBits(rev_index);
    } else if (dim == 1u) {
        r = sobol_d1(rev_index);
    } else if (dim == 2u) {
        r = sobol_d2(rev_index);
    } else {
        r = sobol_d3(rev_index);
    }
    r = reverseBits(owen_rev(r, seed));
    return f32(r) * (1.0 / 4294967808.0);
}

// A path's sample: its index in the pixel's sequence, the pixel's seed, which path of the invocation it is.
// 北冥：这三个量现在在路径状态里（integrator.wgsl 的 PathState）：state.sample、state.rng_pixel、state.legacy.rng_path。

// 北冥：「哪个决定用哪一维」的编号（传给 rng1 到 rng4、rng_hash 的那个 `d`）。编号进种子之前还要过一次哈希
// （rng_seed），所以编号本身只要互不相同。三个名字空间按最高两位分开，按构造互不相撞：
//   最高位 0     照 Cycles 编号：state.rng_offset + PRNG_*（下面的 path_rng_*），相机的两个直接用 PRNG_FILTER、
//                PRNG_LENS_TIME。数都很小。
//   最高两位 10  rng_legacy：还没有照 Cycles 移植的决定（上游的灯、雾、介质，上游顶替闭包自己的选瓣与方向）。
//                新写的代码不许用；哪个决定照 Cycles 移植完了，就把它的槽位从这里删掉、改用 PRNG_*。
//   最高两位 11  rng_sub：一个决定里再分的子流（循环的第几次、第几盏灯）。上游的写法原样保留，包括对父编号异或
//                0x40000000、0x80000000 派生兄弟流（它们只当 rng_sub 的输入用）。介质跟踪用的白噪声（rng_hash）
//                的编号也都从 rng_sub 来。
// 后两个空间里的编号是哈希出来的（各 30 位），同一空间里互不相同靠枚举来保：src/sample.rs 的测试
// `the_dimension_ids_are_distinct` 照下面各函数的用法枚举弹射 0 到 64 的全部编号。加槽位、加子流序号的区段都要
// 同步改那条测试里的登记表。
// `slot`：下面的 D_*，必须小于 PRNG_BOUNCE_NUM（state.rng_offset 每次弹射加这么多，偏移加槽位才不重复）。
fn rng_legacy(slot: u32) -> u32 { return (hash_hp(state.rng_offset + slot) & 0x3fffffffu) | 0x80000000u; }
// The k-th part of decision `d` (a loop's iteration, a light).
fn rng_sub(d: u32, k: u32) -> u32 { return hash_hp(d ^ hash_hp(k + 0x9e3779b9u)) | 0xc0000000u; }

// A path vertex's decisions (`rng_legacy`).
// 北冥：槽位 0（相机）与 2（俄罗斯轮盘）已经改照 Cycles 编号（PRNG_FILTER、PRNG_LENS_TIME、PRNG_TERMINATE），退役，
// 这两个号不再给别的决定用。
const D_BSDF: u32 = 1u;      // lobe, specular or not, direction (4D)
const D_PICK: u32 = 3u;      // light_pick's kind of light
const D_SUN: u32 = 4u;       // a directional light's cone (2D a light)
const D_SUN_VIS: u32 = 5u;   // its shadow ray
const D_LOCAL: u32 = 6u;     // local lights (`local_lights`)
const D_EMIT: u32 = 7u;      // emitters (`sample_emitter_ris`, `sample_emitter`)
const D_EMIT_VIS: u32 = 8u;
const D_ENV: u32 = 9u;       // the environment map (4D)
const D_ENV_VIS: u32 = 10u;
const D_FOG: u32 = 11u;      // height fog's in-scattering (`fog_scatter`)
const D_MEDIA: u32 = 12u;    // bounded media (`media_track`, `media_march`)
const D_PHASE: u32 = 13u;    // a medium's scattered direction (`sample_hg`)
const D_VOL_LIGHT: u32 = 14u; // lights at a point in a medium (`phase_direct`, `point_direct`)

// Live: Sobol only for the camera path's first vertex (not a loop's parts: `rng_sub` sets the top bit), a hash
// elsewhere (as NVIDIA's RTXPT; variance only: all-Sobol is 0.14 ms more of Bistro's trace, 0.9 of Kabukichō's, for
// flicker 0.443 -> 0.431). Offline: Sobol everywhere (as Cycles).
fn rng_white(d: u32) -> bool { return LIVE && (state.bounce > 0u || state.legacy.rng_path != 0u || d >= 0x80000000u); }
fn white(d: u32, c: u32) -> f32 { return f32(hash_hp(rng_seed(d) ^ (state.sample * 0x9e3779b9u + c * 0x85ebca6bu)) >> 8u) * (1.0 / 16777216.0); }

// A hash, always: for loops of no fixed length (delta tracking's steps), where a new Sobol dimension a step is QMC's
// worst case (as pbrt-v4, which draws its majorant tracking from a hashed RNG).
fn rng_hash(d: u32, c: u32) -> f32 { return white(d, c); }
fn rng_hash3(d: u32) -> vec3<f32> { return vec3<f32>(white(d, 0u), white(d, 1u), white(d, 2u)); }

// Dimension id `d`'s scramble seed; the shuffled index, 16 bits (65,536 samples, then it repeats; Cycles' index mask).
fn rng_seed(d: u32) -> u32 { return state.rng_pixel ^ hash_hp(d); }
// 北冥：掩码从全局参数读（P.integrator.sobol_index_mask；现在固定是上游写死的 0xffff0000，为 0 时开渲前报错）。
// 换掩码算法的人只改 CPU 上填它的那一处。
fn rng_index(salt: u32) -> u32 { return rng_index_at(state.sample, salt); }
// 北冥：同上，样本号由调用方给（分支版取数用）。
fn rng_index_at(index: u32, salt: u32) -> u32 { return owen_rev(reverseBits(index), salt) & P.integrator.sobol_index_mask; }

fn rng1(d: u32) -> f32 {
    if (rng_white(d)) { return white(d, 0u); }
    let s = rng_seed(d);
    return sobol_owen(rng_index(s ^ 0xbff95bfeu), 0u, s ^ 0x635c77bdu);
}
fn rng2(d: u32) -> vec2<f32> {
    if (rng_white(d)) { return vec2<f32>(white(d, 0u), white(d, 1u)); }
    let s = rng_seed(d);
    let i = rng_index(s ^ 0xf8ade99au);
    return vec2<f32>(sobol_owen(i, 0u, s ^ 0xe0aaaf76u), sobol_owen(i, 1u, s ^ 0x94964d4eu));
}
fn rng3(d: u32) -> vec3<f32> {
    if (rng_white(d)) { return vec3<f32>(white(d, 0u), white(d, 1u), white(d, 2u)); }
    let s = rng_seed(d);
    let i = rng_index(s ^ 0xcaa726acu);
    return vec3<f32>(sobol_owen(i, 0u, s ^ 0x9e78e391u), sobol_owen(i, 1u, s ^ 0x67c33241u), sobol_owen(i, 2u, s ^ 0x78c395c5u));
}
fn rng4(d: u32) -> vec4<f32> {
    if (rng_white(d)) { return vec4<f32>(white(d, 0u), white(d, 1u), white(d, 2u), white(d, 3u)); }
    let s = rng_seed(d);
    let i = rng_index(s ^ 0xc2c1a055u);
    return vec4<f32>(sobol_owen(i, 0u, s ^ 0x39468210u), sobol_owen(i, 1u, s ^ 0xe9d8a845u), sobol_owen(i, 2u, s ^ 0x5f32b482u), sobol_owen(i, 3u, s ^ 0x1524cc56u));
}

// 北冥：照 Cycles 的取数接口（kernel/integrator/path_state.h 的 path_state_rng_1D / 2D / 3D 与 path_branched_rng_2D）。
// 哪个决定用哪一维，是「路径状态里的偏移加枚举」：编号 = state.rng_offset + 维度，像素种子与样本号也读路径状态。
// 发生器就是上面的 rng1 到 rng3（与 Cycles 的 sobol_burley_sample_1D 到 3D 盐值逐个相同）。
// 维度的枚举，数值照 Cycles 的 PathTraceDimension（kernel/types.h）。相机光线的两个不加偏移，直接当编号用。
const PRNG_FILTER: u32 = 0u;            // 相机：像素滤波，2 维（rng2(PRNG_FILTER)）
const PRNG_LENS_TIME: u32 = 1u;         // 相机：时刻、镜头 x、镜头 y，3 维（rng3(PRNG_LENS_TIME)；时刻现在不用）
// 以下每次弹射各一份（加 state.rng_offset；每次弹射占 PRNG_BOUNCE_NUM 个位置，见 integrator.wgsl）
const PRNG_TERMINATE: u32 = 0u;         // 俄罗斯轮盘，1 维
const PRNG_LIGHT: u32 = 1u;             // 选灯与灯上的点，3 维。已定义（做灯的人用）
const PRNG_LIGHT_TERMINATE: u32 = 2u;   // 灯的贡献太小时的轮盘，1 维。已定义
const PRNG_SURFACE_BSDF: u32 = 3u;      // 表面散射，3 维：前两个定方向，第三个选闭包并复用
const PRNG_SURFACE_AO: u32 = 4u;        // 环境光遮蔽节点，2 维，分支版。已定义
const PRNG_SURFACE_BEVEL: u32 = 5u;     // 倒角节点，2 维，分支版。已定义
// 6、10、11：Cycles 给了路径引导，这里不做，也不许另作他用。3 到 9：Cycles 的体积散射与表面复用同一段（同一次弹射
// 要么是表面要么是体积），移植体积的人照 Cycles 的 PRNG_VOLUME_* 取。7、8、9（表面一侧）、12 到 15：空闲，取用须登记。
fn path_rng_1D(dimension: u32) -> f32 { return rng1(state.rng_offset + dimension); }
fn path_rng_2D(dimension: u32) -> vec2<f32> { return rng2(state.rng_offset + dimension); }
fn path_rng_3D(dimension: u32) -> vec3<f32> { return rng3(state.rng_offset + dimension); }
// 分支版：同一个决定在一个样本里取 `num_branches` 个点（遮蔽与倒角节点一次发多条射线），第 `branch` 个。样本号换成
// state.sample * num_branches + branch。索引只留 16 位，所以有效样本数是 65536 除以分支数，超过之后重复同一批点（不偏，
// 但噪声不再降）；换掩码算法的人一并处理。
fn path_branched_rng_2D(branch: u32, num_branches: u32, dimension: u32) -> vec2<f32> {
    let s = rng_seed(state.rng_offset + dimension);
    let i = rng_index_at(state.sample * num_branches + branch, s ^ 0xf8ade99au);
    return vec2<f32>(sobol_owen(i, 0u, s ^ 0xe0aaaf76u), sobol_owen(i, 1u, s ^ 0x94964d4eu));
}

// Starts sample `index` of a pixel (the sample offline, the frame live) on path `path`; `seed`: the render's
// (THREERT_SEED offline) and the stream's.
// 北冥：像素种子照 Cycles 的 path_rng_pixel_init（kernel/sample/pattern.h）：像素坐标的二维哈希异或全局种子，不再是上游
// 的三重哈希。`seed` 传 P.integrator.seed：用户种子在 CPU 上过一次 hash_hp 之后的值（gpu.rs 的 KernelIntegrator::new），
// 所以只差低位的用户种子（1、2、3）给出的序列也互不相干。
fn rng_start(pix: vec2<u32>, index: u32, seed: u32, path: u32) {
    state.rng_pixel = hash_iqnt2d(pix.x, pix.y) ^ seed;
    state.sample = index;
    state.legacy.rng_path = path;
}
