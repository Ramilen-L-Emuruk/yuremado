import { useEffect, useMemo, useState } from 'react'
import type { JMAQuake } from '../types/earthquake'
import { fetchJmaQuakeHistory } from '../services/p2pquake'
import { fetchDmdataGdEarthquakes, fetchDmdataGdEarthquakesBefore, type GdEarthquakeItem } from '../services/dmdata'
import {
  heatMagnitude,
  magnitudeToWeight,
  quakeIdentityKey,
  hasValidHypocenter,
  isWithinHeatWindow,
  heatmapPeriodStartMs,
  catalogYearsFor,
  catalogHeatPoints,
  gridHeatPoints,
  shouldGridHeatPeriod,
  heatIntensityScale,
  jstYearOf,
  type HeatPoint,
  type HeatmapPeriod,
} from '../utils/quakeHeatmap'
import { loadHypocenterIndex, loadHypocenterYear, completeMinMagnitude, type HypocenterIndex } from '../utils/hypocenterCatalog'
import { log } from '../utils/logger'
import { serverNow, liveServerNow } from '../utils/clock'

import { isDmdss } from '../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'

// 地震活動ヒートマップの点を集める。
//
// **長期震源カタログがある日はカタログから、カタログの終端より後だけを API から取る**
// （2026-10-22 選択「カタログ＋末尾の空きだけ API (Recommended)」。2026-10-25 に境目で濃さが約 15 倍
// 落ちることを示したうえで「決定どおりで」）。カタログは M2.0 以上の全地震、API（DMDATA の
// GD Earthquake List・P2PQuake）は震度を観測した地震だけなので、**境目より後は薄く見える**。
// 期間は凡例のスライダーで選ぶ（`HeatmapPeriod`。2026-10-25 選択「E の案でよい (Recommended)」）。
//
// DMDSS 版で API キーが無い・使えないときは**カタログの分だけ描き、末尾が入らないことを記録に残す**
// （2026-10-22 選択「カタログの分だけ出す (Recommended)」）。

// 末尾の API の取得は一定時間 localStorage の控えを使う。控えた後にライブで届いた地震は
// earthquakes とのマージで別に足すので、控えがやや古くても実害は小さい。
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// v4 から「カタログの終端より後」だけを控える（それまでは直近 30 日を丸ごと）。
const CACHE_KEY = isDmdss ? 'quake-heatmap-tail-dmdss-v1' : 'quake-heatmap-tail-v1'
// 旧形式の控えは二度と読まないので、見かけたら掃除する。
const LEGACY_CACHE_KEYS = [
  'quake-heatmap-cache',
  'quake-heatmap-cache-dmdss',
  'quake-heatmap-cache-v2',
  'quake-heatmap-cache-v3',
  'quake-heatmap-cache-dmdss-v2',
]

const DAY_MS = 24 * 60 * 60 * 1000
/** カタログの索引が読めなかったときに API で遡る上限（日）。API は 1 回の取得で 2000 件までしか返さない。 */
const API_FALLBACK_MAX_DAYS = 30

// quakeIdentityKey で重複排除できるよう、API 側の点にもキーを持たせる。
interface KeyedHeatPoint extends HeatPoint {
  key: string
}

interface TailCacheEntry {
  fetchedAt: number
  /** この控えが取った範囲の始まり。始まりが変わったら（カタログが伸びた等）使わない。 */
  fromMs: number
  points: KeyedHeatPoint[]
}

function loadTailCache(): TailCacheEntry | null {
  try {
    for (const key of LEGACY_CACHE_KEYS) localStorage.removeItem(key)
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as TailCacheEntry
  } catch (e) {
    // 壊れた JSON・localStorage 利用不可。取得し直せば済むので処理は続けるが、
    // 毎回キャッシュが効かない状態に気づけるよう記録は残す。
    log.warn('[data] 地震活動ヒートマップのキャッシュ読み込みに失敗（取得し直します）', e)
    return null
  }
}

function saveTailCache(fromMs: number, points: KeyedHeatPoint[]): void {
  try {
    // 鮮度は実時間で測る（`serverNow()` はリプレイ中に再生時刻を返す）
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: liveServerNow(), fromMs, points }))
  } catch (e) {
    // 容量超過等。次回また取得を試みるので致命的ではないが、黙って毎回取り直す状態になるため残す。
    log.warn('[data] 地震活動ヒートマップのキャッシュ保存に失敗（次回も取得し直します）', e)
  }
}

