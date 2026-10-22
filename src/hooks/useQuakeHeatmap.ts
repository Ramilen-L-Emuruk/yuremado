import { useEffect, useMemo, useState } from 'react'
import type { JMAQuake } from '../types/earthquake'
import { fetchJmaQuakeHistory } from '../services/p2pquake'
import { fetchDmdataGdEarthquakes, fetchDmdataGdEarthquakesBefore, type GdEarthquakeItem } from '../services/dmdata'
import { heatMagnitude, magnitudeToWeight, quakeIdentityKey, hasValidHypocenter, isWithinHeatWindow, HEATMAP_DAYS, type HeatPoint } from '../utils/quakeHeatmap'
import { log } from '../utils/logger'
import { serverNow, liveServerNow } from '../utils/clock'

import { isDmdss } from '../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
// 1ヶ月分の再取得は API 呼び出しコストがあるため、一定時間は localStorage のキャッシュを再利用する。
// キャッシュ取得後にライブ受信した地震は earthquakes とのマージで別途反映するため、
// このキャッシュ自体はやや古くても実害は小さい。
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// 保存形式に震源名・深さ・地震の時刻を足したため、旧形式と混ざらないようキーを変える（v2）。
const CACHE_KEY = isDmdss ? 'quake-heatmap-cache-dmdss-v2' : 'quake-heatmap-cache-v2'
// 旧形式のキャッシュは二度と読まないので、見かけたら掃除する。
const LEGACY_CACHE_KEYS = ['quake-heatmap-cache', 'quake-heatmap-cache-dmdss']

// quakeIdentityKey で重複排除できるよう、キャッシュ側の点にもキーを持たせる。
interface KeyedHeatPoint extends HeatPoint {
  key: string
}

interface CacheEntry {
  fetchedAt: number
  points: KeyedHeatPoint[]
}

function loadCache(): CacheEntry | null {
  try {
    for (const key of LEGACY_CACHE_KEYS) localStorage.removeItem(key)
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CacheEntry
  } catch (e) {
    // 壊れた JSON・localStorage 利用不可。取得し直せば済むので処理は続けるが、
    // 毎回キャッシュが効かない状態に気づけるよう記録は残す。
    log.warn('[data] 地震活動ヒートマップのキャッシュ読み込みに失敗（取得し直します）', e)
    return null
  }
}

function saveCache(points: KeyedHeatPoint[]): void {
  try {
    // 鮮度は実時間で測る（`serverNow()` はリプレイ中に再生時刻を返す）
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: liveServerNow(), points }))
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
    }))
}

/**
 * リプレイ中に取った「再生時刻の前 30 日」の控え。鍵は再生を始めた時刻（ms）。**メモリだけに置く** ——
 * 同じ再生を始め直したときに取り直さないためのもので、localStorage の 6 時間の控え（いまの 30 日）とは別物。
 */
const replayBaseCache = new Map<number, KeyedHeatPoint[]>()
const REPLAY_BASE_CACHE_MAX = 8

/** 再生中に点を出し入れし直す間隔。再生時刻が進むと、前 30 日の端と再生時刻の手前が動くため。 */
const REPLAY_REFILTER_MS = 60_000

