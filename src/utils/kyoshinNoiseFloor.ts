/**
 * 観測点ごとの慢性ノイズ床の学習。強震モニタの震度0 未満の点を地図に出すかの絞り込み
 * （`kyoshinSubThresholdFilter.ts`）が使う。
 *
 * 旧い揺れ検知エンジンが検知のために持っていた点別床の学習を、そのまま切り出したもの
 * （2026-10-28 ユーザー選択「旧エンジンの学習部分だけ残す」）。検知は組み合わせの検知器が受け持つので、
 * ここは床を学ぶだけで、検知の判定はしない。
 *
 * ## 何を学ぶか
 *
 * 点ごとに、揺れていないときの値の平均（`floorMean`）とばらつき（`floorDev`）を 15 分の時定数で追う。
 * 床 ＝ 平均 ＋ 3 × ばらつき（上限 1.5）。都市部の常時微振動点のように平常から値の高い点ほど床が上がる。
 *
 * **揺れている点からは学ばない。** 次のどれかに当たる点はそのフレームの学習を飛ばす。
 * - いまの値が床以上（`levelActive`）
 * - 直近 10 分のうちに立ち上がった（`FLOOR_FREEZE_MS`。揺れの余韻を床として覚えないため）
 *
 * 旧エンジンはこれに「近傍と同時に立ち上がった点」も加えていたが、その点は必ず直近 4 秒に立ち上がっている
 * ので 10 分の凍結に含まれ、結果は変わらない。そのため近傍のつながりはここでは持たない。
 *
 * ## 時間軸の扱い
 *
 * フレームの間隔が `MAX_RESUME_GAP_MS` を超えた（または巻き戻った）ら履歴と立ち上がり時刻を捨て、床だけ残す。
 * `MAX_DT_GAP_MS` を超えてそれ以内の途絶明けは、履歴を捨てたうえでそのフレームの学習を飛ばす（途絶の間の
 * 重みを 1 サンプルに背負わせないため）。どちらも旧エンジンと同じ。
 */
import { computeSiteKeys, ewmaAlpha, indexToValue } from './kyoshinSiteKeys'

/** 床の学習時定数（ms）。慢性ノイズを捉えるため分のオーダー */
export const FLOOR_TAU_MS = 900_000
/**
 * 立ち上がった点の学習を止める長さ（ms）。揺れが収まりかけの残りの変動を静穏点の床として覚えると、群発地震で
 * 床が上がり続けて余震が見えなくなる（2026-07-28 熊本の群発で、本震後 8 分間の震度1 相当の余震 5 件が無反応だった）
 */
export const FLOOR_FREEZE_MS = 600_000
/** 床 ＝ floorMean ＋ この係数 × floorDev */
export const FLOOR_SIGMA_K = 3.0
/** 床を「平常を超えた」の判定に使うときの下限（value） */
export const FLOOR_MIN = 0.0
/** 床の上限（value）。慢性ノイズ点でも鈍くしすぎない */
export const FLOOR_CAP = 1.5
/** 床への上乗せ（value）。value ≥ 床 ＋ これ で「平常を超えた」 */
export const LEVEL_MARGIN = 0.0
/** これ未満の値は常に平常（value。-1.5 = インデックス 3） */
export const TRIG_FLOOR = -1.5
/** 立ち上がりとみなす上昇量の下限（value） */
export const RATE_MIN = 0.5
/** 上昇量を測る窓（ms） */
export const RATE_DT_MS = 2_500
/** これを超えて空いたら途絶明けとして、履歴を捨ててそのフレームは学ばない（ms） */
export const MAX_DT_GAP_MS = 10_000
/** これを超えて空いたら（または巻き戻ったら）、床だけ残して作り直す（ms） */
export const MAX_RESUME_GAP_MS = 60_000

/** 観測点 1 点の状態 */
export interface NoiseFloorSite {
  /** 平常の値の平均（value） */
  floorMean: number
  /** 平常の値のばらつき（|value − floorMean| の平均） */
  floorDev: number
  /** 直近のサンプル（上昇量を測る窓のぶん） */
  hist: { t: number; v: number }[]
  /** 最後に立ち上がった時刻（ms）。無ければ null */
  triggeredAtMs: number | null
}

