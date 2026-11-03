/**
 * 連続評価（`eval-kyoshin-continuous`）の検知を、気象庁の地震情報（震源・震度情報 VXSE53）が出た地震（有感）と突き合わせる（設計書§58）。
 *
 * 地震情報の発生時刻（`OriginTime`）は分で切り捨てて出る（`EventID` も発生時刻ではない）。分のまま照合すると、
 * 同じ分に先に起きた別の地震の束を当たりに数える（能登の週で 11 件）。照合には震源リストの同じ地震の発生時刻（秒まで）を使う。
 * 突き合わせの規則そのものは評価台・連続評価と同じ（`kyoshinCatalogMatch.ts`）。
 */
import type { JMAQuake } from '../../src/types/earthquake'
import { hasDepth } from '../../src/utils/formatters'
import { haversineKm } from '../../src/utils/geo'
import { matchCatalog, type CatalogQuake } from './kyoshinCatalogMatch'

const DAY_MS = 86_400_000
/** 地震情報の地震と震源リストの地震を同じとみなす、震央どうしの距離の上限（km） */
export const FELT_SAME_QUAKE_KM = 30
/** 見ていた区間の終わりから、この秒数の内に起きた地震は数えない（束が見え始める前に流し終えるため。照合の窓の後ろの端に揃える） */
export const FELT_END_MARGIN_SEC = 120

/** 地震情報が出た地震。`minuteMs` は電文の発生時刻（分で切り捨て・UTC のミリ秒） */
export interface FeltQuake {
  eventId: string
  minuteMs: number
  lat: number
  lng: number
  /** 深さ（km）。判らなければ NaN */
  depth: number
  /** M。判らなければ NaN */
  mag: number
  /** 最大震度（`IntensityScale`） */
  maxScale: number
  /** 震央地名 */
  area: string
  /** 電文の発表時刻（UTC のミリ秒）。同じ地震の報が複数あるとき、後の報を採る */
  issuedMs: number
}

/**
 * 読み取った地震情報から、有感の地震を取り出す。震源・震度情報（VXSE53）で、取消でなく、震度1 以上を観測し、
 * 震央と発生時刻が読めるものだけ。それ以外は null。
 *
 * `originTime` は電文の `Earthquake/OriginTime`（発生時刻）。読み取りの `earthquake.time` は発現時刻（`ArrivalTime`）を
 * 優先して入れるので使わない —— 発現時刻は発生時刻の次の分になることがあり、震源リストの同じ分から外れる（能登の週で 43 件）
 */
export type FeltReport =
  | { kind: 'felt'; quake: FeltQuake }
  /** 取消の報。同じ地震の前の報を打ち消す */
  | { kind: 'cancel'; eventId: string; issuedMs: number }
  /** 有感の地震として数えないと決まっている報（遠地地震など別の種別・震度1 未満・震源の位置が決まっていない） */
  | { kind: 'skip'; reason: string }
  /** 読めるはずの欄が読めなかった報。数え漏れになるので、呼ぶ側は不完全の印を立てる */
  | { kind: 'invalid'; reason: string }

export function feltQuakeOf(q: JMAQuake, originTime: string | null): FeltReport {
  const issuedMs = Date.parse(q.issue.time)
  if (!q.eventId) return { kind: 'invalid', reason: 'EventID が無い' }
  if (!Number.isFinite(issuedMs)) return { kind: 'invalid', reason: '発表時刻が読めない' }
  if (q.cancelled) return { kind: 'cancel', eventId: q.eventId, issuedMs }
  if (q.issue.type !== '震源・震度情報') return { kind: 'skip', reason: `種別が ${q.issue.type}` }
  if (!Number.isFinite(q.earthquake.maxScale)) return { kind: 'invalid', reason: '最大震度が数でない' }
  if (q.earthquake.maxScale < 10) return { kind: 'skip', reason: '震度1 未満' }
  const h = q.earthquake.hypocenter
  // 緯度経度の -200 は「位置不明」の印（`utils/geo.ts`）
  if (h.latitude === -200) return { kind: 'skip', reason: '震源の位置が決まっていない' }
  const minuteMs = originTime ? Date.parse(originTime) : NaN
  if (!Number.isFinite(minuteMs)) return { kind: 'invalid', reason: '発生時刻（OriginTime）が読めない' }
  return {
    kind: 'felt',
    quake: {
      eventId: q.eventId, minuteMs, lat: h.latitude, lng: h.longitude,
      depth: hasDepth(h.depth) ? h.depth : NaN, mag: h.magnitude, maxScale: q.earthquake.maxScale, area: h.name, issuedMs,
    },
  }
}

