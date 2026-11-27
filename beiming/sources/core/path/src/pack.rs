// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT
// 北冥新写的文件，不是上游 ThreeRT 的。三种灯的换算是辐射度量学的式子，没有搬 Cycles 的代码；为了和 Cycles 的口径一致，
// 逐条对过 Cycles（Blender v5.2.3）的源码，出处写在 `kernel_light` 的注释里。
//! 北冥：场景包读入器（场景包契约 `scene-pack/0.1`，在 beiming/kernel/contracts/scene-pack/）。读一个场景包目录：
//! 清单 `pack.json`、几何文件（GLB）、实例表（u32）、每帧状态表（f32），全部校验；选一帧建成内核的 `World`，
//! 再走现有的 `scene::build`。读入方是信任边界：一切错都报成带错误码的 `PackError`，不 panic、不越界读。
//!
//! 只做到「读对、读全、读不对就报清楚」。图案节点照契约逐字段解析、校验，留在 `Pack` 里，**不生效**
//! （统计里列在 `notApplied`）。灯光链接与分灯组生效：见 `Pack::light_links`、`Pack::lightgroups`。没登记参数的三种闭包、正交相机、动态网格、材质逐帧表都报 `contract.unsupported-input`。

use crate::{desc, scene, world};
use anyhow::Result;
use glam::{Mat4, Vec3, Vec3A};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 结构不合契约（过不了结构定义，或违反了没有专用码的条文）。错误码表里没有场景包专用的通用码，借用这一个。
pub const BAD_VALUE: &str = "contract.bad-value";
/// 出现了契约没定义的键。
pub const UNKNOWN_KEY: &str = "contract.unknown-key";
/// 图案节点名不在节点登记表里（SP17）。
pub const UNKNOWN_NODE: &str = "contract.unknown-node";
/// 契约允许、这个读入器装不了的东西（参数还没登记的闭包、正交相机、动态网格、材质逐帧表）。
pub const UNSUPPORTED: &str = "contract.unsupported-input";
/// 调用参数出了值域（例如帧号不在包里）。
pub const BAD_ARGUMENT: &str = "usage.bad-argument";

/// 读入场景包时的一个错：错误码、出错字段的路径（如 `lights[2].watts`，整个包的毛病是空串）、说明。
#[derive(Debug, Clone, PartialEq)]
pub struct PackError {
    pub code: &'static str,
    pub at: String,
    pub message: String,
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.at.is_empty() {
            write!(f, "{}: {}", self.code, self.message)
        } else {
            write!(f, "{} at {}: {}", self.code, self.at, self.message)
        }
    }
}

impl std::error::Error for PackError {}

impl PackError {
    pub fn json(&self) -> Value {
        json!({ "error": { "code": self.code, "at": self.at, "message": self.message } })
    }
}

/// 错误码表契约 5.1：退出码只由前缀定。
pub fn exit_code(code: &str) -> i32 {
    match code.split('.').next().unwrap_or("") {
        "usage" => 2,
        "env" => 3,
        "contract" | "auth" => 4,
        "busy" => 5,
        "timeout" => 124,
        _ => 1,
    }
}

type R<T> = std::result::Result<T, PackError>;

fn fail(code: &'static str, at: &str, message: impl Into<String>) -> PackError {
    PackError { code, at: at.to_string(), message: message.into() }
}
fn bad(at: &str, message: impl Into<String>) -> PackError {
    fail(BAD_VALUE, at, message)
}
fn join(at: &str, k: &str) -> String {
    if at.is_empty() { k.to_string() } else { format!("{at}.{k}") }
}
fn idx(at: &str, i: usize) -> String {
    format!("{at}[{i}]")
}

// ------------------------------------------------------------------------------------------ JSON 的几样小工具

fn object<'a>(v: &'a Value, at: &str) -> R<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| bad(at, "必须是对象"))
}
/// 只许出现这些键：别的键报 contract.unknown-key，路径写到那个键。
fn only(m: &Map<String, Value>, at: &str, keys: &[&str]) -> R<()> {
    match m.keys().find(|k| !keys.contains(&k.as_str())) {
        Some(k) => Err(fail(UNKNOWN_KEY, &join(at, k), format!("契约没定义这个键（这里只能有 {}）", keys.join("、")))),
        None => Ok(()),
    }
}
/// 必填字段：缺了报 contract.bad-value，路径写到缺的那个字段。
fn need<'a>(m: &'a Map<String, Value>, at: &str, k: &str) -> R<&'a Value> {
    m.get(k).ok_or_else(|| bad(&join(at, k), "缺必填字段"))
}
fn string<'a>(v: &'a Value, at: &str) -> R<&'a str> {
    v.as_str().ok_or_else(|| bad(at, "必须是字符串"))
}
fn nonempty<'a>(v: &'a Value, at: &str) -> R<&'a str> {
    let s = string(v, at)?;
    if s.is_empty() {
        return Err(bad(at, "不能是空串"));
    }
    Ok(s)
}
/// 双精度数（serde_json 读不出非有限的数：`1e400` 这类在解析整份清单时就报错）。
fn number(v: &Value, at: &str) -> R<f64> {
    v.as_f64().filter(|x| x.is_finite()).ok_or_else(|| bad(at, "必须是数"))
}
fn positive(v: &Value, at: &str) -> R<f64> {
    let x = number(v, at)?;
    if x > 0.0 { Ok(x) } else { Err(bad(at, format!("必须大于 0，现在是 {x}"))) }
}
fn non_negative(v: &Value, at: &str) -> R<f64> {
    let x = number(v, at)?;
    if x >= 0.0 { Ok(x) } else { Err(bad(at, format!("不能小于 0，现在是 {x}"))) }
}
fn unit(v: &Value, at: &str) -> R<f64> {
    let x = number(v, at)?;
    if (0.0..=1.0).contains(&x) { Ok(x) } else { Err(bad(at, format!("必须在 [0, 1] 里，现在是 {x}"))) }
}
/// 整数（JSON 里写成 `3.0` 也算），不小于 `min`，不超过 2^53。
fn integer(v: &Value, at: &str, min: u64) -> R<u64> {
    let x = v.as_f64().filter(|x| x.fract() == 0.0 && *x >= 0.0 && *x <= 9007199254740992.0).ok_or_else(|| bad(at, "必须是不小于 0 的整数"))? as u64;
    if x < min {
        return Err(bad(at, format!("必须不小于 {min}，现在是 {x}")));
    }
    Ok(x)
}
fn boolean(v: &Value, at: &str) -> R<bool> {
    v.as_bool().ok_or_else(|| bad(at, "必须是 true 或 false"))
}
fn array<'a>(v: &'a Value, at: &str) -> R<&'a Vec<Value>> {
    v.as_array().ok_or_else(|| bad(at, "必须是数组"))
}
fn numbers<const N: usize>(v: &Value, at: &str) -> R<[f64; N]> {
    let a = array(v, at)?;
    if a.len() != N {
        return Err(bad(at, format!("必须正好 {N} 个数，现在有 {} 个", a.len())));
    }
    let mut out = [0.0; N];
    for (i, x) in a.iter().enumerate() {
        out[i] = number(x, &idx(at, i))?;
    }
    Ok(out)
}
fn rgb(v: &Value, at: &str, max_one: bool) -> R<[f64; 3]> {
    let c = numbers::<3>(v, at)?;
    for (i, x) in c.iter().enumerate() {
        if *x < 0.0 || (max_one && *x > 1.0) {
            return Err(bad(&idx(at, i), format!("必须在 {} 里，现在是 {x}", if max_one { "[0, 1]" } else { "[0, ∞)" })));
        }
    }
    Ok(c)
}
fn unique<'a>(names: impl IntoIterator<Item = (usize, &'a str)>, at: &str, what: &str) -> R<()> {
    let mut seen = BTreeSet::new();
    for (i, n) in names {
        if !seen.insert(n) {
            return Err(bad(&idx(at, i), format!("{what} {n} 重复了")));
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------ 写法（契约里的正则，手写）

fn segments_ok(s: &str, ok: impl Fn(char) -> bool) -> bool {
    !s.is_empty() && s.split('.').all(|seg| !seg.is_empty() && seg.chars().all(&ok))
}
/// 实体名（镜头契约 5.2）：`^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$`。
pub fn entity_name_ok(s: &str) -> bool {
    segments_ok(s, |c| c.is_ascii_alphanumeric() || c == '_')
}
/// 灯光链接的一项（帧源接口契约 5.5）：实体名，或实体名加 `.*`。
pub fn link_ok(s: &str) -> bool {
    entity_name_ok(s.strip_suffix(".*").unwrap_or(s))
}
fn link_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => name == pattern,
    }
}
/// 分灯组名：`^[a-z0-9][a-z0-9-]*$`。
fn group_ok(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
/// 值名：`^[a-z][A-Za-z0-9]*$`。
fn value_name_ok(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_alphanumeric())
}
/// 包的标识：`^pack:[a-z0-9][a-z0-9-]*@[1-9][0-9]*$`。
fn id_ok(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("pack:") else { return false };
    let Some((name, ver)) = rest.split_once('@') else { return false };
    group_ok(name) && ver.chars().next().is_some_and(|c| ('1'..='9').contains(&c)) && ver.chars().all(|c| c.is_ascii_digit())
}
/// `ext` 的键：`^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$`。
fn ext_key_ok(s: &str) -> bool {
    let Some((head, tail)) = s.split_once('.') else { return false };
    head.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && head.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// 包里的相对路径：不空、不以 `/` 开头、没有反斜杠与冒号（Windows 的盘符与路径分隔）、没有空段与 `..` 段，以 `ext` 结尾。
fn rel_path(v: &Value, at: &str, ext: &str) -> R<String> {
    let s = string(v, at)?;
    let fine = !s.is_empty() && !s.starts_with('/') && !s.contains('\\') && !s.contains(':') && s.split('/').all(|seg| !seg.is_empty() && seg != "..");
    if !fine {
        return Err(bad(at, format!("{s:?} 不是包目录里的相对路径（不许绝对路径、..、反斜杠、盘符、空段）")));
    }
    if !s.ends_with(ext) {
        return Err(bad(at, format!("{s:?} 必须以 {ext} 结尾")));
    }
    Ok(s.to_string())
}

// ------------------------------------------------------------------------------------------ 读出来的包

/// 材质参数（参数登记表：`baseColor`、`metallic`、`roughness`，可选的 `emissionColor`、`emissionStrength`）；`mix` 的 `set` 只列其中几个。
/// 自发光两项只读、只校验，这一版不着色。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Params {
    pub base_color: Option<[f64; 3]>,
    pub metallic: Option<f64>,
    pub roughness: Option<f64>,
    pub emission_color: Option<[f64; 3]>,
    pub emission_strength: Option<f64>,
}

/// 一个图案节点（节点登记表的四种）。只读、只校验，这一版不求值。
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Bevel { radius: f64, samples: u64 },
    Ao { distance: f64, samples: u64, only_local: bool, out: String },
    Smoothstep { input: String, edges: [f64; 2], out: String },
    Mix { by: String, set: Params },
}

#[derive(Clone, Debug)]
pub struct Material {
    pub name: String,
    pub params: Params,
    pub pattern: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LightKind {
    Rect { size: [f64; 2], watts: f64 },
    Point { watts: f64 },
    /// `dir` 指向光来的方向。
    Sun { dir: [f64; 3], irradiance: f64 },
}

#[derive(Clone, Debug)]
pub struct Light {
    pub name: String,
    pub kind: LightKind,
    pub color: [f64; 3],
    pub visible: bool,
    /// 灯光链接（`Pack::light_links`）。
    pub link: Option<Vec<String>>,
    /// 分灯组名（不写时就是灯名；`Pack::lightgroups`）。
    pub group: String,
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub name: String,
    pub tris: usize,
}

/// 一张每帧状态表：形状、列，与解出来的数（行主序）。
#[derive(Clone, Debug)]
pub struct Table {
    pub file: String,
    pub shape: Vec<usize>,
    pub fields: Vec<String>,
    pub data: Vec<f32>,
}

/// 列的宽度（列登记表）。
fn field_width(f: &str) -> Option<usize> {
    match f {
        "mat16" => Some(16),
        "fovY" | "focusDist" | "fstop" | "watts" => Some(1),
        _ => None,
    }
}

impl Table {
    fn width(&self) -> usize {
        self.fields.iter().filter_map(|f| field_width(f)).sum()
    }
    /// 第 `frame` 帧第 `row` 行（二维的表 `row` 取 0）。
    pub fn row(&self, frame: usize, row: usize) -> &[f32] {
        let w = self.width();
        let rows = if self.shape.len() == 3 { self.shape[1] } else { 1 };
        let at = (frame * rows + row) * w;
        &self.data[at..at + w]
    }
    /// 这一行里某一列的数。
    pub fn field<'a>(&self, row: &'a [f32], name: &str) -> Option<&'a [f32]> {
        let mut at = 0;
        for f in &self.fields {
            let w = field_width(f)?;
            if f == name {
                return row.get(at..at + w);
            }
            at += w;
        }
        None
    }
}

/// 一个读进来、校验过的场景包。
#[derive(Clone, Debug)]
pub struct Pack {
    pub dir: PathBuf,
    /// 场景包清单原样（核对记录要整份收进去）。
    pub manifest: Value,
    pub id: String,
    pub meshes: Vec<Mesh>,
    /// 每个网格的几何（与 `meshes` 同次序）：位置、每角法线、下标，读到的原样。
    pub geometry: Vec<world::Geometry>,
    /// 长度为 0 的每角法线有几个（按三角形的角数，内核平铺时回退成面法线）。
    pub zero_normals: usize,
    /// 实例表的行：网格下标、材质下标、实体编号、是否镜像。
    pub rows: Vec<[u32; 4]>,
    pub names: Vec<String>,
    pub class: Vec<String>,
    pub materials: Vec<Material>,
    pub lights: Vec<Light>,
    pub world_color: [f64; 3],
    pub world_visible: bool,
    pub near: f64,
    pub far: f64,
    pub sensor_height: Option<f64>,
    pub count: usize,
    pub frames_instances: Table,
    pub frames_camera: Table,
    pub frames_lights: Table,
}

