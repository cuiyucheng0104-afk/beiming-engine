// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/src/api.rs，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
//! The engine API scene code calls (`globalThis.__engine`, packages/scene/src/engine.ts): what each call does to the
//! engine's world, apart from how the call arrives. Natively it arrives from the embedded QuickJS (script.rs
//! `install_engine`), in a browser from the page's own JavaScript through the wasm module's exports (renderer/web):
//! both hand a call's descriptor over as JSON and its arrays as slices, and both get the same world.

use crate::desc;
use crate::world::{Geometry, Kind, Settings, Texture, TextureSource, World};
use glam::{Quat, Vec3};
use serde_json::Value;
use std::sync::Arc;

/// A call that failed: `Type` for an argument of the wrong shape (a `TypeError` to scene code), `Other` for what the
/// engine refused (an `Error` with its message).
pub enum Error {
    Type(String),
    Other(anyhow::Error),
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Error {
        Error::Other(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::Type(m) => write!(f, "{m}"),
            Error::Other(e) => write!(f, "{e:#}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// A descriptor as the engine's own type.
pub fn parse<T: serde::de::DeserializeOwned>(what: &str, v: &Value) -> Result<T> {
    serde_json::from_value(v.clone()).map_err(|e| Error::Type(format!("engine.{what}: {e}")))
}

/// (`groups`: triples of u32; `colors`: per vertex.)
pub fn geometry(w: &mut World, id: u32, p: &[f32], n: &[f32], uv: &[f32], idx: &[u32], groups: Option<&[u32]>, colors: Option<&[f32]>) -> Result<()> {
    let groups = groups.map_or(vec![], |g| g.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect());
    let g = Geometry { positions: p.to_vec(), normals: n.to_vec(), uvs: uv.to_vec(), indices: idx.to_vec(), groups, colors: colors.map_or(vec![], |c| c.to_vec()) };
    Ok(w.set_geometry(id, g)?)
}

pub fn texture(w: &mut World, id: u32, j: &Value, data: Option<&[u8]>) -> Result<()> {
    let pair = |k: &str, def: f32| -> [f32; 2] { [0, 1].map(|i| j[k][i].as_f64().map_or(def, |x| x as f32)) };
    let source = match (data, j["uri"].as_str()) {
        (Some(bytes), _) if j["size"].is_array() => {
            let (width, height) = (j["size"][0].as_u64().unwrap_or(0) as u32, j["size"][1].as_u64().unwrap_or(0) as u32);
            if bytes.len() != width as usize * height as usize * 4 {
                return Err(Error::Type(format!("engine.texture: {} bytes are not {width}x{height} RGBA8 pixels", bytes.len())));
            }
            match j["stream"].as_str() {
                Some(name) if !name.is_empty() && name.len() <= 64 && !name.contains('|') => TextureSource::Stream { name: name.to_string(), width, height, rgba: Arc::new(bytes.to_vec()) },
                Some(name) => return Err(Error::Type(format!("engine.texture: a stream's name is 1 to 64 characters without '|', not {name:?}"))),
                None => TextureSource::Pixels { width, height, rgba: Arc::new(bytes.to_vec()) },
            }
        }
        (Some(bytes), _) => TextureSource::Encoded(Arc::new(bytes.to_vec())),
        (None, Some(uri)) => TextureSource::File(uri.to_string()),
        (None, None) => return Err(Error::Type("engine.texture: needs a uri or data".into())),
    };
    let t = Texture { source, srgb: j["srgb"].as_bool().unwrap_or(true), wrap: j["wrap"].as_bool().unwrap_or(true), repeat: pair("repeat", 1.0), offset: pair("offset", 0.0) };
    w.set_texture(id, t)?;
    Ok(())
}

/// Density grids (ROADMAP § 6 step 5b): a grid (its size, channels and data). A grid with a program is refused: this
/// build has no grid simulation pass.
pub fn density_grid(w: &mut World, id: u32, j: &Value, data: Option<&[f32]>) -> Result<()> {
    let n = |k: usize| j["size"][k].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32;
    if !j["program"].is_null() {
        return Err(Error::Other(anyhow::anyhow!("engine.densityGrid: grid programs are not supported (the offline core has no grid simulation)")));
    }
    Ok(w.set_grid(id, [n(0), n(1), n(2)], j["channels"].as_u64().unwrap_or(1) as u32, data, None)?)
}

pub fn material(w: &mut World, id: u32, d: &Value) -> Result<()> {
    let m: desc::Material = parse("material", d)?;
    w.set_material(id, m);
    Ok(())
}

pub fn object(w: &mut World, id: u32, j: &Value) -> Result<()> {
    let num = |k: &str| j[k].as_u64().map(|x| x as u32);
    // `body`: a rigid body will drive it (physics.rs). A mesh is then an instance of its own BLAS, so one added while
    // the game runs is placed in place and its moves are its instance's transform.
    let body = j["body"].as_bool().unwrap_or(false);
    let kind = match j["kind"].as_str().unwrap_or("group") {
        "mesh" => {
            let materials: Vec<u32> = j["materials"].as_array().map_or(vec![], |a| a.iter().filter_map(|v| v.as_u64().map(|x| x as u32)).collect());
            Kind::Mesh { geometry: num("geometry").unwrap_or(0), material: num("material").unwrap_or(0), own_blas: j["dynamicGeometry"].as_bool().unwrap_or(false) || (body && materials.len() <= 1), materials }
        }
        "model" => Kind::Model { uri: j["uri"].as_str().unwrap_or_default().to_string(), nodes: serde_json::from_value(j["nodes"].clone()).ok(), animation: serde_json::from_value(j["animation"].clone()).ok(), functions: serde_json::from_value(j["functions"].clone()).unwrap_or_default() },
        "light" => Kind::Light(serde_json::from_value(j["light"].clone()).map_err(|e| Error::Type(format!("engine.object light: {e}")))?),
        "camera" => Kind::Camera(serde_json::from_value(j["camera"].clone()).map_err(|e| Error::Type(format!("engine.object camera: {e}")))?),
        "volume" => Kind::Volume {
            function: j["volume"]["id"].as_str().unwrap_or_default().to_string(),
            params: j["volume"]["params"].as_array().map_or(vec![], |a| a.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect()),
            shape: if j["shape"].as_str() == Some("sphere") { 1 } else { 0 },
            majorant: j["majorant"].as_f64().unwrap_or(0.0) as f32,
            g: j["g"].as_f64().unwrap_or(0.0) as f32,
            homogeneous: j["homogeneous"].as_bool().unwrap_or(false),
            animated: j["animated"].as_bool().unwrap_or(false),
            grid: num("grid"),
        },
        "instanced" => Kind::Instanced {
            geometry: num("geometry").unwrap_or(0),
            procedural: j["procedural"].as_bool().unwrap_or(false),
            materials: j["materials"].as_array().map_or(vec![], |a| a.iter().filter_map(|v| v.as_u64().map(|x| x as u32)).collect()),
            capacity: num("count").unwrap_or(0),
        },
        "procedural" => Kind::Procedural {
            geometry: num("geometry").unwrap_or(0),
            materials: j["materials"].as_array().map_or(vec![], |a| a.iter().filter_map(|v| v.as_u64().map(|x| x as u32)).collect()),
        },
        // (Particle systems: this build has no particle passes; a scene that has them is refused, not drawn without.)
        "gpuParticles" | "particles" => return Err(Error::Other(anyhow::anyhow!("engine.object: particles are not supported (the offline core has no particle passes)"))),
        _ => Kind::Group,
    };
    w.set_object(id, j["name"].as_str().unwrap_or_default().to_string(), num("parent"), kind, j["castShadow"].as_bool().unwrap_or(true), j["movable"].as_bool().unwrap_or(false))?;
    if body {
        w.set_driven(id)?;
    }
    Ok(())
}

/// (Ten numbers: position, rotation xyzw, scale.)
pub fn transform(w: &mut World, id: u32, t: &[f32]) -> Result<()> {
    if t.len() < 10 {
        return Err(Error::Type("engine.transform: needs 10 numbers".into()));
    }
    let q = Quat::from_xyzw(t[3], t[4], t[5], t[6]);
    Ok(w.set_transform(id, Vec3::new(t[0], t[1], t[2]), if q.length_squared() > 0.0 { q.normalize() } else { Quat::IDENTITY }, Vec3::new(t[7], t[8], t[9]))?)
}

pub fn custom_data(w: &mut World, id: u32, v: &[f64]) -> Result<()> {
    let mut c = [0.0f32; 4];
    for (k, x) in v.iter().take(4).enumerate() {
        c[k] = *x as f32;
    }
    Ok(w.set_custom(id, c)?)
}

/// (None: no sway.)
pub fn sway(w: &mut World, id: u32, d: Option<&Value>) -> Result<()> {
    let s: Option<crate::world::Sway> = d.map(|d| parse("sway", d)).transpose()?;
    Ok(w.set_sway(id, s)?)
}

pub fn light(w: &mut World, id: u32, d: &Value) -> Result<()> {
    let l: desc::Light = parse("light", d)?;
    Ok(w.set_light(id, l)?)
}

pub fn camera(w: &mut World, id: u32, d: &Value) -> Result<()> {
    let c: desc::Camera = parse("camera", d)?;
    Ok(w.set_camera_desc(id, c)?)
}

/// (None: no animation.)
pub fn animation(w: &mut World, id: u32, d: Option<&Value>) -> Result<()> {
    let a: Option<desc::Animation> = d.map(|d| parse("animation", d)).transpose()?;
    Ok(w.set_animation(id, a)?)
}

/// Removes an object and what is under it; their bodies go with them (a body asleep would never find out its object
/// went; the object's id may come again).
pub fn remove(w: &mut World, id: u32) {
    w.remove(id);
}

pub fn environment(w: &mut World, d: &Value) -> Result<()> {
    let env: desc::Environment = parse("environment", d)?;
    w.set_environment(env);
    Ok(())
}

pub fn settings(w: &mut World, j: &Value) {
    let s = Settings {
        name: j["name"].as_str().unwrap_or("scene").to_string(),
        preset: j["preset"].as_str().unwrap_or("cinematic").to_string(),
        overrides: Some(j["overrides"].clone()).filter(|o| !o.is_null()),
        width: j["width"].as_u64().unwrap_or(1280) as u32,
        height: j["height"].as_u64().unwrap_or(720) as u32,
        time: j["time"].as_f64().unwrap_or(0.0) as f32,
        camera: j["camera"].as_u64().map(|c| c as u32),
    };
    w.set_settings(s);
}
