import { useEffect, useMemo, useState } from 'react'
import type { JMAQuake } from '../types/earthquake'
import { analysisAsOf, fetchQuakeAnalysis, latestVersion, parseQuakeAnalysis, type AnalysisQuery, type QuakeAnalysis } from '../services/relayAnalysis'
import type { AnalysisOverlayLayer } from '../services/analysisOverlay'
import { readAnalysis, writeAnalysis } from '../utils/analysisDb'
import { testAnalysisFor } from '../utils/testAnalysis'
import { serverNow } from '../utils/clock'
import { hasDepth, hasMagnitude } from '../utils/formatters'
import { hasKnownEpicenter } from '../utils/geo'
import { createLogThrottle, log } from '../utils/logger'
import { extractQuakeEventId } from '../utils/quakeMerge'

/**
 * 地震カードに添える解析（計画書 項目 98）。カードを開くたびに、まず端末の控えを出し、中継へ問い合わせて新しい答えで置き換える
 * （「端末の控え」。日数で打ち切らない）。中継が確かめられない地震（404）には何も出さない。
 *
 * **リプレイ中は、再生の時計より前に公表されていた版だけを出す**（「リプレイ」）。時計が進むと後の版に入れ替わるよう、
 * 開いている間は {@link REPLAY_TICK_MS} ごとに絞り直す。公表の時刻を持たない気象庁の解は出さない（`analysisAsOf`）。
 */

/** リプレイ中に版を絞り直す間隔（ms） */
const REPLAY_TICK_MS = 10_000

export type QuakeAnalysisView =
  /** 解析を問い合わせない地震（EventID・震央が無い・取り消された） */
  | { state: 'none' }
  /** 控えが無く、問い合わせ中 */
  | { state: 'loading' }
  /** 中継がこの地震を確かめられない（404）。行を出さない */
  | { state: 'unverifiable' }
  /** 控えが無く、問い合わせにも失敗した */
  | { state: 'failed' }
  /**
   * 答えがある。`refreshing` は控えを出しつつ問い合わせている間、`refreshFailed` は控えを出したが今回の問い合わせに失敗したとき
   * （出しているのは前に取った答え）
   */
  | { state: 'ready'; analysis: QuakeAnalysis; refreshing: boolean; refreshFailed: boolean }

/**
 * 地図に重ねられる版の URL（推定の揺れ・断層のすべり）。中身を取り終えた（`content: 'done'`）一番新しい版を選ぶ。
 * 無ければ null（カードの切り替えを出さない）。リプレイ中は絞った後の答えから選ぶので、再生の時計までの版になる
 */
export function analysisOverlayUrls(view: QuakeAnalysisView): Record<AnalysisOverlayLayer, string | null> {
  if (view.state !== 'ready') return { mmi: null, slip: null }
  const pick = (versions: readonly { publishedAt: string; overlayUrl: string | null; content: string }[]) =>
    latestVersion(versions.filter(v => v.content === 'done' && v.overlayUrl !== null))?.overlayUrl ?? null
  return { mmi: pick(view.analysis.usgs.shakemap), slip: pick(view.analysis.usgs.finiteFault) }
}

/** カードの地震から中継への問い合わせを組む。組めない地震（EventID・震央・時刻が無い・取り消し）は `null` */
export function analysisQueryOf(quake: JMAQuake): AnalysisQuery | null {
  if (quake.cancelledAt) return null
  const eventId = quake.eventId ?? extractQuakeEventId(quake)
  if (!eventId || !/^\d{14}$/.test(eventId)) return null
  const h = quake.earthquake.hypocenter
  if (!hasKnownEpicenter(h.latitude, h.longitude)) return null
  const time = quake.earthquake.originTime ?? quake.earthquake.time
  if (!Number.isFinite(Date.parse(time))) return null
  return {
    eventId,
    time,
    lat: h.latitude,
    lon: h.longitude,
    depthKm: hasDepth(h.depth) ? h.depth : null,
    mag: hasMagnitude(h.magnitude) ? h.magnitude : null,
  }
}

type Fetched =
  | { kind: 'idle' }
  | { kind: 'loading'; cached: QuakeAnalysis | null }
  | { kind: 'done'; analysis: QuakeAnalysis | null; outcome: 'ok' | 'unverifiable' | 'error' }

/**
 * 問い合わせに失敗したときの状態。控えがあれば控えを、無ければ**直前まで出していた答え**を出し続ける
 * （控えを持てない端末で、続報の取り直しが一時的に失敗しただけで「取得失敗」に落ちて重ねまで閉じないように）
 */
