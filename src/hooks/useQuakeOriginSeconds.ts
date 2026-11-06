// 地震カードごとに、発生時刻を**秒まで**決める（→ 決め方は `utils/quakeOriginSeconds.ts`）。
// 自作地震計の波形へ P 波・S 波の線を引くのに使う。
//
// **材料の集め方**
//
// | 材料 | 取り方 |
// |---|---|
// | 画面に来た緊急地震速報 | 受信した電文と強震モニタ（Yahoo）の EEW（リプレイの再生区間も同じ経路で流れる） |
// | 過去 7 日（＋境目の 1 日）ぶんの緊急地震速報 | 地震ごとの最終報の本文（中継の束・まだ束の無い日は中継の電文一覧から。`dmdataReplay.ts` の `fetchDmdataEewOrigins`） |
// | 地震 ID（緊急地震速報を結ぶ鍵） | カードの電文が持っている |
// | 長期震源カタログ | 中継の公開バケット `data.yuremado.com/h/`（要る年だけ読む） |
//
// **仮定震源要素だったかを見分けられるのは、電文の `condition` を持つ経路だけ。** 加工データの一覧と詳細
// （`/v2/gd/eew`）は `condition` の欄を持たない（2026-10-15 に実物の応答で確かめた）ので、**最終報の本文から読む**
// （2026-10-15 ユーザー承認「地震ごとに本文で確かめる（推奨）」。取り方は同日「それで進めて」— 日ごとのアーカイブを
// 読む）。強震モニタの緊急地震速報も `condition` を持たないが、こちらは「見分けられない」として残し、使う
// （2026-10-15 ユーザー承認「仮定震源の報は使わない（推奨）」の説明「標準版の強震モニタ経路は仮定を見分けられないので除けない」）。
//
// **緊急地震速報の発生時刻は端末へ残す**（`utils/eewOriginStore.ts`）。リロードしても、リプレイを
// 始め直しても、同じ地震について取り直さない。
//
// **取りに行くのは開いた直後とリプレイの開始時だけ。** それ以降に起きた地震の緊急地震速報は
// 画面に来る経路で残るので、定期的には取らない。カタログは同梱データなので、要る年が変わったときに読む。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DmdataClassification, RestSources } from '../services/dmdataClassifications'
import type { DmdataEndpoint } from '../services/dmdataEndpoint'
import { createRelayWarningMemo, fetchEewOriginsFromSources } from '../services/replaySources'
import { fetchDmdataEewOrigins } from '../services/dmdataReplay'
import { relayRestEndpoint } from '../services/relayEndpoint'
import { YAHOO_EEW_ID_PREFIX } from '../services/kyoshin'
import { serverNow } from '../utils/clock'
import {
  loadEewOrigins,
  mergeEewOrigins,
  saveEewOrigins,
  sameEewOrigins,
  type EewOriginEntry,
  type EewOriginFetch,
} from '../utils/eewOriginStore'
import { hasMagnitude } from '../utils/formatters'
import { hasKnownEpicenter } from '../utils/geo'
import { loadHypocenterIndex, loadHypocenterYear } from '../utils/hypocenterCatalog'
import { log } from '../utils/logger'
import { extractQuakeEventId, quakeEventKey } from '../utils/quakeMerge'
import {
  catalogYearsFor,
  findCatalogOriginMs,
  parseJstTimeMs,
  resolveOriginSeconds,
  telegramOriginMinuteMs,
  usableEewOrigin,
  type CatalogColumns,
  type OriginSeconds,
} from '../utils/quakeOriginSeconds'
import type { EEWAlert, JMAQuake } from '../types/earthquake'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 過去分を取りに行く幅。**地震カードの 7 日ぶん ＋ 1 日。** 境目の地震の緊急地震速報が
 * 前日に始まっていても拾えるよう、1 日だけ広く取る。
 */
const EEW_LOOKBACK_MS = 8 * DAY_MS

