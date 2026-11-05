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
  | { kind: 'skip'; eventId: string; issuedMs: number; reason: string }
  /** 読めるはずの欄が読めなかった報。数え漏れになるので、呼ぶ側は不完全の印を立てる */
  | { kind: 'invalid'; reason: string }

export function feltQuakeOf(q: JMAQuake, originTime: string | null): FeltReport {
  const issuedMs = Date.parse(q.issue.time)
  if (!q.eventId) return { kind: 'invalid', reason: 'EventID が無い' }
  if (!Number.isFinite(issuedMs)) return { kind: 'invalid', reason: '発表時刻が読めない' }
  if (q.cancelled) return { kind: 'cancel', eventId: q.eventId, issuedMs }
  if (q.issue.type !== '震源・震度情報') return { kind: 'skip', eventId: q.eventId, issuedMs, reason: `種別が ${q.issue.type}` }
  if (!Number.isFinite(q.earthquake.maxScale)) return { kind: 'invalid', reason: '最大震度が数でない' }
  if (q.earthquake.maxScale < 10) return { kind: 'skip', eventId: q.eventId, issuedMs, reason: '震度1 未満' }
  const h = q.earthquake.hypocenter
  // 緯度経度の -200 は「位置不明」の印（`utils/geo.ts`）
  if (h.latitude === -200) return { kind: 'skip', eventId: q.eventId, issuedMs, reason: '震源の位置が決まっていない' }
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
  const watch = watchOf(days, warmupSec, missingHours, FELT_END_MARGIN_SEC)
  const counted = events.filter((e) => !e.inWarmup)
  const rows: FeltRow[] = []
  const outside: FeltQuake[] = []
  for (const q of felt) {
    // 発生の分が区間に掛からない地震は、震源リストを引く前に落とす（流していない日の控えを要らずに済ませる）
    if (!watch.touches(q.minuteMs)) continue
    const sec = catalogSecondOf(q, catalogOf(q))
    const t = sec ?? q.minuteMs
    const w = watch.at(t)
    if (w === 'unrun') continue
    if (w === 'blind') { outside.push(q); continue }
    const quake: CatalogQuake = { t, lat: q.lat, lng: q.lng, depth: q.depth, mag: q.mag }
    const km = (e: FeltEvent) => haversineKm(q.lat, q.lng, e.pos[0], e.pos[1])
    const matched = counted.filter((e) => matchCatalog(e.firstLikelyMs - frameOffsetMs, e.pos, [quake])).sort((a, b) => km(a) - km(b))
    rows.push({ quake: q, t, fromCatalog: sec !== null, matched })
  }
  return { rows, outside }
}

/**
 * 流した区間・助走・終わり際・秒フレームの無かった時間の判定。`at(t)` は、流していない時刻なら `'unrun'`、
 * 見ていない時刻（区間の頭の助走・終わりの `endMarginSec` 秒・秒フレームの無かった時間とその前後）なら `'blind'`、
 * 見ていた時刻なら `'watched'`。`touches(minuteMs)` は、その分の 60 秒がどこかの区間に掛かるか
 */
export function watchOf(days: readonly string[], warmupSec: number, missingHours: readonly MissingHour[], endMarginSec: number) {
  const segments = segmentsOfDays(days)
  // 秒フレームの無かった時間（UTC のミリ秒の区間）。その前の endMarginSec 秒（束が見え始める前に欠けに入る）と、
  // その後の助走の間（連続評価は欠けの後で検知器を作り直す）も見ていないので広げておく
  const blind = missingHours.map((m) => {
    const from = Date.UTC(+m.day.slice(0, 4), +m.day.slice(4, 6) - 1, +m.day.slice(6, 8), m.hour) - 9 * 3_600_000
    return { from: from - endMarginSec * 1000, to: from + 3_600_000 + warmupSec * 1000 }
  })
  return {
    touches: (minuteMs: number) => segments.some((g) => minuteMs + 60_000 > g.from && minuteMs < g.to),
    at(t: number): 'unrun' | 'blind' | 'watched' {
      const seg = segments.find((g) => t >= g.from && t < g.to)
      if (!seg) return 'unrun'
      if (t < seg.from + warmupSec * 1000 || t > seg.to - endMarginSec * 1000) return 'blind'
      return blind.some((b) => t >= b.from && t < b.to) ? 'blind' : 'watched'
    },
  }
}

