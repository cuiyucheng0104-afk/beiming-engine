// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/src/main.rs，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
//! core-render: native renderer for ThreeRT games (no browser, no engine). A game bundle (game code + the scene
//! runtime) runs in the embedded JS engine and builds the scene through the engine API; the renderer draws it.
//!
//!   core-render render <bundle.js> -o out.png [--assets DIR] [--room id] [--seed n] [--state state.json]
//!                         [--camera '{"position":[x,y,z],"target":[x,y,z],"fov":deg}'] [--spp N] [--stats out.json]
//!                         [--preset name] [--width W --height H] [--time s] [--no-denoise] [--override JSON] [--presets DIR]
//!                         [--runtime threert-runtime.js (the game is then an ES module importing it)]
//!                         [--hdr out.raw] [--signals PREFIX] (linear RGB f32: the image; its diffuse / specular /
//!                         emission apart, PREFIX-{diffuse,specular,emission}.raw)
//!   core-render pack-info <pack dir> [--frame k] [--record check.json] [--width W --height H]
//!                         (北冥：读场景包、选一帧建成内核的场景，不渲；stdout 一行统计的 JSON，--record 写场景包核对记录)
//!   core-render render-pack <pack dir> -o out.png [--frame k] [--spp N] [--width W --height H] [--hdr out.raw]
//!                         [--signals PREFIX] [--no-denoise] [--stats out.json] [--preset name] [--override JSON]
//!                         [--passes DIR] [--pixel-filter box|gaussian|blackman-harris] [--filter-width PX]
//!                         [--clamp-direct X] [--clamp-indirect X] [--filter-glossy X]
//!                         (北冥：读场景包、渲一帧。读不对时 stderr 一行 {"error":{code,at,message}}，退出码照错误码的前缀。
//!                         --passes：照输出通道出层，每个通道一个文件，加通道声明 passes.json，见 write_passes。
//!                         像素滤波、夹取、滤光泽照 Cycles 的口径，见 CyclesFilm；上游的亮度夹取在这一路关掉)
//!   core-render denoise --width W --height H --color c.f32 --albedo a.f32 --normal n.f32 -o out.f32 [--device cpu|cuda|metal|default]
//!                         [--prefilter accurate|fast|none]   # 北冥：现成的三张图走同一个 OIDN 降噪（编进了 oidn 特性时），给对拍用
//!   core-render fncheck-host <函数标识>   # 北冥：宿主一侧照 Cycles 移植的函数，给函数级比对外壳逐组算（stdin 进 f32，stdout 出 f32）
//!   core-render serve [--presets DIR]      # JSON-lines jobs on stdin, keeps the GPU device and game runtimes warm
//!   core-render setup <bundle.js>          # setup cost in the embedded runtime
//!   core-render info [--limits]            # print adapter info (北冥：--limits 打适配器与设备的上限、特性全文的 JSON)
//!   core-render as-size --blas N,N,… [--instances K]   # 北冥：问驱动这些三角形数的 BLAS 与 K 个实例的 TLAS 各占多少字节（不建）

use beiming_core_path::script::ScriptHost;
use beiming_core_path::{default_presets_dir, denoise, gpu, pack, post, prepare, scene};

use anyhow::{anyhow, Context, Result};
use glam::Vec3;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::Instant;

struct Job {
    game: GameJob,
    out: PathBuf,
    spp: Option<u32>,
    stats: Option<PathBuf>,
    denoise: Option<bool>,
    overrides: Option<serde_json::Value>,
    /// Viewpoint instead of the game camera's: {position, target, fov?}.
    camera: Option<serde_json::Value>,
    /// Render preset / image size / scene time (animated materials, rain) instead of the game's.
    preset: Option<String>,
    time: Option<f32>,
    size: (Option<u32>, Option<u32>),
    hdr: Option<PathBuf>,
    /// `--signals PREFIX`: PREFIX-diffuse.raw / -specular.raw / -emission.raw, the image's linear signals apart as the
    /// live denoiser splits them (RGB f32, output size; live snapshots to `*.signals` write the same).
    signals: Option<PathBuf>,
    /// 北冥：`render-pack --passes DIR`：照输出通道出层（每个通道一个文件，加一份通道声明 passes.json），见 `write_passes`。
    passes: Option<PathBuf>,
    /// 北冥：背景对相机不可见（场景包的 world.visibleToCamera 是 false）：相机射线没打到表面的样本不透明度与颜色记 0。
    transparent: bool,
    /// 北冥：照 Cycles 口径的成像参数（只有 render-pack 给）。给了就关掉上游的亮度夹取（`Params::misc[0]`）。
    cycles_film: Option<CyclesFilm>,
    /// 北冥：出层时求 motion 要的相邻一帧（render-pack 给；只有一帧的包是 None，motion 全 0）。
    motion: Option<beiming_core_path::motion::Step>,
}

/// 北冥：render-pack 的像素滤波、夹取与滤光泽，照 Cycles 宿主一侧写进内核的口径（scene/film.cpp、scene/integrator.cpp:
/// 269、311-315）：滤波表照种类与宽度建（盒式宽 1 不查表）；两个夹取上限是用户值乘 3、滤光泽是用户值的倒数，用户给 0 时
/// 这一格写 0（不夹、不滤；Cycles 写 FLT_MAX，内核在 0 上做同样的事）。参数的范围照 Blender 界面的（intern/cycles/blender/
/// addon/properties.py）：滤波宽度 0.01 到 10 像素，两个夹取 0 到 1e8，滤光泽 0 到 10。
struct CyclesFilm {
    filter_table: gpu::KernelFilterTable,
    sample_clamp_direct: f32,
    sample_clamp_indirect: f32,
    filter_glossy: f32,
}