/**
 * 同じ地震（`eventId`）の報を 1 件にまとめる。発表の遅い報を採り、それが取消なら落とす。発生の順に並べる。
 * `cancelled` は、有感の報があったのに取消で落とした地震の数
 */
export function latestPerEvent(reports: readonly FeltReport[]): { quakes: FeltQuake[]; cancelled: number } {
  const byId = new Map<string, { issuedMs: number; quake: FeltQuake | null }>()
  const hadFelt = new Set<string>()
  for (const r of reports) {
    const entry = r.kind === 'felt' ? { issuedMs: r.quake.issuedMs, quake: r.quake, id: r.quake.eventId }
      : r.kind === 'cancel' ? { issuedMs: r.issuedMs, quake: null, id: r.eventId } : null
    if (!entry) continue
    if (entry.quake) hadFelt.add(entry.id)
    const prev = byId.get(entry.id)
    if (!prev || entry.issuedMs >= prev.issuedMs) byId.set(entry.id, entry)
  }
  const latest = [...byId.entries()]
  return {
    quakes: latest.flatMap(([, e]) => (e.quake ? [e.quake] : [])).sort((a, b) => a.minuteMs - b.minuteMs),
    cancelled: latest.filter(([id, e]) => e.quake === null && hadFelt.has(id)).length,
  }
}

/**
 * 震源リストから、地震情報の地震の発生時刻（秒まで）を引く。同じ分（分の頭から 60 秒の内）で震央が
 * {@link FELT_SAME_QUAKE_KM} km 以内のもののうち、「距離 ÷ 10 km ＋ M の差」がいちばん小さいもの。
 * 群発の最中は同じ分に近くの地震が並ぶので、距離だけでなく M でも選ぶ。M がどちらかで判らなければ距離だけで選ぶ。
 * 見つからなければ null
 */
export function catalogSecondOf(q: FeltQuake, quakes: readonly CatalogQuake[]): number | null {
  const score = (x: CatalogQuake) =>
    haversineKm(q.lat, q.lng, x.lat, x.lng) / 10 + (Number.isFinite(x.mag) && Number.isFinite(q.mag) ? Math.abs(x.mag - q.mag) : 0)
  let best: CatalogQuake | null = null
  for (const x of quakes) {
    if (x.t < q.minuteMs || x.t >= q.minuteMs + 60_000 || haversineKm(q.lat, q.lng, x.lat, x.lng) > FELT_SAME_QUAKE_KM) continue
    if (best === null || score(x) < score(best)) best = x
  }
  return best?.t ?? null
}

/** 連続評価の結果ファイルの検知のうち、照合に使う欄 */
export interface FeltEvent {
  /** 見え始め（秒フレームの時刻） */
  firstLikelyMs: number
  firstConfirmedMs: number | null
  pos: [number, number]
  maxMembers: number
  inWarmup: boolean
}

/** 流した日（YYYYMMDD・日本時間）を、続いた日ごとの区間（UTC のミリ秒）にまとめる。評価の道具は区間ごとに検知器を作り直す */
export function segmentsOfDays(days: readonly string[]): { from: number; to: number }[] {
  const segments: { from: number; to: number }[] = []
  for (const d of [...days].sort()) {
    const s = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 9 * 3_600_000
    const last = segments.at(-1)
    if (last && last.to === s) last.to = s + DAY_MS
    else segments.push({ from: s, to: s + DAY_MS })
  }
  return segments
}

/** 発生から地震情報（震源・震度情報）が出るまでの見込みの上限。区間の終わりの地震の報を読む日を決める */
export const FELT_ISSUE_LAG_MS = 3 * 3_600_000

/**
 * 流した日（YYYYMMDD・日本時間）の地震情報が入る、アーカイブの日（`YYYY-MM-DD`）の一覧。
 * アーカイブの日は日本時間の日で区切られる（束の電文の発表時刻で確かめた）。報は発生の後に出るので、
 * 区間の終わりから {@link FELT_ISSUE_LAG_MS} の内に掛かる次の日も読む
 */
