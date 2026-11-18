import { faultTypeOf, type NodalPlane, type PrincipalAxis } from '../services/relayAnalysis'

/**
 * 震源球と断層のずれの 3D（`FaultViewer3D`）の幾何。世界の座標は (北, 東, 下)。
 * 節面（走向・傾斜・すべり角）の取り方は気象庁・USGS の図と同じ（Aki & Richards）。画面の座標は (右, 上, 手前)
 */
export type Vec3 = readonly [number, number, number]

const D2R = Math.PI / 180

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]))

/** 断層面の枠組み: 走向の向き・傾斜の向き（下り）・面の法線（上盤の側を向く）・上盤のすべる向き */
export interface FaultFrame { strike: Vec3; dip: Vec3; normal: Vec3; slip: Vec3 }

export function faultFrame(p: NodalPlane): FaultFrame {
  const f = p.strike * D2R, d = p.dip * D2R, l = p.rake * D2R
  const strike: Vec3 = [Math.cos(f), Math.sin(f), 0]
  const dip: Vec3 = [-Math.cos(d) * Math.sin(f), Math.cos(d) * Math.cos(f), Math.sin(d)]
  const normal: Vec3 = [-Math.sin(d) * Math.sin(f), Math.sin(d) * Math.cos(f), -Math.cos(d)]
  const slip = add(scale(strike, Math.cos(l)), scale(dip, -Math.sin(l)))
  return { strike, dip, normal, slip }
}

/** 節面が 3D に描ける値か。数値でない・傾斜が 0〜90° の外にあるものは描かない（傾斜が外れると上盤の側が逆になり、誤った向きの絵が正しい絵として出る） */
export function isDrawablePlane(p: NodalPlane): boolean {
  return Number.isFinite(p.strike) && Number.isFinite(p.dip) && Number.isFinite(p.rake) && p.dip >= 0 && p.dip <= 90
}

/** 主軸の方位・傾斜が数値のとき */
export function isDrawableAxis(a: PrincipalAxis): boolean {
  return Number.isFinite(a.azimuth) && Number.isFinite(a.plunge)
}

/** 主軸 1 本（方位は北から時計回り、傾斜は水平から下向き）の向きの単位ベクトル */
export function axisVector(a: PrincipalAxis): Vec3 {
  const az = a.azimuth * D2R, pl = a.plunge * D2R
  return [Math.cos(az) * Math.cos(pl), Math.sin(az) * Math.cos(pl), Math.sin(pl)]
}

/** 上半球を消した球で、球面の 1 点（単位ベクトル）が見えるか */
export type HemisphereVisibility = 'visible' | 'occluded' | 'hidden'

/**
 * 上半球（上向きの方向）を消した球の、下半球の点の見え方。上半球の点は見えない（`hidden`）。下半球の手前の面の点は見え（`visible`）、
 * 奥の面の点は、同じ画素の手前の面が上半球（消してある）なら内側が見え（`visible`）、下半球なら手前に隠れる（`occluded`）。
 * 真上から見下ろすと、下半球の内側が全部見える（表の震源球の図と同じ並び）
 */
export function lowerHemisphereVisibility(v: Vec3, view: ViewAngles): HemisphereVisibility {
  if (v[2] < 0) return 'hidden'
  const s = toScreen(v, view)
  // 縁（奥行きがほぼ 0）の点は、丸めの向きで見え方が変わらないよう、手前の面として扱う
  if (s[2] >= -1e-9) return 'visible'
  const zFront = Math.sqrt(Math.max(0, 1 - s[0] * s[0] - s[1] * s[1]))
  return fromScreen([s[0], s[1], zFront], view)[2] < 0 ? 'visible' : 'occluded'
}

/** 見る向き。yaw は上下の軸まわり、pitch は東西の軸まわり（正で上から見下ろす） */
export interface ViewAngles { yaw: number; pitch: number }

export const PITCH_LIMIT = 1.45

export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch))
}

/**
 * 世界の (北, 東, 下) を、画面の (右, 上, 手前) へ。手前は正が見る人の側。
 * 最初の向きは、南から北を見る向き（東が右・上が上・北が奥）。右手系にするため、手前は北ではなく南向き（−北）に取る
 * （手前を北に取ると鏡に映した像になり、北を上・下を奥にして見下ろしたとき東が左に来る）
 */