function fromGdItems(items: GdEarthquakeItem[]): KeyedHeatPoint[] {
  return items.map((it): KeyedHeatPoint => ({
    key: it.eventId,
    lat: it.latitude,
    lng: it.longitude,
    // GD Earthquake List は規模の説明を返さない（不明は -1）。
    weight: magnitudeToWeight(it.magnitude, null),
    name: it.name,
    time: it.originTime,
    depth: it.depth,
    depthAtLeast: false,
    magnitude: heatMagnitude(it.magnitude),
    magnitudeCondition: null,
    count: 1,
  }))
}

function fromJmaQuakes(quakes: JMAQuake[]): KeyedHeatPoint[] {
  return quakes
    .filter(q => hasValidHypocenter(q.earthquake.hypocenter.latitude, q.earthquake.hypocenter.longitude))
    .map((q): KeyedHeatPoint => ({
      key: quakeIdentityKey(q),
      lat: q.earthquake.hypocenter.latitude,
      lng: q.earthquake.hypocenter.longitude,
      weight: magnitudeToWeight(q.earthquake.hypocenter.magnitude, q.earthquake.hypocenter.magnitudeCondition ?? null),
      name: q.earthquake.hypocenter.name,
      time: q.earthquake.time,
      depth: q.earthquake.hypocenter.depth,
      depthAtLeast: q.earthquake.hypocenter.depthAtLeast ?? false,
      magnitude: heatMagnitude(q.earthquake.hypocenter.magnitude),
      magnitudeCondition: q.earthquake.hypocenter.magnitudeCondition ?? null,
      count: 1,
    }))
}

/**
 * リプレイ中に取った末尾の控え。鍵は「再生を始めた時刻|取った範囲の始まり」。**メモリだけに置く** ——
 * 同じ再生を始め直したときに取り直さないためのもの。
 */
const replayTailCache = new Map<string, KeyedHeatPoint[]>()
const REPLAY_TAIL_CACHE_MAX = 8

/** 再生中に点を出し入れし直す間隔。再生時刻が進むと、期間の端と再生時刻の手前が動くため。 */
const REPLAY_REFILTER_MS = 60_000

export interface QuakeHeatmapResult {
  points: HeatPoint[] | null
  isLoading: boolean
  /** 期間の始まり（凡例に出す）。出していない間は `null`。 */
  windowStartMs: number | null
  /**
   * 期間が観測網の疎な時代に掛かるとき、記録が揃う M の下限（凡例の注記に出す）。掛からなければ `null`。
   * 文はカタログタブの注記と同じ（2026-10-25 選択「E の案でよい (Recommended)」）。
   */
  completeness: { fromYear: number; minMagnitude: number } | null
  /** 濃さの係数（`heatIntensityScale`）。30 日以下と出していない間は 1。 */
  intensityScale: number
}