/**
 * 震度速報（VXSE51）だけが出た地震。震源が無いので、最大震度を観測した地域と、電文の時刻（`Head/TargetDateTime`。分で切り捨て）で扱う
 */
export interface ShindoOnly {
  eventId: string
  minuteMs: number
  maxScale: number
  /** 最大震度を観測した地域（一次細分区域）の名前 */
  topAreas: string[]
}

/** 震度速報 1 通を読んだ結果。`invalid` は読めるはずの欄が読めなかった報で、呼ぶ側は不完全の印を立てる */
export type ShindoReport =
  | { kind: 'shindo'; shindo: ShindoOnly; issuedMs: number }
  | { kind: 'cancel'; eventId: string; issuedMs: number }
  | { kind: 'invalid'; reason: string }

/**
 * 震度速報を読む。`targetDateTime` は `Head/TargetDateTime`、`reportDateTime` は `Head/ReportDateTime`（どちらも電文の文字列）。
 * 地域の震度が 1 つも読めない報は、取消と分けて `invalid` にする（黙って落とすと震度速報だけの地震が 0 件に倒れる）
 */
export function shindoReportOf(q: JMAQuake | null, targetDateTime: string | null, reportDateTime: string | null): ShindoReport {
  if (!q) return { kind: 'invalid', reason: '震度速報を読み取れない' }
  if (!q.eventId) return { kind: 'invalid', reason: '震度速報に EventID が無い' }
  const issuedMs = Date.parse(reportDateTime ?? '')
  if (!Number.isFinite(issuedMs)) return { kind: 'invalid', reason: '震度速報の発表時刻（ReportDateTime）が読めない' }
  if (q.cancelled) return { kind: 'cancel', eventId: q.eventId, issuedMs }
  const target = Date.parse(targetDateTime ?? '')
  if (!Number.isFinite(target)) return { kind: 'invalid', reason: '震度速報の時刻（TargetDateTime）が読めない' }
  const areas = areaScalesOf(q)
  if (areas.size === 0) return { kind: 'invalid', reason: '震度速報の地域の震度が 1 つも読めない' }
  const maxScale = Math.max(...areas.values())
  return {
    kind: 'shindo', issuedMs,
    shindo: { eventId: q.eventId, minuteMs: Math.floor(target / 60_000) * 60_000, maxScale, topAreas: [...areas].filter(([, v]) => v === maxScale).map(([a]) => a) },
  }
}

/**
 * 震度速報を EventID ごとに 1 件にまとめる。発表の遅い報を採り（同じ時刻なら後に渡した報。{@link latestPerEvent} と同じ）、それが取消なら落とす。
 * `cancelled` は取消で落とした EventID の数
 */
export function latestShindoPerEvent(reports: readonly ShindoReport[]): { shindo: ShindoOnly[]; cancelled: number } {
  const byId = new Map<string, { issuedMs: number; shindo: ShindoOnly | null }>()
  for (const r of reports) {
    if (r.kind === 'invalid') continue
    const id = r.kind === 'shindo' ? r.shindo.eventId : r.eventId
    const prev = byId.get(id)
    if (!prev || r.issuedMs >= prev.issuedMs) byId.set(id, { issuedMs: r.issuedMs, shindo: r.kind === 'shindo' ? r.shindo : null })
  }
  const latest = [...byId.values()]
  return {
    shindo: latest.flatMap((e) => (e.shindo ? [e.shindo] : [])).sort((a, b) => a.minuteMs - b.minuteMs),
    cancelled: latest.filter((e) => e.shindo === null).length,
  }
}