// ------------------------------------------------------------------------------------------ 清单

/// 只看清单（不碰文件）的解析与校验。`Pack` 里与文件有关的部分先留空，`load` 再填。
pub fn parse_manifest(v: &Value) -> R<Pack> {
    let top = object(v, "")?;
    only(top, "", &["format", "id", "units", "geometry", "instances", "materials", "lights", "world", "camera", "frames", "dynamic", "source", "ext"])?;
    for k in ["format", "id", "units", "geometry", "instances", "materials", "lights", "world", "camera", "frames", "source"] {
        need(top, "", k)?;
    }
    if string(&top["format"], "format")? != "scene-pack/0.1" {
        return Err(bad("format", "必须是 scene-pack/0.1"));
    }
    let id = string(&top["id"], "id")?;
    if !id_ok(id) {
        return Err(bad("id", format!("{id:?} 不合 pack:<名字>@<版本> 的写法")));
    }

    // units（SP2：必须正好是 1、Y、right）
    let u = object(&top["units"], "units")?;
    only(u, "units", &["meter", "up", "hand"])?;
    let meter = number(need(u, "units", "meter")?, "units.meter")?;
    let up = string(need(u, "units", "up")?, "units.up")?;
    let hand = string(need(u, "units", "hand")?, "units.hand")?;
    if meter != 1.0 {
        return Err(bad("units.meter", format!("必须是 1，现在是 {meter}（SP2）")));
    }
    if up != "Y" {
        return Err(bad("units.up", format!("必须是 \"Y\"，现在是 {up:?}（SP2）")));
    }
    if hand != "right" {
        return Err(bad("units.hand", format!("必须是 \"right\"，现在是 {hand:?}（SP2）")));
    }

    // geometry
    let g = object(&top["geometry"], "geometry")?;
    only(g, "geometry", &["file", "meshes"])?;
    rel_path(need(g, "geometry", "file")?, "geometry.file", ".glb")?;
    let ms = array(need(g, "geometry", "meshes")?, "geometry.meshes")?;
    if ms.is_empty() {
        return Err(bad("geometry.meshes", "至少要有 1 项"));
    }
    let mut meshes = vec![];
    for (i, m) in ms.iter().enumerate() {
        let at = idx("geometry.meshes", i);
        let o = object(m, &at)?;
        only(o, &at, &["name", "tris", "attrs"])?;
        let name = nonempty(need(o, &at, "name")?, &join(&at, "name"))?;
        let tris = integer(need(o, &at, "tris")?, &join(&at, "tris"), 1)? as usize;
        let attrs = array(need(o, &at, "attrs")?, &join(&at, "attrs"))?;
        let mut seen = vec![];
        for (k, a) in attrs.iter().enumerate() {
            let s = string(a, &idx(&join(&at, "attrs"), k))?;
            if !["position", "cornerNormal"].contains(&s) || seen.contains(&s) {
                return Err(bad(&idx(&join(&at, "attrs"), k), format!("{s:?} 不是登记过的属性，或重复了")));
            }
            seen.push(s);
        }
        for need_attr in ["position", "cornerNormal"] {
            if !seen.contains(&need_attr) {
                return Err(bad(&join(&at, "attrs"), format!("没有 {need_attr}（SP11）")));
            }
        }
        meshes.push(Mesh { name: name.to_string(), tris });
    }
    unique(meshes.iter().enumerate().map(|(i, m)| (i, m.name.as_str())), "geometry.meshes", "网格名")?;

    // instances
    let ins = object(&top["instances"], "instances")?;
    only(ins, "instances", &["file", "shape", "names", "class"])?;
    rel_path(need(ins, "instances", "file")?, "instances.file", ".u32")?;
    let shape = shape_of(need(ins, "instances", "shape")?, "instances.shape", 2, 2)?;
    let names_v = array(need(ins, "instances", "names")?, "instances.names")?;
    let class_v = array(need(ins, "instances", "class")?, "instances.class")?;
    let names = names_v.iter().enumerate().map(|(i, s)| nonempty(s, &idx("instances.names", i)).map(String::from)).collect::<R<Vec<_>>>()?;
    let class = class_v.iter().enumerate().map(|(i, s)| nonempty(s, &idx("instances.class", i)).map(String::from)).collect::<R<Vec<_>>>()?;
    let n = shape[0];
    if shape[1] != 4 {
        return Err(bad("instances.shape", format!("必须是 [实例数, 4]，现在是 {shape:?}（SP8）")));
    }
    if names.len() != n || class.len() != n {
        return Err(bad("instances", format!("names 有 {} 项、class 有 {} 项，实例数是 {n}（SP8）", names.len(), class.len())));
    }
    for (i, nm) in names.iter().enumerate() {
        if !entity_name_ok(nm) {
            return Err(bad(&idx("instances.names", i), format!("{nm:?} 不是合法的实体名（SP19）")));
        }
    }
    // 查每个名字在「.」处截出的前缀是不是也在表里：总量与名字总长度成正比，实例多也不卡
    let leaf: HashSet<&str> = names.iter().map(String::as_str).collect();
    for b in &names {
        if let Some(a) = b.match_indices('.').map(|(i, _)| &b[..i]).find(|a| leaf.contains(a)) {
            return Err(bad("instances.names", format!("{a} 是装配体（{b} 以它加点开头），实例表只能列叶子实体（SP14）")));
        }
    }
    let mut class_of: HashMap<&str, &str> = HashMap::new();
    for (i, (nm, c)) in names.iter().zip(&class).enumerate() {
        if let Some(prev) = class_of.insert(nm, c) {
            if prev != c {
                return Err(bad(&idx("instances.class", i), format!("实体 {nm} 的各行 class 不同：{prev}、{c}（SP15）")));
            }
        }
    }

    // materials
    let mats = array(&top["materials"], "materials")?;
    if mats.is_empty() {
        return Err(bad("materials", "至少要有 1 项"));
    }
    let mut materials = vec![];
    for (i, m) in mats.iter().enumerate() {
        materials.push(material(m, &idx("materials", i))?);
    }
    unique(materials.iter().enumerate().map(|(i, m)| (i, m.name.as_str())), "materials", "材质名")?;

    // lights
    let ls = array(&top["lights"], "lights")?;
    let mut lights = vec![];
    for (i, l) in ls.iter().enumerate() {
        lights.push(light(l, &idx("lights", i), &names)?);
    }
    unique(lights.iter().enumerate().map(|(i, l)| (i, l.name.as_str())), "lights", "灯名")?;

    // world
    let w = object(&top["world"], "world")?;
    only(w, "world", &["color", "visibleToCamera"])?;
    let world_color = rgb(need(w, "world", "color")?, "world.color", false)?;
    let world_visible = boolean(need(w, "world", "visibleToCamera")?, "world.visibleToCamera")?;

    // camera
    let c = object(&top["camera"], "camera")?;
    only(c, "camera", &["type", "near", "far", "sensorHeight"])?;
    let ctype = string(need(c, "camera", "type")?, "camera.type")?;
    let near = positive(need(c, "camera", "near")?, "camera.near")?;
    let far = positive(need(c, "camera", "far")?, "camera.far")?;
    let sensor_height = c.get("sensorHeight").map(|v| positive(v, "camera.sensorHeight")).transpose()?;
    if !["persp", "ortho"].contains(&ctype) {
        return Err(bad("camera.type", format!("{ctype:?} 不是 persp 或 ortho")));
    }
    if far <= near {
        return Err(bad("camera.far", format!("必须大于 near（{near}），现在是 {far}")));
    }

    // frames
    let f = object(&top["frames"], "frames")?;
    only(f, "frames", &["count", "instances", "camera", "lights", "materials"])?;
    let count = integer(need(f, "frames", "count")?, "frames.count", 1)? as usize;
    let frames_instances = table(need(f, "frames", "instances")?, "frames.instances")?;
    let frames_camera = table(need(f, "frames", "camera")?, "frames.camera")?;
    let frames_lights = table(need(f, "frames", "lights")?, "frames.lights")?;
    if let Some(t) = f.get("materials") {
        table(t, "frames.materials")?;
    }
    let fi = &frames_instances.fields;
    if fi.len() != 1 || fi[0] != "mat16" {
        return Err(bad("frames.instances.fields", "必须正好是 [\"mat16\"]"));
    }
    let fc = &frames_camera.fields;
    for (k, x) in fc.iter().enumerate() {
        if !["mat16", "fovY", "focusDist", "fstop"].contains(&x.as_str()) {
            return Err(bad(&idx("frames.camera.fields", k), format!("{x:?} 不是相机表的列")));
        }
    }
    for want in ["mat16", "fovY"] {
        if !fc.iter().any(|x| x == want) {
            return Err(bad("frames.camera.fields", format!("必须有 {want}")));
        }
    }
    let dof = fc.iter().any(|x| x == "focusDist");
    if dof != fc.iter().any(|x| x == "fstop") {
        return Err(bad("frames.camera.fields", "focusDist、fstop 要么都有，要么都没有"));
    }
    if dof && sensor_height.is_none() {
        return Err(bad("camera.sensorHeight", "相机表带 focusDist、fstop 两列时必填（SP16）"));
    }
    let fl = &frames_lights.fields;
    for (k, x) in fl.iter().enumerate() {
        if !["mat16", "watts"].contains(&x.as_str()) {
            return Err(bad(&idx("frames.lights.fields", k), format!("{x:?} 不是灯表的列")));
        }
    }
    if !fl.iter().any(|x| x == "mat16") {
        return Err(bad("frames.lights.fields", "必须有 mat16"));
    }
    let want: [(&Table, Vec<usize>, &str); 3] = [
        (&frames_instances, vec![count, n, frames_instances.width()], "frames.instances.shape"),
        (&frames_camera, vec![count, frames_camera.width()], "frames.camera.shape"),
        (&frames_lights, vec![count, lights.len(), frames_lights.width()], "frames.lights.shape"),
    ];
    for (t, w, at) in want {
        if t.shape != w {
            return Err(bad(at, format!("是 {:?}，照清单必须是 {w:?}（SP8）", t.shape)));
        }
    }

    // dynamic
    if let Some(d) = top.get("dynamic") {
        let a = array(d, "dynamic")?;
        if a.is_empty() {
            return Err(bad("dynamic", "至少要有 1 项"));
        }
        for (i, x) in a.iter().enumerate() {
            let at = idx("dynamic", i);
            let o = object(x, &at)?;
            only(o, &at, &["name", "files"])?;
            nonempty(need(o, &at, "name")?, &join(&at, "name"))?;
            nonempty(need(o, &at, "files")?, &join(&at, "files"))?;
        }
    }

    // source
    let s = object(&top["source"], "source")?;
    only(s, "source", &["exporter", "blender", "sha256"])?;
    let exporter = string(need(s, "source", "exporter")?, "source.exporter")?;
    nonempty(need(s, "source", "blender")?, "source.blender")?;
    let sha = string(need(s, "source", "sha256")?, "source.sha256")?;
    if exporter.split('@').count() != 2 || exporter.split('@').any(str::is_empty) {
        return Err(bad("source.exporter", format!("{exporter:?} 不合 <名字>@<版本> 的写法")));
    }
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)) {
        return Err(bad("source.sha256", "必须是 64 位小写十六进制"));
    }

    // ext
    if let Some(e) = top.get("ext") {
        for k in object(e, "ext")?.keys() {
            if !ext_key_ok(k) {
                return Err(bad(&join("ext", k), "ext 的键必须带点分前缀"));
            }
        }
    }

    // 结构都对了，才报装不了的东西
    if ctype == "ortho" {
        return Err(fail(UNSUPPORTED, "camera.type", "正交相机：契约里没有画面宽度的列，写不全，这个读入器不收"));
    }
    if top.contains_key("dynamic") {
        return Err(fail(UNSUPPORTED, "dynamic", "动态网格的文件写法契约还没定，这个读入器不收"));
    }
    if f.contains_key("materials") {
        return Err(fail(UNSUPPORTED, "frames.materials", "材质逐帧表的列词汇契约还没定，这个读入器不收"));
    }

    Ok(Pack {
        dir: PathBuf::new(),
        manifest: v.clone(),
        id: id.to_string(),
        meshes,
        geometry: vec![],
        zero_normals: 0,
        rows: vec![],
        names,
        class,
        materials,
        lights,
        world_color,
        world_visible,
        near,
        far,
        sensor_height,
        count,
        frames_instances,
        frames_camera,
        frames_lights,
    })
}

fn shape_of(v: &Value, at: &str, min: usize, max: usize) -> R<Vec<usize>> {
    let a = array(v, at)?;
    if a.len() < min || a.len() > max {
        return Err(bad(at, format!("必须是 {min} 到 {max} 个整数，现在有 {} 个", a.len())));
    }
    a.iter().enumerate().map(|(i, x)| integer(x, &idx(at, i), 0).map(|x| x as usize)).collect()
}