/** 日本時間（UTC+9）。カタログの年は日本時間で区切られている。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 長期震源カタログを読めなかったときに取り直す回数と間隔。同梱データなので一時的な失敗しか想定しない。 */
const CATALOG_RETRY_LIMIT = 3
const CATALOG_RETRY_DELAY_MS = 60_000

/** 読み込んだ長期震源カタログ。 */
export interface LoadedCatalog {
  /** 読んだ年（日本時間の暦年）。 */
  readonly years: ReadonlyMap<number, CatalogColumns>
  /** カタログが覆っている終端（エポックミリ秒）。 */
  readonly coveredThroughMs: number
}

/** 地震カードの材料（地震 ID と時刻）。2 か所で同じ式を使うので 1 つにまとめる。 */
function quakeKeys(q: JMAQuake): {
  readonly eventId: string | null
  /** カードの時刻（地震発現の分）。 */
  readonly timeMs: number
  /** 電文の地震発生時刻（分まで）。電文が持たない（震度速報）・読めなければ `null`。 */
  readonly originMinuteMs: number | null
} {
  // **日本時間として読む**（端末の時間帯で読むと、日本国外で突き合わせが全滅する）。
  const timeMs = parseJstTimeMs(q.earthquake.time)
  return { eventId: extractQuakeEventId(q), timeMs, originMinuteMs: telegramOriginMinuteMs(q) }
}

/**
 * 地震カードごとの秒を組み立てる。**テストから直に確かめられるよう外へ出してある。**
 *
 * 地震 ID はカードの電文から引く。**地震 ID は緊急地震速報を結ぶ鍵にだけ使う**（秒の出どころにはしない）。
 */
export function buildOriginSecondsMap(params: {
  readonly quakes: readonly JMAQuake[]
  readonly eewOrigins: ReadonlyMap<string, EewOriginEntry>
  /** 読み込めた長期震源カタログ（まだ・読めないなら `null`）。 */
  readonly catalog: LoadedCatalog | null
}): Map<string, OriginSeconds> {
  const { quakes, eewOrigins, catalog } = params
  const out = new Map<string, OriginSeconds>()
  for (const q of quakes) {
    const { eventId, timeMs, originMinuteMs } = quakeKeys(q)
    const eew = eventId === null ? undefined : eewOrigins.get(eventId)
    let catalogOriginMs: number | null = null
    if (usableEewOrigin(timeMs, originMinuteMs, eew) === null && catalog !== null) {
      // **要る年が全部読めているときだけ引く。** 年をまたぐ分で片方の年しか無いと、もう片方にある
      // 2 つ目の候補が見えず、「1 つに決まった」と取り違える（見ていないものを見つからなかったと扱わない）。
      const years = catalogYearsFor(timeMs, originMinuteMs).map((y) => catalog.years.get(y))
      if (years.length > 0 && years.every((y) => y !== undefined)) {
        const h = q.earthquake.hypocenter
        catalogOriginMs = findCatalogOriginMs(
          { timeMs, originMinuteMs, latitude: h.latitude, longitude: h.longitude, magnitude: h.magnitude },
          years as CatalogColumns[],
          catalog.coveredThroughMs,
        )
      }
    }
    const resolved = resolveOriginSeconds({ quakeTimeMs: timeMs, originMinuteMs, eew, catalogOriginMs })
    if (resolved !== null) out.set(quakeEventKey(q), resolved)
  }
  return out
}

/**
 * カタログを引きに行く年（昇順）。**緊急地震速報から秒が取れる地震と、震央か規模が判らない地震は数えない**
 * （引いても使わない年のファイルを読まない。1 年ぶんで約 1 MB）。
 */