impl CyclesFilm {
    fn write(&self, p: &mut gpu::Params) {
        // 上游的亮度夹取关掉：物理参考是不夹的，夹取只认上面两格
        p.misc[0] = f32::MAX;
        p.integrator.sample_clamp_direct = self.sample_clamp_direct;
        p.integrator.sample_clamp_indirect = self.sample_clamp_indirect;
        p.integrator.filter_glossy = self.filter_glossy;
        p.filter_table = self.filter_table;
    }
}

/// The game state to render: a bundle's scene for a room, at its initial state or a room's committed state.
struct GameJob {
    /// The game: a bundle (game + runtime in one script), or with `runtime` the game's ES module.
    bundle: PathBuf,
    /// The runtime ES module (threert-runtime.js) the game module imports.
    runtime: Option<PathBuf>,
    /// Asset root the scene's model / texture paths resolve against.
    assets: PathBuf,
    room: String,
    seed: Option<u32>,
    state: Option<serde_json::Value>,
    seq: i64,
}

impl GameJob {
    fn from_json(v: &serde_json::Value) -> Result<GameJob> {
        Ok(GameJob {
            bundle: PathBuf::from(v["game"].as_str().context("job: game bundle path required")?),
            runtime: v["runtime"].as_str().map(PathBuf::from),
            assets: PathBuf::from(v["assets"].as_str().unwrap_or(".")),
            room: v["room"].as_str().unwrap_or("local").to_string(),
            seed: v["seed"].as_u64().map(|s| s as u32),
            state: (!v["state"].is_null()).then(|| v["state"].clone()),
            seq: v["seq"].as_i64().unwrap_or(0),
        })
    }
}

/// Game runtimes of a warm `serve`: one per bundle version / room / seed, set up once, then only given new states.
#[derive(Default)]
struct Hosts {
    hosts: HashMap<String, (ScriptHost, serde_json::Value)>,
}

impl Hosts {
    /// The runtime with the job's scene: setup on first use, then the job's state (or the initial one) applied.
    fn scene(&mut self, job: &GameJob) -> Result<(&ScriptHost, f64)> {
        let version = |p: &Path| -> Result<String> {
            let m = std::fs::metadata(p).with_context(|| p.display().to_string())?;
            Ok(format!("{}|{}|{:?}", p.display(), m.len(), m.modified().ok()))
        };
        let runtime = job.runtime.as_deref().map(version).transpose()?;
        let key = format!("{}|{runtime:?}|{}|{:?}", version(&job.bundle)?, job.room, job.seed);
        let t = Instant::now();
        if !self.hosts.contains_key(&key) {
            if self.hosts.len() >= 8 {
                self.hosts.clear();
            }
            let code = std::fs::read_to_string(&job.bundle)?;
            let host = match &job.runtime {
                Some(r) => ScriptHost::from_modules(&code, &std::fs::read_to_string(r)?)?,
                None => ScriptHost::new(&code)?,
            };
            host.setup(&job.room, job.seed)?;
            let (initial, _) = host.state()?;
            self.hosts.insert(key.clone(), (host, initial));
        }
        let (host, initial) = &self.hosts[&key];
        host.set_state(job.state.as_ref().unwrap_or(initial), job.seq)?;
        Ok((host, t.elapsed().as_secs_f64() * 1000.0))
    }
}

/// Files the scene reads that are not under the asset root yet (a render node fetches them and retries).
#[derive(Debug)]
struct MissingFiles(Vec<String>);

impl std::fmt::Display for MissingFiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "missing files under the asset root: {}", self.0.join(", "))
    }
}

impl std::error::Error for MissingFiles {}

