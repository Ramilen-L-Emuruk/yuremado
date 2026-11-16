// 中継の解析の口（GET /v2/analysis。設計書 docs/relay-server-design.md §6.8）の答えを読む。
//
// 型は中継のリポジトリの `src/analysis/types.ts` の写し。中継が欄を足しても読めるように、知らない欄は無視し、
// 要る欄が欠けた・形が違う答えは捨てる（控えない）。実物の答え（能登・三陸沖）で読めることを
// `relayAnalysis.test.ts` が固定する。

import { RELAY_API_BASE, relayRestEndpoint } from './relayEndpoint'
import { fetchJsonOutcome, API_FETCH_TIMEOUT_MS } from '../utils/fetchWithTimeout'
import { createLogThrottle, log } from '../utils/logger'

export type AnalysisSource = 'usgs' | 'emsc' | 'geofon' | 'jma'
export const ANALYSIS_SOURCES: readonly AnalysisSource[] = ['jma', 'usgs', 'emsc', 'geofon']

export interface NodalPlane { strike: number; dip: number; rake: number }

export interface FocalSolution {
  source: AnalysisSource
  /** 解を出した機関（USGS は `us`、EMSC がまとめた他機関の解ならその機関名） */
  agency: string
  /** 手法（USGS の Mww、気象庁の `CMT（精査後）`・`初動` など。取得元の書き方のまま） */
  method: string
  /** 同じ機関・手法の解を版をまたいで見分ける鍵 */
  key: string
  mw: number | null
  depthKm: number | null
  centroid: { lat: number; lon: number; time: string | null } | null
  planes: [NodalPlane, NodalPlane] | null
  /** 公表の時刻。気象庁の解は持たない（null） */
  publishedAt: string | null
  extra: Record<string, number | boolean>
}

export interface MatchedEvent {
  id: string
  time: string
  lat: number
  lon: number
  depthKm: number | null
  mag: number | null
  magType: string | null
  url: string | null
}

export type SourceStatus = 'pending' | 'matched' | 'none' | 'error'

export interface SourceState {
  status: SourceStatus
  checkedAt: string | null
  error: string | null
  errorAt: string | null
  missingAt: string | null
  event: MatchedEvent | null
}

export interface MatchedQuake { source: 'telegram' | 'catalog'; from: string; to: string }

export interface CatalogCheck {
  checkedAt: string
  result: 'found' | 'not-found' | 'unavailable'
  jmaQuakesNearUsgs: number | null
}

export interface PagerEstimate {
  level: string
  units: string
  bins: { min: number; max: number; probability: number; color: string }[]
}

export type ContentStatus = 'none' | 'pending' | 'done' | 'failed'

export interface UsgsPagerVersion {
  version: string; publishedAt: string; alert: string | null; maxMmi: number | null
  fatality: PagerEstimate | null; economic: PagerEstimate | null; content: ContentStatus
}
export interface UsgsShakeMapVersion {
  version: string; publishedAt: string; maxMmi: number | null; maxPga: number | null; maxPgv: number | null
  overlayUrl: string | null; content: ContentStatus
}
export interface UsgsFiniteFaultVersion {
  version: string; publishedAt: string; mw: number | null; maxSlipM: number | null
  strike: number | null; dip: number | null; rake: number | null; lengthKm: number | null; widthKm: number | null
  overlayUrl: string | null; content: ContentStatus
}
export interface UsgsGroundFailureVersion {
  version: string; publishedAt: string; landslideAlert: string | null; liquefactionAlert: string | null
  landslidePopulation: number | null; liquefactionPopulation: number | null
}
export interface UsgsDyfiVersion { version: string; publishedAt: string; responses: number | null; maxMmi: number | null }

export interface UsgsProducts {
  pager: UsgsPagerVersion[]
  shakemap: UsgsShakeMapVersion[]
  finiteFault: UsgsFiniteFaultVersion[]
  groundFailure: UsgsGroundFailureVersion[]
  dyfi: UsgsDyfiVersion[]
}