export function archiveDaysOf(days: readonly string[]): string[] {
  const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10)
  const out: string[] = []
  for (const seg of segmentsOfDays(days)) {
    for (let ms = seg.from; ms < seg.to + FELT_ISSUE_LAG_MS; ms += DAY_MS) {
      const d = jstDay(ms)
      if (out.at(-1) !== d) out.push(d)
    }
    const last = jstDay(seg.to + FELT_ISSUE_LAG_MS - 1)
    if (out.at(-1) !== last) out.push(last)
  }
  return [...new Set(out)]
}

/** 連続評価が秒フレームの無かった時間（日本時間の YYYYMMDD と時）。この時間に起きた地震は見ていないので数えない */
export interface MissingHour { day: string; hour: number }

export interface FeltRow {
  quake: FeltQuake
  /** 照合に使った発生時刻（UTC のミリ秒）。震源リストに見つからなければ分のまま */
  t: number
  /** 震源リストから秒を引けた */
  fromCatalog: boolean
  /** 当たった束（震央に近い順）。空なら取りこぼし */
  matched: FeltEvent[]
}

export interface FeltResult {
  rows: FeltRow[]
  /** 流した日の内だが、助走の間・終わり際・秒フレームの無かった時間に起きたので数えなかった地震 */
  outside: FeltQuake[]
}

/**
 * 地震情報の地震ごとに、照合の規則で当たる束を探す。流した区間の外の地震は落とし、助走の間・終わり際・
 * 秒フレームの無かった時間（`missingHours`）の地震は `outside` へ分ける。
 * `frameOffsetMs` は UTC のミリ秒を秒フレームの時刻へ直す差（控えの秒フレームは日本時間の時刻を UTC として数える）
 */
export function matchFeltQuakes(
  felt: readonly FeltQuake[], events: readonly FeltEvent[], days: readonly string[], warmupSec: number,
  missingHours: readonly MissingHour[], frameOffsetMs: number, catalogOf: (q: FeltQuake) => readonly CatalogQuake[],
): FeltResult {
  // 秒フレームの無かった時間（UTC のミリ秒の区間）。その前の {@link FELT_END_MARGIN_SEC} 秒（束が見え始める前に欠けに入る）と、
  // その後の助走の間（連続評価は欠けの後で検知器を作り直す）も見ていないので広げておく
  const blind = missingHours.map((m) => {
    const from = Date.UTC(+m.day.slice(0, 4), +m.day.slice(4, 6) - 1, +m.day.slice(6, 8), m.hour) - 9 * 3_600_000
    return { from: from - FELT_END_MARGIN_SEC * 1000, to: from + 3_600_000 + warmupSec * 1000 }
  })
  const inBlind = (t: number) => blind.some((b) => t >= b.from && t < b.to)
  const segments = segmentsOfDays(days)
  const counted = events.filter((e) => !e.inWarmup)
  const rows: FeltRow[] = []
  const outside: FeltQuake[] = []
  for (const q of felt) {
    // 発生の分が区間に掛からない地震は、震源リストを引く前に落とす（流していない日の控えを要らずに済ませる）
    if (!segments.some((g) => q.minuteMs + 60_000 > g.from && q.minuteMs < g.to)) continue
    const sec = catalogSecondOf(q, catalogOf(q))
    const t = sec ?? q.minuteMs
    const seg = segments.find((g) => t >= g.from && t < g.to)
    if (!seg) continue
    if (t < seg.from + warmupSec * 1000 || t > seg.to - FELT_END_MARGIN_SEC * 1000 || inBlind(t)) { outside.push(q); continue }
    const quake: CatalogQuake = { t, lat: q.lat, lng: q.lng, depth: q.depth, mag: q.mag }
    const km = (e: FeltEvent) => haversineKm(q.lat, q.lng, e.pos[0], e.pos[1])
    const matched = counted.filter((e) => matchCatalog(e.firstLikelyMs - frameOffsetMs, e.pos, [quake])).sort((a, b) => km(a) - km(b))
    rows.push({ quake: q, t, fromCatalog: sec !== null, matched })
  }
  return { rows, outside }
}
