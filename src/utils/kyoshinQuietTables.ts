/**
 * 強震モニタの「平常のゆらぎの表」の形と、平常の日の秒フレームからそれを数える部品。
 *
 * 表は 2 つの使い道を持つ。
 * - `tails` / `glob`: 統計の検知器が、観測点ごとに「上がり y がこの段以上になる確率」を引く。
 *   珍しい上がりほど点数が高くなる。数が少ない点は全体の確率（`glob`）へ寄せて使う
 * - `fire`: 波面の検知器が、観測点ごとの発火のしきい値（何段の上がりで「揺れ始め」と見るか）を決める
 *
 * 焼くのは `scripts/build-kyoshin-quiet-tables.ts`（生成物は `public/data/kyoshin-quiet-tables.json`）。
 * 数え方は組み合わせの検知器を作ったときの評価と同じにしてある —— 変えると、評価で測った検知率と誤報の率が成り立たなくなる。
 */
import { KMAX, NONE, OnsetFeatures } from './kyoshinOnsetFeatures'

/** 観測点ごとの上がりの数。配列の添字 k−1 が「上がり ≥ k 段」の秒数（k = 1〜KMAX）。 */
export interface TailCounts {
  /** 上がりを判定できた秒数 */
  n: number
  /** 直近 6 秒の内に新しく達し、いまも保っている段（y） */
  y: number[]
  /** 同じものを 3 秒の窓で見たもの（y3） */
  y3: number[]
}

export interface QuietTables {
  version: 1
  /** 焼いた平常の日（日本時間の YYYYMMDD） */
  days: string[]
  /** 全点を合わせた数 */
  glob: TailCounts
  /** 観測点ごとの数（キーは `quietSiteKey`） */
  tails: Record<string, TailCounts>
  /** 観測点ごとの、3〜59 秒前の最大からの上がりが 1〜5 段以上になった 1 時間あたりの秒数 */
  fire: Record<string, number[]>
}

/** 表のキー。強震モニタの観測点の座標（0.1 度刻み）をそのまま文字列にする。座標が重なる観測点は同じキーを共有する。 */
export const quietSiteKey = (site: readonly [number, number]): string => `${site[0]},${site[1]}`

/** これ以上空いたら、上がりの基準を数え直す（ミリ秒）。途切れの前の値から上がりを数えないため。 */
const RESET_GAP_MS = 60_000
/** 雑音の表に載せるのに要る、判定できた秒数。これより短い点は率が当てにならない。 */
export const FIRE_MIN_SEC = 3600
/**
 * 発火の基準の窓（秒）。FIRE_LAG〜FIRE_L−1 秒前（3〜59 秒前）の最大を見る。波面の検知器の発火
 * （`kyoshinClusterDetector.ts` の `L`・`LAG`）と同じ窓にしておく —— しきい値はこの表から決まるので、
 * 窓がずれると、検知器が比べる上がりと表が数えた上がりが別のものになる。
 */
export const FIRE_L = 60
export const FIRE_LAG = 3
/** 雑音の表に持つ段差の数（1〜5 段以上）。 */
const FIRE_STEPS = 5

const emptyTail = (): TailCounts => ({ n: 0, y: new Array(KMAX).fill(0), y3: new Array(KMAX).fill(0) })

const isTail = (v: unknown): v is TailCounts => {
  const t = v as TailCounts | null
  return !!t && typeof t === 'object' && typeof t.n === 'number' && t.n > 0
    && Array.isArray(t.y) && t.y.length === KMAX && Array.isArray(t.y3) && t.y3.length === KMAX
}

/**
 * 表の中身を検分する。崩れていれば投げる。
 *
 * 配信の破損で空の表が 200 で返ると、検知器は全点を全体の確率で動かすことになり、
 * 検知の具合が黙って変わる。観測点ごとの表は全件を見る（1 点でも形が崩れていれば、その点の確率が NaN になる）。
 * 読み込みの口（`kyoshinQuietTablesLoader.ts`）と評価台（`scripts/bench-kyoshin.ts`）が使う。
 */