export interface QuakeAnalysis {
  eventId: string
  match: MatchedQuake
  catalogCheck: CatalogCheck | null
  watch: { usgsCheckedAt: string | null; usgsError: string | null; usgsErrorAt: string | null }
  sources: Record<AnalysisSource, SourceState>
  solutions: FocalSolution[]
  usgs: UsgsProducts
}

// ───── 読む ─────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** 形が違う欄を見つけたら投げる（答え全体を捨てる） */
class ShapeError extends Error {}
function need<T>(v: T | null, what: string): T {
  if (v === null) throw new ShapeError(`解析の答えの形が違います（${what}）`)
  return v
}

function readEvent(v: unknown): MatchedEvent | null {
  if (!isRecord(v)) return null
  const id = str(v.id)
  const time = isoOrNull(v.time)
  const lat = num(v.lat)
  const lon = num(v.lon)
  if (id === null || time === null || lat === null || lon === null) return null
  return { id, time, lat, lon, depthKm: num(v.depthKm), mag: num(v.mag), magType: str(v.magType), url: str(v.url) }
}

function readSource(v: unknown): SourceState {
  const r = isRecord(v) ? v : {}
  const status = str(r.status)
  const known = status === 'matched' || status === 'none' || status === 'pending' || status === 'error'
  // 知らない状態は確認中として出すが、中継の形が変わったことに気づけるよう記録は残す
  if (!known) warnDropped(() => log.warn('[analysis] 取得元の状態を読めませんでした（確認中として出します）', status))
  return {
    status: known ? status : 'pending',
    checkedAt: isoOrNull(r.checkedAt),
    error: str(r.error),
    errorAt: isoOrNull(r.errorAt),
    missingAt: isoOrNull(r.missingAt),
    event: readEvent(r.event),
  }
}

function readPlane(v: unknown): NodalPlane | null {
  if (!isRecord(v)) return null
  const strike = num(v.strike), dip = num(v.dip), rake = num(v.rake)
  return strike === null || dip === null || rake === null ? null : { strike, dip, rake }
}

function readSolution(v: unknown): FocalSolution | null {
  if (!isRecord(v)) return null
  const source = str(v.source)
  if (source !== 'usgs' && source !== 'emsc' && source !== 'geofon' && source !== 'jma') return null
  const agency = str(v.agency), method = str(v.method), key = str(v.key)
  if (agency === null || method === null || key === null) return null
  const planes = Array.isArray(v.planes) ? v.planes.map(readPlane) : null
  const extra: Record<string, number | boolean> = {}
  if (isRecord(v.extra)) for (const [k, x] of Object.entries(v.extra)) if (typeof x === 'number' || typeof x === 'boolean') extra[k] = x
  const c = isRecord(v.centroid) ? v.centroid : null
  const cLat = c ? num(c.lat) : null, cLon = c ? num(c.lon) : null
  return {
    source, agency, method, key,
    mw: num(v.mw),
    depthKm: num(v.depthKm),
    centroid: c && cLat !== null && cLon !== null ? { lat: cLat, lon: cLon, time: isoOrNull(c.time) } : null,
    planes: planes && planes.length === 2 && planes[0] && planes[1] ? [planes[0], planes[1]] : null,
    publishedAt: isoOrNull(v.publishedAt),
    extra,
  }
}

function readEstimate(v: unknown): PagerEstimate | null {
  if (!isRecord(v)) return null
  const bins = arr(v.bins).flatMap(b => {
    if (!isRecord(b)) return []
    const min = num(b.min), max = num(b.max), probability = num(b.probability)
    return min === null || max === null || probability === null ? [] : [{ min, max, probability, color: str(b.color) ?? '' }]
  })
  return { level: str(v.level) ?? '', units: str(v.units) ?? '', bins }
}

const content = (v: unknown): ContentStatus => (v === 'none' || v === 'pending' || v === 'done' || v === 'failed' ? v : 'pending')

