// 地震タブの一覧の見え方（絞り込み・並び替え・区切り・帯の札の文面）。
//
// 決まったことと原文は docs/spec/quake-spec.md「地震タブの絞り込みと並び替え」（2026-11-07 ユーザー選択）。
import type { IntensityScale, IssueType, JMAQuake } from '../types/earthquake'
import { hasDepth, hasMagnitude } from './formatters'
import { getIntensityLabel } from './intensity'
import { parseJstTimeMs } from './quakeOriginSeconds'
import { quakeListDay } from './quakeListDay'
import { isAreaPoint, isMaxScaleUnreceived, type AreaPrefIndex } from './quakePoints'
import { clampPeriodRange } from './historyDays'
import type { Messages } from '../i18n/messages'

/** 地震タブの語（`i18n/messages` の `quake`） */
export type QuakeWords = Messages['quake']

/** 下限と上限。どちらも null なら絞らない。 */
export interface QuakeRange {
  readonly min: number | null
  readonly max: number | null
}

/** 地域の基準。震央地名か、震度を観測した地域（細分区域）か。 */
export type QuakeRegionBasis = 'epicenter' | 'observed'

/** 期間。今から遡る時間か、日付の範囲（端末の時刻での年月日 `YYYY-MM-DD`、両端を含む）。 */
export type QuakePeriod =
  | { readonly kind: 'hours'; readonly hours: number }
  | { readonly kind: 'range'; readonly from: string; readonly to: string }

/** 期間の窓に並べる「今から遡る時間」（2026-11-07 選択「24時間／3日／7日／30日／日付を指定」）。 */
export const QUAKE_PERIOD_HOURS: readonly { readonly hours: number }[] = [
  { hours: 24 },
  { hours: 72 },
  { hours: 168 },
  { hours: 720 },
]

export interface QuakeListFilter {
  readonly scale: QuakeRange
  readonly magnitude: QuakeRange
  readonly depth: QuakeRange
  /**
   * 地域。`view` は地域の窓で一覧と地図のどちらを出すか（絞りには効かない。最後に選んだ方を覚える。
   * 2026-11-08 選択「最後に選んだ方を覚える」）
   */
  readonly region: { readonly basis: QuakeRegionBasis; readonly names: readonly string[]; readonly view: QuakeRegionView }
  /** 選んだ種類。空ならすべて。 */
  readonly types: readonly QuakeListType[]
  readonly period: QuakePeriod | null
}

/** 地域の窓で一覧と地図のどちらを出すか。 */
export type QuakeRegionView = 'list' | 'map'

export type QuakeSortKey = 'time' | 'scale' | 'magnitude' | 'depth' | 'region'

/** 絞り込みの条件の種類（帯の札と窓の節） */
export type QuakeFilterKind = 'scale' | 'magnitude' | 'depth' | 'region' | 'types' | 'period'

export interface QuakeListSort {
  readonly key: QuakeSortKey
  readonly dir: 'asc' | 'desc'
}

const NO_RANGE: QuakeRange = { min: null, max: null }

export const DEFAULT_QUAKE_LIST_FILTER: QuakeListFilter = {
  scale: NO_RANGE,
  magnitude: NO_RANGE,
  depth: NO_RANGE,
  region: { basis: 'epicenter', names: [], view: 'list' },
  types: [],
  period: null,
}

/** 今の並び（時刻の新しい順）。 */
export const DEFAULT_QUAKE_LIST_SORT: QuakeListSort = { key: 'time', dir: 'desc' }

/**
 * 地震カードに付く報のうち、地震情報の種類（`IssueType`）でないもの。語はカードの報の一覧の札と同じ（`EarthquakeCard.tsx` の報の一覧）。
 * 種類の窓に並べる（2026-11-08 選択「長周期・推計・英文も並べる」）。
 */
export const QUAKE_ATTACHED_TYPES = ['長周期地震動に関する観測情報', '推計震度分布図', '国際津波関連情報'] as const
export type QuakeAttachedType = (typeof QUAKE_ATTACHED_TYPES)[number]
export type QuakeListType = IssueType | QuakeAttachedType

