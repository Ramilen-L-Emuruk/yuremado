import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JMAQuake } from '../types/earthquake'
import { analysisAsOf, fetchQuakeAnalysis, latestVersion, parseQuakeAnalysis, type AnalysisQuery, type QuakeAnalysis } from '../services/relayAnalysis'
import type { AnalysisOverlayLayer } from '../services/analysisOverlay'
import { readAnalysis, writeAnalysis } from '../utils/analysisDb'
import { testAnalysisFor } from '../utils/testAnalysis'
import { subscribeAnalysisUpdated } from '../services/analysisUpdates'
import { liveServerNow, serverNow } from '../utils/clock'
import { hasDepth, hasMagnitude } from '../utils/formatters'
import { hasKnownEpicenter } from '../utils/geo'
import { createLogThrottle, log } from '../utils/logger'
import { extractQuakeEventId } from '../utils/quakeMerge'

/**
 * 地震カードに添える解析（計画書 項目 98）。カードを開くたびに、まず端末の控えを出し、中継へ問い合わせて新しい答えで置き換える
 * （「端末の控え」。日数で打ち切らない）。中継が確かめられない地震（404）には何も出さない。
 *
 * **開いている間も、新しい答えを取りに行く。** 中継がその地震の答えが変わったと知らせてきたとき（`relay-analysis-updated`）と、
 * 中継が海外の取得元を取り直す線（{@link ANALYSIS_REFETCH_LINES_MS}）を越えたときに問い合わせ直す。
 *
 * **リプレイ中は、再生の時計より前に公表されていた版だけを出す**（「リプレイ」）。時計が進むと後の版に入れ替わるよう、
 * 開いている間は {@link REPLAY_TICK_MS} ごとに絞り直す。公表の時刻を持たない気象庁の解は出さない（`analysisAsOf`）。
 */

/** リプレイ中に版を絞り直す間隔（ms） */
const REPLAY_TICK_MS = 10_000

/**
 * 中継が海外の取得元を取り直す線（地震の時刻からの経過。中継の `analysis/schedule.ts` の `REFETCH_LINES_MS` と同じ値。
 * docs/relay-server-design.md §6.8）。中継は線を越えた後に開かれたときに取り直すので、開いている間は線を越えるたびに問い合わせ直す
 */
export const ANALYSIS_REFETCH_LINES_MS: readonly number[] = [10, 30, 60, 180, 360, 720, 1440, 4320, 10080].map(min => min * 60_000)

/**
 * 線から問い合わせ直すまでの遅れ（ms）。中継が線を数える地震の時刻は、確かめた地震情報の発生時刻で、カードの時刻と
 * 分の単位でしか合わないことがある（震源の時刻が分までの報）。線より前に訊くと中継は取り直さないので、1 分半遅らせる
 */
export const ANALYSIS_LINE_SLACK_MS = 90_000

/** 次に問い合わせ直す時刻（線 + 遅れ）。`nowMs` より後のものが無ければ（7 日の線を過ぎた）null */
export function nextAnalysisRefreshMs(eventMs: number, nowMs: number): number | null {
  for (const line of ANALYSIS_REFETCH_LINES_MS) {
    const at = eventMs + line + ANALYSIS_LINE_SLACK_MS
    if (at > nowMs) return at
  }
  return null
}

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
 * @param open カードが開いているか。閉じている間は問い合わせず `none` を返す。開くたびと、開いている間の知らせ・線で問い合わせる
 * @param replaying リプレイ中か
 */
export function useQuakeAnalysis(quake: JMAQuake, open: boolean, replaying: boolean): QuakeAnalysisView {
  // 閉じている間は組み立てない（一覧の全カードで呼ばれるので、開いているカードの分だけ）
  const query = useMemo(() => (open ? analysisQueryOf(quake) : null), [quake, open])
  const queryKey = query ? JSON.stringify(query) : null
  const [fetched, setFetched] = useState<Fetched>({ kind: 'idle' })
  const [nowMs, setNowMs] = useState(() => serverNow())
  // 開いている間に問い合わせ直した回数。中継の知らせと線で増え、増えるたびに下の問い合わせを走らせ直す
  const [refresh, setRefresh] = useState(0)
  // 問い合わせの途中に知らせが来たら、終わってからもう 1 回だけ訊く（途中で打ち切って訊き直すと、答えを受け取れないまま続く）
  const inFlight = useRef(false)
  const pending = useRef(false)
  // 最後に問い合わせ終えた地震と問い合わせの中身。同じなら、開いたままの訊き直し
  const lastRunKey = useRef<string | null>(null)
  const requestRefresh = useCallback(() => {
    if (inFlight.current) pending.current = true
    else setRefresh(n => n + 1)
  }, [])

  useEffect(() => {
    if (!open || query === null) {
      // 閉じたら、次に開いたときは開き直しとして扱う（控えを読む）
      lastRunKey.current = null
      return
    }
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
    // 開いたまま訊き直す（知らせ・線）ときは、出している答えをそのまま出し、控えも読まない（画面の答えが控えと同じか新しい。
    // 失敗したら `failedKeeping` が出している答えを残す）。状態も変えないので、訊き直すだけではカードを描き直さない
    const runKey = `${query.eventId}|${queryKey}`
    const isRefresh = lastRunKey.current === runKey
    // 開き直したときは、前に出していた答えを出したまま問い合わせる（控えを読む間に「読み込み中」へ戻さない）
    if (!isRefresh) setFetched(prev => ({ kind: 'loading', cached: prev.kind === 'done' ? prev.analysis : prev.kind === 'loading' ? prev.cached : null }))
    inFlight.current = true
    pending.current = false
    void (async () => {
      const cached = isRefresh ? null : await readCached(query.eventId)
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
      } finally {
        if (!cancelled) {
          // 終わった問い合わせだけを覚える（途中で打ち切った問い合わせ〔開発時の effect の 2 回目など〕の後は、開き直しとして訊く）
          lastRunKey.current = runKey
          inFlight.current = false
          if (pending.current) {
            pending.current = false
            setRefresh(n => n + 1)
          }
        }
      }
    })()
    return () => {
      cancelled = true
      inFlight.current = false
      pending.current = false
      ac.abort()
    }
    // query は queryKey と同じ中身で作り直されるので、鍵で見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queryKey, refresh])

  // 中継の知らせ: この地震の答えが変わったら訊き直す（→ services/analysisUpdates.ts）
  const eventId = query?.eventId ?? null
  useEffect(() => {
    if (eventId === null) return
    return subscribeAnalysisUpdated(eventId, requestRefresh)
  }, [eventId, requestRefresh])

  // 線: 中継が海外の取得元を取り直す線を越えたら訊き直す（中継は開かれたときに取り直す。知らせは取り直した後に届く）
  const eventMs = query ? Date.parse(query.time) : null
  useEffect(() => {
    if (eventMs === null) return
    const at = nextAnalysisRefreshMs(eventMs, liveServerNow())
    if (at === null) return
    const id = setTimeout(requestRefresh, at - liveServerNow())
    return () => clearTimeout(id)
  }, [eventMs, refresh, requestRefresh])

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