/** 版の共通の欄（版と公表時刻）。欠けた版は捨てる */
function versionHead(v: unknown): { r: Record<string, unknown>; version: string; publishedAt: string } | null {
  if (!isRecord(v)) return null
  const version = str(v.version)
  const publishedAt = isoOrNull(v.publishedAt)
  return version === null || publishedAt === null ? null : { r: v, version, publishedAt }
}

function readProducts(v: unknown): UsgsProducts {
  const p = isRecord(v) ? v : {}
  const heads = (x: unknown) => arr(x).map(versionHead).filter(h => h !== null)
  return {
    pager: heads(p.pager).map(({ r, version, publishedAt }) => ({
      version, publishedAt, alert: str(r.alert), maxMmi: num(r.maxMmi), fatality: readEstimate(r.fatality), economic: readEstimate(r.economic), content: content(r.content),
    })),
    shakemap: heads(p.shakemap).map(({ r, version, publishedAt }) => ({
      version, publishedAt, maxMmi: num(r.maxMmi), maxPga: num(r.maxPga), maxPgv: num(r.maxPgv), overlayUrl: str(r.overlayUrl), content: content(r.content),
    })),
    finiteFault: heads(p.finiteFault).map(({ r, version, publishedAt }) => ({
      version, publishedAt, mw: num(r.mw), maxSlipM: num(r.maxSlipM), strike: num(r.strike), dip: num(r.dip), rake: num(r.rake),
      lengthKm: num(r.lengthKm), widthKm: num(r.widthKm), overlayUrl: str(r.overlayUrl), content: content(r.content),
    })),
    groundFailure: heads(p.groundFailure).map(({ r, version, publishedAt }) => ({
      version, publishedAt, landslideAlert: str(r.landslideAlert), liquefactionAlert: str(r.liquefactionAlert),
      landslidePopulation: num(r.landslidePopulation), liquefactionPopulation: num(r.liquefactionPopulation),
    })),
    dyfi: heads(p.dyfi).map(({ r, version, publishedAt }) => ({ version, publishedAt, responses: num(r.responses), maxMmi: num(r.maxMmi) })),
  }
}

/** 中継の答えを読む。要る欄（EventID・結んだ地震・取得元の並び）が欠けていれば投げる */
export function parseQuakeAnalysis(json: unknown): QuakeAnalysis {
  if (!isRecord(json)) throw new ShapeError('解析の答えの形が違います（オブジェクトではありません）')
  const eventId = need(str(json.eventId), 'eventId')
  const m = isRecord(json.match) ? json.match : null
  const matchSource = m ? str(m.source) : null
  const match: MatchedQuake = {
    source: need(matchSource === 'telegram' || matchSource === 'catalog' ? matchSource : null, 'match.source'),
    from: need(m ? isoOrNull(m.from) : null, 'match.from'),
    to: need(m ? isoOrNull(m.to) : null, 'match.to'),
  }
  const cc = isRecord(json.catalogCheck) ? json.catalogCheck : null
  const ccResult = cc ? str(cc.result) : null
  const catalogCheck: CatalogCheck | null = cc && isoOrNull(cc.checkedAt) && (ccResult === 'found' || ccResult === 'not-found' || ccResult === 'unavailable')
    ? { checkedAt: isoOrNull(cc.checkedAt)!, result: ccResult, jmaQuakesNearUsgs: num(cc.jmaQuakesNearUsgs) }
    : null
  const w = isRecord(json.watch) ? json.watch : {}
  if (!isRecord(json.sources)) throw new ShapeError('解析の答えの形が違います（sources）')
  const srcs = json.sources
  const rawSolutions = arr(json.solutions)
  const solutions = rawSolutions.map(readSolution).filter(s => s !== null)
  const usgs = readProducts(json.usgs)
  // 形の合わない解・版は捨てて残りを出すが、捨てたことは記録に残す（中継の形が変わったとき「無い」に化けて黙らないように）
  const rawVersions = isRecord(json.usgs) ? Object.values(json.usgs).reduce<number>((n, v) => n + arr(v).length, 0) : 0
  const keptVersions = Object.values(usgs).reduce((n, v) => n + v.length, 0)
  const dropped = { solutions: rawSolutions.length - solutions.length, versions: rawVersions - keptVersions }
  if (dropped.solutions > 0 || dropped.versions > 0) warnDropped(() => log.warn(`[analysis] 形の合わない解・版を捨てました（${eventId}）`, dropped))
  return {
    eventId,
    match,
    catalogCheck,
    watch: { usgsCheckedAt: isoOrNull(w.usgsCheckedAt), usgsError: str(w.usgsError), usgsErrorAt: isoOrNull(w.usgsErrorAt) },
    sources: { usgs: readSource(srcs.usgs), emsc: readSource(srcs.emsc), geofon: readSource(srcs.geofon), jma: readSource(srcs.jma) },
    solutions,
    usgs,
  }
}