/// `--camera {position, target, fov?}` (fov in degrees, vertical).
fn override_camera(c: &mut scene::CameraData, v: &serde_json::Value) -> Result<()> {
    let v3 = |k: &str| -> Result<Vec3> {
        let a: [f32; 3] = serde_json::from_value(v[k].clone()).with_context(|| format!("--camera: {k} must be [x, y, z]"))?;
        Ok(Vec3::from(a))
    };
    let (pos, target) = (v3("position")?, v3("target")?);
    let fwd = (target - pos).try_normalize().ok_or_else(|| anyhow!("--camera: position == target"))?;
    let right = fwd.cross(Vec3::Y).try_normalize().unwrap_or(Vec3::X);
    (c.position, c.forward, c.right, c.up) = (pos, fwd, right, right.cross(fwd));
    if let Some(fov) = v["fov"].as_f64() {
        c.tan_half_fov = (fov.to_radians() as f32 * 0.5).tan();
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let presets = flag("--presets").map(PathBuf::from).unwrap_or_else(default_presets_dir);
    match cmd {
        "info" => {
            let g = gpu::Gpu::new()?;
            // 北冥：--limits 打适配器与设备的上限、特性全文（`Gpu::limits_report`），不加时照旧一行
            if args.iter().any(|a| a == "--limits") {
                println!("{}", serde_json::to_string(&g.limits_report())?);
                return Ok(());
            }
            println!("{}", serde_json::json!({ "adapter": g.adapter_info.name, "hwrt": g.hwrt, "backend": format!("{:?}", g.adapter_info.backend), "hwrt": g.hwrt, "device_type": format!("{:?}", g.adapter_info.device_type), "driver": g.adapter_info.driver }));
        }
        "render" => {
            let t0 = Instant::now();
            let g = gpu::Gpu::new()?;
            let init_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let job = Job {
                game: GameJob {
                    bundle: PathBuf::from(args.get(2).filter(|a| !a.starts_with("-")).ok_or_else(|| anyhow!("game bundle required"))?),
                    runtime: flag("--runtime").map(PathBuf::from),
                    assets: PathBuf::from(flag("--assets").unwrap_or_else(|| ".".into())),
                    room: flag("--room").unwrap_or_else(|| "local".into()),
                    seed: flag("--seed").map(|s| s.parse()).transpose()?,
                    state: flag("--state").map(|f| -> Result<serde_json::Value> { Ok(serde_json::from_slice(&std::fs::read(f)?)?) }).transpose()?,
                    seq: 0,
                },
                out: PathBuf::from(flag("-o").unwrap_or_else(|| "out.png".into())),
                spp: flag("--spp").map(|s| s.parse()).transpose()?,
                stats: flag("--stats").map(PathBuf::from),
                denoise: if args.iter().any(|a| a == "--no-denoise") { Some(false) } else { None },
                overrides: flag("--override").map(|s| serde_json::from_str(&s)).transpose()?,
                camera: flag("--camera").map(|s| serde_json::from_str(&s)).transpose()?,
                preset: flag("--preset"),
                time: flag("--time").map(|s| s.parse()).transpose()?,
                size: (flag("--width").map(|s| s.parse()).transpose()?, flag("--height").map(|s| s.parse()).transpose()?),
                hdr: flag("--hdr").map(PathBuf::from),
                signals: flag("--signals").map(PathBuf::from),
                passes: None,
                transparent: false,
                cycles_film: None,
                motion: None,
            };
            let stats = render(&g, &job, &presets, init_ms, &mut Hosts::default())?;
            println!("{}", serde_json::to_string(&stats)?);
        }
        "pack-info" | "render-pack" => {
            if let Err(e) = pack_command(cmd, &args, &presets) {
                match e.downcast_ref::<pack::PackError>() {
                    Some(pe) => {
                        eprintln!("{}", pe.json());
                        std::process::exit(pack::exit_code(pe.code));
                    }
                    None => return Err(e),
                }
            }
        }
        "ae" => {
            // core-render ae linear.exr <ev100 it was exposed at> [lowPercent highPercent compensation minEv maxEv]
            let img = image::open(&args[2])?.to_rgb32f();
            let k = 2f32.powf(args[3].parse::<f32>()?);
            let px: Vec<Vec3> = img.pixels().map(|p| Vec3::new(p.0[0], p.0[1], p.0[2]) * k).collect();
            let num = |i: usize, d: f32| args.get(i).and_then(|v| v.parse::<f32>().ok()).unwrap_or(d);
            let mut pre: beiming_core_path::desc::Preset = serde_json::from_str(&std::fs::read_to_string(presets.join("cinematic.json"))?)?;
            pre.post.auto_exposure.low_percent = num(4, 70.0);
            pre.post.auto_exposure.high_percent = num(5, 97.0);
            pre.post.auto_exposure.histogram_log_min = -10.0;
            pre.post.auto_exposure.histogram_log_max = 20.0;
            let exp = beiming_core_path::desc::Exposure::Auto { compensation: num(6, 0.6), min_ev100: num(7, -1.5), max_ev100: num(8, 3.0) };
            let (_, ev) = post::exposure_scale(&post::Image { w: img.width() as usize, h: img.height() as usize, px }, &exp, &pre.post);
            println!("{{\"ev100\":{ev}}}");
        }
        "setup" => {
            // Setup cost of a game bundle in the embedded runtime (as on a render node).
            let t0 = Instant::now();
            let host = ScriptHost::new(&std::fs::read_to_string(args.get(2).ok_or_else(|| anyhow!("game bundle required"))?)?)?;
            let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let setup_ms = host.setup(&flag("--room").unwrap_or_else(|| "local".into()), flag("--seed").map(|v| v.parse()).transpose()?)?;
            let w = host.world.borrow();
            println!("{}", serde_json::json!({ "engine": "quickjs", "bundle_load_ms": load_ms, "setup_ms": setup_ms, "objects": w.objects.len(), "geometries": w.geometries.len(), "materials": w.materials.len(), "textures": w.textures.len(), "info": host.info }));
        }
        "montage" => {
            // core-render montage out.jpg --width 640 a.png b.png c.png  (horizontal strip)
            let out = PathBuf::from(&args[2]);
            let width: u32 = flag("--width").map(|w| w.parse()).transpose()?.unwrap_or(640);
            let inputs: Vec<&String> = args[3..].iter().filter(|a| !a.starts_with("--") && a.as_str() != width.to_string()).collect();
            let imgs: Vec<image::RgbImage> = inputs.iter().map(|p| image::open(p).map(|i| i.to_rgb8())).collect::<Result<_, _>>()?;
            let h = imgs.iter().map(|i| (i.height() as f32 * width as f32 / i.width() as f32) as u32).max().unwrap_or(1);
            let mut sheet = image::RgbImage::new(width * imgs.len() as u32 + 4 * (imgs.len() as u32 - 1), h);
            for (k, img) in imgs.iter().enumerate() {
                let r = image::imageops::resize(img, width, h, image::imageops::FilterType::Lanczos3);
                image::imageops::replace(&mut sheet, &r, (k as u32 * (width + 4)) as i64, 0);
            }
            sheet.save(&out)?;
        }
        "serve" => {
            // One job per stdin line: {id, game: bundle path (or game module + runtime: runtime module), assets, room,
            // seed, state?, seq?, out, spp?, denoise?, overrides?, camera?, preset?, width?, height?, time?, hdr? (raw f32
            // RGB linear radiance, nits), live? (not supported: the offline core has no real-time renderer)}; one result line
            // each: {id, ok, stats} or
            // {id, ok: false, error, missing?: [files to put under the asset root before retrying]}.
            let t0 = Instant::now();
            let g = gpu::Gpu::new()?;
            let mut init_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let mut hosts = Hosts::default();
            eprintln!("core-render serving on stdin ({} / {:?}), init {init_ms:.0} ms", g.adapter_info.name, g.adapter_info.backend);
            println!("{}", serde_json::json!({ "ready": true, "adapter": g.adapter_info.name, "init_ms": init_ms }));
            for line in std::io::stdin().lock().lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let v: serde_json::Value = serde_json::from_str(&line)?;
                let res = GameJob::from_json(&v).and_then(|game| {
                    let job = Job {
                        game,
                        out: PathBuf::from(v["out"].as_str().unwrap_or("out.png")),
                        spp: v["spp"].as_u64().map(|x| x as u32),
                        stats: None,
                        denoise: v["denoise"].as_bool(),
                        overrides: v.get("overrides").filter(|o| !o.is_null()).cloned(),
                        camera: v.get("camera").filter(|c| !c.is_null()).cloned(),
                        preset: v["preset"].as_str().map(String::from),
                        time: v["time"].as_f64().map(|t| t as f32),
                        size: (v["width"].as_u64().map(|x| x as u32), v["height"].as_u64().map(|x| x as u32)),
                        hdr: v["hdr"].as_str().map(PathBuf::from),
                        signals: v["signals"].as_str().map(PathBuf::from),
                        passes: None,
                        transparent: false,
                        cycles_film: None,
                        motion: None,
                    };
                    // (A `live` job asks for the real-time renderer, which this build does not have.)
                    match v["live"].as_u64() {
                        Some(_) => Err(anyhow!("live: not supported (the offline core has no real-time renderer)")),
                        None => render(&g, &job, &presets, init_ms, &mut hosts),
                    }
                });
                init_ms = 0.0;
                match res {
                    Ok(s) => println!("{}", serde_json::json!({ "id": v["id"], "ok": true, "stats": s })),
                    Err(e) => {
                        let missing = e.downcast_ref::<MissingFiles>().map(|m| m.0.clone());
                        println!("{}", serde_json::json!({ "id": v["id"], "ok": false, "error": format!("{e:#}"), "missing": missing }));
                    }
                }
            }
        }
        // 北冥：`as-size --blas N,N,… [--instances K]`：每个数是一个 BLAS 的三角形数，问驱动这些 BLAS 与 K 个实例的 TLAS 占多少
        // 字节（`Gpu::as_sizes`，不建、不要几何），给大场景估显存。这块显卡没有硬件求交或后端不认时报错
        "as-size" => {
            let g = gpu::Gpu::new()?;
            if !g.hwrt {
                return Err(anyhow!("as-size：这块显卡没开硬件求交，没有加速结构可问"));
            }
            let blases: Vec<Vec<u32>> = flag("--blas").ok_or_else(|| anyhow!("as-size 要 --blas N,N,…"))?.split(',').map(|n| n.trim().parse::<u32>().map(|n| vec![n])).collect::<Result<_, _>>()?;
            let instances: u32 = flag("--instances").map(|s| s.parse()).transpose()?.unwrap_or(0);
            let (blas, tlas, scratch) = g.as_sizes(&blases, instances).ok_or_else(|| anyhow!("as-size：{:?} 后端问不到加速结构的尺寸", g.adapter_info.backend))?;
            println!("{}", serde_json::json!({ "adapter": g.adapter_info.name, "backend": format!("{:?}", g.adapter_info.backend), "blasTriangles": blases.iter().map(|b| b[0]).collect::<Vec<_>>(), "blasBytes": blas, "instances": instances, "tlasBytes": tlas, "maxScratchBytes": scratch }));
        }
        "fncheck-host" => fncheck_host(args.get(2).map(String::as_str).unwrap_or(""))?,
        "denoise" => denoise_files(&flag)?,
        _ => {
            eprintln!("usage: core-render render <bundle.js> -o out.png [--assets DIR] [--state f.json] [--camera JSON] [--spp N] | pack-info <pack dir> | render-pack <pack dir> -o out.png | serve | setup | info | fncheck-host <id>");
            std::process::exit(2);
        }
    }
    Ok(())
}

