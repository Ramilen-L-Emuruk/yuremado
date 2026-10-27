import { describe, expect, it } from 'vitest'
import {
  MIRROR_MIN_ALIGNED,
  MIRROR_MIN_CORRELATION,
  MIRROR_WARN_VOTES,
  applyMat3,
  compareMirror,
  mirrorCounterpart,
  mirrorVerdict,
  voteOf,
  type MirrorVote,
} from './boardMirrorWatch'
import { IDENTITY_MATRIX, type Mat3, type Vec3 } from './stationConfigTypes'
import { headingOfRotation, suggestRotation } from '../admin/calibrationSuggest'

/** 決まった種から作る雑音（テストを毎回同じにする）。 */
function noise(seed: number, n: number, amp: number): Float64Array {
  let s = seed >>> 0
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s / 2 ** 32) * 2 - 1) * amp
  }
  return out
}

type Ground = [Float64Array, Float64Array, Float64Array]

/** 東・北・上に揺れる地面（周期 0.3 秒と 0.5 秒くらいの揺れを 20 ms 刻みで）。 */
function ground(n: number): Ground {
  const e = new Float64Array(n)
  const north = new Float64Array(n)
  const up = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    e[i] = Math.sin(i * 0.42) + 0.4 * Math.sin(i * 0.23 + 1)
    north[i] = 0.7 * Math.sin(i * 0.31 + 0.5) - 0.5 * Math.sin(i * 0.17)
    up[i] = 0.6 * Math.sin(i * 0.37 + 2)
  }
  return [e, north, up]
}

/** 地面の揺れを、向き `d`（東・北・上）の軸が読む値。 */
function readAlong(g: Ground, d: Vec3): Float64Array {
  return g[0].map((v, i) => v * d[0] + g[1][i]! * d[1] + g[2][i]! * d[2])
}

/** `d` の、向き `z`（単位）に沿った成分を裏返す。 */
function reflectAcross(d: Vec3, z: Vec3): Vec3 {
  const k = 2 * (d[0] * z[0] + d[1] * z[1] + d[2] * z[2])
  return [d[0] - k * z[0], d[1] - k * z[1], d[2] - k * z[2]]
}

function mul(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as unknown as Mat3
}

const FLIP_Z: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, -1],
]

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

const N = 1200
/** 立てて置いた 2 軸の基板（基板の Z が水平・方位 117° 付近。2026-10 の実機の形）。列は基板の X・Y・Z。 */
const STANDING_X = unit([0.45, 0.89, 0])
const STANDING_Z = unit([0.89, -0.45, 0])
const STANDING: Mat3 = [
  [STANDING_X[0], 0, STANDING_Z[0]],
  [STANDING_X[1], 0, STANDING_Z[1]],
  [0, 1, 0],
]
/** その基板の軸（地面の座標。水平 2 本と、上を向いた 2 本）。 */
const AXES: Vec3[] = [
  [0.45, 0.89, 0.02],
  [0.89, -0.45, 0.04],
  [0.02, 0.05, 1],
  [-0.4, 0.1, 0.9],
]

/**
 * 実際の手順で鏡像の設定を作る: 6 面法の鏡像の解（基板の中の軸も重力も Z を裏返す）を入れ、
 * 「鉛直を合わせる」（`suggestRotation`）で方角を保ったまま基板の向きを作り直す。
 * 返すのは、その設定が言う地面の向きと、作り直した基板の向き。
 */
function mirroredByProcedure(truth: Mat3, boardAxes: readonly Vec3[]): { directions: Vec3[]; orientation: Mat3 } {
  const gBoard: Vec3 = [truth[2][0], truth[2][1], truth[2][2]]
  const heading = headingOfRotation(truth)
  const s = suggestRotation({ gravity: applyMat3(FLIP_Z, gBoard).map((v) => v * 980) as unknown as Vec3, rotation: IDENTITY_MATRIX, headingDeg: heading })
  if (!s.ok) throw new Error(s.reason)
  return { orientation: s.rotation, directions: boardAxes.map((h) => applyMat3(mul(s.rotation, FLIP_Z), h)) }
}