const warnDropped = createLogThrottle(60_000)

// ───── 並べる・絞る ─────

/** 公表の時刻を数で比べる（取得元ごとに小数の桁が違うので文字では比べない）。持たないものは一番古く扱う */
const publishedMs = (iso: string | null): number => (iso === null ? -Infinity : Date.parse(iso))

/** 同じ鍵（同じ機関・手法）の解を版でまとめ、新しい版を先に置く */
export function groupSolutionVersions(solutions: readonly FocalSolution[]): { latest: FocalSolution; older: FocalSolution[] }[] {
  const by = new Map<string, FocalSolution[]>()
  for (const s of solutions) by.set(s.key, [...(by.get(s.key) ?? []), s])
  return [...by.values()].map(v => {
    const sorted = [...v].sort((a, b) => publishedMs(b.publishedAt) - publishedMs(a.publishedAt))
    return { latest: sorted[0], older: sorted.slice(1) }
  })
}

/** 要約の行に使う代表の解（気象庁 → USGS → 先頭の順） */
export function representativeSolution(a: QuakeAnalysis): FocalSolution | null {
  const groups = groupSolutionVersions(a.solutions)
  return groups.find(g => g.latest.source === 'jma')?.latest
    ?? groups.find(g => g.latest.source === 'usgs')?.latest
    ?? groups[0]?.latest
    ?? null
}

export type FaultType = 'reverse' | 'normal' | 'strikeSlip'

/** すべり角から断層の型を決める（±45°〜±135° を逆断層・正断層、それ以外を横ずれとする） */
export function faultTypeOf(plane: NodalPlane): FaultType {
  if (plane.rake >= 45 && plane.rake <= 135) return 'reverse'
  if (plane.rake >= -135 && plane.rake <= -45) return 'normal'
  return 'strikeSlip'
}

/**
 * リプレイの時計（`nowMs`）より前に公表されていた版だけを残す（計画書 項目 98「リプレイ」）。
 * 公表の時刻を持たない解（気象庁の速報値・精査後）は、いつ出たか分からないので落とす。
 * 取得元の地震そのもの（`sources[].event`）は版を持たないので、その機関の版が 1 つでも出ていたときだけ残す
 */
export function analysisAsOf(a: QuakeAnalysis, nowMs: number): QuakeAnalysis {
  const before = (iso: string | null) => iso !== null && Date.parse(iso) <= nowMs
  const solutions = a.solutions.filter(s => before(s.publishedAt))
  const usgs: UsgsProducts = {
    pager: a.usgs.pager.filter(v => before(v.publishedAt)),
    shakemap: a.usgs.shakemap.filter(v => before(v.publishedAt)),
    finiteFault: a.usgs.finiteFault.filter(v => before(v.publishedAt)),
    groundFailure: a.usgs.groundFailure.filter(v => before(v.publishedAt)),
    dyfi: a.usgs.dyfi.filter(v => before(v.publishedAt)),
  }
  // 取得元の地震そのもの（規模・震源）は公表の時刻を持たないので、その機関の版が 1 つでも再生の時計までに
  // 出ていたときだけ見せる（出ていなければ「確認中」。確定後の規模が再生の画面へ先に混ざらないように）
  const published = (s: AnalysisSource) =>
    solutions.some(x => x.source === s) || (s === 'usgs' && Object.values(usgs).some(v => v.length > 0))
  const sources = Object.fromEntries(ANALYSIS_SOURCES.map(s => [
    s,
    a.sources[s].event && !published(s) ? { ...a.sources[s], status: 'pending', event: null } : a.sources[s],
  ])) as Record<AnalysisSource, SourceState>
  return { ...a, solutions, usgs, sources }
}

