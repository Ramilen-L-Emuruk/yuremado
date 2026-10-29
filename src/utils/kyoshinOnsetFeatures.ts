/**
 * 強震モニタの観測点ごとに「いまの新しい上がり」を数える部品。
 *
 * 平常のゆらぎの表を焼くスクリプト（`scripts/build-kyoshin-quiet-tables.ts`）と、組み合わせの検知器の統計の部分が
 * 同じものを使う。表を焼いたときと検知するときで数え方がずれると、表の確率がその点の実際の上がりと合わなくなる。
 *
 * - 長い基準 = 6〜65 秒前の有効な値の中央値（直前 5 秒は入れない。立ち上がりで基準が引きずられないため）
 * - 短い基準 = 直前 `SHORT` 秒の有効な値の最小
 * - 上がり x = min(いま − 長い基準, いま − 短い基準)（段）。ゆっくりした上下にも、前から続く高止まりにも反応しない
 */

/** 長い基準の窓の長さ（秒）。 */
export const RING = 66
/** 長い基準に入れない直前の秒数。 */
export const LAG = 5
/** 長い基準を出すのに要る有効な値の数。 */
export const MIN_VALID = 20
/** 数える段の上限。 */
export const KMAX = 12
/** 短い基準の窓の長さ（秒）。 */
export const SHORT = 10
/** y: この秒数の内に新しく達した段だけを数える。 */
export const ONSET_W = 6
/** y3: 近くの点がそろって上がったかを見る狭い窓（秒）。窓を狭くするほど偶然には揃わない。 */
export const ONSET_W3 = 3
/** 判定できないことを表す値。 */
export const NONE = -99

/** 値の段は 0〜20。それより上は 20 に詰める。 */
const LEVELS = 21

export class OnsetFeatures {
  readonly n: number
  /** 観測点 × RING の値（-1 = 欠測） */
  private readonly ring: Int8Array
  private pos = 0
  /** 観測点 × 21（長い基準の窓に入っている値の度数） */
  private readonly hist: Int32Array
  private readonly valid: Int32Array
  /** いまの上がり（NONE = 判定できない） */
  readonly x: Int16Array
  /** 長い基準からの上がり */
  readonly r: Int16Array
  /** 短い基準からの上がり */
  readonly j: Int16Array
  readonly base: Int16Array
  /** 直近 ONSET_W 秒の内に新しく達した段のうち、いまも保っている最大（0 = 無し、NONE = 判定できない） */
  readonly y: Int16Array
  /** y の窓を ONSET_W3 秒にしたもの */
  readonly y3: Int16Array
  /** 最後に判定できた x（初めは 99 = 立ち上がりとして数えない。立ち上げ直後に全点が一斉に上がったように見えるのを防ぐ） */
  private readonly lastX: Int16Array
  /** 観測点 × (KMAX+1): その段へ最後に上がった秒（通し番号） */
  private readonly upAt: Int32Array
  /** y >= 1 になっている今回の立ち上がりの秒（-1 = 無し） */
  readonly up1: Int32Array
  /** 入れた秒の通し番号 */
  t = 0

  constructor(n: number) {
    this.n = n
    this.ring = new Int8Array(n * RING).fill(-1)
    this.hist = new Int32Array(n * LEVELS)
    this.valid = new Int32Array(n)
    this.x = new Int16Array(n).fill(NONE)
    this.r = new Int16Array(n).fill(NONE)
    this.j = new Int16Array(n).fill(NONE)
    this.base = new Int16Array(n)
    this.y = new Int16Array(n).fill(NONE)
    this.y3 = new Int16Array(n).fill(NONE)
    this.lastX = new Int16Array(n).fill(99)
    this.upAt = new Int32Array(n * (KMAX + 1)).fill(-1e9)
    this.up1 = new Int32Array(n).fill(-1)
  }

  /** 1 秒ぶんの値（観測点の並び・-1 = 欠測）を入れる。 */
  push(values: ArrayLike<number>): void {
    const { n, ring, hist, valid } = this
    const p = this.pos
    const inPos = (p - LAG - 1 + RING) % RING // LAG+1 秒前の値（いま長い基準の窓に入る）
    for (let i = 0; i < n; i++) {
      const o = i * RING
      const vin = ring[o + inPos]
      if (vin >= 0) { hist[i * LEVELS + vin]++; valid[i]++ }
      const vout = ring[o + p] // RING 秒前の値（窓から出る）
      if (vout >= 0) { hist[i * LEVELS + vout]--; valid[i]-- }
      let mn = 99, cnt = 0
      for (let s = 1; s <= SHORT; s++) {
        const w = ring[o + (p - s + RING) % RING]
        if (w >= 0) { cnt++; if (w < mn) mn = w }
      }
      const v = values[i]
      ring[o + p] = v < 0 ? -1 : v > 20 ? 20 : v
      let rr = NONE, jj = NONE
      if (v >= 0 && valid[i] >= MIN_VALID) {
        const half = valid[i] >> 1
        let c = 0, b = 0
        for (let k = 0; k < LEVELS; k++) { c += hist[i * LEVELS + k]; if (c > half) { b = k; break } }
        this.base[i] = b
        rr = v - b
      }
      if (v >= 0 && cnt >= 5) jj = v - mn
      this.r[i] = rr
      this.j[i] = jj
      const x = rr === NONE || jj === NONE ? NONE : Math.min(rr, jj)
      this.x[i] = x
      if (x === NONE) { this.y[i] = NONE; this.y3[i] = NONE; continue }
      const lx = this.lastX[i], ub = i * (KMAX + 1)
      for (let k = Math.max(1, lx + 1); k <= Math.min(x, KMAX); k++) this.upAt[ub + k] = this.t
      let y = 0
      for (let k = Math.min(x, KMAX); k >= 1; k--) if (this.t - this.upAt[ub + k] < ONSET_W) { y = k; break }
      this.y[i] = y
      let y3 = 0
      for (let k = Math.min(x, KMAX); k >= 1; k--) if (this.t - this.upAt[ub + k] < ONSET_W3) { y3 = k; break }
      this.y3[i] = y3
      if (x >= 1) { if (this.up1[i] < 0 || lx < 1) this.up1[i] = this.upAt[ub + 1] } else this.up1[i] = -1
      this.lastX[i] = x
    }
    this.t++
    this.pos = (p + 1) % RING
  }
}