fn table(v: &Value, at: &str) -> R<Table> {
    let o = object(v, at)?;
    only(o, at, &["file", "shape", "fields"])?;
    let file = rel_path(need(o, at, "file")?, &join(at, "file"), ".f32")?;
    let shape = shape_of(need(o, at, "shape")?, &join(at, "shape"), 2, 3)?;
    let fa = array(need(o, at, "fields")?, &join(at, "fields"))?;
    if fa.is_empty() {
        return Err(bad(&join(at, "fields"), "至少要有 1 项"));
    }
    let fields = fa.iter().enumerate().map(|(i, x)| nonempty(x, &idx(&join(at, "fields"), i)).map(String::from)).collect::<R<Vec<_>>>()?;
    unique(fields.iter().enumerate().map(|(i, s)| (i, s.as_str())), &join(at, "fields"), "列")?;
    Ok(Table { file, shape, fields, data: vec![] })
}

fn params(v: &Value, at: &str, min_one: bool) -> R<Params> {
    let o = object(v, at)?;
    only(o, at, &["baseColor", "metallic", "roughness", "emissionColor", "emissionStrength"])?;
    if min_one && o.is_empty() {
        return Err(bad(at, "至少要有 1 个参数"));
    }
    Ok(Params {
        base_color: o.get("baseColor").map(|c| rgb(c, &join(at, "baseColor"), true)).transpose()?,
        metallic: o.get("metallic").map(|x| unit(x, &join(at, "metallic"))).transpose()?,
        roughness: o.get("roughness").map(|x| unit(x, &join(at, "roughness"))).transpose()?,
        emission_color: o.get("emissionColor").map(|c| rgb(c, &join(at, "emissionColor"), false)).transpose()?,
        emission_strength: o.get("emissionStrength").map(|x| non_negative(x, &join(at, "emissionStrength"))).transpose()?,
    })
}

fn value_name(v: &Value, at: &str) -> R<String> {
    let s = string(v, at)?;
    if !value_name_ok(s) {
        return Err(bad(at, format!("{s:?} 不是值名（小写字母开头的字母和数字）")));
    }
    Ok(s.to_string())
}

fn material(v: &Value, at: &str) -> R<Material> {
    let o = object(v, at)?;
    only(o, at, &["name", "closure", "params", "pattern"])?;
    let name = nonempty(need(o, at, "name")?, &join(at, "name"))?.to_string();
    let closure = string(need(o, at, "closure")?, &join(at, "closure"))?;
    if !["surface", "toon", "emission", "transparent"].contains(&closure) {
        return Err(bad(&join(at, "closure"), format!("{closure:?} 不是 surface、toon、emission、transparent")));
    }
    let p = params(need(o, at, "params")?, &join(at, "params"), false)?;
    if closure == "surface" {
        for (k, has) in [("baseColor", p.base_color.is_some()), ("metallic", p.metallic.is_some()), ("roughness", p.roughness.is_some())] {
            if !has {
                return Err(bad(&join(&join(at, "params"), k), "缺必填字段（surface 闭包三个参数都必填）"));
            }
        }
    }
    let mut pattern = vec![];
    if let Some(pv) = o.get("pattern") {
        let pat = join(at, "pattern");
        let a = array(pv, &pat)?;
        if a.is_empty() {
            return Err(bad(&pat, "至少要有 1 项"));
        }
        let mut outs: Vec<String> = vec![];
        for (j, n) in a.iter().enumerate() {
            let nat = idx(&pat, j);
            let node = pattern_node(n, &nat)?;
            // SP13：in、by 必须是前面某个节点的 out
            let (refkey, refname) = match &node {
                Node::Smoothstep { input, .. } => ("in", Some(input)),
                Node::Mix { by, .. } => ("by", Some(by)),
                _ => ("", None),
            };
            if let Some(r) = refname {
                if !outs.contains(r) {
                    return Err(bad(&join(&nat, refkey), format!("{r:?} 前面没有节点的 out 叫这个名字（SP13）")));
                }
            }
            let out = match &node {
                Node::Bevel { .. } => Some("normal".to_string()),
                Node::Ao { out, .. } | Node::Smoothstep { out, .. } => Some(out.clone()),
                Node::Mix { .. } => None,
            };
            if let Some(out) = out {
                if outs.contains(&out) {
                    return Err(bad(&join(&nat, "out"), format!("{out:?} 在这个材质里重复了")));
                }
                outs.push(out);
            }
            pattern.push(node);
        }
    }
    if closure != "surface" {
        return Err(fail(UNSUPPORTED, &join(at, "closure"), format!("材质 {name} 的闭包 {closure}：契约还没登记它的参数，这个读入器不收")));
    }
    Ok(Material { name, params: p, pattern })
}

fn pattern_node(v: &Value, at: &str) -> R<Node> {
    let o = object(v, at)?;
    let node = nonempty(need(o, at, "node")?, &join(at, "node"))?;
    let f = |k: &str| join(at, k);
    Ok(match node {
        "bevel" => {
            only(o, at, &["node", "radius", "samples", "out"])?;
            let radius = positive(need(o, at, "radius")?, &f("radius"))?;
            let samples = integer(need(o, at, "samples")?, &f("samples"), 1)?;
            if string(need(o, at, "out")?, &f("out"))? != "normal" {
                return Err(bad(&f("out"), "bevel 的 out 只能是 \"normal\""));
            }
            Node::Bevel { radius, samples }
        }
        "ao" => {
            only(o, at, &["node", "distance", "samples", "onlyLocal", "out"])?;
            let distance = positive(need(o, at, "distance")?, &f("distance"))?;
            let samples = integer(need(o, at, "samples")?, &f("samples"), 1)?;
            let only_local = boolean(need(o, at, "onlyLocal")?, &f("onlyLocal"))?;
            let out = non_normal(need(o, at, "out")?, &f("out"))?;
            Node::Ao { distance, samples, only_local, out }
        }
        "smoothstep" => {
            only(o, at, &["node", "in", "edges", "out"])?;
            let input = value_name(need(o, at, "in")?, &f("in"))?;
            let edges = numbers::<2>(need(o, at, "edges")?, &f("edges"))?;
            let out = non_normal(need(o, at, "out")?, &f("out"))?;
            if edges[0] >= edges[1] {
                return Err(bad(&f("edges"), format!("必须 e0 < e1，现在是 {edges:?}")));
            }
            Node::Smoothstep { input, edges, out }
        }
        "mix" => {
            only(o, at, &["node", "by", "set"])?;
            let by = value_name(need(o, at, "by")?, &f("by"))?;
            let set = params(need(o, at, "set")?, &f("set"), true)?;
            Node::Mix { by, set }
        }
        other => return Err(fail(UNKNOWN_NODE, &f("node"), format!("图案节点 {other:?} 不在节点登记表里（bevel、ao、smoothstep、mix）"))),
    })
}

fn non_normal(v: &Value, at: &str) -> R<String> {
    let s = value_name(v, at)?;
    if s == "normal" {
        return Err(bad(at, "\"normal\" 只能当 bevel 的 out"));
    }
    Ok(s)
}

fn light(v: &Value, at: &str, names: &[String]) -> R<Light> {
    let o = object(v, at)?;
    only(o, at, &["name", "type", "size", "watts", "dir", "irradiance", "color", "visibleToCamera", "link", "group"])?;
    let name = nonempty(need(o, at, "name")?, &join(at, "name"))?.to_string();
    let ty = string(need(o, at, "type")?, &join(at, "type"))?;
    let color = rgb(need(o, at, "color")?, &join(at, "color"), false)?;
    let visible = boolean(need(o, at, "visibleToCamera")?, &join(at, "visibleToCamera"))?;
    let forbid = |k: &str| if o.contains_key(k) { Err(bad(&join(at, k), format!("{ty} 灯不得有 {k}"))) } else { Ok(()) };
    let kind = match ty {
        "area-rect" => {
            let s = numbers::<2>(need(o, at, "size")?, &join(at, "size"))?;
            if s[0] <= 0.0 || s[1] <= 0.0 {
                return Err(bad(&join(at, "size"), format!("宽和高都必须大于 0，现在是 {s:?}")));
            }
            let watts = non_negative(need(o, at, "watts")?, &join(at, "watts"))?;
            forbid("dir")?;
            forbid("irradiance")?;
            LightKind::Rect { size: s, watts }
        }
        "point" => {
            let watts = non_negative(need(o, at, "watts")?, &join(at, "watts"))?;
            forbid("size")?;
            forbid("dir")?;
            forbid("irradiance")?;
            LightKind::Point { watts }
        }
        "sun" => {
            let dir = numbers::<3>(need(o, at, "dir")?, &join(at, "dir"))?;
            let irradiance = non_negative(need(o, at, "irradiance")?, &join(at, "irradiance"))?;
            forbid("size")?;
            forbid("watts")?;
            let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
            if (len - 1.0).abs() > 1e-6 {
                return Err(bad(&join(at, "dir"), format!("必须是单位向量，长度现在是 {len}")));
            }
            LightKind::Sun { dir, irradiance }
        }
        other => return Err(bad(&join(at, "type"), format!("{other:?} 不是 area-rect、point、sun"))),
    };
    let link = match o.get("link") {
        None => None,
        Some(l) => {
            let la = join(at, "link");
            let a = array(l, &la)?;
            if a.is_empty() {
                return Err(bad(&la, "至少要有 1 项"));
            }
            let mut out = vec![];
            for (k, x) in a.iter().enumerate() {
                let s = nonempty(x, &idx(&la, k))?;
                if !link_ok(s) {
                    return Err(bad(&idx(&la, k), format!("{s:?} 不是合法的实体名或带通配的实体名（SP19）")));
                }
                if !names.iter().any(|n| link_matches(s, n)) {
                    return Err(bad(&idx(&la, k), format!("{s:?} 一个实体名都配不到（SP12）")));
                }
                out.push(s.to_string());
            }
            Some(out)
        }
    };
    let group = match o.get("group") {
        Some(g) => {
            let g = string(g, &join(at, "group"))?;
            if !group_ok(g) {
                return Err(bad(&join(at, "group"), format!("{g:?} 不合分灯组名的写法")));
            }
            g.to_string()
        }
        None => {
            if !group_ok(&name) {
                return Err(bad(&join(at, "name"), format!("没写 group 时组名就是灯名，{name:?} 不合分灯组名的写法")));
            }
            name.clone()
        }
    };
    Ok(Light { name, kind, color, visible, link, group })
}

// ------------------------------------------------------------------------------------------ 文件

/// pack.json 的上限。
const MANIFEST_MAX: u64 = 64 << 20;

/// 包里的文件：路径要落在包目录里（按真实路径比，符号链接指出去的不收），字节数等于 `want`（给了的话）。
fn read_file(dir: &Path, rel: &str, at: &str, want: Option<u64>) -> R<Vec<u8>> {
    let root = dir.canonicalize().map_err(|e| bad("", format!("包目录打不开：{e}")))?;
    let p = root.join(rel).canonicalize().map_err(|e| bad(at, format!("{rel} 打不开：{e}")))?;
    if !p.starts_with(&root) || !p.is_file() {
        return Err(bad(at, format!("{rel} 不是包目录里的文件")));
    }
    let len = std::fs::metadata(&p).map_err(|e| bad(at, format!("{rel}：{e}")))?.len();
    if let Some(w) = want {
        if len != w {
            return Err(bad(at, format!("{rel} 是 {len} 字节，照 shape 必须是 {w} 字节（SP8）")));
        }
    }
    if len > FILE_MAX {
        return Err(bad(at, format!("{rel} 是 {len} 字节，超过单个文件的上限 {FILE_MAX}")));
    }
    std::fs::read(&p).map_err(|e| bad(at, format!("{rel} 读不出来：{e}")))
}

/// 单个文件（几何、任一张每帧状态表）与三张每帧状态表合计的字节上限。读入器把文件整个读进内存（表还要再解成 f32），
/// 不设上限的话，一个只声明了大 shape 的清单、或磁盘上几乎不占地方的稀疏文件，就能让进程占掉几 GB 内存。上限在读之前查。
/// 取值对现实场景宽裕：1 GiB 的实例表够一万个实例跑一千六百多帧（每帧每行 64 字节），1 GiB 的 GLB 是千万量级的三角形。
const FILE_MAX: u64 = 1 << 30;
const TABLES_MAX: u64 = 2 << 30;

fn bytes_of(shape: &[usize], at: &str) -> R<u64> {
    shape.iter().try_fold(4u64, |a, &x| a.checked_mul(x as u64)).ok_or_else(|| bad(at, "shape 各项之积太大"))
}

/// 三张每帧状态表照 shape 的字节数（实例、相机、灯）；单张超过 `file_max` 或累计超过 `total_max` 时报在那张表的 shape 上。
fn table_bytes(p: &Pack, file_max: u64, total_max: u64) -> R<[u64; 3]> {
    let mut out = [0; 3];
    let mut total = 0;
    for (k, (t, at)) in [(&p.frames_instances, "frames.instances.shape"), (&p.frames_camera, "frames.camera.shape"), (&p.frames_lights, "frames.lights.shape")].into_iter().enumerate() {
        let b = bytes_of(&t.shape, at)?;
        if b > file_max {
            return Err(bad(at, format!("照 shape 是 {b} 字节，超过单个文件的上限 {file_max}")));
        }
        total += b;
        if total > total_max {
            return Err(bad(at, format!("三张每帧状态表照 shape 合计到这张已是 {total} 字节，超过上限 {total_max}")));
        }
        out[k] = b;
    }
    Ok(out)
}