export function catalogYearsNeeded(params: {
  readonly quakes: readonly JMAQuake[]
  readonly eewOrigins: ReadonlyMap<string, EewOriginEntry>
}): number[] {
  const { quakes, eewOrigins } = params
  const years = new Set<number>()
  for (const q of quakes) {
    const h = q.earthquake.hypocenter
    if (!hasKnownEpicenter(h.latitude, h.longitude) || !hasMagnitude(h.magnitude)) continue
    const { eventId, timeMs, originMinuteMs } = quakeKeys(q)
    if (usableEewOrigin(timeMs, originMinuteMs, eventId === null ? undefined : eewOrigins.get(eventId)) !== null) continue
    for (const y of catalogYearsFor(timeMs, originMinuteMs)) years.add(y)
  }
  return [...years].sort((a, b) => a - b)
}

/**
 * 画面に来ている緊急地震速報から、残す値と除く地震を取り出す。
 *
 * **訓練・試験の報は採らない。** **取り消された地震は除く** —— 誤報の発生時刻で線を引かない
 * （取消は `cancelledAt` で表される。下の判定を参照）。
 * 地震 ID（`issue.eventId`）を持たない報は鍵が無いので採らない。
 *
 * **仮定震源要素の報は印を付けて残す**（使わないが、後から届く見分けられない値に上書きされないため。
 * → `utils/eewOriginStore.ts`）。**強震モニタ（Yahoo）の報は見分けられない**（`condition` を運ばない）。
 */
export function eewOriginsFromActive(eews: Iterable<EEWAlert>): {
  updates: Array<[string, EewOriginEntry]>
  removals: string[]
} {
  const updates: Array<[string, EewOriginEntry]> = []
  const removals: string[] = []
  for (const eew of eews) {
    if (eew.test) continue
    const eventId = eew.issue?.eventId
    if (!eventId) continue
    // **画面の EEW は取消を `cancelledAt` で持つ**（`useEarthquakes` は取消電文を受けると既存の報に
    // `cancelledAt` だけを足して表示猶予の間残す。`cancelled` は false のまま）。両方を見る。
    if (eew.cancelled || eew.cancelledAt) {
      removals.push(eventId)
      continue
    }
    const originMs = new Date(eew.earthquake.originTime).getTime()
    if (!Number.isFinite(originMs)) continue
    // `condition` を持たない報（強震モニタ・欄の無い形）は見分けられない。
    const condition = eew.earthquake.condition as string | undefined
    const assumed = eew.id.startsWith(YAHOO_EEW_ID_PREFIX) || condition === undefined ? null : condition === '仮定震源要素'
    updates.push([eventId, { originMs, assumed }])
  }
  return { updates, removals }
}