/**
 * 答え全体の時点: 中継が取得元・USGS の見張り・長期震源カタログを確かめた時刻のうち一番新しいもの。
 * 読めない時刻は比べる前に捨てる（先頭が壊れていても他の時刻を採る）。どれも無ければ null
 */
export function analysisCheckedAt(a: QuakeAnalysis): string | null {
  let best: string | null = null
  let bestMs = -Infinity
  for (const s of [...ANALYSIS_SOURCES.map(k => a.sources[k].checkedAt), a.watch.usgsCheckedAt, a.catalogCheck?.checkedAt ?? null]) {
    if (s === null) continue
    const ms = Date.parse(s)
    if (Number.isNaN(ms) || ms <= bestMs) continue
    best = s
    bestMs = ms
  }
  return best
}

/** 版の並びから一番新しい版（公表の時刻が一番遅いもの） */
export function latestVersion<T extends { publishedAt: string }>(versions: readonly T[]): T | null {
  let best: T | null = null
  for (const v of versions) if (!best || publishedMs(v.publishedAt) > publishedMs(best.publishedAt)) best = v
  return best
}

/** どの取得元にも該当が無い（解も製品も無い）か */
export function analysisIsEmpty(a: QuakeAnalysis): boolean {
  return a.solutions.length === 0
    && ANALYSIS_SOURCES.every(s => a.sources[s].event === null)
    && Object.values(a.usgs).every(v => v.length === 0)
}

// ───── 取る ─────

export interface AnalysisQuery {
  eventId: string
  /** 地震情報の発生時刻（ISO） */
  time: string
  lat: number
  lon: number
  depthKm: number | null
  mag: number | null
}

export type AnalysisFetchResult =
  /** `raw` は答えの JSON そのまま（端末の控えへ書く） */
  | { kind: 'ok'; analysis: QuakeAnalysis; raw: unknown }
  /** 中継がこの地震を確かめられない（404）。行を出さない */
  | { kind: 'unverifiable' }
  /** `cause` は元の例外（JSON の壊れ方・形の違い）。記録に添える */
  | { kind: 'error'; message: string; cause: unknown }

export function analysisUrl(q: AnalysisQuery): string {
  const p = new URLSearchParams({ eventId: q.eventId, time: q.time, lat: String(q.lat), lon: String(q.lon) })
  if (q.depthKm !== null) p.set('depth', String(q.depthKm))
  if (q.mag !== null) p.set('mag', String(q.mag))
  return `${RELAY_API_BASE}/analysis?${p}`
}

/** 中継へ解析を問い合わせる。札・門は REST の取得と同じ 1 組を使う */
export async function fetchQuakeAnalysis(q: AnalysisQuery, signal: AbortSignal | null): Promise<AnalysisFetchResult> {
  const ep = relayRestEndpoint
  await ep.prepare(signal ?? undefined)
  await ep.waitApiSlot()
  const outcome = await fetchJsonOutcome(analysisUrl(q), { timeoutMs: API_FETCH_TIMEOUT_MS, signal, init: { headers: ep.apiHeaders() } }, res => res.ok)
  ep.observe(outcome.status, outcome.headers)
  if (outcome.status === 404) return { kind: 'unverifiable' }
  if (!outcome.ok || outcome.body === null) return { kind: 'error', message: `status=${outcome.status}`, cause: null }
  if ('error' in outcome.body) return { kind: 'error', message: '答えを JSON として読めません', cause: outcome.body.error }
  try {
    return { kind: 'ok', analysis: parseQuakeAnalysis(outcome.body.value), raw: outcome.body.value }
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e), cause: e }
  }
}
