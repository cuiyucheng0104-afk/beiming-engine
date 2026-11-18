// 只当文档，不编译。条文以 CONTRACT.md 为准。

/** 每帧元数据。结构见每帧元数据契约（M）的 schema/meta.schema.json。 */
export type FrameMeta = object;

/** 片子描述里的一个镜头条目，见片子描述契约（D）。 */
export type ShotEntry = object;

/** 锁文件，见锁文件契约（LK）。 */
export type FilmLock = object;

/** 对落盘文件的引用。结构待定。 */
export type Ref = unknown;

/** 能力声明。字段见 CONTRACT.md 3.4 和 schema/caps.schema.json。 */
export type Caps = object;

export type OutputName = 'color' | 'meta' | 'depth' | 'objectId' | 'normal' | 'motion';

export type RenderOpts = {
  samples?: number;                                  // 每像素采样数，整数，>= 1
  scale?: number;                                    // (0, 1]
  shutter?: { angleDeg: number; samples: number };   // angleDeg：度，[0, 360]；samples：整数，>= 1
};

export type FrameResult = {
  meta: FrameMeta;
  color?: Ref; depth?: Ref; objectId?: Ref; normal?: Ref; motion?: Ref;
};

export type Manifest = {
  frames: number;                                               // 这个镜头的帧数，整数，>= 1
  entities: { id: number; name: string; class: string }[];      // id：整数，>= 1；0 留给背景
};

export type SceneQueryKind = 'bbox3d' | 'anchor' | 'intersect' | 'contact' | 'belowGround';

export type SceneQuery = {
  kind: SceneQueryKind;    // 只能问能力声明的 sceneQuery 里列了的
  of: string[];            // 实体名，可以写「前缀加 .*」：["kit.*"]
  against?: string[];      // 和谁比；intersect、contact 用
  tol?: number;            // 容差，米
};

export type QueryResult = {
  kind: SceneQueryKind;
  items: { a: string; b?: string; value: number; unit: string; at?: number[] }[];   // 最多 50 项
  truncated?: number;      // 被截掉几项；没截就不出现
};

export interface Session {
  manifest(): Manifest;
  render(f: number, opts: RenderOpts, want: OutputName[]): Promise<FrameResult>;   // f：镜头局部帧号
  query(f: number, q: SceneQuery): Promise<QueryResult>;                           // f：镜头局部帧号
  close(): Promise<void>;
}

export interface FrameSource {
  caps(): Caps;
  open(shot: ShotEntry, env: { lock: FilmLock; tier: 'draft' | 'final'; workspace: string }): Promise<Session>;
}