/// 北冥：`fncheck-host <函数标识>`：宿主一侧照 Cycles 移植的函数（`pixel_filter`），协议同函数级比对外壳的标准答案程序
/// （../../fncheck/cycles/ref.cpp）：stdin 是小端 f32 流，每组 n_in 个；stdout 每组 n_out 个。标识不认识退出 1，最后一组不完整退出 2。
fn fncheck_host(id: &str) -> Result<()> {
    use beiming_core_path::pixel_filter as pf;
    type F = fn(&[f32], &mut [f32]);
    let (n_in, n_out, f): (usize, usize, F) = match id {
        "filter_func_box" => (2, 1, |i, o| o[0] = pf::filter_func_box(i[0], i[1])),
        "filter_func_gaussian" => (2, 1, |i, o| o[0] = pf::filter_func_gaussian(i[0], i[1])),
        "filter_func_blackman_harris" => (2, 1, |i, o| o[0] = pf::filter_func_blackman_harris(i[0], i[1])),
        // 输入：种类（scene/film.h 的 FilterType 的数值）、宽度
        "filter_table" => (2, pf::FILTER_TABLE_SIZE, |i, o| {
            let kind = [pf::FilterType::Box, pf::FilterType::Gaussian, pf::FilterType::BlackmanHarris][i[0] as usize];
            o.copy_from_slice(&pf::filter_table(kind, i[1]));
        }),
        _ => {
            eprintln!("unknown function id: {id}");
            std::process::exit(1);
        }
    };
    let mut input = vec![];
    std::io::Read::read_to_end(&mut std::io::stdin().lock(), &mut input)?;
    if input.len() % (4 * n_in) != 0 {
        eprintln!("truncated input: {} bytes is not a whole number of {n_in}-float groups", input.len());
        std::process::exit(2);
    }
    let floats: Vec<f32> = input.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let mut out = vec![0.0f32; floats.len() / n_in * n_out];
    for (i, o) in floats.chunks_exact(n_in).zip(out.chunks_exact_mut(n_out)) {
        f(i, o);
    }
    std::io::Write::write_all(&mut std::io::stdout().lock(), &out.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())?;
    Ok(())
}

