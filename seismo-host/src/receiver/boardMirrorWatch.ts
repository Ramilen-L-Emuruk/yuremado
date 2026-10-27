/**
 * **2 軸のセンサーだけの基板の、鏡像の取り違えの見張り**（#1084）。
 *
 * 2 軸のセンサーだけの基板の 6 面法は、鏡に映した解もデータに同じだけ合う（`boardSixFace.ts` の冒頭）。
 * 「印字面が上の置き方」を指してもらって選ぶが、指し違えれば鏡像のまま入る。入ってしまうと、
 * 校正の残差にも震度にも現れない（2026-10 に 2 週間気づかなかった）。
 *
 * そこで揺れた区間ごとに、同じ観測点の 3 軸のセンサーが測った揺れと比べる。2 軸の基板の全部の軸から
 * 東・北・上を最小二乗で解き、**いまの向きのままと、鏡像の解を入れていた場合の向きの 2 通り**で、
 * 3 軸の側との相関を取る。鏡像の側のほうがよく合う揺れが続けば、鏡像で入っている疑いがある。
 *
 * **鏡像の側は、軸を裏返すだけでなく基板の向きも作り直した形**（`mirrorCounterpart`）—— 6 面法の鏡像の解を
 * 入れると、「鉛直を合わせる」も裏返った重力で基板の向きを作る（`calibrationSuggest.ts`）。基板の Z が水平なら
 * 重力は裏返らず向きも変わらないが、平置きなら向きが X 軸まわりに半回転する。
 *
 * **水平だけでは比べない** —— 平置きの基板の鏡像は東・北の片方と上を入れ違えるだけで、水平の片方には現れない。
 * 実機の 24 窓では、3 成分で比べても振るいを通った 4 窓すべてで正しい側が勝ち（0.17〜0.34）、
 * 通らなかった窓の |相関| は最大 0.10 だった（水平だけなら 5 窓・0.18〜0.46／0.11）。
 *
 * **行列式（3 軸 = A · 2 軸 の回帰の A）では判じない**（2026-10-27 ユーザー承認「相関で比べる」）——
 * 実機の 24 窓で、ノイズに埋もれた揺れでは符号が当てずっぽうになり、強い揺れでも 1 方向に偏ると 0 に近い値が出た。
 *
 * ここは入出力を持たない計算だけ。揺れの区間の生データを読み、帯域を切り出して時刻を揃えるのは配線側。
 */
import type { Mat3, Vec3 } from './stationConfigTypes'

/**
 * 票にする相関の下限（勝った側の相関がこれ以上。`voteOf`）。実機の 24 窓では、ノイズに埋もれた揺れの |相関| は
 * 最大 0.11、振るいを通った 5 窓の勝った側は 0.18〜0.46 だった（2026-10-27 ユーザー承認）。
 */
export const MIRROR_MIN_CORRELATION = 0.15

/** 票にする、揃った目盛りの下限（20 ms 刻みで 4 秒）。短い揺れは相関がぶれる。 */
export const MIRROR_MIN_ALIGNED = 200

/** 警告する鏡像の票の数（2026-10-27 ユーザー承認「3 票・逆の票より多い」）。 */
export const MIRROR_WARN_VOTES = 3

/**
 * 軸の向きが 3 方向へ散っているとみなす下限（`DᵀD` の行列式。単位の向きで、直交 3 本なら 1）。
 * これを下回る基板（平置きの 2 軸だけ等）は東・北・上を解けないので比べない。
 */
const MIN_SPREAD_DET = 0.05

function mul(a: Mat3, b: Mat3): Mat3 {
  const row = (i: number): Vec3 => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!) as unknown as Vec3
  return [row(0), row(1), row(2)]
}

function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ]
}

/** 地面の向き `d` へ行列 `m` を掛ける。 */
export function applyMat3(m: Mat3, d: Vec3): Vec3 {
  return [0, 1, 2].map((i) => m[i]![0] * d[0] + m[i]![1] * d[1] + m[i]![2] * d[2]) as unknown as Vec3
}