export interface NoiseFloorState {
  /** 観測点のキー（`computeSiteKeys`。座標が重なる点は別のキー）→ 状態 */
  sites: Record<string, NoiseFloorSite>
  /** 最後に食わせたフレームのデータ時刻（ms） */
  lastDataTimeMs: number
}

/** 永続化する部分。床が既定から動いた点だけを持つ（静穏点は省く） */
export interface NoiseFloorSnapshot {
  /** 観測点のキー → [floorMean, floorDev] */
  floors: Record<string, [number, number]>
}

export function initNoiseFloorState(dataTimeMs = 0): NoiseFloorState {
  return { sites: {}, lastDataTimeMs: dataTimeMs }
}

/** 震度0 未満の絞り込みに使う床（value）。下限は置かず、上限 `FLOOR_CAP` だけで頭を押さえる */
export function chronicNoiseFloor(s: Pick<NoiseFloorSite, 'floorMean' | 'floorDev'>): number {
  return Math.min(s.floorMean + FLOOR_SIGMA_K * s.floorDev, FLOOR_CAP)
}

/** 「平常を超えた」の判定に使う床（value）。`[FLOOR_MIN, FLOOR_CAP]` に収める */
function triggerFloor(s: NoiseFloorSite): number {
  return Math.min(Math.max(s.floorMean + FLOOR_SIGMA_K * s.floorDev, FLOOR_MIN), FLOOR_CAP)
}

function pushHist(hist: { t: number; v: number }[], t: number, v: number): void {
  hist.push({ t, v })
  const cutoff = t - RATE_DT_MS * 2
  while (hist.length > 2 && hist[0].t < cutoff) hist.shift()
}

/** 窓の起点（now − RATE_DT_MS 以前で最新のサンプル。0.5 秒の許容つき）からの上昇量。起点が無ければ null */
function windowRate(hist: { t: number; v: number }[], now: number): number | null {
  const target = now - RATE_DT_MS
  let baseline: { t: number; v: number } | null = null
  for (const s of hist) {
    if (s.t <= target + 500) baseline = s
  }
  if (!baseline) return null
  return hist[hist.length - 1].v - baseline.v
}

/**
 * 1 フレーム（1 秒ぶん）を食わせて、次の状態を返す（純粋。`state` は書き換えない）。
 *
 * @param keys 観測点の並びと同じ並びのキー（`noiseFloorKeys`）。観測点集合ごとに一度作って使い回す
 * @param values 計測震度のインデックス（Yahoo の生の値。負は欠測）
 */