/** 種類の窓に並べる語。カードの札と同じ語（2026-11-07 選択「札と同じ語で選ぶ (Recommended)」）。 */
export const QUAKE_LIST_TYPES: readonly QuakeListType[] = [
  '震度速報', '震源情報', '震源・震度情報', '各地の震度情報', '顕著な地震の震源要素更新のお知らせ', '遠地地震',
  ...QUAKE_ATTACHED_TYPES,
]

function rangeSet(r: QuakeRange): boolean {
  return r.min !== null || r.max !== null
}

/** 何か絞っているか。 */
export function isQuakeListFiltered(f: QuakeListFilter): boolean {
  return rangeSet(f.scale) || rangeSet(f.magnitude) || rangeSet(f.depth)
    || f.region.names.length > 0 || f.types.length > 0 || f.period !== null
}

/**
 * 「すべて解除」の後の条件。既定へ戻し、窓の「一覧／地図」だけは残す（絞りではなく見せ方で、最後に選んだ方を覚える ——
 * 2026-11-08 選択「最後に選んだ方を覚える」）
 */
export function clearQuakeListFilter(f: QuakeListFilter): QuakeListFilter {
  return { ...DEFAULT_QUAKE_LIST_FILTER, region: { ...DEFAULT_QUAKE_LIST_FILTER.region, view: f.region.view } }
}

/** 種類の絞りに、地震カードに付く報（長周期・推計・英文）が入っているか。入っていなければ `attachedTypesOf` は呼ばれない。 */
export function wantsAttachedTypes(f: QuakeListFilter): boolean {
  return f.types.some(t => (QUAKE_ATTACHED_TYPES as readonly string[]).includes(t))
}

function inRange(value: number, r: QuakeRange): boolean {
  return (r.min === null || value >= r.min) && (r.max === null || value <= r.max)
}

/** 深さ。「700km以上」は 700 として扱う（電文が持つのは下限だけ）。不明は null。 */
function depthOf(q: JMAQuake): number | null {
  const d = q.earthquake.hypocenter.depth
  return hasDepth(d) ? d : null
}

function magnitudeOf(q: JMAQuake): number | null {
  const m = q.earthquake.hypocenter.magnitude
  return hasMagnitude(m) ? m : null
}

/**
 * 震度を観測した地域（細分区域）の名前。地域の点は名前そのもの、観測点はその点の地域。
 * 都道府県のまとめの点（`isAreaPoint` が偽の区域点）は区域ではないので入れない（地域の窓の一覧 `quakeRegionGroups` と同じ）。
 */
export function observedAreas(q: Pick<JMAQuake, 'points'>, areaPrefIndex: AreaPrefIndex): Set<string> {
  const out = new Set<string>()
  for (const p of q.points) {
    if (p.isArea && !isAreaPoint(p, areaPrefIndex)) continue
    const area = p.isArea ? p.addr : p.area
    if (area) out.add(area)
  }
  return out
}

/** その地震で受け取った種類（記録が無ければ今の種類）。 */
function receivedTypes(q: JMAQuake): QuakeListType[] {
  return q.reports && q.reports.length > 0 ? q.reports.map(r => r.type) : [q.issue.type]
}

/**
 * 日本時間で `YYYY-MM-DD` の 0 時のエポックミリ秒。読めなければ NaN。
 * 端末の時刻ではなく日本時間で切る（地震カードの時刻・読み足しの注記の日付と境をそろえる。2026-11-08 選択「日本時間で切る」）
 */
function jstDayStartMs(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return Number.NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3_600_000
}

function inPeriod(q: JMAQuake, p: QuakePeriod, nowMs: number): boolean {
  const t = parseJstTimeMs(q.earthquake.time)
  if (!Number.isFinite(t)) return false
  if (p.kind === 'hours') return t >= nowMs - p.hours * 3_600_000
  const from = jstDayStartMs(p.from)
  const toStart = jstDayStartMs(p.to)
  if (!Number.isFinite(from) || !Number.isFinite(toStart)) return false
  // 終わりの日も含める（日本時間の翌日の 0 時の手前まで。日本時間に夏時間は無い）
  const toEnd = toStart + 86_400_000
  return t >= from && t < toEnd
}