export function useQuakeHeatmap(
  enabled: boolean,
  dmdataApiKey: string,
  earthquakes: JMAQuake[],
  replayOffsetMs: number | null,
  period: HeatmapPeriod,
): QuakeHeatmapResult {
  // 再生を始めた時刻（ms）。オフセットが変わるのは再生の開始・停止のときだけなので、変わった時点の再生時刻を採る。
  // **分で切り捨てる。** オフセットは「開始時刻 − 押した瞬間の Date.now()」なので、ここで足し戻すと
  // 押してから描くまでの数ミリ秒ぶんだけ毎回ずれ、同じ開始時刻でも控えの鍵が一致しない。
  const replayAnchorMs = useMemo(
    () => (replayOffsetMs === null ? null : Math.floor((Date.now() + replayOffsetMs) / 60_000) * 60_000),
    [replayOffsetMs],
  )
  // 期間の始まり。**期間・再生の開始を変えたときだけ決め直す**（毎回計算すると、毎秒の描き直しのたびに
  // カタログの点を作り直すことになる）。ライブで開きっぱなしにすると、始まりは開いた時点のまま留まる。
  const { windowStartMs, intensityScale } = useMemo(() => {
    if (!enabled) return { windowStartMs: null, intensityScale: 1 }
    const endMs = replayAnchorMs ?? liveServerNow()
    const startMs = heatmapPeriodStartMs(period, endMs)
    return { windowStartMs: startMs, intensityScale: heatIntensityScale(startMs, endMs) }
  }, [enabled, period, replayAnchorMs])

  // 再生中は 1 分ごとに描き直す（点の出し入れを再生時刻に合わせる）
  const [refilterTick, setRefilterTick] = useState(0)
  useEffect(() => {
    if (replayAnchorMs === null) return
    const id = setInterval(() => setRefilterTick(t => t + 1), REPLAY_REFILTER_MS)
    return () => clearInterval(id)
  }, [replayAnchorMs])

  // ── 索引（カタログの終端・収録年・完全性） ────────────────────────────
  const [index, setIndex] = useState<HypocenterIndex | null>(null)
  const [indexFailed, setIndexFailed] = useState(false)
  useEffect(() => {
    if (!enabled || index) return
    let cancelled = false
    loadHypocenterIndex()
      .then(idx => { if (!cancelled) { setIndex(idx); setIndexFailed(false) } })
      .catch(err => {
        if (cancelled) return
        // 索引が読めなければカタログは使えない。末尾の API だけで直近を描く（下の `tailFromMs`）
        log.warn('[data] 地震活動ヒートマップ: 震源カタログの索引を読めず、直近の分だけ API から描きます', err)
        setIndexFailed(true)
      })
    return () => { cancelled = true }
  }, [enabled, index])

  // カタログで描く範囲の終わり。カタログの終端と、再生中なら再生を始めた時刻の早いほう。
  const catalogEndMs = index === null ? null : Math.min(index.coveredThroughMs, replayAnchorMs ?? Infinity)
  // API で取る範囲の始まり。カタログがあればカタログで描いた範囲の終わりから、索引が読めなければ
  // 期間（最長 30 日）から。**再生時刻がカタログの終端より前なら、再生を始めた時刻から**になる ——
  // 終端から始めると、再生で届いた地震（終端より前）がどちらの区間にも入らず描かれない。
  // 「いま」を読むので、毎回の描き直しで値が動かないよう決め直す契機を絞る。
  const tailFromMs = useMemo(() => {
    if (windowStartMs === null) return null
    if (index !== null) return Math.max(Math.min(index.coveredThroughMs, replayAnchorMs ?? Infinity), windowStartMs)
    if (!indexFailed) return null
    return Math.max(windowStartMs, (replayAnchorMs ?? liveServerNow()) - API_FALLBACK_MAX_DAYS * DAY_MS)
  }, [index, indexFailed, windowStartMs, replayAnchorMs])

  // ── カタログの点 ───────────────────────────────────────────────
  const [catalogPoints, setCatalogPoints] = useState<HeatPoint[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  useEffect(() => {
    if (!enabled || windowStartMs === null) {
      setCatalogPoints(null)
      return
    }
    if (indexFailed) {
      setCatalogPoints([])
      return
    }
    if (!index || catalogEndMs === null) return
    const years = catalogYearsFor(windowStartMs, catalogEndMs, index.years)
    if (years.length === 0) {
      setCatalogPoints([])
      return
    }
    let cancelled = false
    setCatalogLoading(true)
    // **1 年取れなくても、取れた年は描く。** 欠けた年は記録に残す（その年は地震が無いように見える）。
    Promise.allSettled(years.map(loadHypocenterYear))
      .then(results => {
        if (cancelled) return
        const loaded = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
        const failed = years.filter((_, i) => results[i].status === 'rejected')
        if (failed.length > 0) {
          log.warn(`[data] 地震活動ヒートマップ: 震源カタログの ${failed.join('・')} 年を取得できず、その年は描きません`)
        }
        const raw = catalogHeatPoints(loaded, windowStartMs, catalogEndMs)
        // 1 年より長い期間は格子にまとめる（`shouldGridHeatPeriod` の注記）。末尾の API の点はまとめない
        // （数日ぶんで数十点。まとめると、受けたばかりの地震を吹き出しで個別に見られなくなる）。
        setCatalogPoints(shouldGridHeatPeriod(period) ? gridHeatPoints(raw) : raw)
      })
      .finally(() => { if (!cancelled) setCatalogLoading(false) })
    return () => {
      cancelled = true
      setCatalogLoading(false)
    }
  }, [enabled, index, indexFailed, windowStartMs, catalogEndMs, period])

  // ── 末尾の API ─────────────────────────────────────────────────
  const [tailPoints, setTailPoints] = useState<KeyedHeatPoint[] | null>(null)
  const [tailLoading, setTailLoading] = useState(false)
  useEffect(() => {
    if (!enabled || tailFromMs === null) {
      setTailPoints(null)
      return
    }
    const untilMs = replayAnchorMs ?? liveServerNow()
    if (untilMs <= tailFromMs) {
      // 再生時刻がカタログの終端より前。API は要らない（再生で届いた地震は earthquakes から足す）
      setTailPoints([])
      return
    }
    // DMDSS 版は gd.earthquake スコープ付きの APIキーが要る。**無ければカタログの分だけ描く**
    // （冒頭の注記）。末尾が入らないことは記録に残す —— 画面にエラーを出さない経路なので、記録を落とすと
    // 「直近だけ空いている」理由に辿り着けない。
    if (isDmdss && !dmdataApiKey) {
      log.warn('[data] 地震活動ヒートマップ: API キーが無いため、震源カタログの終端より後の地震は描きません')
      setTailPoints([])
      return
    }
    if (isDmdss && !isValidDmdataApiKey(dmdataApiKey)) {
      log.warn(`[data] 地震活動ヒートマップ: 震源カタログの終端より後を取得しない: ${DMDATA_API_KEY_INVALID_MESSAGE}`)
      // 取れないだけで、既に持っているものが無効になったわけではない。キー入力中はデバウンス（800ms）で
      // ここを一時的に通るため、捨てると「直している最中に、見えていた点が消える」ことになる。
      const cached = loadTailCache()
      setTailPoints(cached && cached.fromMs === tailFromMs ? cached.points : [])
      return
    }
    const days = (untilMs - tailFromMs) / DAY_MS

    if (replayAnchorMs !== null) {
      const cacheKey = `${replayAnchorMs}|${tailFromMs}`
      const hit = replayTailCache.get(cacheKey)
      if (hit) {
        setTailPoints(hit)
        return
      }
      const controller = new AbortController()
      setTailPoints([])
      setTailLoading(true)
      // complete が偽（取れなかった日がある）なら控えない。控えると、同じ開始時刻で再生し直しても
      // 欠けた日が戻らないまま表示され続ける
      const loadReplay: Promise<{ points: KeyedHeatPoint[]; complete: boolean }> = isDmdss
        ? fetchDmdataGdEarthquakesBefore(dmdataApiKey, replayAnchorMs, days, controller.signal)
          .then(r => ({ points: fromGdItems(r.items), complete: r.failedDays.length === 0 }))
        : fetchJmaQuakeHistory(days, replayAnchorMs, controller.signal)
          .then(quakes => ({ points: fromJmaQuakes(quakes), complete: true }))
      loadReplay
        .then(({ points, complete }) => {
          if (controller.signal.aborted) return
          if (complete) {
            replayTailCache.set(cacheKey, points)
            while (replayTailCache.size > REPLAY_TAIL_CACHE_MAX) {
              const oldest = replayTailCache.keys().next().value
              if (oldest === undefined) break
              replayTailCache.delete(oldest)
            }
          }
          setTailPoints(points)
        })
        .catch(err => {
          if (controller.signal.aborted) {
            log.debug('[data] 再生時刻の地震活動ヒートマップ取得を打ち切った', err)
            return
          }
          // 空のまま残す（カタログと再生で届いた地震だけが出る）
          log.warn('[data] 再生時刻の地震活動ヒートマップ取得失敗（震源カタログと再生で届いた地震だけを出します）', err)
        })
        .finally(() => {
          if (!controller.signal.aborted) setTailLoading(false)
        })
      return () => {
        controller.abort()
        // 打ち切った取得は finally で読み込み中を降ろさないので、ここで降ろす（次の取得が立て直す）
        setTailLoading(false)
      }
    }

    const cached = loadTailCache()
    if (cached && cached.fromMs === tailFromMs && liveServerNow() - cached.fetchedAt < CACHE_TTL_MS) {
      setTailPoints(cached.points)
      return
    }

    let cancelled = false
    setTailLoading(true)
    const load = isDmdss
      ? fetchDmdataGdEarthquakes(dmdataApiKey, days).then(fromGdItems)
      : fetchJmaQuakeHistory(days, null, null).then(fromJmaQuakes)
    load
      .then(result => {
        if (cancelled) return
        setTailPoints(result)
        saveTailCache(tailFromMs, result)
      })
      .catch(err => {
        // ログは cancelled と無関係に必ず出す。状態更新を止めることと、失敗を記録しないことは
        // 別の話。ここを cancelled で早期 return すると、設定変更で effect が張り直された経路
        // （APIキー入力欄は 1 文字ごとに更新するため高頻度に起きる）で失敗が完全に消える。
        if (cancelled) {
          log.debug('[data] 地震活動ヒートマップ取得失敗（この取得は破棄済み）', err)
          return
        }
        log.warn('[data] 地震活動ヒートマップ取得失敗（震源カタログの終端より後は控えがあれば控えで描きます）', err)
        setTailPoints(cached && cached.fromMs === tailFromMs ? cached.points : [])
      })
      .finally(() => {
        if (!cancelled) setTailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, dmdataApiKey, replayAnchorMs, tailFromMs])

  // 末尾の点にライブ受信中の地震をマージする。取消済み・震源未確定・範囲外は除外し、
  // 同一地震（quakeIdentityKey）が両方にあればライブ側（最新情報）を優先する。
  // **カタログの終端より前の地震は足さない**（カタログが持っている。足すと同じ地震が 2 点になる）。
  // 範囲の終わりは「いま」で、再生中なら再生時刻（`serverNow()`）。
  const mergedTail = useMemo(() => {
    if (tailPoints === null || tailFromMs === null) return null
    // 再生していないときは実時間で測る。`serverNow()` は時計側のオフセットを読むので、フックが受け取る
    // オフセットと戻る瞬間がずれうる（停止した直後だけ再生時刻で絞られる）
    const nowMs = replayAnchorMs === null ? liveServerNow() : serverNow()
    const merged = new Map<string, HeatPoint>()
    // 規模の説明・深さの下限の欄を持たない形で控えた点は「無い」として読む。重みも読み直す
    // （前の形は規模不明の重みを NaN で控えていて、JSON を通ると null になる）。
    for (const p of tailPoints) {
      if (!isWithinHeatWindow(p.time, nowMs, tailFromMs)) continue
      const magnitude = heatMagnitude(p.magnitude)
      const magnitudeCondition = p.magnitudeCondition ?? null
      merged.set(p.key, {
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        time: p.time,
        depth: p.depth,
        magnitude,
        magnitudeCondition,
        depthAtLeast: p.depthAtLeast ?? false,
        weight: Number.isFinite(p.weight) ? p.weight : magnitudeToWeight(magnitude, magnitudeCondition),
        count: 1,
      })
    }
    for (const q of earthquakes) {
      if (q.cancelled || q.cancelledAt) continue
      const { latitude, longitude, magnitude, magnitudeCondition, name, depth, depthAtLeast } = q.earthquake.hypocenter
      if (!hasValidHypocenter(latitude, longitude)) continue
      if (!isWithinHeatWindow(q.earthquake.time, nowMs, tailFromMs)) continue
      merged.set(quakeIdentityKey(q), {
        lat: latitude,
        lng: longitude,
        weight: magnitudeToWeight(magnitude, magnitudeCondition ?? null),
        name,
        time: q.earthquake.time,
        depth,
        depthAtLeast: depthAtLeast ?? false,
        magnitude: heatMagnitude(magnitude),
        magnitudeCondition: magnitudeCondition ?? null,
        count: 1,
      })
    }
    return Array.from(merged.values())
    // refilterTick は再生中に 1 分ごとに描き直すためだけの依存（中身は読まない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailPoints, tailFromMs, earthquakes, refilterTick, replayAnchorMs])

  const points = useMemo(() => {
    if (!enabled) return null
    if (catalogPoints === null && mergedTail === null) return null
    if (catalogPoints === null) return mergedTail
    if (mergedTail === null || mergedTail.length === 0) return catalogPoints
    return catalogPoints.concat(mergedTail)
  }, [enabled, catalogPoints, mergedTail])

  const completeness = useMemo(() => {
    if (!index || windowStartMs === null) return null
    const fromYear = jstYearOf(windowStartMs)
    const minMagnitude = completeMinMagnitude(index, fromYear)
    return minMagnitude > index.minMagnitude ? { fromYear, minMagnitude } : null
  }, [index, windowStartMs])

  return {
    points,
    isLoading: catalogLoading || tailLoading,
    windowStartMs: enabled ? windowStartMs : null,
    completeness,
    intensityScale,
  }
}