/// 读一个场景包目录：清单、几何、实例表、三张每帧状态表，全部校验。
pub fn load(dir: &Path) -> R<Pack> {
    let root = dir.canonicalize().map_err(|e| bad("", format!("包目录 {} 打不开：{e}", dir.display())))?;
    let mp = root.join("pack.json");
    let len = std::fs::metadata(&mp).map_err(|e| bad("pack.json", format!("包目录里没有 pack.json：{e}")))?.len();
    if len > MANIFEST_MAX {
        return Err(bad("pack.json", format!("{len} 字节，超过上限 {MANIFEST_MAX}")));
    }
    let text = std::fs::read(&mp).map_err(|e| bad("pack.json", format!("读不出来：{e}")))?;
    let v: Value = serde_json::from_slice(&text).map_err(|e| bad("pack.json", format!("不是合法的 JSON：{e}")))?;
    let mut p = parse_manifest(&v)?;
    p.dir = root.clone();
    let m = &v;

    // 实例表
    let n = p.names.len();
    let ifile = m["instances"]["file"].as_str().unwrap_or_default().to_string();
    let raw = read_file(&root, &ifile, "instances.file", Some(n as u64 * 16))?;
    p.rows = raw.chunks_exact(16).map(|c| [0, 1, 2, 3].map(|k| u32::from_le_bytes([c[k * 4], c[k * 4 + 1], c[k * 4 + 2], c[k * 4 + 3]]))).collect();
    let mut name_of: HashMap<u32, &str> = HashMap::new();
    let mut id_of: HashMap<&str, u32> = HashMap::new();
    for (i, r) in p.rows.iter().enumerate() {
        let at = format!("{ifile} 第 {i} 行");
        if r[0] as usize >= p.meshes.len() {
            return Err(bad("instances.file", format!("{at}：网格下标 {} 不小于网格数 {}（SP9）", r[0], p.meshes.len())));
        }
        if r[1] as usize >= p.materials.len() {
            return Err(bad("instances.file", format!("{at}：材质下标 {} 不小于材质数 {}（SP9）", r[1], p.materials.len())));
        }
        if r[2] < 1 {
            return Err(bad("instances.file", format!("{at}：实体编号是 0，必须不小于 1（SP9）")));
        }
        if r[3] > 1 {
            return Err(bad("instances.file", format!("{at}：第四列是 {}，必须是 0 或 1（SP9）", r[3])));
        }
        if r[2] >= 1 << 24 {
            return Err(fail(UNSUPPORTED, "instances.file", format!("{at}：实体编号 {} 不小于 2^24，内核的物体扩展表按浮点存，装不下", r[2])));
        }
        let nm = p.names[i].as_str();
        if *name_of.entry(r[2]).or_insert(nm) != nm || *id_of.entry(nm).or_insert(r[2]) != r[2] {
            return Err(bad("instances.file", format!("{at}：实体编号 {} 与实体名 {nm} 不是一一对应（SP10）", r[2])));
        }
    }

    // 每帧状态表
    let sizes = table_bytes(&p, FILE_MAX, TABLES_MAX)?;
    for (key, at, want) in [("instances", "frames.instances", sizes[0]), ("camera", "frames.camera", sizes[1]), ("lights", "frames.lights", sizes[2])] {
        let t = match key {
            "instances" => &mut p.frames_instances,
            "camera" => &mut p.frames_camera,
            _ => &mut p.frames_lights,
        };
        let raw = read_file(&root, &t.file.clone(), &join(at, "file"), Some(want))?;
        t.data = raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        if let Some(k) = t.data.iter().position(|x| !x.is_finite()) {
            return Err(bad(&join(at, "file"), format!("{} 的第 {k} 个数是 {}，表里不得有 NaN 与无穷", t.file, t.data[k])));
        }
    }
    check_tables(&p)?;

    // 几何
    let gfile = m["geometry"]["file"].as_str().unwrap_or_default().to_string();
    let glb = read_file(&root, &gfile, "geometry.file", None)?;
    let (geometry, zero) = read_glb(&glb, &p.meshes)?;
    p.geometry = geometry;
    p.zero_normals = zero;
    Ok(p)
}

/// 每帧状态表的值域：矩阵的第 4、8、12 个数是 0、第 16 个是 1，fovY 在 (0, π)，focusDist、fstop 大于 0，watts 不小于 0；
/// 镜像标记与行列式的符号一致（SP3，行列式为 0 的不判）。sun 在灯表里那一行读入方不读，也不判。
fn check_tables(p: &Pack) -> R<()> {
    let mat_ok = |m: &[f32]| m[3] == 0.0 && m[7] == 0.0 && m[11] == 0.0 && m[15] == 1.0;
    for k in 0..p.count {
        for (i, r) in p.rows.iter().enumerate() {
            let m = p.frames_instances.row(k, i);
            if !mat_ok(m) {
                return Err(bad("frames.instances.file", format!("第 {k} 帧第 {i} 行的 mat16 第 4、8、12 个数必须是 0、第 16 个是 1")));
            }
            let d = det3(m);
            if (d < 0.0 && r[3] != 1) || (d > 0.0 && r[3] != 0) {
                return Err(bad("instances.file", format!("第 {k} 帧实例表第 {i} 行的行列式是 {d}，第四列是 {}（SP3）", r[3])));
            }
        }
        let c = p.frames_camera.row(k, 0);
        let t = &p.frames_camera;
        if !mat_ok(t.field(c, "mat16").unwrap_or(&[0.0; 16])) {
            return Err(bad("frames.camera.file", format!("第 {k} 帧的 mat16 第 4、8、12 个数必须是 0、第 16 个是 1")));
        }
        let fov = t.field(c, "fovY").map_or(0.0, |x| x[0]);
        if !(fov > 0.0 && (fov as f64) < std::f64::consts::PI) {
            return Err(bad("frames.camera.file", format!("第 {k} 帧的 fovY 是 {fov}，必须在 (0, π) 里")));
        }
        for col in ["focusDist", "fstop"] {
            if let Some(x) = t.field(c, col) {
                if x[0] <= 0.0 {
                    return Err(bad("frames.camera.file", format!("第 {k} 帧的 {col} 是 {}，必须大于 0", x[0])));
                }
            }
        }
        for (j, l) in p.lights.iter().enumerate() {
            if matches!(l.kind, LightKind::Sun { .. }) {
                continue;
            }
            let t = &p.frames_lights;
            let row = t.row(k, j);
            if !mat_ok(t.field(row, "mat16").unwrap_or(&[0.0; 16])) {
                return Err(bad("frames.lights.file", format!("第 {k} 帧灯 {} 的 mat16 第 4、8、12 个数必须是 0、第 16 个是 1", l.name)));
            }
            if let Some(w) = t.field(row, "watts") {
                if w[0] < 0.0 {
                    return Err(bad("frames.lights.file", format!("第 {k} 帧灯 {} 的 watts 是 {}，不能小于 0", l.name, w[0])));
                }
            }
        }
    }
    Ok(())
}

/// 契约 5.4 的左上 3×3 行列式：表里的 32 位浮点原样拿来按双精度算。
pub fn det3(m: &[f32]) -> f64 {
    let m: Vec<f64> = m.iter().map(|x| *x as f64).collect();
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])
}

/// 一个访问器的数：只认 GLB 自带的二进制块，每一个读取都先查边界。
fn accessor_values(a: &gltf::Accessor, blob: &[u8], at: &str, what: &str, comps: usize, float: bool) -> R<Vec<f64>> {
    use gltf::accessor::{DataType, Dimensions};
    let dims_ok = matches!((comps, a.dimensions()), (3, Dimensions::Vec3) | (1, Dimensions::Scalar));
    let size = match (a.data_type(), float) {
        (DataType::F32, true) => 4,
        (DataType::U32, false) => 4,
        (DataType::U16, false) => 2,
        (DataType::U8, false) => 1,
        _ => 0,
    };
    if !dims_ok || size == 0 || a.normalized() || a.sparse().is_some() {
        return Err(bad(at, format!("{what} 的访问器类型不对（要 {}，不许归一化与稀疏存储）", if float { "VEC3 的 32 位浮点" } else { "无符号整数的标量" })));
    }
    let view = a.view().ok_or_else(|| bad(at, format!("{what} 的访问器没有缓冲视图")))?;
    if !matches!(view.buffer().source(), gltf::buffer::Source::Bin) {
        return Err(bad(at, format!("{what} 不在 GLB 的二进制块里（只认自带的二进制块）")));
    }
    let elem = size * comps;
    let stride = view.stride().unwrap_or(elem);
    let end = view.offset().checked_add(view.length()).filter(|e| *e <= blob.len()).ok_or_else(|| bad(at, format!("{what} 的缓冲视图越出了二进制块")))?;
    let count = a.count();
    let start = view.offset().checked_add(a.offset()).ok_or_else(|| bad(at, "偏移太大"))?;
    // 每一步都 checked：坏文件的 byteOffset 可以接近 2^64，普通加法会回绕成小数骗过检查
    let last = count.checked_sub(1).and_then(|c| c.checked_mul(stride)).and_then(|x| x.checked_add(elem)).and_then(|x| x.checked_add(start));
    if stride < elem || (count > 0 && last.is_none_or(|last| last > end)) {
        return Err(bad(at, format!("{what} 的访问器越出了它的缓冲视图")));
    }
    let mut out = Vec::with_capacity(count * comps);
    for i in 0..count {
        for c in 0..comps {
            let o = start + i * stride + c * size;
            let b = o.checked_add(size).and_then(|e| blob.get(o..e)).ok_or_else(|| bad(at, format!("{what} 的访问器越出了二进制块")))?;
            out.push(match (size, float) {
                (4, true) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
                (4, false) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
                (2, _) => u16::from_le_bytes([b[0], b[1]]) as f64,
                _ => b[0] as f64,
            });
        }
    }
    Ok(out)
}

/// 读 GLB：清单里每个网格是文件里一个同名网格、只有一个三角形图元，带 POSITION 与 NORMAL；三角形数与清单相等。
/// 文件里不得有蒙皮、动画、变形目标（SP1）。返回每个网格的几何，与长度为 0 的每角法线的个数（按角数）。
pub fn read_glb(bytes: &[u8], meshes: &[Mesh]) -> R<(Vec<world::Geometry>, usize)> {
    let at = "geometry.file";
    let g = gltf::Gltf::from_slice(bytes).map_err(|e| bad(at, format!("不是合法的 GLB：{e}")))?;
    let blob = g.blob.as_deref().ok_or_else(|| bad(at, "GLB 没有二进制块"))?;
    let doc = &g.document;
    if doc.skins().count() > 0 || doc.animations().count() > 0 {
        return Err(bad(at, format!("几何文件带了 {} 个蒙皮、{} 个动画，必须都是 0（SP1）", doc.skins().count(), doc.animations().count())));
    }
    let mut out = vec![];
    let mut zero = 0;
    for (i, m) in meshes.iter().enumerate() {
        let mat = idx("geometry.meshes", i);
        let found: Vec<gltf::Mesh> = doc.meshes().filter(|x| x.name() == Some(m.name.as_str())).collect();
        if found.len() != 1 {
            return Err(bad(&join(&mat, "name"), format!("几何文件里名叫 {} 的网格有 {} 个，必须正好 1 个", m.name, found.len())));
        }
        let prims: Vec<gltf::Primitive> = found[0].primitives().collect();
        if prims.len() != 1 || prims[0].mode() != gltf::mesh::Mode::Triangles {
            return Err(bad(&mat, format!("网格 {} 必须正好一个三角形图元（现在 {} 个图元）", m.name, prims.len())));
        }
        let pr = &prims[0];
        if pr.morph_targets().count() > 0 {
            return Err(bad(&mat, format!("网格 {} 带变形目标（SP1）", m.name)));
        }
        let pos_a = pr.get(&gltf::Semantic::Positions).ok_or_else(|| bad(&mat, format!("网格 {} 没有 POSITION", m.name)))?;
        let nrm_a = pr.get(&gltf::Semantic::Normals).ok_or_else(|| bad(&mat, format!("网格 {} 没有 NORMAL", m.name)))?;
        let pos = accessor_values(&pos_a, blob, &mat, "POSITION", 3, true)?;
        let nrm = accessor_values(&nrm_a, blob, &mat, "NORMAL", 3, true)?;
        let n = pos.len() / 3;
        if nrm.len() != pos.len() {
            return Err(bad(&mat, format!("网格 {} 的 NORMAL 有 {} 个、POSITION 有 {n} 个", m.name, nrm.len() / 3)));
        }
        let indices: Vec<u32> = match pr.indices() {
            Some(ia) => accessor_values(&ia, blob, &mat, "下标", 1, false)?.into_iter().map(|x| x as u32).collect(),
            None => (0..n as u32).collect(),
        };
        if indices.len() % 3 != 0 {
            return Err(bad(&mat, format!("网格 {} 的下标个数 {} 不是 3 的倍数", m.name, indices.len())));
        }
        if let Some(k) = indices.iter().find(|&&k| k as usize >= n) {
            return Err(bad(&mat, format!("网格 {} 的下标 {k} 越界（只有 {n} 个顶点）", m.name)));
        }
        if pos.iter().chain(&nrm).any(|x| !x.is_finite()) {
            return Err(bad(&mat, format!("网格 {} 的顶点里有 NaN 或无穷", m.name)));
        }
        let tris = indices.len() / 3;
        if tris != m.tris {
            return Err(bad(&join(&mat, "tris"), format!("清单写 {} 个三角形，几何文件里的网格 {} 是 {tris} 个", m.tris, m.name)));
        }
        let normals: Vec<f32> = nrm.iter().map(|x| *x as f32).collect();
        zero += indices.iter().filter(|&&k| normals[k as usize * 3..k as usize * 3 + 3] == [0.0; 3]).count();
        out.push(world::Geometry { positions: pos.iter().map(|x| *x as f32).collect(), normals, uvs: vec![0.0; n * 2], indices, groups: vec![], colors: vec![] });
    }
    Ok((out, zero))
}

// ------------------------------------------------------------------------------------------ 建 World