function failedKeeping(cached: QuakeAnalysis | null): (prev: Fetched) => Fetched {
  return prev => ({
    kind: 'done',
    analysis: cached ?? (prev.kind === 'loading' ? prev.cached : prev.kind === 'done' ? prev.analysis : null),
    outcome: 'error',
  })
}

/** 取得の失敗の記録は 1 分に 1 回へ間引く（中継が落ちている間に、開閉のたびに積み上がらないように） */
const warnFetch = createLogThrottle(60_000)
const warnCache = createLogThrottle(60_000)

/** 控えの答えを読む。形が変わって読めなければ無かったことにする（記録は残す。取得できれば上書きされる） */
async function readCached(eventId: string): Promise<QuakeAnalysis | null> {
  const row = await readAnalysis(eventId)
  if (!row) return null
  try {
    return parseQuakeAnalysis(row.body)
  } catch (e) {
    warnCache(() => log.warn(`[analysis] 控えの解析の答えを読めませんでした（${eventId}）`, e))
    return null
  }
}

/**
 * @param quake カードの地震
 * @param open カードが開いているか。閉じている間は問い合わせず `none` を返す。開くたびに問い合わせる
 * @param replaying リプレイ中か
 */
export function useQuakeAnalysis(quake: JMAQuake, open: boolean, replaying: boolean): QuakeAnalysisView {
  // 閉じている間は組み立てない（一覧の全カードで呼ばれるので、開いているカードの分だけ）
  const query = useMemo(() => (open ? analysisQueryOf(quake) : null), [quake, open])
  const queryKey = query ? JSON.stringify(query) : null
  const [fetched, setFetched] = useState<Fetched>({ kind: 'idle' })
  const [nowMs, setNowMs] = useState(() => serverNow())

  useEffect(() => {
    if (!open || query === null) return
    // 設定の窓「解析テスト」の地震は、中継に問い合わせずに置いた答えを出す（控えにも書かない）
    const injected = testAnalysisFor(query.eventId)
    if (injected !== undefined) {
      try {
        setFetched({ kind: 'done', analysis: parseQuakeAnalysis(injected), outcome: 'ok' })
      } catch (e) {
        log.warn('[analysis] テストの解析の答えを読めませんでした', e)
        setFetched({ kind: 'done', analysis: null, outcome: 'error' })
      }
      return
    }
    const ac = new AbortController()
    let cancelled = false
    // 開き直したときは、前に出していた答えを出したまま問い合わせる（控えを読む間に「読み込み中」へ戻さない）
    setFetched(prev => ({ kind: 'loading', cached: prev.kind === 'done' ? prev.analysis : prev.kind === 'loading' ? prev.cached : null }))
    void (async () => {
      const cached = await readCached(query.eventId)
      if (cancelled) return
      if (cached) setFetched({ kind: 'loading', cached })
      try {
        const r = await fetchQuakeAnalysis(query, ac.signal)
        if (cancelled) return
        if (r.kind === 'ok') {
          setFetched({ kind: 'done', analysis: r.analysis, outcome: 'ok' })
          void writeAnalysis(query.eventId, r.raw, Date.now())
        } else if (r.kind === 'unverifiable') {
          setFetched({ kind: 'done', analysis: null, outcome: 'unverifiable' })
        } else {
          warnFetch(() => log.warn(`[analysis] 解析を取得できませんでした（${query.eventId}）: ${r.message}`, r.cause))
          setFetched(failedKeeping(cached))
        }
      } catch (e) {
        if (cancelled) return
        warnFetch(() => log.warn(`[analysis] 解析を取得できませんでした（${query.eventId}）`, e))
        setFetched(failedKeeping(cached))
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
    // query は queryKey と同じ中身で作り直されるので、鍵で見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queryKey])

  useEffect(() => {
    if (!open || !replaying) return
    setNowMs(serverNow())
    const id = setInterval(() => setNowMs(serverNow()), REPLAY_TICK_MS)
    return () => clearInterval(id)
  }, [open, replaying])

  return useMemo((): QuakeAnalysisView => {
    if (query === null) return { state: 'none' }
    const shown = (a: QuakeAnalysis) => (replaying ? analysisAsOf(a, nowMs) : a)
    switch (fetched.kind) {
      case 'idle':
        return { state: 'loading' }
      case 'loading':
        return fetched.cached
          ? { state: 'ready', analysis: shown(fetched.cached), refreshing: true, refreshFailed: false }
          : { state: 'loading' }
      case 'done':
        if (fetched.outcome === 'unverifiable') return { state: 'unverifiable' }
        if (fetched.analysis === null) return { state: 'failed' }
        return { state: 'ready', analysis: shown(fetched.analysis), refreshing: false, refreshFailed: fetched.outcome === 'error' }
    }
  }, [query, fetched, replaying, nowMs])
}