/// 北冥：`pack-info`、`render-pack`。参数出值域报 usage.bad-argument；场景包的毛病由 pack.rs 报带错误码的 `PackError`。
fn pack_command(cmd: &str, args: &[String], presets: &Path) -> Result<()> {
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let usage = |at: &str, m: String| -> anyhow::Error { pack::PackError { code: pack::BAD_ARGUMENT, at: at.into(), message: m }.into() };
    let num = |name: &str| -> Result<Option<u32>> { flag(name).map(|s| s.parse::<u32>().map_err(|_| usage(name, format!("{s:?} 不是非负整数")))).transpose() };
    let dir = PathBuf::from(args.get(2).filter(|a| !a.starts_with('-')).ok_or_else(|| usage("", "要给场景包目录".into()))?);
    let frame = num("--frame")?.unwrap_or(0) as usize;
    let size = (num("--width")?.unwrap_or(1280), num("--height")?.unwrap_or(720));
    if size.0 == 0 || size.1 == 0 {
        return Err(usage("--width", "画面的宽和高都要大于 0".into()));
    }
    let overrides: Option<serde_json::Value> = flag("--override").map(|s| serde_json::from_str(&s)).transpose()?;
    // 北冥：像素滤波、夹取、滤光泽（CyclesFilm）。不给就是盒式宽 1、不夹、不滤
    let real = |name: &str, lo: f32, hi: f32, default: f32| -> Result<f32> {
        let Some(s) = flag(name) else { return Ok(default) };
        match s.parse::<f32>() {
            Ok(v) if v >= lo && v <= hi => Ok(v),
            _ => Err(usage(name, format!("{s:?} 不是 [{lo}, {hi}] 里的数"))),
        }
    };
    let kind = match flag("--pixel-filter") {
        None => beiming_core_path::pixel_filter::FilterType::Box,
        Some(s) => beiming_core_path::pixel_filter::FilterType::parse(&s).ok_or_else(|| usage("--pixel-filter", format!("{s:?} 不是 box、gaussian、blackman-harris")))?,
    };
    let width = real("--filter-width", 0.01, 10.0, 1.0)?;
    let times3 = |v: f32| if v == 0.0 { 0.0 } else { v * 3.0 };
    let glossy = real("--filter-glossy", 0.0, 10.0, 0.0)?;
    let film = CyclesFilm {
        filter_table: gpu::KernelFilterTable::new(kind, width),
        sample_clamp_direct: times3(real("--clamp-direct", 0.0, 1e8, 0.0)?),
        sample_clamp_indirect: times3(real("--clamp-indirect", 0.0, 1e8, 0.0)?),
        filter_glossy: if glossy == 0.0 { 0.0 } else { 1.0 / glossy },
    };
    let t_total = Instant::now();
    let p = pack::load(&dir)?;
    if cmd == "pack-info" {
        let b = pack::build(&p, frame, size, flag("--preset").as_deref(), presets, overrides.as_ref())?;
        if let Some(out) = flag("--record") {
            std::fs::write(&out, serde_json::to_vec_pretty(&pack::record(&p, frame, &b))?)?;
        }
        println!("{}", pack::info(&p, frame, &b));
        return Ok(());
    }
    let t0 = Instant::now();
    let g = gpu::Gpu::new()?;
    let init_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let b = pack::build(&p, frame, size, flag("--preset").as_deref(), presets, overrides.as_ref())?;
    let motion = pack::motion_step(&p, frame, size, &b)?;
    let timings = vec![("gpu_init_ms".into(), init_ms), ("pack_ms".into(), t.elapsed().as_secs_f64() * 1000.0)];
    let job = Job {
        // （场景来自场景包，不来自游戏脚本：`finish` 不读 `game`）
        game: GameJob { bundle: dir.clone(), runtime: None, assets: dir.clone(), room: String::new(), seed: None, state: None, seq: 0 },
        out: PathBuf::from(flag("-o").unwrap_or_else(|| "out.png".into())),
        spp: num("--spp")?,
        stats: flag("--stats").map(PathBuf::from),
        denoise: if args.iter().any(|a| a == "--no-denoise") { Some(false) } else { None },
        overrides,
        camera: None,
        preset: flag("--preset"),
        time: None,
        size: (Some(size.0), Some(size.1)),
        hdr: flag("--hdr").map(PathBuf::from),
        signals: flag("--signals").map(PathBuf::from),
        passes: flag("--passes").map(PathBuf::from),
        transparent: !p.world_visible,
        cycles_film: Some(film),
        motion,
    };
    let mut stats = finish(&g, b.scene, &job, init_ms, timings, t_total)?;
    stats["pack"] = serde_json::json!({ "id": p.id, "frame": frame, "frames": p.count });
    if let Some(f) = &job.stats {
        std::fs::write(f, serde_json::to_vec_pretty(&stats)?)?;
    }
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}