/// 一盏灯在第 `k` 帧换成内核的灯描述。功率照 Cycles 的口径换（`size`、`watts` 照契约：瓦，场景线性；Cycles 的灯强度是
/// 功率乘灯色，再乘下面的 eval_fac 就是它渲染时用的量）。行号是 Blender v5.2.3 的 intern/cycles/ 下的：
/// - 矩形面光：辐亮度 L = P / (π·宽·高)。scene/light.cpp:224 面积是宽乘高（`AreaLight::area`），:238 `invarea = 1 / area`
///   （normalize 默认开），kernel/light/area.h:313 `eval_fac = M_1_PI_F * invarea`。内核的矩形纯光收的就是辐亮度
///   （light.wgsl 的 `bm_rect_le` 一段：在里面乘回 π·面积，area_light.wgsl 再乘 1 / (π·面积)），与第 2 级对过解析值的
///   那条换算是同一个式子。
/// - 点光（半径 0）：辐射强度 I = P / (4π)。scene/light.cpp:135 半径 0 时 `PointLight::area` 取 4，:142 `invarea = 1 / area`，
///   :145 `eval_fac = invarea * M_1_PI_F`，即 1 / (4π)；kernel/light/point.h:32 取用它。内核的点光收的是辐射强度（按 1 / d² 衰减）。
/// - 平行光（夹角 0）：辐照度 E 原样。scene/light.cpp:298 夹角 0 时 `SunLight::area` 取 1，:316 `eval_fac = 1 / area`，即 1；
///   kernel/light/sun.h:46 取用它。内核的平行光收的是垂直于光线的面上的辐照度。
/// 包里没有的几样照 Blender 的默认取：normalize 开、面光不聚拢（spread 180°）、点光半径 0、平行光夹角 0。
/// 上面的式子有前提：Blender 一侧同步给 Cycles 的 strength = 灯色 × energy × 2^exposure（开色温时还乘色温色），所以这里
/// 假定灯的曝光为 0、不开色温、normalize 开、面光是矩形（不是圆、椭圆）、灯矩阵不带缩放（Cycles 的面积会乘缩放）。
/// 这些前提由导出器保证，读入器不查。
/// 平行光的张角（全角，度）：场景包契约没有这个字段，取 Blender 新建灯的默认值（DNA_light_types.h 的 `sun_angle = DEG2RADF(0.526f)`）。
pub const SUN_ANGLE_DEG: f32 = 0.526;

pub fn kernel_light(l: &Light, watts: f64) -> desc::Light {
    let color = l.color.map(|c| c as f32);
    match l.kind {
        LightKind::Rect { size, .. } => desc::Light::Rect {
            color,
            cast_shadow: true,
            intensity: (watts / (std::f64::consts::PI * size[0] * size[1])) as f32,
            width: size[0] as f32,
            height: size[1] as f32,
            range: 0.0,
            barn_door_angle: 90.0,
            volumetric_scattering: 1.0,
            specular_scale: 1.0,
            visible: l.visible,
        },
        LightKind::Point { .. } => desc::Light::Point { color, cast_shadow: true, intensity: (watts / (4.0 * std::f64::consts::PI)) as f32, radius: 0.0, range: 0.0, volumetric_scattering: 1.0, specular_scale: 1.0 },
        LightKind::Sun { irradiance, .. } => desc::Light::Directional { color, cast_shadow: true, intensity: irradiance as f32, angular_diameter: SUN_ANGLE_DEG, volumetric_scattering: 1.0, specular_scale: 1.0 },
    }
}

/// 灯光链接的接收者集合号只到这个数（灯记录的成员掩码是 32 位；Cycles 到 63）。
pub const MAX_RECEIVER_SET: u32 = 31;
/// 物体的阴影终止几何偏移：Blender 新建物体的默认值（scene/object.cpp:91-92；标准答案机没改这项设置）。
pub const SHADOW_TERMINATOR_GEOMETRY_OFFSET: f32 = 0.1;

/// 灯光链接照 Blender 的建法（source/blender/depsgraph/intern/depsgraph_light_linking.cc 的 `LinkingData::link_object`、
/// `end_build`、`EmitterSetMembership::get_mask`）落成的两样：每一行实例的接收者集合号，与每盏灯的成员掩码。
pub struct LightLinks {
    /// 按实例行：接收者集合号，0 是不在任何灯的链接名单里（Blender 的 `LightSet::DEFAULT_ID`）。
    pub receiver_set: Vec<u32>,
    /// 按灯：第 s 位是 1，集合号为 s 的接收者受它照。没写链接的灯全 1（`LIGHT_LINK_MASK_ALL`）。
    pub membership: Vec<u32>,
}

impl Pack {
    /// 分灯组：组名按它在灯清单里第一次出现的次序，下标就是灯组槽位（输出通道 `lightgroup:<名>` 也按这个次序）。
    pub fn lightgroups(&self) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        for l in &self.lights {
            if !out.contains(&l.group) {
                out.push(l.group.clone());
            }
        }
        out
    }
    /// 第 `j` 盏灯的灯组槽位。
    pub fn lightgroup_slot(&self, j: usize) -> u32 {
        self.lightgroups().iter().position(|g| *g == self.lights[j].group).unwrap_or(scene::LIGHTGROUP_SLOT_NONE as usize) as u32
    }
    /// 灯光链接。每盏写了链接的灯是一个「链接集合」（它名单里的实体）；一行实例的集合是「把它列进名单的那些灯」（只有包含，
    /// 没有排除），相同的集合合成一个号，从 1 起按实例行的次序编；灯的成员掩码是名单里有它的那些集合号（一个都没有时视为全部，
    /// Blender 的 `get_mask`）。集合号超过 `MAX_RECEIVER_SET` 报 `contract.unsupported-input`。
    pub fn light_links(&self) -> std::result::Result<LightLinks, PackError> {
        let linked: Vec<usize> = (0..self.lights.len()).filter(|&j| self.lights[j].link.is_some()).collect();
        let mut sets: Vec<u64> = vec![];
        let mut receiver_set = vec![0u32; self.rows.len()];
        for (i, name) in self.names.iter().enumerate().take(self.rows.len()) {
            let mut include = 0u64;
            for (k, &j) in linked.iter().enumerate() {
                if self.lights[j].link.as_ref().is_some_and(|ls| ls.iter().any(|pat| link_matches(pat, name))) {
                    include |= 1 << k;
                }
            }
            if include == 0 {
                continue;
            }
            let id = match sets.iter().position(|s| *s == include) {
                Some(at) => at + 1,
                None => {
                    sets.push(include);
                    sets.len()
                }
            };
            if id as u32 > MAX_RECEIVER_SET {
                return Err(fail(UNSUPPORTED, "lights", format!("灯光链接要 {id} 个接收者集合，内核的成员掩码只有 32 位（集合号到 {MAX_RECEIVER_SET}）")));
            }
            receiver_set[i] = id as u32;
        }
        let membership = (0..self.lights.len())
            .map(|j| match linked.iter().position(|&x| x == j) {
                None => u32::MAX,
                Some(k) => {
                    let m = sets.iter().enumerate().filter(|(_, s)| *s >> k & 1 == 1).fold(0u32, |m, (at, _)| m | 1 << (at + 1));
                    if m == 0 { u32::MAX } else { m }
                }
            })
            .collect();
        Ok(LightLinks { receiver_set, membership })
    }
    /// 第 `k` 帧这盏灯的功率：灯表有 watts 列取表里的，没有取清单里的（契约 5.5）。
    pub fn watts(&self, k: usize, j: usize) -> f64 {
        let t = &self.frames_lights;
        match (t.field(t.row(k, j), "watts"), &self.lights[j].kind) {
            (Some(w), _) => w[0] as f64,
            (None, LightKind::Rect { watts, .. } | LightKind::Point { watts }) => *watts,
            (None, LightKind::Sun { .. }) => 0.0,
        }
    }
    pub fn instance_matrix(&self, k: usize, i: usize) -> Mat4 {
        Mat4::from_cols_slice(self.frames_instances.row(k, i))
    }
    fn camera_matrix(&self, k: usize) -> Mat4 {
        let t = &self.frames_camera;
        Mat4::from_cols_slice(t.field(t.row(k, 0), "mat16").unwrap_or(&[0.0; 16]))
    }
    fn light_matrix(&self, k: usize, j: usize) -> Mat4 {
        let t = &self.frames_lights;
        Mat4::from_cols_slice(t.field(t.row(k, j), "mat16").unwrap_or(&[0.0; 16]))
    }
    /// 第 `k` 帧的相机描述（fovY 弧度换成度；有景深时 sensor_width 按画面宽高比从 sensorHeight 换，见 `sensor_width_mm`）。
    pub fn camera_desc(&self, k: usize, aspect: f64) -> desc::Camera {
        let t = &self.frames_camera;
        let row = t.row(k, 0);
        let fov = t.field(row, "fovY").map_or(1.0, |x| x[0]);
        let dof = match (t.field(row, "focusDist"), t.field(row, "fstop"), self.sensor_height) {
            (Some(fd), Some(fs), Some(sh)) => Some(desc::Dof { focus_distance: fd[0], f_stop: fs[0], sensor_width: sensor_width_mm(sh, aspect) }),
            _ => None,
        };
        desc::Camera { fov: fov.to_degrees(), near: self.near as f32, far: self.far as f32, exposure: desc::Exposure::Manual { ev100: 0.0 }, dof }
    }
}

/// 契约 5.11 的孔径直径是 sensorHeight ÷ (2 tan(fovY / 2)) ÷ fstop（米）；内核（lib.rs 的 `prepare_as`）从毫米的传感器宽度、
/// 按画面宽高比反推传感器高度，算出半径 0.5 · 焦距 ÷ fstop。两边一致要 sensor_width = sensorHeight × 1000 × 宽高比。
pub fn sensor_width_mm(sensor_height_m: f64, aspect: f64) -> f32 {
    (sensor_height_m * 1000.0 * aspect) as f32
}

/// 实例表一行在内核里落到了哪：物体表的下标、这一帧画不画、画出来的三角形数（几何文件里这个网格实际读到的三角形数，不画是 0），和用来查法线的那个三角形。
#[derive(Clone, Debug)]
pub struct Placed {
    pub row: usize,
    pub object: Option<u32>,
    pub drawn: bool,
    pub triangles: usize,
    /// (网格里的三角形下标, 由顶点直接叉乘出的方向 raw, 内核平铺后实际用的几何法线 used)，都是世界坐标。
    pub probe: Option<(usize, [f64; 3], [f64; 3])>,
}

pub struct Built {
    pub scene: scene::Scene,
    pub placed: Vec<Placed>,
}

const ROW_ID: u32 = 1;

fn row_id(i: usize) -> u32 {
    ROW_ID + i as u32
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn tri_normal(p: [[f64; 3]; 3]) -> [f64; 3] {
    let s = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    cross(s(p[1], p[0]), s(p[2], p[0]))
}

/// 第 `k` 帧建成内核的 `World`。网格、材质、每行实例（一行一个 `Instanced` 物体，矩阵原样进实例表，不经平移-旋转-缩放
/// 分解）、灯、相机、背景。缩放全为 0 的那一行这一帧不建。灯与相机的物体变换由矩阵分解得来，`build` 之后再按原样的
/// 矩阵重算一次（矩形纯光、点光、平行光、相机）；只有相机看得见的矩形灯（发光卡片）用分解过的变换。
/// 法线照 Cycles 的存储精度过一遍（`crate::packed_normal`）。关掉只给负对照用
pub const CYCLES_NORMAL_PACKING: bool = true;

/// 第 `k` 帧给内核的几何：法线照 Cycles 过一遍存储精度。每个顶点法线编成 `packed_normal` 的码（blender/mesh.cpp:672、:765）；
/// 只被一行实例用的网格（Cycles 的 `apply_static_transforms`，scene/object.cpp:1172-1238：几何只有一个使用者、没有次表面、
/// 没有真位移、不细分、不开运动模糊，场景包都满足；变换是恒等时 Object::apply_transform 直接返回）再照 `Mesh::apply_transform`
/// 把码烘进世界空间（解码、乘逆转置、归一化、再编码）。内核拿到的是 SIMD 版解码出来的法线（Cycles 在处理器上取法线用它）。
/// 内核仍按实例矩阵在渲染时变换法线，所以烘过的世界空间法线 nw 换回模型空间存：n′ = normalize(Lᵀ·nw)（L 是实例矩阵的线性
/// 部分），内核的法线矩阵 (L⁻¹)ᵀ 乘回去就是 nw（只差单精度的舍入，远小于编码的步长）。位置不烘（照旧由实例矩阵变换）：
/// 照 Cycles 把位置也烘进世界空间试过，第 4 级读数只在第四位有效数字上动，没有可见改善
fn kernel_geometry(p: &Pack, k: usize) -> Vec<world::Geometry> {
    let mut users = vec![0usize; p.geometry.len()];
    let mut user = vec![0usize; p.geometry.len()];
    for (i, r) in p.rows.iter().enumerate() {
        if let Some(u) = users.get_mut(r[0] as usize) {
            *u += 1;
            user[r[0] as usize] = i;
        }
    }
    p.geometry
        .iter()
        .enumerate()
        .map(|(gi, g)| {
            let mut g = g.clone();
            if !CYCLES_NORMAL_PACKING {
                return g;
            }
            let m = p.frames_instances.row(k, user[gi]);
            let l = glam::DMat3::from_cols_array(&[m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]].map(|x| x as f64));
            let bake = users[gi] == 1 && l.determinant() != 0.0 && m.iter().zip(&[1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]).any(|(a, b)| a != b);
            // 逆转置的行（transform_direction 按行乘），双精度求再存成单精度
            let nt = l.inverse().transpose();
            let ntfm = [0, 1, 2].map(|r| [0, 1, 2].map(|c| nt.col(c)[r] as f32));
            for n in g.normals.chunks_exact_mut(3) {
                let mut code = crate::packed_normal::encode([n[0], n[1], n[2]]);
                if bake {
                    code = crate::packed_normal::apply_transform(code, ntfm);
                }
                let d = crate::packed_normal::decode_simd(code);
                let out = if bake {
                    let v = (l.transpose() * glam::DVec3::new(d[0] as f64, d[1] as f64, d[2] as f64)).normalize();
                    [v.x as f32, v.y as f32, v.z as f32]
                } else {
                    d
                };
                n.copy_from_slice(&out);
            }
            g
        })
        .collect()
}