/** 真の向き `truth` の基板に、基板の座標で `boardAxes` の軸が載っているときの、地面の向き。 */
const groundOf = (truth: Mat3, boardAxes: readonly Vec3[]): Vec3[] => boardAxes.map((h) => applyMat3(truth, h))

const BOARD_AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0.6, 0, 1],
  [0, 0.5, 1],
]

describe('mirrorCounterpart（鏡像の設定から本当の向きへ戻す行列）', () => {
  const cases: [string, Mat3][] = [
    ['立てた基板（Z が水平）', STANDING],
    ['平置きの基板（Z が真上）', IDENTITY_MATRIX],
  ]
  const tilted = suggestRotation({ gravity: unit([0.3, -0.5, 0.8]).map((v) => v * 980) as unknown as Vec3, rotation: IDENTITY_MATRIX, headingDeg: 40 })
  if (tilted.ok) cases.push(['斜めに傾いた基板', tilted.rotation])

  it.each(cases)('正: %s — 実際の手順で作った鏡像の設定を、本当の向きへ戻す', (_name, truth) => {
    const { directions, orientation } = mirroredByProcedure(truth, BOARD_AXES)
    const m = mirrorCounterpart(orientation)
    const want = groundOf(truth, BOARD_AXES)
    directions.forEach((d, j) => {
      const got = applyMat3(m, d)
      for (let a = 0; a < 3; a++) expect(got[a]).toBeCloseTo(want[j]![a]!, 4)
    })
  })

  it('安全弁: 傾いた基板の素材が作れている（作れなければ上の 1 件が黙って減る）', () => {
    expect(cases).toHaveLength(3)
  })

  it('正: 基板の Z が水平なら、基板の Z に沿った裏返しと同じ', () => {
    const m = mirrorCounterpart(STANDING)
    for (const d of AXES) {
      const got = applyMat3(m, d)
      const want = reflectAcross(d, STANDING_Z)
      for (let a = 0; a < 3; a++) expect(got[a]).toBeCloseTo(want[a]!, 9)
    }
  })

  it('対照: 平置きでは基板の Z ではなく基板の Y に沿って裏返る（Z だけ裏返す形では戻らない）', () => {
    const m = mirrorCounterpart(IDENTITY_MATRIX)
    const up = applyMat3(m, [0, 0, 1])
    const north = applyMat3(m, [0, 1, 0])
    ;[0, 0, 1].forEach((v, a) => expect(up[a]).toBeCloseTo(v, 9))
    ;[0, -1, 0].forEach((v, a) => expect(north[a]).toBeCloseTo(v, 9))
  })
})

describe('compareMirror（今の向きと裏返した向きで相関を比べる）', () => {
  const g = ground(N)
  const ref: Ground = [0, 1, 2].map((a) => g[a]!.map((v, i) => v + noise(1 + a, N, 0.05)[i]!)) as Ground

  it('正: 設定が正しければ、今の向きの相関が高く、鏡像の側は下がる', () => {
    const signals = AXES.map((d, j) => readAlong(g, d).map((v, i) => v + noise(10 + j, N, 0.05)[i]!))
    const r = compareMirror({ signals, directions: AXES, orientation: STANDING, ref })
    expect(r.aligned).toBe(N)
    expect(r.current).toBeGreaterThan(0.9)
    expect(r.mirrored).toBeLessThan(r.current - 0.5)
  })

  it('正: 立てた基板（#712 の形）に鏡像が入っていれば、鏡像の側の相関が高い', () => {
    const { directions, orientation } = mirroredByProcedure(STANDING, BOARD_AXES)
    const truth = groundOf(STANDING, BOARD_AXES)
    const signals = truth.map((d, j) => readAlong(g, d).map((v, i) => v + noise(20 + j, N, 0.05)[i]!))
    const r = compareMirror({ signals, directions, orientation, ref })
    expect(r.mirrored).toBeGreaterThan(0.9)
    expect(r.current).toBeLessThan(r.mirrored - 0.5)
  })

  it('正: 平置きの基板に鏡像が入っていれば（向きは上下逆さまに作り直される）、鏡像の側の相関が高い', () => {
    const { directions, orientation } = mirroredByProcedure(IDENTITY_MATRIX, BOARD_AXES)
    const truth = groundOf(IDENTITY_MATRIX, BOARD_AXES)
    const signals = truth.map((d, j) => readAlong(g, d).map((v, i) => v + noise(30 + j, N, 0.05)[i]!))
    const r = compareMirror({ signals, directions, orientation, ref })
    expect(r.mirrored).toBeGreaterThan(0.9)
    expect(r.current).toBeLessThan(r.mirrored - 0.5)
  })

  it('対照: 平置きで正しく入っていれば、今の向きが勝つ', () => {
    const truth = groundOf(IDENTITY_MATRIX, BOARD_AXES)
    const signals = truth.map((d, j) => readAlong(g, d).map((v, i) => v + noise(40 + j, N, 0.05)[i]!))
    const r = compareMirror({ signals, directions: truth, orientation: IDENTITY_MATRIX, ref })
    expect(r.current).toBeGreaterThan(0.9)
    expect(r.mirrored).toBeLessThan(r.current - 0.5)
  })

  it('対照: どれかが欠けた目盛りは数えない', () => {
    const signals = AXES.map((d) => readAlong(g, d))
    signals[0]![5] = Number.NaN
    const holed: Ground = [ref[0].slice(), ref[1], ref[2]]
    holed[0][9] = Number.NaN
    const r = compareMirror({ signals, directions: AXES, orientation: STANDING, ref: holed })
    expect(r.aligned).toBe(N - 2)
  })

  it('安全弁: 軸が 3 方向へ散っていなければ（平置きの 2 軸だけ）、解けないとして返す', () => {
    const flat: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
    ]
    const r = compareMirror({ signals: flat.map(() => new Float64Array(N)), directions: flat, orientation: IDENTITY_MATRIX, ref })
    expect(r.aligned).toBe(0)
  })
})