export interface QuakeFilterContext {
  /** 期間の「今」（サーバーと合わせた時刻）。 */
  readonly nowMs: number
  /**
   * 絞りに関係なく出す地震の鍵（通知や津波タブから開いた地震）。最新の 1 枚は `withLatestPinned` が足す。
   * 津波の原因地震・国際津波関連情報の付いた地震も、ここに入っていなければ絞りどおり外す
   * （2026-11-08 選択「例外をやめる (Recommended)」）。
   */
  readonly pinnedKeys: ReadonlySet<string>
  readonly keyOf: (q: JMAQuake) => string
  /** その地震カードに付いている、地震情報の種類でない報（長周期・推計・英文）。取り消された報は入れない。 */
  readonly attachedTypesOf: (q: JMAQuake) => readonly QuakeAttachedType[]
  /** 一次細分区域名 → 都道府県名（都道府県のまとめの点を区域と見分ける。→ `observedAreas`）。 */
  readonly areaPrefIndex: AreaPrefIndex
}

/** 条件ごとに 1 回だけ作る集合（地震 1 件ごとに作り直さない）。 */
const filterSets = new WeakMap<QuakeListFilter, { names: ReadonlySet<string>; types: ReadonlySet<QuakeListType> }>()
function setsOf(f: QuakeListFilter): { names: ReadonlySet<string>; types: ReadonlySet<QuakeListType> } {
  let sets = filterSets.get(f)
  if (!sets) {
    sets = { names: new Set(f.region.names), types: new Set(f.types) }
    filterSets.set(f, sets)
  }
  return sets
}

/**
 * 震度の絞りに通るか。**例外は震度の絞りでだけ当てる**（2026-11-07 選択「絞りごとに当てる (Recommended)」）：
 * 遠地地震は国内の震度を持たないので比べない。「5弱以上（未入電）」は実際には 5強以上だった可能性が
 * あるので、下限には通す（上限とは下限の 5弱で比べる）。
 */
function passesScale(q: JMAQuake, r: QuakeRange): boolean {
  if (!rangeSet(r)) return true
  if (q.issue.type === '遠地地震') return true
  const s = q.earthquake.maxScale
  if (s < 0) return false
  if (isMaxScaleUnreceived(s, q.points)) return r.max === null || s <= r.max
  return inRange(s, r)
}

/** 1 つの地震が条件に通るか（開いた地震の固定を含む）。 */
export function passesQuakeListFilter(q: JMAQuake, f: QuakeListFilter, ctx: QuakeFilterContext): boolean {
  if (ctx.pinnedKeys.has(ctx.keyOf(q))) return true
  if (!passesScale(q, f.scale)) return false
  if (rangeSet(f.magnitude)) {
    const m = magnitudeOf(q)
    if (m === null || !inRange(m, f.magnitude)) return false
  }
  if (rangeSet(f.depth)) {
    const d = depthOf(q)
    if (d === null || !inRange(d, f.depth)) return false
  }
  if (f.region.names.length > 0) {
    const { names } = setsOf(f)
    if (f.region.basis === 'epicenter') {
      if (!names.has(q.earthquake.hypocenter.name)) return false
    } else {
      let hit = false
      for (const a of observedAreas(q, ctx.areaPrefIndex)) if (names.has(a)) { hit = true; break }
      if (!hit) return false
    }
  }
  if (f.types.length > 0) {
    const { types } = setsOf(f)
    if (!receivedTypes(q).some(t => types.has(t)) && !ctx.attachedTypesOf(q).some(t => types.has(t))) return false
  }
  if (f.period !== null && !inPeriod(q, f.period, ctx.nowMs)) return false
  return true
}

/** 並べる値。不明は null（並びの向きによらず末尾へ置く）。 */
function sortValue(q: JMAQuake, key: QuakeSortKey): number | null {
  switch (key) {
    case 'time': {
      const t = parseJstTimeMs(q.earthquake.time)
      return Number.isFinite(t) ? t : null
    }
    case 'scale': return q.earthquake.maxScale >= 0 ? q.earthquake.maxScale : null
    case 'magnitude': return magnitudeOf(q)
    case 'depth': return depthOf(q)
    case 'region': {
      const c = q.earthquake.hypocenter.code
      const n = c === undefined ? Number.NaN : Number(c)
      return Number.isFinite(n) ? n : null
    }
  }
}

