import type { JMAQuake } from '../types/earthquake'
import { extractQuakeEventIdFromId } from './quakeMerge'
import { hasKnownEpicenter } from './geo'
import { formatMagnitude, formatMagnitudeWithCondition } from './formatters'

/**
 * ヒートマップの期間の目盛り。凡例のヒートマップ欄のスライダーで選ぶ（2026-10-25 ユーザー選択「E の案でよい
 * (Recommended)」。10 段・既定 30 日・1919 年まで）。`days` と `years` はどちらか一方だけを持つ。
 * 年は暦で遡る（1 年 = 365 日にすると閏年を跨ぐたびに 1 日ずれる）。
 */
export const HEATMAP_PERIODS = [
  { key: '7d', label: '7日', days: 7 },
  { key: '30d', label: '30日', days: 30 },
  { key: '90d', label: '90日', days: 90 },
  { key: '1y', label: '1年', years: 1 },
  { key: '2y', label: '2年', years: 2 },
  { key: '5y', label: '5年', years: 5 },
  { key: '10y', label: '10年', years: 10 },
  { key: '20y', label: '20年', years: 20 },
  { key: '50y', label: '50年', years: 50 },
  { key: 'all', label: '1919年から' },
] as const satisfies readonly { key: string; label: string; days?: number; years?: number }[]

export type HeatmapPeriod = (typeof HEATMAP_PERIODS)[number]['key']

export const DEFAULT_HEATMAP_PERIOD: HeatmapPeriod = '30d'

export function isHeatmapPeriod(value: unknown): value is HeatmapPeriod {
  return typeof value === 'string' && HEATMAP_PERIODS.some((p) => p.key === value)
}

/** 長期震源カタログの最初の年。「1919年から」の始まり。 */
export const HEATMAP_FIRST_YEAR = 1919

const DAY_MS = 24 * 60 * 60 * 1000
/** 日本時間の時差。年の境目・「1919年から」の始まりは日本時間の暦で決める。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 期間の始まり（UTC epoch ミリ秒）。`nowMs` は「いま」（再生中は再生時刻）。
 * 年で遡る目盛りは日本時間の暦で年だけを引く（2026/10/25 の 1 年前は 2025/10/25）。
 */
export function heatmapPeriodStartMs(period: HeatmapPeriod, nowMs: number): number {
  const def = HEATMAP_PERIODS.find((p) => p.key === period) ?? HEATMAP_PERIODS[1]
  if ('days' in def) return nowMs - def.days * DAY_MS
  if ('years' in def) {
    const jst = new Date(nowMs + JST_OFFSET_MS)
    jst.setUTCFullYear(jst.getUTCFullYear() - def.years)
    return jst.getTime() - JST_OFFSET_MS
  }
  return Date.UTC(HEATMAP_FIRST_YEAR, 0, 1) - JST_OFFSET_MS
}

/** 期間の始まりが日本時間で何年か（完全性の注記と、読む年ファイルを決めるのに使う）。 */
export function jstYearOf(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCFullYear()
}