export function toScreen(v: Vec3, view: ViewAngles): Vec3 {
  const e = v[1], u = -v[2], n = -v[0]
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch)
  const x1 = e * cy + n * sy
  const z1 = -e * sy + n * cy
  return [x1, u * cp - z1 * sp, u * sp + z1 * cp]
}

/** `toScreen` の逆 */
export function fromScreen(a: Vec3, view: ViewAngles): Vec3 {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch)
  const u = a[1] * cp + a[2] * sp
  const z1 = -a[1] * sp + a[2] * cp
  const e = a[0] * cy - z1 * sy
  const n = a[0] * sy + z1 * cy
  return [-n, e, -u]
}

/**
 * 開いたときの向き。逆断層・正断層は走向をこちらへ向けて断面（傾斜の向き）を横に見せ、
 * 横ずれ断層は上から見下ろして水平のずれを見せる（少しだけ斜めにして立体に見せる）
 */
export function initialView(p: NodalPlane): ViewAngles {
  const f = p.strike * D2R
  return faultTypeOf(p) === 'strikeSlip' ? { yaw: f + 0.35, pitch: 1.15 } : { yaw: f + 0.45, pitch: 0.5 }
}

/** ずれのループ 1 巡の長さ（ミリ秒） */
export const SLIP_LOOP_MS = 4800

function ease(x: number): number {
  return x * x * (3 - 2 * x)
}

/**
 * ずれの進み具合（0 = 元の位置、1 = ずれきった位置）。止まる → ずれる → ずれた位置で止まる → ぱっと元の位置へ。
 * 戻る途中の動きは置かない（断層が戻ったように見えないため。2026-11-18 ユーザー発言「ズレたあとはぱっと最初の位置に戻るようにしてほしいです」）
 */
export function slipProgress(ms: number): number {
  const t = (((ms % SLIP_LOOP_MS) + SLIP_LOOP_MS) % SLIP_LOOP_MS) / SLIP_LOOP_MS
  if (t < 0.15) return 0
  if (t < 0.55) return ease((t - 0.15) / 0.4)
  if (t < 0.85) return 1
  return 0
}

/** 多角形を平面 `keep * (n·p − d) ≥ 0` の側だけに切る（Sutherland–Hodgman） */
export function clipPolygon(poly: readonly Vec3[], n: Vec3, d: number, keep: 1 | -1): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const da = keep * (dot(n, a) - d)
    const db = keep * (dot(n, b) - d)
    if (da >= 0) out.push(a)
    if ((da >= 0) !== (db >= 0)) {
      const k = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k])
    }
  }
  return out
}

export interface BlockFace {
  points: Vec3[]
  /** 面の外向きの法線（陰影用） */
  normal: Vec3
  kind: 'top' | 'side' | 'cut'
  /** 上盤の側（ずれる側）の面 */
  moving: boolean
}

/**
 * 描く面と順番（奥から手前）。2 つの塊はどちらも凸で、断層面を境に離れている（ずれは面に沿うので、ずれても面の両側に分かれたまま）。
 * だから、見る人から遠い側の塊を先に描き、各塊は見る人に向いた面だけを描けば、前後の入れ替わり（面の中心の奥行きで並べると起きる崩れ）は起きない
 */
export function visibleFaces(faces: readonly BlockFace[], frame: FaultFrame, view: ViewAngles): BlockFace[] {
  const toViewer = fromScreen([0, 0, 1], view)
  // 見る人が上盤の側にいるなら、手前は上盤。下盤を先に描く
  const movingFirst = dot(toViewer, frame.normal) < 0
  const facing = (f: BlockFace) => dot(f.normal, toViewer) > 0
  const far = faces.filter(f => f.moving === movingFirst && facing(f))
  const near = faces.filter(f => f.moving !== movingFirst && facing(f))
  return [...far, ...near]
}