/// 北冥：`--passes DIR` 出的层。每个通道一个文件、没有文件头、行主序（行从上到下，像素从左到右，一个像素里各分量挨着）、
/// 每个数 4 字节小端，文件名是「通道名.类型」（帧源接口契约 3.3 的写法，与页面宿主一致）。objectId 的两个分量类型不同：
/// id（u32）进 objectId.u32，coverage（f32）另进 objectId.coverage.f32，两个文件形状相同。
/// 通道的数值照输出通道契约：color 是 RGBA（RGB 是样本均值，已经预乘 A）；depth、objectId、normal 取辅助样本；
/// denoiseAlbedo 是上游口径的反照率均值；denoiseNormal 照 Cycles 的降噪特征换到它的相机空间（看 +Z、Y 向上：
/// kernel/film/denoising_passes.h 把世界空间的法线经 worldtocamera 变过去），见 STRUCTURES.md「输出通道」。
/// motion 照输出通道契约 5.6（快门角为 0）：辅助样本的命中点在相邻一帧的屏幕位置之差，宿主一侧用双精度求（`motion::layer`），
/// `motion` 是 None（只有一帧的包）时全 0。不出分灯组。另写一份通道声明 passes.json（passes/0.1，列交出的七个固定通道）。
/// 返回给 stdout 统计的一段：每个通道的文件、形状 [高, 宽, 分量数]、分量名与类型。
fn write_passes(dir: &Path, frame: &gpu::Frame, params: &gpu::Params, motion: Option<&beiming_core_path::motion::Step>) -> Result<serde_json::Value> {
    let aux = frame.aux.as_ref().ok_or_else(|| anyhow!("要出层，渲染却没有带辅助层"))?;
    std::fs::create_dir_all(dir)?;
    let (h, w) = (frame.height as usize, frame.width as usize);
    let denoise_normal: Vec<f32> = camera_normals(frame, params).iter().flat_map(|n| [n.x, n.y, n.z]).collect();
    let color: Vec<f32> = frame.color.iter().zip(&frame.alpha).flat_map(|(c, a)| [c[0], c[1], c[2], *a]).collect();
    let flat = |v: &[[f32; 3]]| v.iter().flatten().copied().collect::<Vec<f32>>();
    let motion = beiming_core_path::motion::layer(motion, &aux.hit, frame.width, frame.height).map_err(|e| anyhow!(e))?;
    let f32s: [(&str, &str, &[&str], Vec<f32>); 7] = [
        ("color", "color.f32", &["R", "G", "B", "A"], color),
        ("depth", "depth.f32", &["Z"], aux.depth.clone()),
        ("objectId.coverage", "objectId.coverage.f32", &["coverage"], aux.coverage.clone()),
        ("normal", "normal.f32", &["X", "Y", "Z"], flat(&aux.normal)),
        ("motion", "motion.f32", &["X", "Y"], motion),
        ("denoiseAlbedo", "denoiseAlbedo.f32", &["R", "G", "B"], flat(&frame.albedo)),
        ("denoiseNormal", "denoiseNormal.f32", &["X", "Y", "Z"], denoise_normal),
    ];
    let mut layers = serde_json::Map::new();
    let entry = |file: &str, k: usize, comps: &[&str], ty: &str| serde_json::json!({ "file": file, "shape": [h, w, k], "components": comps, "type": ty });
    for (name, file, comps, data) in &f32s {
        debug_assert_eq!(data.len(), h * w * comps.len());
        std::fs::write(dir.join(file), bytemuck::cast_slice::<f32, u8>(data))?;
        layers.insert(name.to_string(), entry(file, comps.len(), comps, "f32"));
    }
    std::fs::write(dir.join("objectId.u32"), bytemuck::cast_slice::<u32, u8>(&aux.id))?;
    layers.insert("objectId".into(), entry("objectId.u32", 1, &["id"], "u32"));
    // 通道声明：各通道的属性照输出通道契约 3.1 的登记表
    let ch = |name: &str, comps: &[(&str, &str)], space: &str, sample: &str| {
        serde_json::json!({ "name": name, "components": comps.iter().map(|(n, t)| serde_json::json!({ "name": n, "type": t })).collect::<Vec<_>>(), "colorSpace": space, "sample": sample, "antialiased": sample == "accumulate" })
    };
    let (f, lin) = ("f32", "scene-linear-rec709");
    let table = serde_json::json!({
        "format": "passes/0.1",
        "channels": [
            ch("color", &[("R", f), ("G", f), ("B", f), ("A", f)], lin, "accumulate"),
            ch("depth", &[("Z", f)], "none", "sub0"),
            ch("objectId", &[("id", "u32"), ("coverage", f)], "none", "sub0"),
            ch("normal", &[("X", f), ("Y", f), ("Z", f)], "none", "sub0"),
            ch("motion", &[("X", f), ("Y", f)], "none", "sub0"),
            ch("denoiseAlbedo", &[("R", f), ("G", f), ("B", f)], lin, "accumulate"),
            ch("denoiseNormal", &[("X", f), ("Y", f), ("Z", f)], "none", "accumulate"),
        ],
    });
    std::fs::write(dir.join("passes.json"), serde_json::to_vec_pretty(&table)?)?;
    Ok(serde_json::json!({ "dir": dir, "table": "passes.json", "layers": layers }))
}

/// 北冥：降噪特征的法线换到 Cycles 降噪特征的相机空间（看 +Z、Y 向上），出层的 denoiseNormal 与 OIDN 的引导用同一份。
fn camera_normals(frame: &gpu::Frame, params: &gpu::Params) -> Vec<Vec3> {
    let v3 = |v: [f32; 4]| Vec3::new(v[0], v[1], v[2]);
    let (right, up, fwd) = (v3(params.cam_right), v3(params.cam_up), v3(params.cam_fwd));
    frame.normal.iter().map(|n| { let n = Vec3::from(*n); Vec3::new(n.dot(right), n.dot(up), n.dot(fwd)) }).collect()
}