describe('voteOf（1 つの揺れの票）', () => {
  it('正: どちらかの相関が下限以上なら、勝った側の票', () => {
    expect(voteOf({ current: 0.05, mirrored: 0.35, aligned: 1000 })).toBe('mirrored')
    expect(voteOf({ current: 0.42, mirrored: -0.3, aligned: 1000 })).toBe('ok')
  })
  it('対照: 両方とも下限未満（ノイズに埋もれた揺れ）なら票にしない', () => {
    // 実機の弱い窓は |相関| が最大 0.11 だった。
    expect(voteOf({ current: 0.11, mirrored: -0.1, aligned: 1000 })).toBeNull()
    expect(MIRROR_MIN_CORRELATION).toBe(0.15)
  })
  it('安全弁: どちらも逆相関（どちらの向きも合っていない）なら票にしない', () => {
    expect(voteOf({ current: -0.4, mirrored: -0.5, aligned: 1000 })).toBeNull()
    expect(voteOf({ current: -0.5, mirrored: -0.4, aligned: 1000 })).toBeNull()
    // 片方だけが正で下限以上なら、その側の票（符号の取り違えではない）。
    expect(voteOf({ current: -0.4, mirrored: 0.2, aligned: 1000 })).toBe('mirrored')
  })
  it('安全弁: 揃った目盛りが足りなければ票にしない', () => {
    expect(voteOf({ current: 0.0, mirrored: 0.9, aligned: MIRROR_MIN_ALIGNED - 1 })).toBeNull()
  })
})

describe('mirrorVerdict（票を集めて警告するか）（2026-10-27 ユーザー承認「3 票・逆の票より多い」）', () => {
  const votes = (...v: MirrorVote[]) => v
  it('正: 鏡像の票が 3 以上で、正しい票より多ければ警告する', () => {
    expect(mirrorVerdict(votes('mirrored', 'mirrored', 'mirrored'))).toEqual({ warn: true, mirrored: 3, ok: 0 })
    expect(mirrorVerdict(votes('mirrored', 'ok', 'mirrored', 'mirrored'))).toEqual({ warn: true, mirrored: 3, ok: 1 })
    expect(MIRROR_WARN_VOTES).toBe(3)
  })
  it('対照: 2 票では出さない', () => {
    expect(mirrorVerdict(votes('mirrored', 'mirrored')).warn).toBe(false)
  })
  it('対照: 正しい票と同じ数なら出さない', () => {
    expect(mirrorVerdict(votes('mirrored', 'mirrored', 'mirrored', 'ok', 'ok', 'ok')).warn).toBe(false)
  })
})