/**
 * 並べ替える（元の配列は変えない）。同じ値どうしは時刻の新しい順。不明は向きによらず末尾。
 * 地域は震央地名コードの順（2026-11-07 選択「コード順のまま (Recommended)」）。
 */
export function sortQuakeList(quakes: readonly JMAQuake[], sort: QuakeListSort): JMAQuake[] {
  if (sort.key === 'time' && sort.dir === 'desc') return [...quakes]
  const sign = sort.dir === 'asc' ? 1 : -1
  const rows = quakes.map((q, i) => ({ q, i, v: sortValue(q, sort.key), t: sortValue(q, 'time') }))
  rows.sort((a, b) => {
    if (a.v === null || b.v === null) {
      if (a.v !== b.v) return a.v === null ? 1 : -1
    } else if (a.v !== b.v) {
      return (a.v - b.v) * sign
    }
    if (a.t !== null && b.t !== null && a.t !== b.t) return b.t - a.t
    return a.i - b.i
  })
  return rows.map(r => r.q)
}

/** 区切り。`key` が前の行と変わったところに `label` の行を置く。区切らない並びは null。 */
export interface QuakeListSection {
  readonly key: string
  readonly label: string
}

/** 深さの区切りの幅（2026-11-07 選択「並べた欄の幅ごとに区切る (Recommended)」）。 */
function depthSection(d: number | null, w: QuakeWords['section']): QuakeListSection {
  if (d === null) return { key: 'depth:none', label: w.depthUnknown }
  if (d < 30) return { key: 'depth:0', label: w.depthUnder30 }
  if (d < 100) return { key: 'depth:30', label: w.depth30to100 }
  if (d < 300) return { key: 'depth:100', label: w.depth100to300 }
  return { key: 'depth:300', label: w.depth300plus }
}

/**
 * その地震の区切り。時刻は日付、震度は階級、規模は整数（「M5」。原文「M5.○であることが分かればいいのでM5だけでいい」）、
 * 深さは幅、地域は区切らない（2026-11-07 選択「地域順では区切らない (Recommended)」）。
 */
export function quakeListSection(q: JMAQuake, key: QuakeSortKey, w: QuakeWords['section']): QuakeListSection | null {
  switch (key) {
    case 'time': {
      const day = quakeListDay(q.earthquake.time)
      return day ? { key: `day:${day.key}`, label: day.label } : null
    }
    case 'scale': {
      const s = q.earthquake.maxScale
      return s >= 0 ? { key: `scale:${s}`, label: w.scale(getIntensityLabel(s)) } : { key: 'scale:none', label: w.scaleUnknown }
    }
    case 'magnitude': {
      const m = magnitudeOf(q)
      return m === null ? { key: 'mag:none', label: w.magnitudeUnknown } : { key: `mag:${Math.floor(m)}`, label: w.magnitude(Math.floor(m)) }
    }
    case 'depth': return depthSection(depthOf(q), w)
    case 'region': return null
  }
}

function formatMagnitudeBound(m: number): string {
  return m.toFixed(1)
}

/** 期間の札の語（`QUAKE_PERIOD_HOURS` の時間。表に無い時間は「N時間」の形）。 */
export function quakePeriodHoursLabel(hours: number, w: QuakeWords): string {
  return w.filter.periodHours[hours] ?? w.filter.periodHoursOther(hours)
}

/** 帯の札の文面（2026-11-07 選択「地域と種類は数だけ」）。絞っていない札は条件の名前だけ。 */
export function quakeFilterChipLabels(f: QuakeListFilter, w: QuakeWords): Record<QuakeFilterKind, string> {
  const c = w.filter.chip
  const name = w.filter.section
  const s = f.scale
  const scale = s.min !== null && s.max !== null
    ? c.scaleRange(getIntensityLabel(s.min), getIntensityLabel(s.max))
    : s.min !== null ? c.scaleMin(getIntensityLabel(s.min))
      : s.max !== null ? c.scaleMax(getIntensityLabel(s.max)) : name.scale
  const m = f.magnitude
  const magnitude = m.min !== null && m.max !== null
    ? c.magnitudeRange(formatMagnitudeBound(m.min), formatMagnitudeBound(m.max))
    : m.min !== null ? c.magnitudeMin(formatMagnitudeBound(m.min))
      : m.max !== null ? c.magnitudeMax(formatMagnitudeBound(m.max)) : name.magnitude
  const d = f.depth
  const depth = d.min !== null && d.max !== null
    ? c.depthRange(d.min, d.max)
    : d.min !== null ? c.depthMin(d.min)
      : d.max !== null ? c.depthMax(d.max) : name.depth
  const region = f.region.names.length > 0 ? c.picked(name.region, f.region.names.length) : name.region
  const types = f.types.length > 0 ? c.picked(name.types, f.types.length) : name.types
  let period = name.period
  if (f.period?.kind === 'hours') {
    period = quakePeriodHoursLabel(f.period.hours, w)
  } else if (f.period?.kind === 'range') {
    const md = (ymd: string) => ymd.slice(5).replace('-', '/')
    period = `${md(f.period.from)}〜${md(f.period.to)}`
  }
  return { scale, magnitude, depth, region, types, period }
}