export function validateQuietTables(raw: unknown): asserts raw is QuietTables {
  const t = raw as QuietTables | null
  if (!t || typeof t !== 'object' || t.version !== 1) throw new Error('平常のゆらぎの表の形が崩れている（版が違う）')
  if (!Array.isArray(t.days) || t.days.some(d => typeof d !== 'string')) throw new Error('平常のゆらぎの表の日の一覧が崩れている')
  if (!isTail(t.glob) || !isCountTail(t.glob)) throw new Error('平常のゆらぎの表の全体の数が崩れている')
  if (!t.tails || typeof t.tails !== 'object' || Object.keys(t.tails).length === 0) throw new Error('平常のゆらぎの表に観測点ごとの数が無い')
  if (!t.fire || typeof t.fire !== 'object' || Object.keys(t.fire).length === 0) throw new Error('平常のゆらぎの表に雑音の表が無い')
  for (const [k, v] of Object.entries(t.tails)) if (!isTail(v) || !isCountTail(v)) throw new Error(`平常のゆらぎの表の ${k} の数が崩れている`)
  for (const [k, v] of Object.entries(t.fire)) {
    if (!Array.isArray(v) || v.length !== FIRE_STEPS || v.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`平常のゆらぎの表の ${k} の雑音の率が崩れている`)
  }
}

/**
 * 端末で数えた分の版。**数え方を変えたら上げる** —— 端末に残った古い数え方の分は、版が違えば読み込みで捨てて
 * 数え直す（{@link isQuietCounts}）。混ぜると、新しい数え方の表に古い数え方の回数が足し込まれる。
 * 2: 雑音の表の窓を 4〜60 秒前から 3〜59 秒前（`FIRE_LAG`〜`FIRE_L`−1）へ揃えた
 */
export const QUIET_COUNTS_VERSION = 2

/** 端末で数えた分。表（`QuietTables`）と違い、雑音の表を率ではなく秒と回数のまま持つ（あとから足し合わせるため）。 */
export interface QuietCounts {
  version: typeof QUIET_COUNTS_VERSION
  glob: TailCounts
  tails: Record<string, TailCounts>
  /** 観測点ごとの、判定できた秒と、3〜59 秒前の最大からの上がりが 1〜5 段以上になった回数 */
  fire: Record<string, { sec: number; hits: number[] }>
}

export const EMPTY_QUIET_COUNTS: QuietCounts = { version: QUIET_COUNTS_VERSION, glob: emptyTail(), tails: {}, fire: {} }

const isCount = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0
const isCountTail = (v: unknown): boolean => {
  const t = v as TailCounts | null
  return !!t && typeof t === 'object' && isCount(t.n)
    && Array.isArray(t.y) && t.y.length === KMAX && t.y.every(isCount)
    && Array.isArray(t.y3) && t.y3.length === KMAX && t.y3.every(isCount)
}

/**
 * 端末に残した数（{@link QuietCounts}）の形を確かめる。表の検分（{@link validateQuietTables}）と違い、
 * 数え始めで判定できた秒が 0 の点も通す。端末の保存領域から読み戻した値は壊れていることがあるので、
 * 1 つでも数でない・負の値・並びの長さ違いがあれば使わない（混ぜた表の確率が NaN になる）。
 */
export function isQuietCounts(raw: unknown): raw is QuietCounts {
  const c = raw as QuietCounts | null
  if (!c || typeof c !== 'object' || c.version !== QUIET_COUNTS_VERSION || !isCountTail(c.glob)) return false
  if (!c.tails || typeof c.tails !== 'object' || !Object.values(c.tails).every(isCountTail)) return false
  if (!c.fire || typeof c.fire !== 'object') return false
  return Object.values(c.fire).every(f => !!f && typeof f === 'object' && isCount(f.sec)
    && Array.isArray(f.hits) && f.hits.length === FIRE_STEPS && f.hits.every(isCount))
}

/**
 * 配る表に端末で数えた分を混ぜる。配る表は 1 点あたり `priorSec` 秒ぶんの重みで頭打ちにするので、
 * 端末で数えた秒が増えるほど端末の率へ寄る。端末で 1 秒も数えていなければ配る表の率のまま。
 */
