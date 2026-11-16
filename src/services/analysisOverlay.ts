// 地震カードの「MMI（USGS）」「すべり」で地図に重ねるファイル（中継の公開の置き場所 `https://data.yuremado.com/x/…`）を取って検める。
//
// 中継は USGS の ShakeMap の等値線（`cont_mmi.json`）と有限断層モデル（`FFM.geojson`）を版ごとに写して置き、
// 解析の答え（`relayAnalysis.ts`）の `overlayUrl` で指す。版の URL ごとに中身は変わらないので、取れた分は
// 開いている間の記憶に持ち、同じ版を取り直さない。

import type { Feature, FeatureCollection, MultiLineString, Polygon } from 'geojson'
import { fetchJsonOutcome, API_FETCH_TIMEOUT_MS } from '../utils/fetchWithTimeout'

/** 重ねのファイルの土台（公開バケット）。ここで始まらない URL は取らない */
export const ANALYSIS_OVERLAY_BASE = 'https://data.yuremado.com/x/'

export type AnalysisOverlayLayer = 'mmi' | 'slip'

export interface MmiOverlay {
  layer: 'mmi'
  /** 等値線。`value` は MMI（0.5 刻み） */
  lines: FeatureCollection<MultiLineString, { value: number }>
  maxMmi: number
}

export interface SlipOverlay {
  layer: 'slip'
  /** 断層面の小区画。`slip` はすべりの量（m） */
  cells: FeatureCollection<Polygon, { slip: number }>
  maxSlipM: number
}

export type AnalysisOverlay = MmiOverlay | SlipOverlay

export type AnalysisOverlayResult =
  | { kind: 'ok'; overlay: AnalysisOverlay }
  | { kind: 'error'; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPosition = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1])
const isLine = (l: unknown): l is [number, number][] => Array.isArray(l) && l.length >= 2 && l.every(isPosition)
const isRing = (r: unknown): r is [number, number][] => Array.isArray(r) && r.length >= 4 && r.every(isPosition)

function features(json: unknown): unknown[] {
  if (!isRecord(json) || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    throw new Error('重ねのファイルの形が違います（FeatureCollection ではありません）')
  }
  return json.features
}

/** ShakeMap の等値線を読む。線と値の欠けた地物は捨てる。1 本も残らなければ投げる */
export function parseMmiOverlay(json: unknown): MmiOverlay {
  const out: Feature<MultiLineString, { value: number }>[] = []
  for (const f of features(json)) {
    if (!isRecord(f) || !isRecord(f.geometry) || !isRecord(f.properties)) continue
    const value = f.properties.value
    const g = f.geometry
    if (!finite(value)) continue
    const lines = g.type === 'MultiLineString' && Array.isArray(g.coordinates) ? g.coordinates.filter(isLine)
      : g.type === 'LineString' && isLine(g.coordinates) ? [g.coordinates] : []
    if (lines.length === 0) continue
    out.push({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines }, properties: { value } })
  }
  if (out.length === 0) throw new Error('重ねのファイルに等値線がありません')
  return { layer: 'mmi', lines: { type: 'FeatureCollection', features: out }, maxMmi: Math.max(...out.map(f => f.properties.value)) }
}

/** 有限断層モデルの小区画を読む。面とすべりの欠けた地物は捨てる。1 つも残らなければ投げる */
export function parseSlipOverlay(json: unknown): SlipOverlay {
  const out: Feature<Polygon, { slip: number }>[] = []
  for (const f of features(json)) {
    if (!isRecord(f) || !isRecord(f.geometry) || !isRecord(f.properties)) continue
    const slip = f.properties.slip
    const g = f.geometry
    if (!finite(slip) || g.type !== 'Polygon' || !Array.isArray(g.coordinates) || !g.coordinates.every(isRing) || g.coordinates.length === 0) continue
    out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: g.coordinates as [number, number][][] }, properties: { slip } })
  }
  if (out.length === 0) throw new Error('重ねのファイルに断層の区画がありません')
  return { layer: 'slip', cells: { type: 'FeatureCollection', features: out }, maxSlipM: Math.max(...out.map(f => f.properties.slip)) }
}

/** 重ねの範囲（南西と北東の [緯度, 経度]）。地図をこの範囲へ寄せるのに使う */
export function analysisOverlayBounds(o: AnalysisOverlay): [[number, number], [number, number]] {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
  const visit = (p: readonly number[]) => {
    const [lng, lat] = p
    if (lat < s) s = lat
    if (lat > n) n = lat
    if (lng < w) w = lng
    if (lng > e) e = lng
  }
  if (o.layer === 'mmi') for (const f of o.lines.features) for (const l of f.geometry.coordinates) l.forEach(visit)
  else for (const f of o.cells.features) for (const r of f.geometry.coordinates) r.forEach(visit)
  return [[s, w], [n, e]]
}

/** 取れた重ね（版の URL ごと）。版の中身は変わらないので、アプリを開いている間は取り直さない */
const loaded = new Map<string, AnalysisOverlay>()
const LOADED_MAX = 20