/** 箱の深さ（水平の半幅 1 に対する比） */
export const BLOCK_DEPTH = 1
/** ずれきったときの動く量（箱の大きさに対する見やすさのための飾りの量で、実際のずれの量ではない） */
export const SLIP_SHIFT = 0.34
/** 箱（立体）の中心。断層面はここを通し、回す中心と力の軸の根元もここに置く（2026-11-18 ユーザー選択「立体の中心を通す (Recommended)」） */
export const BLOCK_CENTRE: Vec3 = [0, 0, BLOCK_DEPTH / 2]

function boxFaces(): { points: Vec3[]; normal: Vec3; kind: 'top' | 'side' }[] {
  const h = BLOCK_DEPTH
  const v = (a: number, b: number, c: number): Vec3 => [a, b, c * h]
  return [
    { points: [v(-1, -1, 0), v(1, -1, 0), v(1, 1, 0), v(-1, 1, 0)], normal: [0, 0, -1], kind: 'top' },
    { points: [v(-1, -1, 1), v(-1, 1, 1), v(1, 1, 1), v(1, -1, 1)], normal: [0, 0, 1], kind: 'side' },
    { points: [v(1, -1, 0), v(1, -1, 1), v(1, 1, 1), v(1, 1, 0)], normal: [1, 0, 0], kind: 'side' },
    { points: [v(-1, -1, 0), v(-1, 1, 0), v(-1, 1, 1), v(-1, -1, 1)], normal: [-1, 0, 0], kind: 'side' },
    { points: [v(-1, 1, 0), v(1, 1, 0), v(1, 1, 1), v(-1, 1, 1)], normal: [0, 1, 0], kind: 'side' },
    { points: [v(-1, -1, 0), v(-1, -1, 1), v(1, -1, 1), v(1, -1, 0)], normal: [0, -1, 0], kind: 'side' },
  ]
}

/** 箱の半空間（面の内側が `n·p ≥ d`）。断層面の切り口を箱の中へ収めるのに使う */
const BOX_HALF_SPACES: readonly { n: Vec3; d: number }[] = [
  { n: [0, 0, 1], d: 0 }, { n: [0, 0, -1], d: -BLOCK_DEPTH },
  { n: [1, 0, 0], d: -1 }, { n: [-1, 0, 0], d: -1 },
  { n: [0, 1, 0], d: -1 }, { n: [0, -1, 0], d: -1 },
]

/**
 * 地表から深さ方向へ向けた箱を、箱の中心（`BLOCK_CENTRE`）を通る断層面で下盤と上盤の 2 つに切り、上盤だけをすべりの向きへ `slip`（0〜1）に応じて動かした面の並び。
 * 上盤は断層面の法線の側（`n·(p − 中心) ≥ 0`）
 */
export function blockFaces(frame: FaultFrame, slip: number): BlockFace[] {
  const faces: BlockFace[] = []
  const shiftOf = (moving: boolean): Vec3 => (moving ? scale(frame.slip, slip * SLIP_SHIFT) : [0, 0, 0])
  const d = dot(frame.normal, BLOCK_CENTRE)
  for (const moving of [false, true]) {
    const keep: 1 | -1 = moving ? 1 : -1
    const shift = shiftOf(moving)
    for (const f of boxFaces()) {
      const poly = clipPolygon(f.points, frame.normal, d, keep)
      if (poly.length >= 3) faces.push({ points: poly.map(p => add(p, shift)), normal: f.normal, kind: f.kind, moving })
    }
    // 断層面の切り口: 箱の中心を通る、断層面に沿った大きな四角形を箱で切る
    let cap: Vec3[] = [
      add(BLOCK_CENTRE, add(scale(frame.strike, -3), scale(frame.dip, -3))), add(BLOCK_CENTRE, add(scale(frame.strike, 3), scale(frame.dip, -3))),
      add(BLOCK_CENTRE, add(scale(frame.strike, 3), scale(frame.dip, 3))), add(BLOCK_CENTRE, add(scale(frame.strike, -3), scale(frame.dip, 3))),
    ]
    for (const h of BOX_HALF_SPACES) cap = cap.length >= 3 ? clipPolygon(cap, h.n, h.d, 1) : cap
    if (cap.length >= 3) faces.push({ points: cap.map(p => add(p, shift)), normal: moving ? scale(frame.normal, -1) : frame.normal, kind: 'cut', moving })
  }
  return faces
}