export function blendQuietTables(prior: QuietTables, learned: QuietCounts, priorSec: number): QuietTables {
  const mix = (p: TailCounts | undefined, l: TailCounts | undefined, cap: number): TailCounts | null => {
    const s = p && p.n > 0 ? Math.min(1, cap / p.n) : 0
    const n = (p ? p.n * s : 0) + (l ? l.n : 0)
    if (!(n > 0)) return null
    const sum = (a: number[] | undefined, b: number[] | undefined) =>
      Array.from({ length: KMAX }, (_, k) => (a ? a[k] * s : 0) + (b ? b[k] : 0))
    return { n, y: sum(p?.y, l?.y), y3: sum(p?.y3, l?.y3) }
  }
  const tails: Record<string, TailCounts> = {}
  for (const k of new Set([...Object.keys(prior.tails), ...Object.keys(learned.tails)])) {
    const m = mix(prior.tails[k], learned.tails[k], priorSec)
    if (m) tails[k] = m
  }
  // 全体の数は点の数ぶんの重みで頭打ちにする（点ごとの頭打ちと釣り合わせる）
  const glob = mix(prior.glob, learned.glob, priorSec * Math.max(1, Object.keys(prior.tails).length)) ?? emptyTail()
  const fire: Record<string, number[]> = {}
  for (const k of new Set([...Object.keys(prior.fire), ...Object.keys(learned.fire)])) {
    const p = prior.fire[k], l = learned.fire[k]
    const sec = (p ? priorSec : 0) + (l ? l.sec : 0)
    if (sec < FIRE_MIN_SEC) continue
    const hits = Array.from({ length: FIRE_STEPS }, (_, t) => (p ? p[t] * priorSec / 3600 : 0) + (l ? l.hits[t] : 0))
    fire[k] = hits.map(h => +(h / (sec / 3600)).toFixed(3))
  }
  return { version: 1, days: prior.days, glob, tails, fire }
}

export class QuietTableBaker {
  private readonly glob = emptyTail()
  private readonly tails = new Map<string, TailCounts>()
  private readonly fireSec = new Map<string, number>()
  private readonly fireHits = new Map<string, number[]>()

  private cfg: string | null = null
  private prevMs = -Infinity
  private features: OnsetFeatures | null = null
  private siteTails: TailCounts[] = []
  private siteKeys: string[] = []
  private fireRing = new Int16Array(0)
  private firePos = 0
  private fireFilled = 0

  /**
   * 1 秒ぶんを入れる。`values` は観測点の並び（-1 = 欠測）。
   * `count` が偽の秒は、上がりを測る直前の値としては使うが数には足さない（揺れ検知が出ていた秒を「普段」と覚えないため。
   * 入れずに飛ばすと、60 秒を超える途切れとして測り直しになり、前後の秒まで数え損ねる）。
   */
  feed(ms: number, cfg: string, sites: readonly (readonly [number, number])[], values: ArrayLike<number>, count: boolean): void {
    const n = sites.length
    if (values.length !== n) throw new Error(`観測点の数（${n}）と値の数（${values.length}）が食い違っています（${cfg}）`)
    // 時刻が巻き戻ったとき（端末で時間軸が替わったとき）も、前の値から上がりを数えないよう数え直す
    if (this.features === null || cfg !== this.cfg || ms - this.prevMs > RESET_GAP_MS || ms <= this.prevMs) this.reset(cfg, sites)
    this.prevMs = ms
    this.countTails(values, count)
    this.countFire(values, count)
  }

  /** いま持っている数の写し。端末に残して、次に開いたときに `fromCounts` で戻す。 */
  counts(): QuietCounts {
    const copy = (t: TailCounts): TailCounts => ({ n: t.n, y: [...t.y], y3: [...t.y3] })
    const tails: Record<string, TailCounts> = {}
    for (const [k, c] of this.tails) tails[k] = copy(c)
    const fire: Record<string, { sec: number; hits: number[] }> = {}
    for (const [k, sec] of this.fireSec) fire[k] = { sec, hits: [...(this.fireHits.get(k) ?? new Array(FIRE_STEPS).fill(0))] }
    return { version: QUIET_COUNTS_VERSION, glob: copy(this.glob), tails, fire }
  }

  /** 書き出した数から作り直す。上がりを測る直前の値は持ち越さない（次の秒から測り直す）。 */
  static fromCounts(c: QuietCounts): QuietTableBaker {
    const b = new QuietTableBaker()
    b.glob.n = c.glob.n
    b.glob.y.splice(0, KMAX, ...c.glob.y)
    b.glob.y3.splice(0, KMAX, ...c.glob.y3)
    for (const [k, t] of Object.entries(c.tails)) b.tails.set(k, { n: t.n, y: [...t.y], y3: [...t.y3] })
    for (const [k, f] of Object.entries(c.fire)) { b.fireSec.set(k, f.sec); b.fireHits.set(k, [...f.hits]) }
    return b
  }