pub fn world_at(p: &Pack, k: usize, size: (u32, u32)) -> Result<world::World> {
    let mut w = world::World::default();
    // 镜像件的镜像位由 `build` 写进物体扩展表，镜像件与原件共用网格（STRUCTURES 第 56 条）
    w.mirror_flag_by_caller = true;
    for (i, g) in kernel_geometry(p, k).into_iter().enumerate() {
        w.set_geometry(1 + i as u32, g)?;
    }
    for (i, m) in p.materials.iter().enumerate() {
        let c = m.params.base_color.unwrap_or([0.8; 3]).map(|x| x as f32);
        w.set_material(1 + i as u32, desc::Material {
            name: m.name.clone(),
            color: c,
            opacity: 1.0,
            metalness: m.params.metallic.unwrap_or(0.0) as f32,
            roughness: m.params.roughness.unwrap_or(0.5) as f32,
            emissive: [0.0; 3],
            emissive_intensity: 0.0,
            map: None,
            normal_map: None,
            normal_scale: None,
            roughness_map: None,
            metalness_map: None,
            ao_map: None,
            emissive_map: None,
            specular_intensity: None,
            clearcoat: None,
            clearcoat_roughness: None,
            transmission: None,
            transmission_map: None,
            ior: None,
            // Cycles 不剔背面
            double_sided: true,
            alpha_test: None,
            transparent: false,
            shader: None,
            unlit: false,
            vertex_colors: false,
        });
    }
    for (i, r) in p.rows.iter().enumerate() {
        let m = p.frames_instances.row(k, i);
        if [0, 1, 2, 4, 5, 6, 8, 9, 10].iter().all(|&j| m[j] == 0.0) {
            continue;
        }
        let id = row_id(i);
        let kind = world::Kind::Instanced { geometry: 1 + r[0], procedural: false, materials: vec![1 + r[1]], capacity: 1 };
        w.set_object(id, format!("{}#{i}", p.names[i]), None, kind, true, false)?;
        w.set_instances(id, 1, Some(m.to_vec()), None, None)?;
    }
    let light0 = row_id(p.rows.len());
    for (j, l) in p.lights.iter().enumerate() {
        let id = light0 + j as u32;
        w.set_object(id, format!("light:{}", l.name), None, world::Kind::Light(kernel_light(l, p.watts(k, j))), true, false)?;
        // （sun 在灯表里那一行写什么不定、读入方不读：它的方向在 build 里直接从 dir 填）
        if !matches!(l.kind, LightKind::Sun { .. }) {
            let (s, r, t) = p.light_matrix(k, j).to_scale_rotation_translation();
            w.set_transform(id, t, r, s)?;
        }
    }
    let cam = light0 + p.lights.len() as u32;
    let aspect = size.0 as f64 / size.1.max(1) as f64;
    w.set_object(cam, "camera".into(), None, world::Kind::Camera(p.camera_desc(k, aspect)), false, false)?;
    let (s, r, t) = p.camera_matrix(k).to_scale_rotation_translation();
    w.set_transform(cam, t, r, s)?;
    w.set_environment(desc::Environment {
        sky: desc::Sky::Color { color: p.world_color.map(|x| x as f32), intensity: 1.0, sky_light_intensity: 1.0 },
        fog: None,
        // 背景对相机不可见：相机直接看到黑色（透明度归输出通道）
        background: (!p.world_visible).then_some([0.0; 3]),
        wetness: 0.0,
        rain: 0.0,
        cloud_cover: 0.0,
    });
    w.set_settings(world::Settings { name: p.id.clone(), preset: "cinematic".into(), overrides: None, width: size.0, height: size.1, time: 0.0, camera: Some(cam) });
    Ok(w)
}

/// 第 `k` 帧建成内核的场景：`world_at` 之后走现有的 `scene::build`，再按原样的矩阵重算相机与灯，填物体扩展表的实体编号
/// 与镜像位，并找出每一行实例在内核里的三角形。
pub fn build(p: &Pack, k: usize, size: (u32, u32), preset: Option<&str>, presets: &Path, overrides: Option<&Value>) -> Result<Built> {
    if k >= p.count {
        return Err(fail(BAD_ARGUMENT, "frame", format!("帧号 {k} 不在 [0, {}) 里", p.count)).into());
    }
    let mut w = world_at(p, k, size)?;
    if let Some(name) = preset {
        w.settings.preset = name.to_string();
    }
    let mut sc = scene::build(&w, Path::new("."), presets, overrides)?;
    let aspect = size.0 as f64 / size.1.max(1) as f64;
    sc.camera = scene::camera_data(p.camera_matrix(k), &p.camera_desc(k, aspect));
    let links = p.light_links()?;
    let light0 = row_id(p.rows.len());
    for (slot, id) in sc.retained.light_nodes.clone().iter().enumerate() {
        let Some(j) = id.checked_sub(light0).map(|j| j as usize).filter(|j| *j < p.lights.len()) else { continue };
        let l = &p.lights[j];
        let Some(mut gl) = scene::gpu_light(&kernel_light(l, p.watts(k, j)), p.light_matrix(k, j), 1.0) else { continue };
        if let LightKind::Sun { dir, .. } = l.kind {
            // 内核的平行光沿 dir 射出；契约的 dir 指向光来的方向
            let d = -Vec3::new(dir[0] as f32, dir[1] as f32, dir[2] as f32).normalize();
            gl.pos = [0.0, 0.0, 0.0, 0.0];
            gl.dir = [d.x, d.y, d.z, gl.dir[3]];
        }
        gl.cy[2] = links.membership[j];
        gl.cy[3] = (gl.cy[3] & !scene::LIGHTGROUP_SLOT_MASK) | p.lightgroup_slot(j);
        sc.lights[slot] = gl;
    }

    let mut placed = vec![];
    let mut ext = vec![scene::GpuObjectExt::default(); sc.objects.len() / sc.object_stride()];
    for (i, r) in p.rows.iter().enumerate() {
        let id = row_id(i);
        let name = format!("{}#{i}", p.names[i]);
        let g = &p.geometry[r[0] as usize];
        // 内核的三角形 t：共享网格的实例（镜像的也是）在模型空间的池里按实例矩阵变；镜像的实例内核按物体扩展表的镜像位把
        // 几何法线取反（shader.wgsl `shader_setup_from_hit`），这里照样换成第 2、3 个顶点对调的次序。发光、玻璃这类在建场景时
        // 平铺（镜像的已换绕序）
        let flips = r[3] == 1;
        let (object, drawn, kernel_tri): (Option<u32>, bool, Box<dyn Fn(usize) -> [Vec3A; 3]>) = match sc.retained.instanced(id) {
            Some(ip) if ip.mesh.is_some() => {
                let inst = &sc.instances[ip.first as usize];
                let first = sc.meshes[ip.mesh.unwrap_or(0) as usize].first as usize;
                let pool = &sc.pool_tris;
                (Some(ip.object), !inst.hidden, Box::new(move |t| { let [a, b, c] = inst.tri(&pool[first + t]); if flips { [a, c, b] } else { [a, b, c] } }))
            }
            _ => match sc.tri_nodes.iter().find(|n| n.0 == name) {
                Some(&(_, start, _)) => {
                    let tris = &sc.tris;
                    (Some(sc.attrs[start as usize].x[1].to_bits()), true, Box::new(move |t| tris[start as usize + t]))
                }
                None => (None, false, Box::new(|_| [Vec3A::ZERO; 3])),
            },
        };
        let mut probe = None;
        if drawn {
            let m = p.frames_instances.row(k, i);
            let md: Vec<f64> = m.iter().map(|x| *x as f64).collect();
            let world_p = |v: u32| {
                let q = [g.positions[v as usize * 3] as f64, g.positions[v as usize * 3 + 1] as f64, g.positions[v as usize * 3 + 2] as f64];
                [0, 1, 2].map(|c| md[c] * q[0] + md[4 + c] * q[1] + md[8 + c] * q[2] + md[12 + c])
            };
            for (t, ix) in g.indices.chunks_exact(3).enumerate() {
                let raw = tri_normal([world_p(ix[0]), world_p(ix[1]), world_p(ix[2])]);
                if raw.iter().map(|x| x * x).sum::<f64>() > 0.0 {
                    let kt = kernel_tri(t).map(|v| [v.x as f64, v.y as f64, v.z as f64]);
                    probe = Some((t, raw, tri_normal(kt)));
                    break;
                }
            }
        }
        if let Some(o) = object.filter(|o| (*o as usize) < ext.len()) {
            ext[o as usize].entity_id = r[2] as f32;
            ext[o as usize].object_flag = if r[3] == 1 { scene::SD_OBJECT_NEGATIVE_SCALE } else { 0 };
            ext[o as usize].receiver_light_set = links.receiver_set[i];
            // 场景包的网格都带逐角法线，照平滑着色算（标准答案机导入时全部 use_smooth）
            ext[o as usize].shadow_terminator_geometry_offset = SHADOW_TERMINATOR_GEOMETRY_OFFSET;
        }
        placed.push(Placed { row: i, object, drawn, triangles: if drawn { g.indices.len() / 3 } else { 0 }, probe });
    }
    sc.object_ext = ext;
    Ok(Built { scene: sc, placed })
}

/// 北冥：第 `k` 帧的 motion 要的东西（输出通道契约 5.6）。另一帧取第 k + 1 帧，第 k 帧是最后一帧时取第 k − 1 帧（向后差分），
/// 只有一帧的包返回 None（motion 全 0）；最后一帧按场景包的帧号（`frames.count`）判，不看镜头的 `out`。每个这一帧画出来的
/// 实例行：它在内核物体表里的下标 → 两帧实例矩阵给出的刚体变换，另一帧里被隐藏的是 None（motion 写 0，见 `motion::rigid`）；
/// 两行落到同一个物体上时分不出命中的是哪一行，报错。
pub fn motion_step(p: &Pack, k: usize, size: (u32, u32), b: &Built) -> Result<Option<crate::motion::Step>> {
    let Some(g) = (if k + 1 < p.count { Some(k + 1) } else { k.checked_sub(1) }) else { return Ok(None) };
    let aspect = size.0 as f64 / size.1.max(1) as f64;
    let cam = |f: usize| {
        let t = &p.frames_camera;
        crate::motion::Cam::new(p.camera_matrix(f), t.field(t.row(f, 0), "fovY").map_or(1.0, |x| x[0] as f64), aspect)
    };
    let mut objects = HashMap::new();
    for x in b.placed.iter().filter(|x| x.drawn) {
        let Some(o) = x.object else { continue };
        if objects.insert(o, crate::motion::rigid(p.instance_matrix(k, x.row), p.instance_matrix(g, x.row))).is_some() {
            return Err(anyhow::anyhow!("实例表第 {} 行与另一行落到了内核的同一个物体 {o} 上，motion 分不出命中的是哪一行", x.row));
        }
    }
    Ok(Some(crate::motion::Step { here: cam(k), there: cam(g), forward: g > k, objects }))
}

// ------------------------------------------------------------------------------------------ 统计与核对记录

/// `pack-info` 的统计。三角形数是从几何文件实际读到的每个网格的三角形数，乘以这一帧画出来的实例（不是抄清单的 tris）。
/// `drawn` 与 `triangles` 只算这一帧画出来的实例：九个数全为 0 的不建；行列式为 0（九个数不全为 0，压扁成面或线）的，内核建场景时
/// 也不画（`scene::instance_world` 把它藏起来），即行列式为 0 的那一帧这个实例不画。
pub fn info(p: &Pack, k: usize, b: &Built) -> Value {
    let entities: BTreeSet<u32> = p.rows.iter().map(|r| r[2]).collect();
    let mut types: std::collections::BTreeMap<&str, usize> = Default::default();
    for l in &p.lights {
        let t = match l.kind {
            LightKind::Rect { .. } => "area-rect",
            LightKind::Point { .. } => "point",
            LightKind::Sun { .. } => "sun",
        };
        *types.entry(t).or_default() += 1;
    }
    let patterned: Vec<Value> = p.materials.iter().filter(|m| !m.pattern.is_empty()).map(|m| json!({ "material": m.name, "nodes": m.pattern.len() })).collect();
    let linked: Vec<Value> = p.lights.iter().filter_map(|l| l.link.as_ref().map(|ls| json!({ "light": l.name, "link": ls }))).collect();
    json!({
        "format": "core-pack-info/0.1",
        "id": p.id,
        "frame": k,
        "frames": p.count,
        "meshes": p.meshes.len(),
        "meshTriangles": p.geometry.iter().map(|g| g.indices.len() / 3).sum::<usize>(),
        "triangles": b.placed.iter().map(|x| x.triangles).sum::<usize>(),
        "instances": p.rows.len(),
        "drawn": b.placed.iter().filter(|x| x.drawn).count(),
        "entities": entities.len(),
        "mirrored": p.rows.iter().filter(|r| r[3] == 1).count(),
        "materials": p.materials.len(),
        "lights": p.lights.len(),
        "lightTypes": types,
        "patternNodes": p.materials.iter().map(|m| m.pattern.len()).sum::<usize>(),
        "lightLinks": linked.len(),
        "zeroCornerNormals": p.zero_normals,
        "notApplied": { "pattern": patterned },
        "lightGroups": p.lightgroups(),
        "kernel": { "objects": b.scene.objects.len() / b.scene.object_stride(), "flatTriangles": b.scene.tris.len(), "instances": b.scene.instances.len(), "lights": b.scene.lights.len() },
    })
}