export function useQuakeOriginSeconds(params: {
  /** 波形を出さない設定なら何もしない（取りに行かず、端末にも残さない）。 */
  readonly enabled: boolean
  /**
   * 引く先と区分（→ `dmdataClassifications.ts` の `restSources`）。予報は中継が予報キーを受け付けていれば中継から、
   * 自分の鍵の予報が通っていれば鍵から引く（→ `replaySources.ts` の `fetchEewOriginsFromSources`）。
   */
  readonly sources: RestSources
  /** 自分の鍵の繋ぎ先。鍵が無ければ null */
  readonly keyEndpoint: DmdataEndpoint | null
  readonly quakes: readonly JMAQuake[]
  readonly activeEEWs: ReadonlyMap<string, EEWAlert>
  /** リプレイ中の時刻のずれ（ライブなら `null`）。変わったら過去分を取り直す。 */
  readonly replayOffsetMs: number | null
}): ReadonlyMap<string, OriginSeconds> {
  const { enabled, sources, keyEndpoint, quakes, activeEEWs, replayOffsetMs } = params
  // 依存は中身で持つ（配列の作り直しで取り直さない）。鍵から引くかも中身に含める
  const classificationsKey = [...sources.relay].sort().join(',')
  const keyForecast = sources.keyForecast
  // 鍵の繋ぎ先は鍵の文字列が変わったときだけ作り直される（呼び出し側の `useMemo`）。依存に入れず ref で読む
  const keyEndpointRef = useRef(keyEndpoint)
  keyEndpointRef.current = keyEndpoint
  const keyPresent = keyEndpoint !== null
  const [eewOrigins, setEewOrigins] = useState<Map<string, EewOriginEntry>>(() => (enabled ? loadEewOrigins() : new Map()))
  const [catalog, setCatalog] = useState<LoadedCatalog | null>(null)
  const originsRef = useRef(eewOrigins)
  originsRef.current = eewOrigins

  // 足すときは必ずここを通す（画面と端末の両方を揃える）。
  const recordRef = useRef((updates: Iterable<readonly [string, EewOriginEntry]>, removals: Iterable<string>) => {
    const next = mergeEewOrigins(originsRef.current, updates, removals)
    if (sameEewOrigins(next, originsRef.current)) return
    originsRef.current = next
    setEewOrigins(next)
    saveEewOrigins(next)
  })

  // 無効から有効へ変わったら、端末に残っている分を読み直す。
  useEffect(() => {
    if (!enabled) return
    const stored = loadEewOrigins()
    recordRef.current(stored, [])
  }, [enabled])

  // 画面で取り消しを受けた地震。**過去分の取得結果で戻さない** —— 取得（取り直しを含め最大 3 分）の途中で取消が
  // 届くと、取得が持っている取消前の報が後から書き込まれ、取り消された地震の線が戻る。画面で同じ地震の有効な報を
  // 受け直したら外す（リプレイで取消の前へ巻き戻したとき）。
  const liveCanceledRef = useRef(new Set<string>())

  // 画面に来た緊急地震速報を残す（ライブ・リプレイの再生区間の両方）。
  useEffect(() => {
    if (!enabled) return
    const { updates, removals } = eewOriginsFromActive(activeEEWs.values())
    for (const [id] of updates) liveCanceledRef.current.delete(id)
    for (const id of removals) liveCanceledRef.current.add(id)
    if (updates.length > 0 || removals.length > 0) recordRef.current(updates, removals)
  }, [enabled, activeEEWs])

  // 開いた直後とリプレイの開始時に、過去分を取りに行く。
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // 結果を要らなくなったら（設定の変更・リプレイの切替・アンマウント）、途中の取得も止める。
    const abort = new AbortController()
    // **一覧が取消と伝えた地震は、端末の記録からも除く**（画面で先に有効な報として残した値が残らないように）。
    const recordFetched = (found: EewOriginFetch) => {
      const liveCanceled = liveCanceledRef.current
      const origins = liveCanceled.size === 0 ? found.origins : new Map([...found.origins].filter(([id]) => !liveCanceled.has(id)))
      if (origins.size > 0 || found.canceled.length > 0) recordRef.current(origins, found.canceled)
    }
    const anchor = serverNow()
    // **地震ごとの最終報の本文から読む。** 画面で受けた報と同じ関数で記録に変える（仮定震源要素の見分け・
    // 取消・訓練報の扱いを 1 か所に揃える）。一覧が取消と伝えた地震も除く。
    const cls = classificationsKey === '' ? [] : (classificationsKey.split(',') as DmdataClassification[])
    const fetchSources: RestSources = { relay: cls, keyForecast }
    // **取りきれなかったら間を置いて取り直す**（長期震源カタログと同じ回数・間隔）。取りきれなかった分は
    // 「緊急地震速報が無かった」と区別が付かず、取り直さないとリロードまで線が引けない。アーカイブと電文本体は
    // 控えに残るので、取り直しで飛ぶのは一覧と、読めなかった分だけ。中継の警報は、取りきれていれば
    // 取り直しの間で使い回す（期間はこの回の `anchor` で決まっているので、取り直しでも同じ）。
    const relayWarningMemo = createRelayWarningMemo()
    const fetchOnce = (attempt: number) => {
      void fetchEewOriginsFromSources(
        (endpoint, classifications) => fetchDmdataEewOrigins(endpoint, new Date(anchor - EEW_LOOKBACK_MS), new Date(anchor), classifications, abort.signal),
        relayRestEndpoint, keyEndpointRef.current, fetchSources, relayWarningMemo,
      )
        .then((found) => {
          if (cancelled) return
          const { updates, removals } = eewOriginsFromActive(found.finals)
          recordFetched({ origins: new Map(updates), canceled: [...removals, ...found.canceledIds] })
          if (found.complete) return
          if (attempt >= CATALOG_RETRY_LIMIT) {
            log.warn(`[eew-origin] 過去の緊急地震速報を ${attempt + 1} 回取って取りきれませんでした（取れた分だけで線を引きます）`)
            return
          }
          retryTimer = setTimeout(() => { if (!cancelled) fetchOnce(attempt + 1) }, CATALOG_RETRY_DELAY_MS)
        })
        .catch((err: unknown) => { log.warn('[eew-origin] 過去の緊急地震速報を記録できませんでした', err) })
    }
    fetchOnce(0)
    return () => {
      cancelled = true
      abort.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [enabled, classificationsKey, keyForecast, keyPresent, replayOffsetMs])

  // 長期震源カタログのうち、要る年を読む。**読めた年は捨てない**（ファイルの控えは
  // `hypocenterCatalog.ts` が持つので、読み直しても通信は出ない）。**年ごとに成否を扱う** —— 1 年の
  // 失敗で他の年まで巻き添えにしない。読めなかった年は間を置いて {@link CATALOG_RETRY_LIMIT} 回まで取り直す。
  const neededYearsKey = useMemo(
    () => (enabled ? catalogYearsNeeded({ quakes, eewOrigins }).join(',') : ''),
    [enabled, quakes, eewOrigins],
  )
  const [catalogRetry, setCatalogRetry] = useState(0)
  useEffect(() => { setCatalogRetry(0) }, [neededYearsKey])
  useEffect(() => {
    if (neededYearsKey === '') return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const wanted = neededYearsKey.split(',').map(Number)
    const scheduleRetry = () => {
      if (catalogRetry >= CATALOG_RETRY_LIMIT) return
      retryTimer = setTimeout(() => { if (!cancelled) setCatalogRetry((n) => n + 1) }, CATALOG_RETRY_DELAY_MS)
    }
    void (async () => {
      let index
      try {
        index = await loadHypocenterIndex()
      } catch (err) {
        if (cancelled) return
        log.warn(`[origin] 長期震源カタログの索引を読めませんでした（要る年 ${neededYearsKey}・${catalogRetry} 回目の取り直し）`, err)
        scheduleRetry()
        return
      }
      if (cancelled) return
      const available = new Set(index.years)
      // **終端より後の年・索引に無い年は読まない**（まだ 1 件も載っていない）。その年に掛かる地震は
      // 「要る年が揃っていない」として引かれない（上の `buildOriginSecondsMap`）。
      const years = wanted.filter((y) => available.has(y) && Date.UTC(y, 0, 1) - JST_OFFSET_MS <= index.coveredThroughMs)
      const settled = await Promise.allSettled(years.map((y) => loadHypocenterYear(y)))
      if (cancelled) return
      const failed = years.filter((_, i) => settled[i].status === 'rejected')
      if (failed.length > 0) {
        const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        log.warn(`[origin] 長期震源カタログの ${failed.join(',')} 年を読めませんでした（${catalogRetry} 回目の取り直し）`, first?.reason)
        scheduleRetry()
      }
      const loaded = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      setCatalog((prev) => {
        const fresh = loaded.filter((y) => prev?.years.get(y.year) !== y)
        if (prev !== null && fresh.length === 0 && prev.coveredThroughMs === index.coveredThroughMs) return prev
        const merged = new Map(prev?.years ?? [])
        for (const y of loaded) merged.set(y.year, y)
        return { years: merged, coveredThroughMs: index.coveredThroughMs }
      })
    })()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [neededYearsKey, catalogRetry])

  return useMemo(
    () => (enabled ? buildOriginSecondsMap({ quakes, eewOrigins, catalog }) : new Map()),
    [enabled, quakes, eewOrigins, catalog],
  )
}