/**
 * いまの設定（基板の向き `orientation` B・軸 h）が鏡像の取り違えなら本当はどうだったかを、地面の座標で返す
 * 行列 M（本当の向き = M · いまの向き）。
 *
 * 6 面法の鏡像の解は、軸も静止で読む重力も基板の Z を裏返した形（S = diag(1, 1, −1)）。「鉛直を合わせる」は
 * その重力を真上へ回し、基板の X 軸の方角を保つ（`calibrationSuggest.ts` の `suggestRotation`）。いま基板の中で
 * 読む重力は g = Bᵀ·上（B の 3 行目）なので、もう一方の解を入れていれば、向きは B·R になる —— R は基板の X 軸
 * まわりの回転で、S·g を g へ送る（X 軸は S で動かないので、地面での X 軸の向きも B と同じ）。
 * よって M = B · R · S · Bᵀ。**基板の Z が水平なら R は単位で、M は基板の Z に沿った裏返しになる。**
 * 平置きなら R は X 軸まわりの半回転で、M は基板の Y に沿った裏返しになる。
 *
 * **前提は、いまの向きが「方角を保って鉛直を合わせた」ものであること**（6 面法の後に「鉛直を合わせる」を
 * 押した、いつもの手順）。方角を入れずに鉛直を合わせた・向きを手で入れた設定では、もう一方の解を入れていた
 * ときの向きが B·R とは限らず、M は本当の鏡像の側からずれうる。いまの向きが正しければ、ずれた M が
 * 本当の向きより揺れに合うことは無いので、外れるのは鏡像を見逃す側（いまの向きが鏡像なのに票が割れる）。
 */
export function mirrorCounterpart(orientation: Mat3): Mat3 {
  const gy = orientation[2][1]
  const gz = orientation[2][2]
  // (gy, −gz) を (gy, gz) へ送る角。X 軸が真上・真下なら gy = gz = 0 で、回さない。
  const theta = 2 * Math.atan2(gz, gy)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const r: Mat3 = [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ]
  const flip: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ]
  return mul(mul(mul(orientation, r), flip), transpose(orientation))
}

export interface MirrorComparison {
  /** いまの向きのままで解いた東・北・上と、3 軸の側との相関。 */
  readonly current: number
  /** 鏡像の解を入れていた場合の向き（`mirrorCounterpart`）で解いた東・北・上と、3 軸の側との相関。 */
  readonly mirrored: number
  /** 両方が揃った目盛りの数。解けない形（軸が 3 方向へ散っていない）なら 0。 */
  readonly aligned: number
}

export interface MirrorInput {
  /** 2 軸の基板の軸ごとの列（帯域を切り出し、時刻を揃えた後。欠けは NaN）。 */
  readonly signals: readonly Float64Array[]
  /** 各軸の測る向き（地面の座標＝東・北・上。いまの設定）。 */
  readonly directions: readonly Vec3[]
  /** 基板の向き（基板の座標 → 地面の座標。いまの設定）。鏡像の側の向きはここから作る（`mirrorCounterpart`）。 */
  readonly orientation: Mat3
  /** 同じ観測点の 3 軸のセンサーが測った東・北・上（同じ目盛り）。 */
  readonly ref: readonly [Float64Array, Float64Array, Float64Array]
}

type Ground = readonly [Float64Array, Float64Array, Float64Array]

function invert3(m: readonly (readonly number[])[]): number[][] | null {
  const [a, b, c] = m as [number[], number[], number[]]
  const det = a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)
  if (!(Math.abs(det) > MIN_SPREAD_DET)) return null
  return [
    [b[1]! * c[2]! - b[2]! * c[1]!, a[2]! * c[1]! - a[1]! * c[2]!, a[1]! * b[2]! - a[2]! * b[1]!],
    [b[2]! * c[0]! - b[0]! * c[2]!, a[0]! * c[2]! - a[2]! * c[0]!, a[2]! * b[0]! - a[0]! * b[2]!],
    [b[0]! * c[1]! - b[1]! * c[0]!, a[1]! * c[0]! - a[0]! * c[1]!, a[0]! * b[1]! - a[1]! * b[0]!],
  ].map((row) => row.map((v) => v / det))
}