/// 北冥：`denoise`：拿现成的三张图（颜色、反照率、法线，各是 RGB f32 小端、行主序、没有文件头）走 render-pack 用的同一个
/// `denoise::oidn()`，输出同样格式的一张图；stdout 一行统计。给对拍用：别家渲染器的带噪颜色与降噪特征喂进来，和它自己降噪的结果比。
fn denoise_files(flag: &dyn Fn(&str) -> Option<String>) -> Result<()> {
    let need = |k: &str| flag(k).ok_or_else(|| anyhow!("denoise 要 {k}"));
    let (w, h): (usize, usize) = (need("--width")?.parse()?, need("--height")?.parse()?);
    let device = flag("--device").unwrap_or_else(|| "cpu".into());
    let prefilter = flag("--prefilter").unwrap_or_else(|| "accurate".into());
    let dev = denoise::OidnDevice::parse(&device).ok_or_else(|| anyhow!("--device 只认 cpu、cuda、metal、default"))?;
    let pre = denoise::Prefilter::parse(&prefilter).ok_or_else(|| anyhow!("--prefilter 只认 accurate、fast、none"))?;
    let read = |k: &str| -> Result<Vec<Vec3>> {
        let bytes = std::fs::read(need(k)?)?;
        if bytes.len() != w * h * 12 {
            return Err(anyhow!("{k} 有 {} 字节，{w}×{h} 的 RGB f32 要 {}", bytes.len(), w * h * 12));
        }
        Ok(bytemuck::pod_collect_to_vec::<u8, f32>(&bytes).chunks(3).map(|p| Vec3::new(p[0], p[1], p[2])).collect())
    };
    let (color, albedo, normal) = (read("--color")?, read("--albedo")?, read("--normal")?);
    let t = Instant::now();
    let out = denoise::oidn(w, h, &color, &albedo, &normal, dev, pre).map_err(|e| anyhow!(e))?;
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    let raw: Vec<f32> = out.iter().flat_map(|c| [c.x, c.y, c.z]).collect();
    std::fs::write(need("-o")?, bytemuck::cast_slice(&raw))?;
    println!("{}", serde_json::json!({ "denoise": "oidn", "device": device, "prefilter": prefilter, "quality": "high", "width": w, "height": h, "denoise_ms": (ms * 10.0).round() / 10.0 }));
    Ok(())
}

/// PREFIX-diffuse.raw, -specular.raw, -emission.raw (RGB f32 each).
fn write_signals(prefix: &Path, diffuse: &[f32], specular: &[f32], emission: &[f32]) -> Result<()> {
    if let Some(parent) = prefix.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for (name, v) in [("diffuse", diffuse), ("specular", specular), ("emission", emission)] {
        std::fs::write(format!("{}-{name}.raw", prefix.display()), bytemuck::cast_slice(v))?;
    }
    Ok(())
}

fn render(g: &gpu::Gpu, job: &Job, presets: &Path, init_ms: f64, hosts: &mut Hosts) -> Result<serde_json::Value> {
    let t_total = Instant::now();
    let mut timings: Vec<(String, f64)> = vec![("gpu_init_ms".into(), init_ms)];
    let (host, script_ms) = hosts.scene(&job.game)?;
    // A frame script draws a timeline: the render shows the game at the job's scene time (0 without one), as live
    // shows it after running that long. Before, a still showed the frame script at its last run (setup: time 0) while
    // shaders and sway took the job's time: the Bistro C slice's walkers, smoke and rain stood at 0 s in every frame.
    if host.has_frame() {
        host.seek(job.time.unwrap_or(0.0))?;
    }
    timings.push(("script_ms".into(), script_ms));
    let sc = {
        let mut w = host.world.borrow_mut();
        w.take_changes();
        let missing: Vec<String> = w.files().into_iter().filter(|f| !beiming_core_path::files::asset_path(&job.game.assets, f).is_file()).collect();
        if !missing.is_empty() {
            return Err(MissingFiles(missing).into());
        }
        let saved = w.settings.clone();
        if let Some(p) = &job.preset {
            w.settings.preset = p.clone();
        }
        w.settings.time = job.time.unwrap_or(w.settings.time);
        let t = w.settings.time;
        w.apply_sway(t);
        let sc = scene::build(&w, &job.game.assets, presets, job.overrides.as_ref());
        w.settings = saved;
        sc?
    };
    timings.push(("load_ms".into(), sc.stats["load_ms"]));
    finish(g, sc, job, init_ms, timings, t_total)
}