/**
 * 震源・震度情報の報ごとの状態から、EventID ごとの状態を引く。数える報（`felt`）と取消（`cancel`）は {@link latestPerEvent} と同じく発表の遅い報を採り
 * （同じ時刻なら後に渡した報）、どちらも無く数えないと決まった報（震源の位置が決まっていない等）だけがある EventID は `skip`。
 * `areas` は採った `felt` の報の地域ごとの最大震度。`latestPerEvent` と食い違うと、同じ地震を震度速報の側でも数えてしまう
 */
export function latestQuakeStates(
  reports: readonly { report: FeltReport; areas: ReadonlyMap<string, number> }[],
): Map<string, { state: 'felt' | 'cancel' | 'skip'; areas: ReadonlyMap<string, number> }> {
  const byId = new Map<string, { issuedMs: number; state: 'felt' | 'cancel'; areas: ReadonlyMap<string, number> }>()
  const skipped = new Set<string>()
  for (const { report: r, areas } of reports) {
    if (r.kind === 'invalid') continue
    if (r.kind === 'skip') { skipped.add(r.eventId); continue }
    const id = r.kind === 'felt' ? r.quake.eventId : r.eventId
    const issuedMs = r.kind === 'felt' ? r.quake.issuedMs : r.issuedMs
    const prev = byId.get(id)
    if (!prev || issuedMs >= prev.issuedMs) byId.set(id, { issuedMs, state: r.kind, areas: r.kind === 'felt' ? areas : new Map() })
  }
  const out = new Map<string, { state: 'felt' | 'cancel' | 'skip'; areas: ReadonlyMap<string, number> }>()
  for (const [id, { state, areas }] of byId) out.set(id, { state, areas })
  for (const id of skipped) if (!out.has(id)) out.set(id, { state: 'skip', areas: new Map() })
  return out
}

/**
 * 読み取った地震情報の、地域（一次細分区域）ごとの最大震度。県の行（`pref` に県名が入る）と、震度5弱以上未入電の行（`scale` は下限の 45 を
 * 仮に置いたもの）は数えない
 */
export function areaScalesOf(q: JMAQuake): Map<string, number> {
  const m = new Map<string, number>()
  for (const p of q.points) if (p.isArea && p.pref === '' && !p.unreceived) m.set(p.addr, Math.max(m.get(p.addr) ?? 0, p.scale))
  return m
}

/** 震源・震度情報と結ぶとき、震源・震度情報の発生時刻（分）を、震度速報の時刻のこの長さ前まで見る */
export const SHINDO_LINK_BEFORE_MS = 3 * 60_000

/**
 * 震度速報だけの地震を、同じ地震の震源・震度情報（別の EventID で出ることがある）と結ぶ。結べなかったものと、結べたものの相手の EventID を返す。
 * 結ぶ条件は、震度速報で最大震度を観測した地域のどれかが、震源・震度情報でも同じ震度で出ていて、震源・震度情報の発生時刻（分）が
 * 震度速報の時刻の {@link SHINDO_LINK_BEFORE_MS} 前〜1 分後に入ること（震度速報の地域は揺れた所で、震源の地域とは限らない）。
 * `felt` には数える側の震源・震度情報だけを渡す（結んだ先が数えられていないと、その地震はどこにも数えられない）。
 *
 * 結び先は 1 対 1 にする。`taken` は、自分の EventID の震度速報を既に持つ震源・震度情報の EventID で、結び先にしない。
 * 候補が複数あれば発生時刻（分）がいちばん近いものを採り、採った先はほかの震度速報に使わない（群発の最中に、
 * 結び先の無い震度速報が別の地震へ結ばれて母数から消えるのを防ぐ）。`candidates` は採る前の候補の数
 */