/** 重ねのファイルを取る。公開の置き場所の外の URL は取らない */
export async function fetchAnalysisOverlay(url: string, layer: AnalysisOverlayLayer, signal: AbortSignal | null): Promise<AnalysisOverlayResult> {
  if (!url.startsWith(ANALYSIS_OVERLAY_BASE)) return { kind: 'error', message: `重ねの置き場所の外です: ${url}` }
  const hit = loaded.get(url)
  if (hit && hit.layer === layer) return { kind: 'ok', overlay: hit }
  // 取れなかった版は少しの間覚えて、切り替えを押し直すたびに取りに行かない
  const failedAt = failed.get(url)
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_RETRY_MS) return { kind: 'error', message: '直前に取得できなかった版です' }
  const fail = (message: string): AnalysisOverlayResult => {
    failed.set(url, Date.now())
    return { kind: 'error', message }
  }
  const outcome = await fetchJsonOutcome(url, { timeoutMs: API_FETCH_TIMEOUT_MS, signal }, res => res.ok)
  if (!outcome.ok || outcome.body === null) return fail(`status=${outcome.status}`)
  if ('error' in outcome.body) return fail('重ねのファイルを JSON として読めません')
  try {
    const overlay = layer === 'mmi' ? parseMmiOverlay(outcome.body.value) : parseSlipOverlay(outcome.body.value)
    loaded.set(url, overlay)
    // 記憶は新しい順に {@link LOADED_MAX} 版まで（開いた地震の数だけ膨らまないように。古いものは開き直せば取り直す）
    if (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value as string)
    failed.delete(url)
    return { kind: 'ok', overlay }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/** 取れなかった版と時刻。{@link FAILED_RETRY_MS} の間は取り直さない */
const failed = new Map<string, number>()
const FAILED_RETRY_MS = 60_000

/** テスト用: 記憶を捨てる */
export function clearAnalysisOverlayMemo(): void {
  loaded.clear()
  failed.clear()
  overlayFailure = null
  retryCount = 0
}

// ───── 開いている重ねを取れなかったこと（地図左上の帯 `MapDataStatus` が読む） ─────

/** 開いている重ねのうち、取れなかったもの。閉じた・取れたら null */
let overlayFailure: { layer: AnalysisOverlayLayer; url: string } | null = null
/** 押し直しの回数。重ねの部品はこれが変わると取り直す */
let retryCount = 0
const statusListeners = new Set<() => void>()
const emitStatus = () => { for (const fn of statusListeners) fn() }

export function subscribeAnalysisOverlayStatus(fn: () => void): () => void {
  statusListeners.add(fn)
  return () => { statusListeners.delete(fn) }
}
export const getAnalysisOverlayFailure = () => overlayFailure
export const getAnalysisOverlayRetry = () => retryCount

/** 重ねの部品が、開いている重ねを取れなかった（`null` は取れた・閉じた） */
export function setAnalysisOverlayFailure(f: { layer: AnalysisOverlayLayer; url: string } | null): void {
  if (overlayFailure?.url === f?.url && overlayFailure?.layer === f?.layer) return
  overlayFailure = f
  emitStatus()
}

/** この版の重ねを開いていて、取れなかったか（押し直しを、閉じる代わりに取り直しにするのに使う） */
export const analysisOverlayFailedFor = (url: string) => overlayFailure?.url === url

/**
 * 取れなかった重ねを取り直す（帯の「押し直すと取り直します」。2026-11-16 ユーザー選択「その帯に載せる (Recommended)」）。
 * 押し直しは利用者の操作なので、取れなかった版を少しの間取り直さない間引きを外す
 */
export function retryAnalysisOverlay(url: string): void {
  failed.delete(url)
  retryCount++
  emitStatus()
}

// ───── 色 ─────

/**
 * USGS の ShakeMap の MMI の色（添字が MMI。I〜X）。USGS の凡例の段（I・II–III・IV〜IX・X+）に合わせ、
 * II と III は同じ色、X は赤
 */
export const MMI_COLORS = ['#ffffff', '#ffffff', '#bfccff', '#bfccff', '#a0e6ff', '#80ffff', '#7aff93', '#ffff00', '#ffc800', '#ff9100', '#ff0000'] as const
/** 凡例の段（USGS の ShakeMap の凡例と同じ並び）。`mmi` はその段の色を引く階級 */
export const MMI_LEGEND_STEPS = [
  { label: 'I', mmi: 1 }, { label: 'II–III', mmi: 2 }, { label: 'IV', mmi: 4 }, { label: 'V', mmi: 5 }, { label: 'VI', mmi: 6 },
  { label: 'VII', mmi: 7 }, { label: 'VIII', mmi: 8 }, { label: 'IX', mmi: 9 }, { label: 'X+', mmi: 10 },
] as const
export const MMI_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'] as const
export const mmiIndex = (v: number): number => Math.max(0, Math.min(10, Math.round(v)))
export const mmiColor = (v: number): string => MMI_COLORS[mmiIndex(v)]

/** すべりの色の段（0 から最大までを 5 段。USGS の有限断層の図と同じく白から赤） */
export const SLIP_COLORS = ['#ffffcc', '#fed976', '#fd8d3c', '#e31a1c', '#800026'] as const

/** すべりの量の色を最大との比で決める段（凡例と地図の式で同じものを使う） */
export function slipColorStops(maxSlipM: number): { at: number; color: string }[] {
  const top = maxSlipM > 0 ? maxSlipM : 1
  return SLIP_COLORS.map((color, i) => ({ at: (top * i) / (SLIP_COLORS.length - 1), color }))
}