/// The rest of a render once its scene is built: the GPU trace, denoise, post, the files, the stats.
fn finish(g: &gpu::Gpu, mut sc: scene::Scene, job: &Job, init_ms: f64, mut timings: Vec<(String, f64)>, t_total: Instant) -> Result<serde_json::Value> {
    sc.width = job.size.0.unwrap_or(sc.width);
    sc.height = job.size.1.unwrap_or(sc.height);
    if let Some(c) = &job.camera {
        override_camera(&mut sc.camera, c)?;
    }

    let prep = prepare(g, &mut sc, &mut timings);
    let preset = sc.preset.clone();
    let spp = job.spp.unwrap_or(preset.native.spp);
    let mut params = prep.params;
    if job.signals.is_some() {
        params.motion[1] = 1.0;
    }
    params.integrator.background_transparent = job.transparent as u32;
    if let Some(f) = &job.cycles_film {
        f.write(&mut params);
    }
    let frame = g.render(&sc, &prep.tri_verts, prep.groups, bytemuck::cast_slice(&prep.nodes), &prep.emitters, &prep.gpu_emitter_tris, beiming_core_path::ltree::nodes_of(prep.light_tree.as_ref()), &prep.env, &prep.env_cdf, &prep.energy, params, spp, job.passes.is_some(), &mut timings)?;
    let passes = match &job.passes {
        Some(dir) => Some(write_passes(dir, &frame, &params, job.motion.as_ref())?),
        None => None,
    };
    if let Some(prefix) = &job.signals {
        // The raw (undenoised) means: diffuse = color less specular and emission.
        let diffuse: Vec<f32> = frame.color.iter().zip(&frame.specular).zip(&frame.emission).flat_map(|((c, s), e)| [0, 1, 2].map(|k| (c[k] - s[k] - e[k]).max(0.0))).collect();
        let flat = |v: &[[f32; 3]]| v.iter().flatten().copied().collect::<Vec<f32>>();
        write_signals(prefix, &diffuse, &flat(&frame.specular), &flat(&frame.emission))?;
    }

    let t = Instant::now();
    let (w, h) = (frame.width as usize, frame.height as usize);
    let color: Vec<Vec3> = frame.color.iter().map(|c| Vec3::from(*c)).collect();
    let denoise = job.denoise.unwrap_or(preset.native.denoise);
    let (exposure, ev100) = post::exposure_scale(&post::Image { w, h, px: color.clone() }, &sc.camera.exposure, &preset.post);
    let mut denoiser = "none";
    let color = if denoise {
        let albedo: Vec<Vec3> = frame.albedo.iter().map(|c| Vec3::from(*c)).collect();
        let normal: Vec<Vec3> = frame.normal.iter().map(|c| Vec3::from(*c).normalize_or_zero()).collect();
        // 北冥：OIDN 的法线是相机空间的均值（照 Cycles），只在编进了 OIDN 时算；小波降噪照旧用世界空间、逐像素归一的。
        // 设备与预过滤取 Cycles 最终渲染的默认：CPU、ACCURATE（质量 HIGH 在 oidn() 里）。Cycles 的渲染缓冲第一行是画面最下面
        // 一行，这里的帧第一行是最上面一行；卷积网络对上下翻转不逐位不变，所以照 Cycles 的行序喂进去、出来再翻回
        let oidn = if cfg!(feature = "oidn") {
            let flip = |v: &[Vec3]| -> Vec<Vec3> { v.chunks(w).rev().flatten().copied().collect() };
            denoise::oidn(w, h, &flip(&color), &flip(&albedo), &flip(&camera_normals(&frame, &params)), denoise::OidnDevice::Cpu, denoise::Prefilter::Accurate)
                .map(|c| flip(&c))
                .map_err(|e| eprintln!("oidn: {e}"))
                .ok()
        } else {
            None
        };
        match oidn {
            Some(c) => {
                denoiser = "oidn";
                c
            }
            None => {
                denoiser = "atrous";
                denoise::denoise(w, h, &color, &albedo, &normal, &frame.variance, 4)
            }
        }
    } else {
        color
    };
    timings.push(("denoise_ms".into(), t.elapsed().as_secs_f64() * 1000.0));

    let t = Instant::now();
    let img = post::Image { w, h, px: color };
    // Local exposure's middle grey follows the exposure compensation (UE: auto bias; manual: bias = -EV100).
    let compensation = match &sc.camera.exposure {
        beiming_core_path::desc::Exposure::Auto { compensation, .. } => 2f32.powf(*compensation),
        beiming_core_path::desc::Exposure::Manual { ev100 } => 2f32.powf(-ev100),
    };
    let rgba = post::finish(&img, exposure, compensation, &preset.post);
    timings.push(("post_ms".into(), t.elapsed().as_secs_f64() * 1000.0));
    if let Some(hdr) = &job.hdr {
        let raw: Vec<f32> = img.px.iter().flat_map(|c| [c.x, c.y, c.z]).collect();
        std::fs::write(hdr, bytemuck::cast_slice(&raw))?;
    }

    let t = Instant::now();
    if let Some(parent) = job.out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let ext = job.out.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
    if ext == "jpg" || ext == "jpeg" {
        let rgb: Vec<u8> = rgba.chunks(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        let f = std::io::BufWriter::new(std::fs::File::create(&job.out)?);
        image::codecs::jpeg::JpegEncoder::new_with_quality(f, 88).encode(&rgb, w as u32, h as u32, image::ExtendedColorType::Rgb8)?;
    } else {
        image::save_buffer(&job.out, &rgba, w as u32, h as u32, image::ColorType::Rgba8)?;
    }
    timings.push(("encode_ms".into(), t.elapsed().as_secs_f64() * 1000.0));
    timings.push(("total_ms".into(), t_total.elapsed().as_secs_f64() * 1000.0 + init_ms));

    let trace_ms = timings.iter().find(|t| t.0 == "trace_ms").map(|t| t.1).unwrap_or(0.0);
    let stats = serde_json::json!({
        "scene": sc.name,
        "out": job.out,
        "width": w, "height": h, "spp": spp,
        "triangles": sc.stats.get("triangles").map_or(sc.tris.len(), |t| *t as usize), "instances": sc.instances.len(),
        "instanced_triangles": sc.stats.get("instanced_triangles").copied().unwrap_or(0.0) as u64, "flat_triangles": sc.tris.len(), "bvh_nodes": prep.nodes.len(), "emitters": prep.emitter_tris.len(), "lights": sc.lights.len(), "textures": sc.textures.len(),
        "adapter": g.adapter_info.name, "backend": format!("{:?}", g.adapter_info.backend), "hwrt": g.hwrt,
        "ev100": ev100, "denoise": denoiser, "preset": preset.name,
        "samples_per_sec": (w * h) as f64 * spp as f64 / (trace_ms / 1000.0).max(1e-9),
        "timings_ms": timings.iter().map(|(k, v)| (k.clone(), serde_json::json!((v * 10.0).round() / 10.0))).collect::<serde_json::Map<_, _>>(),
    });
    let mut stats = stats;
    if let Some(p) = passes {
        stats["passes"] = p;
    }
    if let Some(p) = &job.stats {
        std::fs::write(p, serde_json::to_vec_pretty(&stats)?)?;
    }
    Ok(stats)
}