export function stepNoiseFloor(
  state: NoiseFloorState,
  dataTimeMs: number,
  values: ArrayLike<number>,
  keys: readonly string[],
): NoiseFloorState {
  if (values.length !== keys.length) throw new Error(`観測点の数（${keys.length}）と値の数（${values.length}）が食い違っています`)
  const now = dataTimeMs
  const dtMs = now - state.lastDataTimeMs
  const sites: Record<string, NoiseFloorSite> = {}

  if (dtMs <= 0 || dtMs > MAX_RESUME_GAP_MS) {
    // 作り直し。床は引き継ぎ、履歴と立ち上がりだけ捨てる。このフレームは学ばない
    for (let i = 0; i < values.length; i++) {
      const key = keys[i]
      const prior = state.sites[key]
      if (values[i] < 0) {
        if (prior) sites[key] = { floorMean: prior.floorMean, floorDev: prior.floorDev, hist: [], triggeredAtMs: null }
        continue
      }
      const value = indexToValue(values[i])
      sites[key] = prior
        ? { floorMean: prior.floorMean, floorDev: prior.floorDev, hist: [{ t: now, v: value }], triggeredAtMs: null }
        : { floorMean: value, floorDev: 0, hist: [{ t: now, v: value }], triggeredAtMs: null }
    }
    return { sites, lastDataTimeMs: now }
  }

  const resumedAfterGap = dtMs > MAX_DT_GAP_MS
  const a = ewmaAlpha(dtMs, FLOOR_TAU_MS)
  for (let i = 0; i < values.length; i++) {
    const key = keys[i]
    const prev = state.sites[key]
    if (values[i] < 0) {
      // 欠測でも床は残す（落とすと次に値が届いたとき既定から学び直しになる）。履歴は捨てる
      if (prev) sites[key] = { ...prev, hist: [] }
      continue
    }
    const value = indexToValue(values[i])
    if (!prev) {
      sites[key] = { floorMean: value, floorDev: 0, hist: [{ t: now, v: value }], triggeredAtMs: null }
      continue
    }
    const hist = resumedAfterGap ? [] : [...prev.hist]
    pushHist(hist, now, value)
    const levelActive = value >= triggerFloor(prev) + LEVEL_MARGIN && value >= TRIG_FLOOR
    const rate = windowRate(hist, now)
    const onset = levelActive && rate != null && rate >= RATE_MIN
    const triggeredAtMs = onset ? now : prev.triggeredAtMs
    let { floorMean, floorDev } = prev
    const frozen = levelActive || (triggeredAtMs != null && now - triggeredAtMs <= FLOOR_FREEZE_MS)
    if (!resumedAfterGap && !frozen) {
      floorMean = floorMean + a * (value - floorMean)
      floorDev = floorDev + a * (Math.abs(value - floorMean) - floorDev)
    }
    sites[key] = { floorMean, floorDev, hist, triggeredAtMs }
  }
  return { sites, lastDataTimeMs: now }
}

/** 「今揺れ始めた点」とみなす、立ち上がりからの長さ（ms） */
export const RECENT_ONSET_MS = 8_000

/**
 * いまのフレームで値が届いた点のうち、直近 `RECENT_ONSET_MS` に立ち上がった点のキー。
 * 表示側が「今揺れ始めた点」と「揺れが去った後の残り」を分けるのに使う。
 *
 * @param values `stepNoiseFloor` に渡したのと同じフレームの値（欠測の点は数えない）
 */
export function recentOnsetKeys(state: NoiseFloorState, values: ArrayLike<number>, keys: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < keys.length; i++) {
    if (values[i] < 0) continue
    const t = state.sites[keys[i]]?.triggeredAtMs
    if (t != null && state.lastDataTimeMs - t <= RECENT_ONSET_MS) out.push(keys[i])
  }
  return out
}

/** 観測点の並びに対応するキー。座標が重なる点は別のキーになる */
export function noiseFloorKeys(sites: readonly (readonly [number, number])[]): readonly string[] {
  return computeSiteKeys(sites.map(([lat, lng]) => [lat, lng]))
}

/** 観測点の並びの順に、絞り込みに使う床を返す。まだ学んでいない点は 0 */
export function noiseFloorsFor(state: NoiseFloorState, keys: readonly string[]): number[] {
  return keys.map((k) => {
    const s = state.sites[k]
    return s ? chronicNoiseFloor(s) : 0
  })
}

/** 永続化する形へ。床が既定から動いた点だけを残す */
export function extractNoiseFloors(state: NoiseFloorState): NoiseFloorSnapshot {
  const floors: Record<string, [number, number]> = {}
  for (const [k, s] of Object.entries(state.sites)) {
    if (s.floorMean > 0.05 || s.floorDev > 0.05) floors[k] = [s.floorMean, s.floorDev]
  }
  return { floors }
}

/** 永続化した床から状態を作る。履歴と立ち上がりは持たない */
export function hydrateNoiseFloors(snapshot: NoiseFloorSnapshot, dataTimeMs = 0): NoiseFloorState {
  const sites: Record<string, NoiseFloorSite> = {}
  for (const [k, [floorMean, floorDev]] of Object.entries(snapshot.floors)) {
    if (!Number.isFinite(floorMean) || !Number.isFinite(floorDev)) continue
    sites[k] = { floorMean, floorDev, hist: [], triggeredAtMs: null }
  }
  return { sites, lastDataTimeMs: dataTimeMs }
}