/// 场景包核对记录（契约 3.11）：清单、解出来的实例表、这一帧每个画出来的实例一个 normalProbes。`raw` 由读入器从包里的
/// 顶点与矩阵直接算，`used` 是内核平铺后实际用的那个三角形的几何法线。
pub fn record(p: &Pack, k: usize, b: &Built) -> Value {
    let probes: Vec<Value> = b.placed.iter().filter_map(|x| x.probe.map(|(t, raw, used)| json!({ "row": x.row, "frame": k, "raw": raw, "used": used, "ext": { "core.triangle": t } }))).collect();
    json!({
        "format": "scene-pack-check/0.1",
        "pack": p.manifest,
        "tables": { "instances": p.rows },
        "loads": [{ "status": "ok" }],
        "normalProbes": probes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个最小的包：两个网格（一块斜板、地面），三行实例（地面、原件、镜像件），每种灯一盏，带景深的相机。
    fn manifest() -> Value {
        json!({
            "format": "scene-pack/0.1", "id": "pack:unit@1", "units": { "meter": 1, "up": "Y", "hand": "right" },
            "geometry": { "file": "g.glb", "meshes": [{ "name": "ramp", "tris": 1, "attrs": ["position", "cornerNormal"] }] },
            "instances": { "file": "i.u32", "shape": [2, 4], "names": ["kit.a", "kit.b"], "class": ["part", "part"] },
            "materials": [{ "name": "m", "closure": "surface", "params": { "baseColor": [0.5, 0.5, 0.5], "metallic": 0, "roughness": 1 },
                "pattern": [{ "node": "ao", "distance": 0.1, "samples": 2, "onlyLocal": false, "out": "ao" }, { "node": "mix", "by": "ao", "set": { "roughness": 0.2 } }] }],
            "lights": [
                { "name": "key", "type": "area-rect", "size": [1, 2], "watts": 100, "color": [1, 1, 1], "visibleToCamera": false, "link": ["kit.*"] },
                { "name": "bulb", "type": "point", "watts": 40, "color": [1, 1, 1], "visibleToCamera": false },
                { "name": "sun", "type": "sun", "dir": [0, 1, 0], "irradiance": 3, "color": [1, 1, 1], "visibleToCamera": false }],
            "world": { "color": [0, 0, 0], "visibleToCamera": true },
            "camera": { "type": "persp", "near": 0.1, "far": 100, "sensorHeight": 0.024 },
            "frames": { "count": 1,
                "instances": { "file": "f/i.f32", "shape": [1, 2, 16], "fields": ["mat16"] },
                "camera": { "file": "f/c.f32", "shape": [1, 19], "fields": ["mat16", "fovY", "focusDist", "fstop"] },
                "lights": { "file": "f/l.f32", "shape": [1, 3, 17], "fields": ["mat16", "watts"] } },
            "source": { "exporter": "unit@1", "blender": "5.2.3", "sha256": "0".repeat(64) }
        })
    }

    #[test]
    fn a_good_manifest_parses() {
        let p = parse_manifest(&manifest()).unwrap();
        assert_eq!((p.meshes.len(), p.names.len(), p.lights.len(), p.materials[0].pattern.len()), (1, 2, 3, 2));
        assert_eq!(p.lights[0].link.as_deref(), Some(&["kit.*".to_string()][..]));
        assert_eq!(p.lights[1].group, "bulb");
    }

    #[test]
    fn light_links_and_groups_follow_blender() {
        let mut v = manifest();
        v["lights"][1]["link"] = json!(["kit.b"]);
        v["lights"][2]["group"] = json!("key");
        let mut p = parse_manifest(&v).unwrap();
        p.names = vec!["kit.a".into(), "kit.b".into(), "ground".into()];
        p.rows = vec![[0; 4]; 3];
        // kit.a 只在 key 的名单里（集合 1），kit.b 在 key 与 bulb 的名单里（集合 2），ground 不在任何名单里（集合 0）
        let l = p.light_links().unwrap();
        assert_eq!(l.receiver_set, [1, 2, 0]);
        assert_eq!(l.membership, [0b110, 0b100, u32::MAX]);
        // 组名按第一次出现的次序；sun 并进 key 那一组
        assert_eq!(p.lightgroups(), ["key", "bulb"]);
        assert_eq!((0..3).map(|j| p.lightgroup_slot(j)).collect::<Vec<_>>(), [0, 1, 0]);
        // 集合号超过 31 不收
        p.lights = (0..33).map(|k| Light { link: Some(vec![format!("e{k}")]), ..p.lights[0].clone() }).collect();
        p.names = (0..33).map(|k| format!("e{k}")).collect();
        p.rows = vec![[0; 4]; 33];
        assert_eq!(p.light_links().err().map(|e| e.code), Some(UNSUPPORTED));
    }

    fn err_of(f: impl FnOnce(&mut Value)) -> PackError {
        let mut v = manifest();
        f(&mut v);
        parse_manifest(&v).unwrap_err()
    }

    #[test]
    fn missing_fields_name_their_path() {
        let e = err_of(|v| { v["lights"][1].as_object_mut().unwrap().remove("watts"); });
        assert_eq!((e.code, e.at.as_str()), (BAD_VALUE, "lights[1].watts"));
        let e = err_of(|v| { v["frames"]["camera"].as_object_mut().unwrap().remove("fields"); });
        assert_eq!(e.at, "frames.camera.fields");
        let e = err_of(|v| { v["materials"][0]["params"].as_object_mut().unwrap().remove("roughness"); });
        assert_eq!(e.at, "materials[0].params.roughness");
        let e = err_of(|v| { v.as_object_mut().unwrap().remove("source"); });
        assert_eq!(e.at, "source");
    }

    #[test]
    fn bad_packs_get_codes() {
        assert_eq!(err_of(|v| v["materials"][0]["pattern"][0]["node"] = json!("toon-line")).code, UNKNOWN_NODE);
        assert_eq!(err_of(|v| v["camera"]["fov"] = json!(1)).code, UNKNOWN_KEY);
        for p in ["../g.glb", "/abs/g.glb", "\\x\\g.glb", "a//g.glb", "C:g.glb"] {
            let e = err_of(|v| v["geometry"]["file"] = json!(p));
            assert_eq!((e.code, e.at.as_str()), (BAD_VALUE, "geometry.file"), "{p}");
        }
        assert_eq!(err_of(|v| v["camera"]["type"] = json!("ortho")).code, UNSUPPORTED);
        assert_eq!(err_of(|v| v["materials"][0]["closure"] = json!("toon")).code, UNSUPPORTED);
        assert_eq!(err_of(|v| v["frames"]["lights"]["shape"] = json!([1, 2, 17])).at, "frames.lights.shape");
        assert_eq!(err_of(|v| v["lights"][0]["link"] = json!(["nobody"])).at, "lights[0].link[0]");
        assert_eq!(err_of(|v| v["materials"][0]["pattern"][1]["by"] = json!("line")).at, "materials[0].pattern[1].by");
        assert_eq!(err_of(|v| v["instances"]["names"] = json!(["kit", "kit.b"])).at, "instances.names");
        assert_eq!(err_of(|v| v["instances"]["names"] = json!(["kit.a.b", "kit"])).at, "instances.names");
        let mut v = manifest();
        v["instances"]["names"] = json!(["kit.ab", "kit.a"]);
        assert!(parse_manifest(&v).is_ok(), "kit.ab 不以「kit.a.」开头，两个都是叶子");
        assert_eq!(err_of(|v| { v["camera"].as_object_mut().unwrap().remove("sensorHeight"); }).at, "camera.sensorHeight");
    }

    #[test]
    fn emission_params_are_read_not_shaded() {
        let mut v = manifest();
        v["materials"][0]["params"]["emissionColor"] = json!([2, 1, 0]);
        v["materials"][0]["params"]["emissionStrength"] = json!(3);
        v["materials"][0]["pattern"][1]["set"]["emissionStrength"] = json!(0.5);
        let p = parse_manifest(&v).unwrap();
        assert_eq!((p.materials[0].params.emission_color, p.materials[0].params.emission_strength), (Some([2.0, 1.0, 0.0]), Some(3.0)));
        let e = err_of(|v| v["materials"][0]["params"]["emissionStrength"] = json!(-1));
        assert_eq!((e.code, e.at.as_str()), (BAD_VALUE, "materials[0].params.emissionStrength"));
        let e = err_of(|v| v["materials"][0]["params"]["emissionColor"] = json!([0.2, -0.1, 0.5]));
        assert_eq!((e.code, e.at.as_str()), (BAD_VALUE, "materials[0].params.emissionColor[1]"));
    }

    /// 一个带一个三角形的 GLB（JSON 块加二进制块），用来测几何的读法与越界检查。
    fn glb(index: u32) -> Vec<u8> {
        glb_with(index, |_| {})
    }

    /// 同上，JSON 块先交给 `f` 改一改（造坏文件用）。
    fn glb_with(index: u32, f: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut bin = vec![];
        for x in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0] {
            bin.extend_from_slice(&x.to_le_bytes());
        }
        for i in [0u32, 1, index] {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        let mut j = json!({ "asset": { "version": "2.0" }, "buffers": [{ "byteLength": bin.len() }],
            "bufferViews": [{ "buffer": 0, "byteOffset": 0, "byteLength": 36 }, { "buffer": 0, "byteOffset": 36, "byteLength": 36 }, { "buffer": 0, "byteOffset": 72, "byteLength": 12 }],
            "accessors": [{ "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0] }, { "bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3" }, { "bufferView": 2, "componentType": 5125, "count": 3, "type": "SCALAR" }],
            "meshes": [{ "name": "ramp", "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1 }, "indices": 2 }] }] });
        f(&mut j);
        let mut js = serde_json::to_vec(&j).unwrap();
        while js.len() % 4 != 0 {
            js.push(b' ');
        }
        let mut out = b"glTF".to_vec();
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&((12 + 8 + js.len() + 8 + bin.len()) as u32).to_le_bytes());
        out.extend_from_slice(&(js.len() as u32).to_le_bytes());
        out.extend_from_slice(b"JSON");
        out.extend_from_slice(&js);
        out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&bin);
        out
    }

    #[test]
    fn geometry_is_read_and_checked() {
        let meshes = [Mesh { name: "ramp".into(), tris: 1 }];
        let (g, zero) = read_glb(&glb(2), &meshes).unwrap();
        assert_eq!((g[0].indices.clone(), g[0].positions.len(), zero), (vec![0, 1, 2], 9, 1), "第二个角的法线长度是 0");
        assert_eq!(read_glb(&glb(7), &meshes).unwrap_err().code, BAD_VALUE, "下标越界");
        assert_eq!(read_glb(&glb(2), &[Mesh { name: "ramp".into(), tris: 2 }]).unwrap_err().at, "geometry.meshes[0].tris");
        let mut cut = glb(2);
        cut.truncate(cut.len() - 8);
        assert!(read_glb(&cut, &meshes).is_err(), "截短的文件报错，不越界读");
        for off in [u64::MAX - 11, u64::MAX, 1 << 63] {
            let e = read_glb(&glb_with(2, |j| j["accessors"][0]["byteOffset"] = json!(off)), &meshes).unwrap_err();
            assert_eq!(e.code, BAD_VALUE, "byteOffset = {off}：报错，不 panic");
        }
    }

    /// 一个装好的包（不经文件）：一块朝 +z 的三角板，原件在 x = -1，镜像件（x 取反）在 x = +1。
    fn pack(flip_flag: u32, mirror: bool) -> Pack {
        let mut p = parse_manifest(&manifest()).unwrap();
        let meshes = [Mesh { name: "ramp".into(), tris: 1 }];
        let mut bytes = glb(2);
        // 第二个角的法线长度是 0 的那份只拿来测回退；这里换成三个角都朝 +z
        let at = bytes.len() - 12 - 36 + 12;
        bytes[at..at + 12].copy_from_slice(&[0.0f32, 0.0, 1.0].iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>());
        p.geometry = read_glb(&bytes, &meshes).unwrap().0;
        p.rows = vec![[0, 0, 1, 0], [0, 0, 2, flip_flag]];
        let sx = if mirror { -1.0 } else { 1.0 };
        let mut inst = vec![];
        inst.extend_from_slice(&Mat4::from_translation(Vec3::new(-1.0, 0.0, 0.0)).to_cols_array());
        inst.extend_from_slice(&(Mat4::from_translation(Vec3::new(1.0, 0.0, 0.0)) * Mat4::from_scale(Vec3::new(sx, 1.0, 1.0))).to_cols_array());
        p.frames_instances.data = inst;
        let mut cam = Mat4::from_translation(Vec3::new(0.0, 0.0, 5.0)).to_cols_array().to_vec();
        cam.extend_from_slice(&[0.8, 5.0, 2.8]);
        p.frames_camera.data = cam;
        p.frames_lights.data = (0..3).flat_map(|j| {
            let mut r = Mat4::from_translation(Vec3::new(0.0, 0.0, 3.0)).to_cols_array().to_vec();
            r.push(10.0 * (j + 1) as f32);
            r
        }).collect();
        p
    }

    fn presets() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("presets")
    }

    #[test]
    fn mirrored_instances_have_flipped_geometric_normals_and_their_ids() {
        let p = pack(1, true);
        check_tables(&p).unwrap();
        let b = build(&p, 0, (64, 32), None, &presets(), None).unwrap();
        for x in &b.placed {
            let (_, raw, used) = x.probe.unwrap();
            let d: f64 = (0..3).map(|c| raw[c] * used[c]).sum();
            assert!(if p.rows[x.row][3] == 1 { d < 0.0 } else { d > 0.0 }, "第 {} 行：used·raw = {d}", x.row);
            let o = x.object.unwrap() as usize;
            assert_eq!(b.scene.object_ext[o].entity_id, p.rows[x.row][2] as f32);
            assert_eq!(b.scene.object_ext[o].object_flag, if p.rows[x.row][3] == 1 { scene::SD_OBJECT_NEGATIVE_SCALE } else { 0 });
        }
        assert_eq!(b.placed.iter().map(|x| x.triangles).sum::<usize>(), 2);
        // 镜像标记与行列式不一致的包不收（SP3）
        assert_eq!(check_tables(&pack(0, true)).unwrap_err().at, "instances.file");
    }

    #[test]
    fn zero_scale_rows_are_not_drawn() {
        let mut p = pack(0, false);
        for x in &mut p.frames_instances.data[16..16 + 12] {
            *x = 0.0;
        }
        let b = build(&p, 0, (64, 32), None, &presets(), None).unwrap();
        assert_eq!(b.placed.iter().map(|x| (x.drawn, x.triangles)).collect::<Vec<_>>(), vec![(true, 1), (false, 0)]);
        // 九个数不全为 0、行列式为 0（压扁成 yz 平面上的一个面）：建了，但内核不画
        let mut p = pack(0, false);
        for x in &mut p.frames_instances.data[16..16 + 3] {
            *x = 0.0;
        }
        let b = build(&p, 0, (64, 32), None, &presets(), None).unwrap();
        assert_eq!(b.placed.iter().map(|x| (x.drawn, x.triangles)).collect::<Vec<_>>(), vec![(true, 1), (false, 0)]);
    }

    #[test]
    fn normals_take_cycles_storage_precision() {
        use crate::packed_normal::{apply_transform, decode_simd, encode};
        // 两行共用一个网格：只编码再解码，朝 +z 的法线解码后偏开约 2^-16
        let p = pack(0, false);
        let g = kernel_geometry(&p, 0);
        for (a, b) in p.geometry[0].normals.chunks_exact(3).zip(g[0].normals.chunks_exact(3)) {
            assert_eq!(b, decode_simd(encode([a[0], a[1], a[2]])));
            assert_ne!(a, b);
        }
        // 只剩一行、绕 x 转 90°：码烘进世界空间，存回模型空间，实例矩阵乘回去等于世界空间的码解出来的法线
        let mut p = pack(0, false);
        p.rows.truncate(1);
        let m = Mat4::from_rotation_x(std::f32::consts::FRAC_PI_2);
        p.frames_instances.data[..16].copy_from_slice(&m.to_cols_array());
        let g = kernel_geometry(&p, 0);
        let r = glam::Mat3::from_mat4(m);
        let ntfm = [0, 1, 2].map(|i| [0, 1, 2].map(|j| r.col(j)[i]));
        for (a, b) in p.geometry[0].normals.chunks_exact(3).zip(g[0].normals.chunks_exact(3)) {
            let want = decode_simd(apply_transform(encode([a[0], a[1], a[2]]), ntfm));
            let got = r * Vec3::from_slice(b);
            assert!((got - Vec3::from(want)).abs().max_element() < 1e-6, "{got:?} ≠ {want:?}");
        }
    }

    /// 景深：内核算出的孔径直径等于契约 5.11 的 sensorHeight ÷ (2 tan(fovY / 2)) ÷ fstop，画面宽高比变了也一样。
    #[test]
    fn the_aperture_is_the_contracts() {
        let p = pack(1, true);
        for size in [(64u32, 32u32), (40, 60)] {
            let mut b = build(&p, 0, size, None, &presets(), None).unwrap();
            b.scene.width = size.0;
            b.scene.height = size.1;
            let prep = crate::prepare_as(false, &mut b.scene, &mut vec![]);
            let want = 0.024 / (2.0 * (0.8f64 / 2.0).tan()) / 2.8;
            let got = 2.0 * prep.params.cam_right[3] as f64;
            assert!((got / want - 1.0).abs() < 1e-5, "{size:?}: {got} vs {want}");
            assert_eq!(prep.params.cam_up[3], 5.0);
        }
    }

    /// 三种灯的换算照 Cycles：矩形 P / (π·面积)，点光 P / (4π)，平行光辐照度原样；功率取灯表的 watts 列。
    #[test]
    fn lights_are_converted_as_cycles_does() {
        let p = pack(1, true);
        assert_eq!(p.watts(0, 1), 20.0);
        let b = build(&p, 0, (64, 32), None, &presets(), None).unwrap();
        let by_type = |t: f32| b.scene.lights.iter().find(|l| l.pos[3] == t).unwrap().color[0] as f64;
        assert!((by_type(3.0) / (10.0 / (std::f64::consts::PI * 2.0)) - 1.0).abs() < 1e-6);
        assert!((by_type(1.0) / (20.0 / (4.0 * std::f64::consts::PI)) - 1.0).abs() < 1e-6);
        assert_eq!(by_type(0.0), 3.0);
        let sun = b.scene.lights.iter().find(|l| l.pos[3] == 0.0).unwrap();
        assert_eq!(&sun.dir[..3], &[0.0, -1.0, 0.0]);
    }

    /// 每帧状态表按帧取行：两帧的包，第 1 帧的灯功率、第 1 行实例的矩阵、相机位置都与第 0 帧不同；相机表与灯表的列次序
    /// 故意和登记表的次序不一样。选第 1 帧建出来的场景取到的是第 1 帧的值。
    #[test]
    fn each_frame_reads_its_own_rows() {
        let mut v = manifest();
        v["frames"]["count"] = json!(2);
        v["frames"]["instances"]["shape"] = json!([2, 2, 16]);
        v["frames"]["camera"] = json!({ "file": "f/c.f32", "shape": [2, 19], "fields": ["fstop", "fovY", "mat16", "focusDist"] });
        v["frames"]["lights"] = json!({ "file": "f/l.f32", "shape": [2, 3, 17], "fields": ["watts", "mat16"] });
        let mut p = parse_manifest(&v).unwrap();
        let base = pack(0, false);
        p.geometry = base.geometry.clone();
        p.rows = base.rows.clone();
        let mut inst = base.frames_instances.data.clone();
        inst.extend_from_slice(&base.frames_instances.data[..16]);
        inst.extend_from_slice(&Mat4::from_translation(Vec3::new(1.0, 2.0, 0.0)).to_cols_array());
        p.frames_instances.data = inst;
        let cam = |z: f32| [&[2.8, 0.8][..], &Mat4::from_translation(Vec3::new(0.0, 0.0, z)).to_cols_array(), &[5.0]].concat();
        p.frames_camera.data = [cam(5.0), cam(7.0)].concat();
        let light = |w: f32| [&[w][..], &Mat4::from_translation(Vec3::new(0.0, 0.0, 3.0)).to_cols_array()].concat();
        p.frames_lights.data = [light(10.0), light(20.0), light(0.0), light(30.0), light(60.0), light(0.0)].concat();
        check_tables(&p).unwrap();
        let b = build(&p, 1, (64, 32), None, &presets(), None).unwrap();
        assert_eq!(b.scene.camera.position, Vec3::new(0.0, 0.0, 7.0));
        let by_type = |t: f32| b.scene.lights.iter().find(|l| l.pos[3] == t).unwrap().color[0] as f64;
        assert!((by_type(3.0) / (30.0 / (std::f64::consts::PI * 2.0)) - 1.0).abs() < 1e-6, "矩形灯取第 1 帧的 30 瓦");
        assert!((by_type(1.0) / (60.0 / (4.0 * std::f64::consts::PI)) - 1.0).abs() < 1e-6, "点光取第 1 帧的 60 瓦");
        let ip = b.scene.retained.instanced(row_id(1)).unwrap();
        assert_eq!(b.scene.instances[ip.first as usize].world.w_axis, glam::Vec4::new(1.0, 2.0, 0.0, 1.0));
        // motion：第 1 帧里把第 1 行藏起来（左上 3×3 九个数全 0，平移留着）。第 0 帧对第 1 帧，第 1 行那一项没有定义，第 0 行照常
        for x in &mut p.frames_instances.data[48..48 + 12] {
            *x = 0.0;
        }
        let b0 = build(&p, 0, (64, 32), None, &presets(), None).unwrap();
        let s = motion_step(&p, 0, (64, 32), &b0).unwrap().unwrap();
        let obj = |r: usize| b0.placed[r].object.unwrap();
        assert!(s.forward && s.objects[&obj(0)].is_some() && s.objects[&obj(1)].is_none(), "{:?}", s.objects);
        // 第 1 帧是场景包的最后一帧：向后差分
        let b1 = build(&p, 1, (64, 32), None, &presets(), None).unwrap();
        assert!(!motion_step(&p, 1, (64, 32), &b1).unwrap().unwrap().forward);
    }

    /// 查「只列叶子实体」（SP14）的耗时与名字总长度成正比：二十万个实例的清单也在几秒内校验完。
    #[test]
    fn many_instances_are_checked_quickly() {
        let n = 200_000;
        let mut v = manifest();
        v["instances"]["shape"] = json!([n, 4]);
        v["instances"]["names"] = json!((0..n).map(|i| format!("kit.p{i}")).collect::<Vec<_>>());
        v["instances"]["class"] = json!(vec!["part"; n]);
        v["frames"]["instances"]["shape"] = json!([1, n, 16]);
        let t = std::time::Instant::now();
        assert_eq!(parse_manifest(&v).unwrap().names.len(), n);
        assert!(t.elapsed().as_secs_f64() < 10.0, "{:?}", t.elapsed());
    }

    /// 一个空的临时包目录（系统临时目录下，按测试名与进程号分开）。
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("beiming-pack-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("f")).unwrap();
        d
    }

    fn f32_bytes(x: &[f32]) -> Vec<u8> {
        x.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    /// 内存上限在读之前查：表的 shape 声明了 2 GiB（文件根本不存在）、几何文件是 1 GiB 多一个字节的稀疏文件，都报带码的错。
    #[test]
    fn oversized_files_are_refused_before_reading() {
        let c = 1usize << 24;
        let mut v = manifest();
        v["frames"]["count"] = json!(c);
        v["frames"]["instances"]["shape"] = json!([c, 2, 16]);
        v["frames"]["camera"]["shape"] = json!([c, 19]);
        v["frames"]["lights"]["shape"] = json!([c, 3, 17]);
        let d = scratch("big-table");
        std::fs::write(d.join("pack.json"), serde_json::to_vec(&v).unwrap()).unwrap();
        std::fs::write(d.join("i.u32"), [0u32, 0, 1, 0, 0, 0, 2, 0].map(|x| x.to_le_bytes()).concat()).unwrap();
        let e = load(&d).unwrap_err();
        assert_eq!((e.code, e.at.as_str()), (BAD_VALUE, "frames.instances.shape"), "{}", e.message);
        std::fs::remove_dir_all(&d).unwrap();

        let p = pack(0, false);
        let d = scratch("big-glb");
        std::fs::write(d.join("pack.json"), serde_json::to_vec(&manifest()).unwrap()).unwrap();
        std::fs::write(d.join("i.u32"), [0u32, 0, 1, 0, 0, 0, 2, 0].map(|x| x.to_le_bytes()).concat()).unwrap();
        std::fs::write(d.join("f/i.f32"), f32_bytes(&p.frames_instances.data)).unwrap();
        std::fs::write(d.join("f/c.f32"), f32_bytes(&p.frames_camera.data)).unwrap();
        std::fs::write(d.join("f/l.f32"), f32_bytes(&p.frames_lights.data)).unwrap();
        std::fs::File::create(d.join("g.glb")).unwrap().set_len(FILE_MAX + 1).unwrap();
        let e = load(&d).unwrap_err();
        assert_eq!((e.code, e.at.as_str()), (BAD_VALUE, "geometry.file"));
        assert!(e.message.contains("上限"), "{}", e.message);
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// 单张表与三张表合计的上限（这里换成小数，免得造大清单）：超了报在让它超的那张表的 shape 上。
    #[test]
    fn table_limits_name_the_shape() {
        let p = parse_manifest(&manifest()).unwrap();
        assert_eq!(table_bytes(&p, 1000, 1000).unwrap(), [128, 76, 204]);
        assert_eq!(table_bytes(&p, 200, 1000).unwrap_err().at, "frames.lights.shape");
        assert_eq!(table_bytes(&p, 1000, 150).unwrap_err().at, "frames.camera.shape");
    }

    #[test]
    fn name_rules() {
        assert!(entity_name_ok("kit.arm_L.bolt2") && !entity_name_ok("kit-arm") && !entity_name_ok("kit..a") && !entity_name_ok(""));
        assert!(link_ok("kit.*") && link_ok("kit.a") && !link_ok("kit*") && !link_ok("*"));
        assert!(link_matches("kit.*", "kit.a") && !link_matches("kit.*", "kit") && !link_matches("kit", "kit.a"));
        assert!(id_ok("pack:a-b1@2") && !id_ok("pack:A@1") && !id_ok("pack:a@0") && !id_ok("a@1"));
        assert!(ext_key_ok("chassis.note") && !ext_key_ok("scene"));
        assert_eq!(exit_code(BAD_VALUE), 4);
        assert_eq!(exit_code(BAD_ARGUMENT), 2);
    }
}