  /**
   * 数をすべて `factor` 倍にして、古い秒の重みを落とす。観測点の入れ替えや年単位の変化に追いつくため。
   * 割合なので、点ごとの率（上がりの数 / 判定できた秒）は変えない。
   */
  decay(factor: number): void {
    if (!(factor > 0 && factor <= 1)) throw new Error(`薄める割合は 0 より大きく 1 以下にしてください（${factor}）`)
    const scale = (t: TailCounts) => {
      t.n *= factor
      for (let k = 0; k < KMAX; k++) { t.y[k] *= factor; t.y3[k] *= factor }
    }
    scale(this.glob)
    for (const t of this.tails.values()) scale(t)
    for (const [k, sec] of this.fireSec) this.fireSec.set(k, sec * factor)
    for (const hits of this.fireHits.values()) for (let t = 0; t < hits.length; t++) hits[t] *= factor
  }

  result(days: string[]): QuietTables {
    const tails: Record<string, TailCounts> = {}
    for (const [k, c] of this.tails) if (c.n > 0) tails[k] = c
    const fire: Record<string, number[]> = {}
    for (const [k, sec] of this.fireSec) {
      if (sec < FIRE_MIN_SEC) continue
      const hits = this.fireHits.get(k) ?? new Array(FIRE_STEPS).fill(0)
      fire[k] = hits.map(h => +(h / (sec / 3600)).toFixed(3))
    }
    return { version: 1, days, glob: this.glob, tails, fire }
  }

  private reset(cfg: string, sites: readonly (readonly [number, number])[]): void {
    const n = sites.length
    this.cfg = cfg
    this.features = new OnsetFeatures(n)
    this.siteKeys = sites.map(quietSiteKey)
    this.siteTails = this.siteKeys.map(k => {
      let c = this.tails.get(k)
      if (!c) { c = emptyTail(); this.tails.set(k, c) }
      return c
    })
    this.fireRing = new Int16Array(n * FIRE_L).fill(-1)
    this.firePos = 0
    this.fireFilled = 0
  }

  private countTails(values: ArrayLike<number>, count: boolean): void {
    const F = this.features!
    F.push(values)
    if (!count) return
    const g = this.glob
    for (let i = 0; i < F.n; i++) {
      if (F.x[i] === NONE) continue
      const a = this.siteTails[i]
      a.n++; g.n++
      for (let k = 1; k <= Math.min(F.y[i], KMAX); k++) { a.y[k - 1]++; g.y[k - 1]++ }
      for (let k = 1; k <= Math.min(F.y3[i], KMAX); k++) { a.y3[k - 1]++; g.y3[k - 1]++ }
    }
  }

  private countFire(values: ArrayLike<number>, count: boolean): void {
    const n = this.siteKeys.length, ring = this.fireRing, pos = this.firePos
    if (count && this.fireFilled >= FIRE_L) {
      for (let i = 0; i < n; i++) {
        const v = values[i]
        if (v < 0) continue
        // 輪の pos はまだ書いていない枠（= FIRE_L 秒前の値）、pos − d が d 秒前の値
        let mx = -1
        for (let d = FIRE_LAG; d < FIRE_L; d++) {
          const x = ring[((pos - d + FIRE_L) % FIRE_L) * n + i]
          if (x > mx) mx = x
        }
        if (mx < 0) continue
        const key = this.siteKeys[i]
        this.fireSec.set(key, (this.fireSec.get(key) ?? 0) + 1)
        const e = v - mx
        if (e < 1) continue
        let hits = this.fireHits.get(key)
        if (!hits) { hits = new Array(FIRE_STEPS).fill(0); this.fireHits.set(key, hits) }
        for (let t = 1; t <= FIRE_STEPS; t++) if (e >= t) hits[t - 1]++
      }
    }
    for (let i = 0; i < n; i++) ring[pos * n + i] = values[i]
    this.firePos = (pos + 1) % FIRE_L
    this.fireFilled++
  }
}