export function linkShindo(
  shindo: readonly ShindoOnly[], felt: readonly { eventId: string; minuteMs: number; areas: ReadonlyMap<string, number> }[],
  taken: ReadonlySet<string>,
): { unlinked: ShindoOnly[]; links: { eventId: string; to: string; candidates: number }[] } {
  const used = new Set(taken)
  const unlinked: ShindoOnly[] = [], links: { eventId: string; to: string; candidates: number }[] = []
  for (const s of [...shindo].sort((a, b) => a.minuteMs - b.minuteMs)) {
    const cands = felt.filter((f) => !used.has(f.eventId)
      && f.minuteMs >= s.minuteMs - SHINDO_LINK_BEFORE_MS && f.minuteMs <= s.minuteMs + 60_000
      && s.topAreas.some((a) => f.areas.get(a) === s.maxScale))
    if (cands.length === 0) { unlinked.push(s); continue }
    const best = cands.reduce((a, b) => (Math.abs(b.minuteMs - s.minuteMs) < Math.abs(a.minuteMs - s.minuteMs) ? b : a))
    used.add(best.eventId)
    links.push({ eventId: s.eventId, to: best.eventId, candidates: cands.length })
  }
  return { unlinked, links }
}

/** 結べなかった震度速報を束に当てるときの、地域の代表点からの距離の上限（km。M3 未満の届く範囲 `catalogReachKm` に揃える） */
export const SHINDO_MATCH_KM = 150
/** 結べなかった震度速報を束に当てるときの窓（電文の分の頭の 10 秒前〜分の終わりの 120 秒後。近い地震の照合の窓に揃える） */
export const SHINDO_WINDOW_BEFORE_MS = 10_000
export const SHINDO_WINDOW_AFTER_MS = 60_000 + 120_000

/** `km[i]` は `matched[i]` の束から、いちばん近い代表点までの距離 */
export interface ShindoRow { shindo: ShindoOnly; matched: FeltEvent[]; km: number[] }

/**
 * 結べなかった震度速報を、最大震度を観測した地域の代表点（`labelOf`。引けない地域は使わない）と時刻で束に当てる。
 * 代表点のどれかから {@link SHINDO_MATCH_KM} の内で、窓の内に見え始めた束があれば当たり。流した区間の外は落として `unrun` に数え、
 * 見ていない時刻（終わり際の余白は窓の後ろの長さ）は `outside` へ分ける。代表点を 1 つでも引けない震度速報は `noLabel` へ分ける
 */
export function matchShindoOnly(
  shindo: readonly ShindoOnly[], events: readonly FeltEvent[], days: readonly string[], warmupSec: number,
  missingHours: readonly MissingHour[], frameOffsetMs: number, labelOf: (area: string) => readonly [number, number] | null,
): { rows: ShindoRow[]; outside: ShindoOnly[]; noLabel: ShindoOnly[]; unrun: number } {
  const watch = watchOf(days, warmupSec, missingHours, SHINDO_WINDOW_AFTER_MS / 1000)
  const counted = events.filter((e) => !e.inWarmup)
  const rows: ShindoRow[] = [], outside: ShindoOnly[] = [], noLabel: ShindoOnly[] = []
  let unrun = 0
  for (const s of shindo) {
    const w = watch.at(s.minuteMs)
    if (w === 'unrun') { unrun++; continue }
    if (w === 'blind') { outside.push(s); continue }
    const labels = s.topAreas.map(labelOf).filter((l): l is readonly [number, number] => l !== null)
    // 一部だけ引けないときも分ける（残りの代表点だけで照合すると、探す範囲が黙って狭まる）
    if (labels.length < s.topAreas.length) { noLabel.push(s); continue }
    const nearestKm = (e: FeltEvent) => Math.min(...labels.map(([lat, lng]) => haversineKm(lat, lng, e.pos[0], e.pos[1])))
    const matched = counted.filter((e) => {
      const seen = e.firstLikelyMs - frameOffsetMs
      return seen >= s.minuteMs - SHINDO_WINDOW_BEFORE_MS && seen <= s.minuteMs + SHINDO_WINDOW_AFTER_MS && nearestKm(e) <= SHINDO_MATCH_KM
    })
    rows.push({ shindo: s, matched, km: matched.map(nearestKm) })
  }
  return { rows, outside, noLabel, unrun }
}