/** 全部の軸から東・北・上を最小二乗で解く。軸が 3 方向へ散っていなければ null。 */
function solveGround(signals: readonly Float64Array[], dirs: readonly Vec3[], length: number): Ground | null {
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const d of dirs) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a]![b]! += d[a]! * d[b]!
  const inv = invert3(m)
  if (inv === null) return null
  const out: Ground = [0, 1, 2].map(() => new Float64Array(length).fill(Number.NaN)) as unknown as Ground
  const r = [0, 0, 0]
  for (let i = 0; i < length; i++) {
    r[0] = 0
    r[1] = 0
    r[2] = 0
    let ok = true
    for (let j = 0; j < dirs.length; j++) {
      const y = signals[j]![i]!
      if (Number.isNaN(y)) {
        ok = false
        break
      }
      for (let a = 0; a < 3; a++) r[a]! += dirs[j]![a]! * y
    }
    if (!ok) continue
    for (let a = 0; a < 3; a++) out[a]![i] = inv[a]![0]! * r[0]! + inv[a]![1]! * r[1]! + inv[a]![2]! * r[2]!
  }
  return out
}

function correlation(x: Ground, ref: Ground): { r: number; aligned: number } {
  let mm = 0
  let ii = 0
  let mi = 0
  let aligned = 0
  for (let i = 0; i < x[0].length; i++) {
    let ok = true
    for (let a = 0; a < 3; a++) if (Number.isNaN(x[a]![i]!) || Number.isNaN(ref[a]![i]!)) ok = false
    if (!ok) continue
    for (let a = 0; a < 3; a++) {
      mm += ref[a]![i]! * ref[a]![i]!
      ii += x[a]![i]! * x[a]![i]!
      mi += ref[a]![i]! * x[a]![i]!
    }
    aligned++
  }
  const den = Math.sqrt(mm * ii)
  return { r: den > 0 ? mi / den : 0, aligned }
}

/** 1 つの揺れについて、いまの向きと鏡像の側の向きの相関を比べる。 */
export function compareMirror(input: MirrorInput): MirrorComparison {
  const length = Math.min(...input.ref.map((s) => s.length), ...input.signals.map((s) => s.length))
  const cur = solveGround(input.signals, input.directions, length)
  const m = mirrorCounterpart(input.orientation)
  const flipped = solveGround(
    input.signals,
    input.directions.map((d) => applyMat3(m, d)),
    length,
  )
  if (cur === null || flipped === null) return { current: 0, mirrored: 0, aligned: 0 }
  const a = correlation(cur, input.ref)
  const b = correlation(flipped, input.ref)
  return { current: a.r, mirrored: b.r, aligned: Math.min(a.aligned, b.aligned) }
}

export type MirrorVote = 'mirrored' | 'ok'

/**
 * 1 つの揺れの票。ノイズに埋もれた揺れ・短すぎる揺れは票にしない（null）。**勝った側の相関が正で下限以上の
 * ときだけ票にする** —— どちらも逆相関（どちらの向きも合っていない）なら、符号付きの大小で「ましな側」を
 * 選ぶと、軸の符号まで取り違えた基板で「いまの向き」の票が溜まり、鏡像の警告を打ち消してしまう。
 */
export function voteOf(c: MirrorComparison): MirrorVote | null {
  if (c.aligned < MIRROR_MIN_ALIGNED) return null
  if (Math.max(c.current, c.mirrored) < MIRROR_MIN_CORRELATION) return null
  return c.mirrored > c.current ? 'mirrored' : 'ok'
}

export interface MirrorVerdict {
  readonly warn: boolean
  readonly mirrored: number
  readonly ok: number
}

/** 票を集めて、警告するかを決める。 */
export function mirrorVerdict(votes: readonly MirrorVote[]): MirrorVerdict {
  const mirrored = votes.filter((v) => v === 'mirrored').length
  const ok = votes.length - mirrored
  return { warn: mirrored >= MIRROR_WARN_VOTES && mirrored > ok, mirrored, ok }
}