/** 凡例に出す日付（日本時間・`2026/09/25`）。 */
export function formatHeatmapDate(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}/${mm}/${dd}`
}

/**
 * 地震の時刻が期間（`startMs` から「いま」まで）の中か。**「いま」より後は外す** —— リプレイ中、
 * 再生時刻より後に起きた地震を地図に出さないため。時刻が読めないものも外す。
 */
export function isWithinHeatWindow(timeIso: string, nowMs: number, startMs: number): boolean {
  const t = new Date(timeIso).getTime()
  return Number.isFinite(t) && t <= nowMs && t >= startMs
}

export interface HeatPoint {
  lat: number
  lng: number
  weight: number
  /** 震源地名。DMDSS の GD Earthquake List が返さない場合は空文字。 */
  name: string
  /** 地震の時刻（ISO 文字列）。 */
  time: string
  /** 深さ(km)。不明・未取得は -1（formatDepth が「不明」に落とす）。 */
  depth: number
  /**
   * 深さが「700km以上」という下限だけの値か（`Hypocenter.depthAtLeast`）。吹き出しで「700km以上」と出す。
   * 土台の取得元（P2PQuake・DMDATA の GD Earthquake List）は持たないので常に偽。
   */
  depthAtLeast: boolean
  /**
   * マグニチュード。**不明は -1 に揃えて持つ**（`heatMagnitude` を通す）。DMDATA の電文は不明を
   * `NaN` で持つが、`NaN` は土台のキャッシュ（JSON）を通ると `null` に化け、読み戻した側の
   * `Number(null)` が 0 になって「M0.0」と出る。
   */
  magnitude: number
  /**
   * 規模が数値で求まらないときに気象庁が添えた説明（`Hypocenter.magnitudeCondition`）。無ければ `null`。
   *
   * **「M 不明」と「Ｍ８を超える巨大地震」を見分けるための欄。** どちらも `magnitude` は数値に
   * ならないので、これが無いと最大級の地震が最も薄い点になる。`undefined` ではなく `null` で
   * 持つのは、土台のキャッシュ（JSON）を通っても欄が消えないようにするため。
   * 土台の取得元（P2PQuake・DMDATA の GD Earthquake List）は説明を返さないので、常に `null`。
   */
  magnitudeCondition: string | null
  /**
   * この点にまとめた地震の数。1 つの地震なら 1。長い期間で格子にまとめた点（`gridHeatPoints`）は 2 以上になりうる。
   * 2 以上の点では `name`・`depth` は持たず、`magnitude` は格子の中の最大、`time` は最も新しい地震の時刻。
   */
  count: number
}

/**
 * 「Ｍ８を超える巨大地震」を表す説明の原文（全角）。電文解説資料の値で、
 * `bufrEstimatedIntensity.ts` の `MAG_CONDITION_HUGE` と同じ文字列（一致はテストで確かめる）。
 * あちらは二進電文の復号器なので、ヒートマップから読み込むのを避けてここにも置く。
 */
const HUGE_MAGNITUDE_CONDITION = 'Ｍ８を超える巨大地震'

/** 規模の説明が「Ｍ８を超える巨大地震」か。 */
export function isHugeMagnitudeCondition(condition: string | null): boolean {
  return condition === HUGE_MAGNITUDE_CONDITION
}

/** ヒートマップの点に持たせるマグニチュード。数値にならない値は不明（-1）へ揃える。 */
export function heatMagnitude(magnitude: number): number {
  return Number.isFinite(magnitude) ? magnitude : -1
}

// 地震の同一性判定キー。DMDSS版の id には14桁の eventId が埋め込まれておりそれを使う
// （GD Earthquake List の eventId フィールドも同じ14桁形式のため突き合わせ可能）。
// 通常版（P2PQuake）の id はこの形式を持たないため地震の時刻にフォールバックするが、
// P2PQuake の地震の時刻は分単位のため震源名まで含めて「同じ分に起きた別の地震」を分ける
// （震源名を持たない震度速報は座標も無く、ヒートマップでは hasValidHypocenter で除外される）。
// 副作用: 震源を訂正した報は訂正前後で別キーになり、1 つの地震が 2 点残ることがある。
// ヒートマップは分布の統計表示なので、別々の地震が 1 点に潰れる方を避ける選択をしている
// （カード側の統合は `quakeMerge.sameQuakeEntry` が訂正報を正しく 1 イベントにまとめる）。
export function quakeIdentityKey(q: Pick<JMAQuake, 'id' | 'earthquake'>): string {
  const dmdataEventId = extractQuakeEventIdFromId(q.id)
  return dmdataEventId ?? `${q.earthquake.time}|${q.earthquake.hypocenter.name}`
}

/**
 * 震源が未確定（震度速報段階など）のプレースホルダー座標を判定する。
 *
 * **実体は `geo.ts` の `hasKnownEpicenter`。** 同じ判定を別実装で持つと、値域の扱いが
 * 片方だけ変わったときに黙ってずれる（この判定は地図・カード・読み上げ・ヒートマップに
 * またがっている）。名前だけこのモジュールの語彙で残してある。
 */
export const hasValidHypocenter = hasKnownEpicenter

/** 重みの下限。M1 以下と不明の点はこの濃さ。 */
const MIN_WEIGHT = 0.1

// マグニチュードをヒートマップの重みに変換する。
// 震度は震源からの距離に左右され月単位の集計には向かないため、地震そのものの規模を表す
// マグニチュードを重みに採用する（M1〜M8 を 0〜1 に正規化）。
// マグニチュードは対数尺度（+1で放出エネルギーが約31.6倍）なため単純な線形では
// 大地震のインパクトが実態より圧縮されすぎる。二乗して差を強調する。
//
// 数値にならない規模は説明で分ける（2026-10-19 ユーザー承認「巨大地震を言い分ける (推奨)」）。
// - 「Ｍ８を超える巨大地震」: M8 以上と同じ最大の重み。M8 を超えて速報できないという事実なので、
//   最も薄い点にすると最大級の地震ほど分布から消える。
// - それ以外（M 不明・説明なし）: 最小の重み（土台の取得元が不明を -1 で返したときと同じ値）。
// どちらも有限の値を返す。NaN を流すとヒートマップの重みが壊れる。
export function magnitudeToWeight(magnitude: number, condition: string | null): number {
  if (isHugeMagnitudeCondition(condition)) return 1
  if (!Number.isFinite(magnitude)) return MIN_WEIGHT
  const normalized = Math.min(1, Math.max(0, (magnitude - 1) / 7))
  return Math.max(MIN_WEIGHT, normalized ** 2)
}

/**
 * 吹き出しで同じ場所に重なった点のどれを出すかの順位（大きいほど優先）。
 * 巨大地震は数値を持たないので、比べられる値（実在する最大の M より大きい 10）へ置く。
 * 不明は -1 のまま最下位。`NaN` を渡すと比較がすべて偽になり、巨大地震が選ばれなくなる。
 */
export function heatMagnitudeRank(magnitude: number, condition: string | null): number {
  if (isHugeMagnitudeCondition(condition)) return 10
  return heatMagnitude(magnitude)
}

/**
 * 吹き出しに出す規模の札。巨大地震だけは気象庁の説明（「M8を超える巨大地震」）を出し、
 * それ以外の数値にならない規模は「不明」のまま（「Ｍ不明」の説明を持っていても「M不明」とは出さない）。
 */
export function heatMagnitudeLabel(magnitude: number, condition: string | null): string {
  // 長期震源カタログは電文の種別（`@type`）を持たないので、従来どおり `M` で出す。
  if (isHugeMagnitudeCondition(condition)) return formatMagnitudeWithCondition(magnitude, condition ?? undefined, undefined)
  return formatMagnitude(magnitude, undefined)
}

/** 吹き出しの札の色。巨大地震は M8 と同じ色（最上位の段）にする。 */
export function heatMagnitudeColorValue(magnitude: number, condition: string | null): number {
  return isHugeMagnitudeCondition(condition) ? 8 : magnitude
}

/** カタログの年ファイルのうち、ヒートマップが読むのに要る列だけ。 */
export interface HeatCatalogYear {
  year: number
  timeMs: ArrayLike<number>
  lat: ArrayLike<number>
  lng: ArrayLike<number>
  depth: ArrayLike<number>
  magnitude: ArrayLike<number>
  /** 震央地名の表と、地震ごとの添字（`-1` は名前なし）。 */
  names: readonly string[]
  nameIdx: ArrayLike<number>
  /** 気象庁以外の機関が決めた震源なら 1。 */
  external: ArrayLike<number>
}

/**
 * 期間のうちカタログで描く年。`startMs` から `endMs`（カタログの終端と「いま」の早いほう）までに
 * 掛かる日本時間の年で、索引に載っているものだけ。`endMs <= startMs` なら空。
 */
export function catalogYearsFor(startMs: number, endMs: number, availableYears: readonly number[]): number[] {
  if (!(endMs > startMs)) return []
  const from = jstYearOf(startMs)
  const to = jstYearOf(endMs - 1)
  return availableYears.filter((y) => y >= from && y <= to)
}

/**
 * カタログの年ファイルから、期間 `[startMs, endMs)` の点を作る。
 *
 * **カタログの点は API の点と突き合わせない。** 両者は時刻で分けてある（カタログの終端より前は
 * カタログ、後は API）ので、同じ地震が 2 点になることはない。
 *
 * **気象庁以外の機関の震源は入れない。** 同じ地震を気象庁と重ねて数えることになる（大きい地震ほど
 * 両方に載る）。震央地名はカタログの名前を入れる（2026-10-25 ユーザー承認「C の案でよい (Recommended)」）。
 */
export function catalogHeatPoints(years: readonly HeatCatalogYear[], startMs: number, endMs: number): HeatPoint[] {
  const out: HeatPoint[] = []
  for (const y of years) {
    const n = y.timeMs.length
    for (let i = 0; i < n; i++) {
      if (isCatalogHeatTarget(y, i, startMs, endMs)) out.push(catalogHeatPointAt(y, i))
    }
  }
  return out
}

/** カタログの `i` 番目の地震を、期間 `[startMs, endMs)` のヒートマップに入れるか。 */
function isCatalogHeatTarget(y: HeatCatalogYear, i: number, startMs: number, endMs: number): boolean {
  const t = y.timeMs[i]
  if (!(t >= startMs && t < endMs)) return false
  if (y.external[i] === 1) return false
  return hasValidHypocenter(y.lat[i], y.lng[i])
}

function catalogHeatPointAt(y: HeatCatalogYear, i: number): HeatPoint {
  const magnitude = heatMagnitude(y.magnitude[i])
  const depth = y.depth[i]
  return {
    lat: y.lat[i],
    lng: y.lng[i],
    weight: magnitudeToWeight(magnitude, null),
    name: y.nameIdx[i] >= 0 ? y.names[y.nameIdx[i]] : '',
    time: new Date(y.timeMs[i]).toISOString(),
    depth: Number.isFinite(depth) ? depth : -1,
    depthAtLeast: false,
    magnitude,
    magnitudeCondition: null,
    count: 1,
  }
}

/**
 * `gridHeatPoints(catalogHeatPoints(years, startMs, endMs))` と同じ結果を、**点のオブジェクトを作らずに**列から直接畳んで作る。
 *
 * 1919 年からの段では対象が約 129 万件あり、先に点を作ると時刻の文字列ごと約 350MB を一時に抱え、
 * 開発機でも約 1 秒止まった（2026-10-25 に同じ形のオブジェクトで試算）。升目には数値だけを持ち、
 * 外へ出す点（1 件だけの升目はその地震、2 件以上はまとめた点）だけを作る。
 */
export function catalogGridHeatPoints(
  years: readonly HeatCatalogYear[],
  startMs: number,
  endMs: number,
  gridDeg: number = HEAT_GRID_DEG,
): HeatPoint[] {
  interface Cell {
    w: number
    latW: number
    lngW: number
    count: number
    /** 最初に入った地震（1 件だけの升目はこれをそのまま出す）。 */
    firstYear: HeatCatalogYear
    firstIndex: number
    /** 規模がいちばん大きい地震の規模（同じ規模なら先に入ったもの。`gridHeatPoints` と同じ）。 */
    topMagnitude: number
    latestMs: number
  }
  const cells = new Map<string, Cell>()
  for (const y of years) {
    const n = y.timeMs.length
    for (let i = 0; i < n; i++) {
      if (!isCatalogHeatTarget(y, i, startMs, endMs)) continue
      const lat = y.lat[i]
      const lng = y.lng[i]
      const magnitude = heatMagnitude(y.magnitude[i])
      const weight = magnitudeToWeight(magnitude, null)
      const t = y.timeMs[i]
      const key = `${Math.floor(lat / gridDeg)},${Math.floor(lng / gridDeg)}`
      const c = cells.get(key)
      if (!c) {
        cells.set(key, {
          w: weight, latW: lat * weight, lngW: lng * weight, count: 1,
          firstYear: y, firstIndex: i, topMagnitude: magnitude, latestMs: t,
        })
        continue
      }
      c.w += weight
      c.latW += lat * weight
      c.lngW += lng * weight
      c.count += 1
      if (heatMagnitudeRank(magnitude, null) > heatMagnitudeRank(c.topMagnitude, null)) c.topMagnitude = magnitude
      if (t > c.latestMs) c.latestMs = t
    }
  }
  const out: HeatPoint[] = []
  for (const c of cells.values()) {
    if (c.count === 1) {
      out.push(catalogHeatPointAt(c.firstYear, c.firstIndex))
      continue
    }
    out.push({
      lat: c.latW / c.w,
      lng: c.lngW / c.w,
      weight: c.w,
      name: '',
      time: new Date(c.latestMs).toISOString(),
      depth: -1,
      depthAtLeast: false,
      magnitude: c.topMagnitude,
      magnitudeCondition: null,
      count: c.count,
    })
  }
  return out
}

/** 濃さの基準にする期間（日）。描画の濃さの係数はこの長さの点に合わせてある。 */
const HEAT_INTENSITY_BASE_DAYS = 30

/**
 * 期間の長さに合わせた濃さの係数。`√(30 日 ÷ 期間の日数)` で、30 日以下は 1（今までどおり）。
 * 長い期間は点が積み上がって日本列島が一面赤く飽和するので、平方根で下げる
 * （2026-10-25 ユーザー選択「A 期間の比の平方根で下げる (Recommended)」。比そのもので下げると東北沖の斑点しか残らなかった）。
 */
export function heatIntensityScale(startMs: number, endMs: number): number {
  const days = (endMs - startMs) / 86_400_000
  if (!(days > HEAT_INTENSITY_BASE_DAYS)) return 1
  return Math.sqrt(HEAT_INTENSITY_BASE_DAYS / days)
}

/** 格子にまとめる升目の大きさ（度）。約 5km。 */
export const HEAT_GRID_DEG = 0.05

/**
 * 格子にまとめる期間か。**1 年より長い期間だけ**まとめる（2026-10-25 ユーザー選択「A 1年超だけ格子にまとめる (Recommended)」）。
 * 1919 年からを点のまま流すと約 129 万点になり、地図を動かしただけでタブが応答しなくなった（同日に測った）。
 * まとめれば 1919 年からでも約 9 万点（0.05 度の格子）。
 */
export function shouldGridHeatPeriod(period: HeatmapPeriod): boolean {
  return HEATMAP_PERIODS.findIndex((p) => p.key === period) > HEATMAP_PERIODS.findIndex((p) => p.key === '1y')
}

/**
 * 点を `HEAT_GRID_DEG` の升目ごとに 1 点へまとめる。
 *
 * - 重みは**足し合わせる**。ヒートマップの密度は点の重みの和なので、まとめても同じ升目の中の濃さは保たれる
 * - 位置は重みで平均する（升目の中心へ寄せると、格子の目が絵に出る）
 * - 規模は升目の中の最大（`heatMagnitudeRank` で比べる。巨大地震を最上位に置く）、時刻は最も新しい地震
 * - 1 点しか無い升目はその地震のまま（`count` 1）
 */
export function gridHeatPoints(points: readonly HeatPoint[], gridDeg: number = HEAT_GRID_DEG): HeatPoint[] {
  interface Cell { w: number; latW: number; lngW: number; first: HeatPoint; top: HeatPoint; latest: string; count: number }
  const cells = new Map<string, Cell>()
  for (const p of points) {
    const key = `${Math.floor(p.lat / gridDeg)},${Math.floor(p.lng / gridDeg)}`
    const c = cells.get(key)
    if (!c) {
      cells.set(key, { w: p.weight, latW: p.lat * p.weight, lngW: p.lng * p.weight, first: p, top: p, latest: p.time, count: 1 })
      continue
    }
    c.w += p.weight
    c.latW += p.lat * p.weight
    c.lngW += p.lng * p.weight
    c.count += p.count
    if (heatMagnitudeRank(p.magnitude, p.magnitudeCondition) > heatMagnitudeRank(c.top.magnitude, c.top.magnitudeCondition)) c.top = p
    if (p.time > c.latest) c.latest = p.time
  }
  const out: HeatPoint[] = []
  for (const c of cells.values()) {
    if (c.count === 1) {
      out.push(c.first)
      continue
    }
    out.push({
      lat: c.latW / c.w,
      lng: c.lngW / c.w,
      weight: c.w,
      name: '',
      time: c.latest,
      depth: -1,
      depthAtLeast: false,
      magnitude: c.top.magnitude,
      magnitudeCondition: c.top.magnitudeCondition,
      count: c.count,
    })
  }
  return out
}