/** 日本時間の `YYYY-MM-DD` を「10月31日」の形に。注記「〇〇以前は未読込みです。」「（〇〇以降を読込済み）」に使う（文面はユーザー原文「〇〇以前は未読込みです。で」）。 */
export function quakeListDayLabel(day: string): string {
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`
}

/** 期間の始まり（日本時間の「10月31日」の形）。注記「〇〇まで読み込んでいます…」に使う。 */
export function quakeListPeriodStartLabel(period: QuakePeriod, nowMs: number): string {
  const startMs = period.kind === 'hours' ? nowMs - period.hours * 3_600_000 : jstDayStartMs(period.from)
  const d = new Date(startMs + 9 * 3_600_000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 震度の窓で選べる値。 */
export const QUAKE_SCALE_STEPS: readonly IntensityScale[] = [10, 20, 30, 40, 45, 50, 55, 60, 70]

/**
 * 規模・深さのスライダーの幅（震源カタログタブと同じ二つまみのスライダー。2026-11-07 選択「カタログと同じスライダー (Recommended)」）。
 * 端に置くとその側の制限を外す。規模は M2 未満の有感地震も来るので、カタログ（2〜9）と違って 0 から。
 */
export const QUAKE_MAGNITUDE_RANGE = { min: 0, max: 9, step: 0.1 } as const
export const QUAKE_DEPTH_RANGE = { min: 0, max: 700, step: 10 } as const

/** 地域の一覧の 1 行（名前と、読み込んだ地震のうちその地域に当たる数）。 */
export interface QuakeRegionOption {
  readonly name: string
  readonly count: number
}

/** 地域の一覧の見出しごとのまとまり。 */
export interface QuakeRegionGroup {
  readonly label: string
  readonly options: readonly QuakeRegionOption[]
}

/**
 * 地域の窓の一覧を組む（2026-11-07 選択「読んだ地震にある地域＋件数 (Recommended)」）。読み込んだ地震に出てくる名前だけを並べ、
 * 選んだままの名前は今の一覧に無くても残す（数は 0）。
 *
 * - 震央地名: 都道府県名で始まる名前はその県、北海道の陸の区域（コード 100〜179）は北海道、900 番台は「遠方」、それ以外は「海域」。
 *   並びは県の番号順 → 海域 → 遠方、まとまりの中は震央地名コードの順
 * - 震度を観測した地域: 一次細分区域の名前を、区域→県の索引（`areaPrefIndex`）で引いた県でまとめ、県の番号順。
 *   まとまりの中は気象庁の標準の並び（`areaRank`。地震カードの震度一覧と同じ）、同じ順位どうしは名前の順。都道府県のまとめの点（`isAreaPoint` が偽の区域点）は区域ではないので数えない。
 *   索引が無いとき（座標表の読み込み前）は点の県名・県名で始まるかで引き、引けなければ「海域」に置く
 */
export function quakeRegionGroups(
  quakes: readonly JMAQuake[],
  basis: QuakeRegionBasis,
  selected: readonly string[],
  prefectures: readonly { code: string; name: string }[],
  areaPrefIndex: AreaPrefIndex,
  areaRank: (name: string) => number,
): QuakeRegionGroup[] {
  const counts = new Map<string, number>()
  const groupOf = new Map<string, string>()
  const codeOf = new Map<string, number>()
  const add = (name: string, group: string, code: number) => {
    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (!groupOf.has(name)) groupOf.set(name, group)
    if (!codeOf.has(name)) codeOf.set(name, code)
  }
  const prefOfName = (name: string) => prefectures.find(p => name.startsWith(p.name))?.name ?? null
  const prefOfArea = (area: string, pointPref = '') => areaPrefIndex?.get(area) ?? (pointPref || prefOfName(area) || '海域')
  for (const q of quakes) {
    if (basis === 'epicenter') {
      const h = q.earthquake.hypocenter
      if (!h.name) continue
      const code = h.code === undefined ? Number.NaN : Number(h.code)
      const pref = prefOfName(h.name)
      const group = pref ?? (code >= 100 && code < 180 ? '北海道' : code >= 900 ? '遠方' : '海域')
      add(h.name, group, Number.isFinite(code) ? code : Number.MAX_SAFE_INTEGER)
    } else {
      const seen = new Set<string>()
      for (const p of q.points) {
        if (p.isArea && !isAreaPoint(p, areaPrefIndex)) continue
        const area = p.isArea ? p.addr : p.area
        if (!area || seen.has(area)) continue
        seen.add(area)
        add(area, prefOfArea(area, p.pref), 0)
      }
    }
  }
  for (const name of selected) {
    if (counts.has(name)) continue
    counts.set(name, 0)
    groupOf.set(name, basis === 'observed' ? prefOfArea(name) : prefOfName(name) ?? '海域')
    codeOf.set(name, Number.MAX_SAFE_INTEGER)
  }
  const order = (label: string) => {
    const i = prefectures.findIndex(p => p.name === label)
    if (i >= 0) return i
    return label === '海域' ? prefectures.length : prefectures.length + 1
  }
  const groups = new Map<string, QuakeRegionOption[]>()
  for (const [name, count] of counts) {
    const g = groupOf.get(name) ?? '海域'
    const list = groups.get(g) ?? []
    list.push({ name, count })
    groups.set(g, list)
  }
  return [...groups.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([label, options]) => ({
      label,
      options: [...options].sort((a, b) =>
        basis === 'epicenter'
          ? (codeOf.get(a.name) ?? 0) - (codeOf.get(b.name) ?? 0) || a.name.localeCompare(b.name, 'ja')
          : areaRank(a.name) - areaRank(b.name) || a.name.localeCompare(b.name, 'ja')),
    }))
}

/** 地方（県の組の上の段）。県の名前を束ねる。 */
export interface QuakeRegionBlock {
  readonly label: string
  readonly groups: readonly QuakeRegionGroup[]
}

/**
 * 地方の区分と、その地方に入る県のコードの範囲（JIS X 0401。両端を含む）。
 * 一般の 8 地方区分（2026-11-08 選択「地方ごとにまとめて 2 段で畳む」の説明「北海道・東北・関東・中部・近畿・中国・四国・九州沖縄」）。
 */
const QUAKE_REGION_BLOCKS: readonly { label: string; from: number; to: number }[] = [
  { label: '北海道', from: 1, to: 1 },
  { label: '東北', from: 2, to: 7 },
  { label: '関東', from: 8, to: 14 },
  { label: '中部', from: 15, to: 23 },
  { label: '近畿', from: 24, to: 30 },
  { label: '中国', from: 31, to: 35 },
  { label: '四国', from: 36, to: 39 },
  { label: '九州沖縄', from: 40, to: 47 },
]

/**
 * 県の組を地方ごとに束ねる（地域の窓の一覧を 2 段で畳む）。県でない組（海域・遠方）は、それだけで 1 つの段にする。
 * 並びは地方の順で、県でない組は `groups` の並びのまま後ろへ置く。
 */
export function quakeRegionBlocks(
  groups: readonly QuakeRegionGroup[],
  prefectures: readonly { code: string; name: string }[],
): QuakeRegionBlock[] {
  const codeOf = new Map(prefectures.map(p => [p.name, Number(p.code)]))
  const blocks = QUAKE_REGION_BLOCKS.map(b => ({ label: b.label, groups: [] as QuakeRegionGroup[] }))
  const rest: QuakeRegionBlock[] = []
  for (const g of groups) {
    const code = codeOf.get(g.label)
    const i = code === undefined ? -1 : QUAKE_REGION_BLOCKS.findIndex(b => code >= b.from && code <= b.to)
    if (i >= 0) blocks[i]!.groups.push(g)
    else rest.push({ label: g.label, groups: [g] })
  }
  return [...blocks.filter(b => b.groups.length > 0), ...rest]
}

/** 並べ替えの欄（設定の値の一覧にも使う）。 */
export const QUAKE_SORT_KEYS: readonly QuakeSortKey[] = ['time', 'scale', 'magnitude', 'depth', 'region']

/** 期間の「今から遡る時間」の値（0 は絞らない）。設定の値の一覧にも使う。 */
export const QUAKE_PERIOD_HOUR_VALUES = [0, 24, 72, 168, 720] as const

/**
 * 設定に残す形（`hooks/useSettings.ts` の `AppSettings` の一部）。
 *
 * **平たい項目で持つ。** 設定の項目は 1 つずつ使用状況データへ載せる決まりで（`utils/usageSettings.ts`）、
 * 入れ子のままでは送れないため（2026-11-07 選択「設定に入れ、使用状況データにも載せる (Recommended)」）。
 * 地域と種類は名前を持つが、送るのは数だけ（地域の名前は住んでいる場所に結びつきうる）。
 */
export interface QuakeListSettings {
  /** 震度の下限・上限（-1 は決めていない）。下限は設定の窓にあった「最低表示震度」（`minDisplayScale`）から引き継ぐ。 */
  quakeListScaleMin: number
  quakeListScaleMax: number
  quakeListMagnitudeMin: number | null
  quakeListMagnitudeMax: number | null
  quakeListDepthMin: number | null
  quakeListDepthMax: number | null
  quakeListRegionBasis: QuakeRegionBasis
  quakeListRegions: string[]
  quakeListTypes: QuakeListType[]
  /** 地域の窓で一覧と地図のどちらを出すか（最後に選んだ方）。 */
  quakeListRegionView: QuakeRegionView
  /** 今から遡る時間（0 は絞らない）。日付の範囲が入っていればそちらを使う。 */
  quakeListPeriodHours: (typeof QUAKE_PERIOD_HOUR_VALUES)[number]
  quakeListPeriodFrom: string | null
  quakeListPeriodTo: string | null
  quakeListSortKey: QuakeSortKey
  quakeListSortDir: 'asc' | 'desc'
}

export const DEFAULT_QUAKE_LIST_SETTINGS: QuakeListSettings = {
  quakeListScaleMin: -1,
  quakeListScaleMax: -1,
  quakeListMagnitudeMin: null,
  quakeListMagnitudeMax: null,
  quakeListDepthMin: null,
  quakeListDepthMax: null,
  quakeListRegionBasis: 'epicenter',
  quakeListRegions: [],
  quakeListTypes: [],
  quakeListRegionView: 'list',
  quakeListPeriodHours: 0,
  quakeListPeriodFrom: null,
  quakeListPeriodTo: null,
  quakeListSortKey: 'time',
  quakeListSortDir: 'desc',
}

const scaleOrNull = (v: number): number | null => (v >= 0 ? v : null)

/** 設定から条件を組む。 */
export function quakeListFilterOf(s: QuakeListSettings): QuakeListFilter {
  // 日付の期間は 90 日まで（日付の欄が寄せるので通常は収まる。前の版で保存した長い範囲は、終わりの日から 90 日へ縮める）
  const range = s.quakeListPeriodFrom !== null && s.quakeListPeriodTo !== null
    ? clampPeriodRange(s.quakeListPeriodFrom, s.quakeListPeriodTo, 'to', s.quakeListPeriodTo)
    : null
  const period: QuakePeriod | null = range !== null
    ? { kind: 'range', from: range.from, to: range.to }
    : s.quakeListPeriodHours > 0 ? { kind: 'hours', hours: s.quakeListPeriodHours } : null
  return {
    scale: { min: scaleOrNull(s.quakeListScaleMin), max: scaleOrNull(s.quakeListScaleMax) },
    magnitude: { min: s.quakeListMagnitudeMin, max: s.quakeListMagnitudeMax },
    depth: { min: s.quakeListDepthMin, max: s.quakeListDepthMax },
    region: { basis: s.quakeListRegionBasis, names: s.quakeListRegions, view: s.quakeListRegionView },
    types: s.quakeListTypes,
    period,
  }
}

/** 条件を設定の形へ戻す（並べ替えの欄は含めない）。 */
export function quakeListFilterSettings(f: QuakeListFilter): Omit<QuakeListSettings, 'quakeListSortKey' | 'quakeListSortDir'> {
  const hours = f.period?.kind === 'hours' ? f.period.hours : 0
  return {
    quakeListScaleMin: f.scale.min ?? -1,
    quakeListScaleMax: f.scale.max ?? -1,
    quakeListMagnitudeMin: f.magnitude.min,
    quakeListMagnitudeMax: f.magnitude.max,
    quakeListDepthMin: f.depth.min,
    quakeListDepthMax: f.depth.max,
    quakeListRegionBasis: f.region.basis,
    quakeListRegions: [...f.region.names],
    quakeListTypes: [...f.types],
    quakeListRegionView: f.region.view,
    quakeListPeriodHours: (QUAKE_PERIOD_HOUR_VALUES as readonly number[]).includes(hours) ? hours as QuakeListSettings['quakeListPeriodHours'] : 0,
    quakeListPeriodFrom: f.period?.kind === 'range' ? f.period.from : null,
    quakeListPeriodTo: f.period?.kind === 'range' ? f.period.to : null,
  }
}

export function quakeListSortOf(s: Pick<QuakeListSettings, 'quakeListSortKey' | 'quakeListSortDir'>): QuakeListSort {
  return { key: s.quakeListSortKey, dir: s.quakeListSortDir }
}

/**
 * 見出しを押したときの次の並び。同じ欄なら向きを返し、別の欄なら大きい方（時刻は新しい方）から並べる。
 * 地域だけはコードの小さい方（北）から。
 */
export function nextQuakeListSort(cur: QuakeListSort, key: QuakeSortKey): QuakeListSort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'region' ? 'asc' : 'desc' }
}

/**
 * 絞った一覧が前回と同じ地震の並びなら、前回の配列を返す（毎分の時計や条件の再計算で、下流の memo と
 * 波形の取り先の選び直しを空回りさせない）。地震のカードが 1 枚でも作り直されていれば新しい配列を返す。
 */
export function keepIfSame(prev: JMAQuake[] | null, next: JMAQuake[]): JMAQuake[] {
  if (prev === null || prev.length !== next.length) return next
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) return next
  return prev
}

/**
 * 最新の 1 枚を、絞りで外れていても一覧に足す（2026-11-07 選択「最新の1枚は一覧にも出す (Recommended)」。
 * 選んでいる地震によらず常に足す —— 同日選択「いつも一覧に出す (Recommended)」。選び替えで行が出たり消えたりしない）。
 * **最新が既に一覧にあれば `filtered` をそのまま返す。** 足すときは `all`（時刻の新しい順）の並びを保つ。
 */
export function withLatestPinned(
  filtered: JMAQuake[],
  all: readonly JMAQuake[],
  latest: JMAQuake | null,
): JMAQuake[] {
  if (latest === null || filtered.includes(latest)) return filtered
  const shown = new Set(filtered)
  return all.filter(q => q === latest || shown.has(q))
}

/**
 * 窓の「◯件中 ◯件」の後ろの数。条件に合う地震だけを数える（2026-11-08 選択「条件に合う数だけ」）。
 * `filtered` は固定（飛んで開いた 1 件）を通した後の結果なので、固定の 1 件が条件に合わないときだけ 1 を引く。
 * 最新の 1 枚（`withLatestPinned` が足す）は `filtered` に入らないので、ここでは数えない。
 */
export function quakeListMatchedCount(
  filtered: readonly JMAQuake[],
  f: QuakeListFilter,
  ctx: QuakeFilterContext,
): number {
  if (ctx.pinnedKeys.size === 0) return filtered.length
  const unpinned: QuakeFilterContext = { ...ctx, pinnedKeys: new Set<string>() }
  let n = 0
  for (const q of filtered) if (!ctx.pinnedKeys.has(ctx.keyOf(q)) || passesQuakeListFilter(q, f, unpinned)) n++
  return n
}