// 直近1ヶ月分の地震活動ヒートマップ用データを取得する。
// 30日分のベースデータは API 取得後 CACHE_TTL_MS の間キャッシュしつつ、ライブ受信中の
// 地震一覧（earthquakes）を都度マージすることで、新規受信した地震も即座に反映する。
// earthquakes は useEarthquakes 側で既に issue 種別の優先度・同一性判定を解決済みの
// 一覧（1地震につき1エントリ）のため、ここで改めてその判定をする必要はない。
//
// **リプレイ中（`replayOffsetMs` が null でない）は、再生時刻の前 30 日を取り直し、再生時刻より後の点を出さない**
// （2026-10-22 ユーザー選択「前 30 日を取り直す (Recommended)」）。いまの 30 日の控えを流用すると、
// 再生時刻より後に起きた地震が地図に並び、30 日より前を再生すると再生で届いた地震しか出ない。
// 取り直しは再生を始めた時刻ごとに 1 回。DMDSS 版は日ごとに最低 31 リクエスト、標準版は日付で絞って数ページ
// （→ `services/dmdata.ts` の `fetchDmdataGdEarthquakesBefore`・`services/p2pquake.ts` の `fetchJmaQuakeHistory`）。
export function useQuakeHeatmap(
  enabled: boolean,
  dmdataApiKey: string,
  earthquakes: JMAQuake[],
  replayOffsetMs: number | null,
): { points: HeatPoint[] | null; isLoading: boolean } {
  const [basePoints, setBasePoints] = useState<KeyedHeatPoint[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  // 再生を始めた時刻（ms）。オフセットが変わるのは再生の開始・停止のときだけなので、変わった時点の再生時刻を採る。
  // **分で切り捨てる。** オフセットは「開始時刻 − 押した瞬間の Date.now()」なので、ここで足し戻すと
  // 押してから描くまでの数ミリ秒ぶんだけ毎回ずれ、同じ開始時刻でも控えの鍵が一致しない。
  // 切り捨てたぶん（1 分未満）だけ手前までしか取らない。その 1 分に起きた地震は、再生の初期状態で
  // 届けば地図に出るが、届かなければ出ない（ヒートマップの粒度では見分けが付かない差として受け入れる）。
  const replayAnchorMs = useMemo(
    () => (replayOffsetMs === null ? null : Math.floor((Date.now() + replayOffsetMs) / 60_000) * 60_000),
    [replayOffsetMs],
  )
  // 再生中は 1 分ごとに描き直す（点の出し入れを再生時刻に合わせる）
  const [refilterTick, setRefilterTick] = useState(0)
  useEffect(() => {
    if (replayAnchorMs === null) return
    const id = setInterval(() => setRefilterTick(t => t + 1), REPLAY_REFILTER_MS)
    return () => clearInterval(id)
  }, [replayAnchorMs])

  useEffect(() => {
    if (!enabled) {
      setBasePoints(null)
      return
    }
    // DMDSS版は gd.earthquake スコープ付きの APIキーが要るため、未設定なら取得しない。
    if (isDmdss && !dmdataApiKey) {
      setBasePoints(null)
      return
    }
    // 通信へ載せられない文字を含むキーも取得しないが、こちらは記録を残す。
    // 未設定は利用者が選んだ状態なので黙って出さなくてよいが、入れたキーが使えないのは異常であり、
    // 手がかりが無いと「ヒートマップだけ出ない」理由に辿り着けない。
    // この経路は画面にエラーを出さない仕様のため、記録を落とすと完全に無音になる。
    if (isDmdss && !isValidDmdataApiKey(dmdataApiKey)) {
      log.warn(`[data] 地震活動ヒートマップを取得しない: ${DMDATA_API_KEY_INVALID_MESSAGE}`)
      // 取れないだけで、既に持っているものが無効になったわけではない。下の .catch と同じく
      // キャッシュがあれば表示を保つ。キー入力中はデバウンス（800ms）でここを一時的に通るため、
      // 捨てると「直している最中に、見えていたヒートマップが消える」ことになる。
      // 変換途中の値こそこの判定を入れた理由なので、まさに直そうとしている人にだけ起きる。
      // （リプレイ中も同じ控えを置くが、再生時刻より後の点は下の絞り込みで外れる）
      setBasePoints(loadCache()?.points ?? null)
      return
    }

    if (replayAnchorMs !== null) {
      const hit = replayBaseCache.get(replayAnchorMs)
      if (hit) {
        setBasePoints(hit)
        return
      }
      const controller = new AbortController()
      // 取れるまでは何も出さない（いまの 30 日を出すと、再生時刻より後の地震が並ぶ）
      setBasePoints([])
      setIsLoading(true)
      // complete が偽（取れなかった日がある）なら控えない。控えると、同じ開始時刻で再生し直しても
      // 欠けた日が戻らないまま表示され続ける
      const loadReplay: Promise<{ points: KeyedHeatPoint[]; complete: boolean }> = isDmdss
        ? fetchDmdataGdEarthquakesBefore(dmdataApiKey, replayAnchorMs, HEATMAP_DAYS, controller.signal)
          .then(r => ({ points: fromGdItems(r.items), complete: r.failedDays.length === 0 }))
        : fetchJmaQuakeHistory(HEATMAP_DAYS, replayAnchorMs, controller.signal)
          .then(quakes => ({ points: fromJmaQuakes(quakes), complete: true }))
      loadReplay
        .then(({ points, complete }) => {
          if (controller.signal.aborted) return
          if (complete) {
            replayBaseCache.set(replayAnchorMs, points)
            while (replayBaseCache.size > REPLAY_BASE_CACHE_MAX) {
              const oldest = replayBaseCache.keys().next().value
              if (oldest === undefined) break
              replayBaseCache.delete(oldest)
            }
          }
          setBasePoints(points)
        })
        .catch(err => {
          if (controller.signal.aborted) {
            log.debug('[data] 再生時刻の地震活動ヒートマップ取得を打ち切った', err)
            return
          }
          // 空のまま残す（再生で届いた地震だけが出る）。いまの 30 日へは倒さない
          log.warn('[data] 再生時刻の地震活動ヒートマップ取得失敗（再生で届いた地震だけを出します）', err)
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false)
        })
      return () => {
        controller.abort()
        // 打ち切った取得は finally で読み込み中を降ろさないので、ここで降ろす（次の取得が立て直す）
        setIsLoading(false)
      }
    }

    const cached = loadCache()
    if (cached && liveServerNow() - cached.fetchedAt < CACHE_TTL_MS) {
      setBasePoints(cached.points)
      return
    }

    let cancelled = false
    setIsLoading(true)

    const load = isDmdss
      ? fetchDmdataGdEarthquakes(dmdataApiKey, HEATMAP_DAYS).then(fromGdItems)
      : fetchJmaQuakeHistory(HEATMAP_DAYS, null, null).then(fromJmaQuakes)

    load
      .then(result => {
        if (cancelled) return
        setBasePoints(result)
        saveCache(result)
      })
      .catch(err => {
        // ログは cancelled と無関係に必ず出す。状態更新を止めることと、失敗を記録しないことは
        // 別の話。ここを cancelled で早期 return すると、設定変更で effect が張り直された経路
        // （APIキー入力欄は 1 文字ごとに更新するため高頻度に起きる）で失敗が完全に消える。
        if (cancelled) {
          log.debug('[data] 地震活動ヒートマップ取得失敗（この取得は破棄済み）', err)
          return
        }
        log.warn('[data] 地震活動ヒートマップ取得失敗', err)
        // 失敗時は古いキャッシュがあればそれで継続する
        setBasePoints(cached?.points ?? null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, dmdataApiKey, replayAnchorMs])

  // ベースデータにライブ受信中の地震をマージする。取消済み・震源未確定・期間外は除外し、
  // 同一地震（quakeIdentityKey）が両方にあればライブ側（最新情報）を優先する。
  // 期間は「いま」から遡る 30 日で、**「いま」より後は外す**。いまは再生中なら再生時刻
  // （`serverNow()`）。控えの点も、再生で届いた地震も同じ物差しで見る（`isWithinHeatWindow`）。
  const points = useMemo(() => {
    if (!basePoints) return null
    // 再生していないときは実時間で測る。`serverNow()` は時計側のオフセットを読むので、フックが受け取る
    // オフセットと戻る瞬間がずれうる（停止した直後だけ再生時刻で絞られる）
    const nowMs = replayAnchorMs === null ? liveServerNow() : serverNow()
    const merged = new Map<string, HeatPoint>()
    // 規模の説明・深さの下限の欄を持たない形で控えた点（この欄を足す前のキャッシュ）は「無い」として読む。
    // **重みも読み直す。** 前の形は規模不明の重みを NaN で控えていて、JSON を通ると null になる
    // （そのままだと濃さの式に null が流れ、点が描かれない）。
    for (const p of basePoints) {
      if (!isWithinHeatWindow(p.time, nowMs)) continue
      const magnitude = heatMagnitude(p.magnitude)
      const magnitudeCondition = p.magnitudeCondition ?? null
      merged.set(p.key, {
        ...p,
        magnitude,
        magnitudeCondition,
        depthAtLeast: p.depthAtLeast ?? false,
        weight: Number.isFinite(p.weight) ? p.weight : magnitudeToWeight(magnitude, magnitudeCondition),
      })
    }
    for (const q of earthquakes) {
      if (q.cancelled || q.cancelledAt) continue
      const { latitude, longitude, magnitude, magnitudeCondition, name, depth, depthAtLeast } = q.earthquake.hypocenter
      if (!hasValidHypocenter(latitude, longitude)) continue
      if (!isWithinHeatWindow(q.earthquake.time, nowMs)) continue
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
      })
    }
    return Array.from(merged.values())
    // refilterTick は再生中に 1 分ごとに描き直すためだけの依存（中身は読まない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePoints, earthquakes, refilterTick, replayAnchorMs])

  return { points, isLoading }
}
