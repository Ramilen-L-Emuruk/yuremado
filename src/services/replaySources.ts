// リプレイの電文を、中継と自分の鍵の 2 か所から引いて合わせる。
//
// **鍵を入れた人もライブと同じ電文で再生する**（設計書 §0 の 2026-10-31「自分で契約した鍵を入れた利用者も、予報キーの端末と同じ動きになるようにする」の行）。
// ライブでは、自分の鍵の予報が通っている間は予報（VXSE45）を鍵から受け、中継の警報（VXSE43）を採らない。
// 再生も同じく、地震・津波などの電文は中継から、予報は自分の鍵で DMDATA から引く（どちらから引くかは
// `dmdataClassifications.ts` の `restSources`）。
import type { DmdataEndpoint } from './dmdataEndpoint'
import type { DmdataClassification, RestSources } from './dmdataClassifications'
import type { ReplayEntry, ReplayFetchResult } from '../types/replay'
import type { EEWAlert } from '../types/earthquake'
import type { DmdataEewOriginsResult } from './dmdataReplay'
import { toJstDateStr } from './dmdataReplayLive'
import { sumSkippedByDay } from '../utils/telegramLoss'
import { isAbortedByCaller } from '../utils/fetchWithTimeout'
import { eewIssueTimeMs } from '../utils/eew'
import { log } from '../utils/logger'

/** 1 つの繋ぎ先から、指定した区分で窓の電文を引く口（`fetchDmdataReplayEvents` を窓と設定で閉じたもの）。 */
export type ReplayFetchFrom = (endpoint: DmdataEndpoint, classifications: readonly DmdataClassification[]) => Promise<ReplayFetchResult>

/**
 * 代わりの警報まで引けなかったときに、読めなかった取得元へ積む印。緊急地震速報の分を丸ごと読めなかったことを、
 * 「静かな時間帯だった」と区別できる形で残す（→ `types/replay.ts` の `failedArchiveUrls`）。
 */
export const EEW_FALLBACK_FAILED_SOURCE = 'eew:relay-fallback'

/**
 * 窓の電文を引く。鍵から引かないなら中継を 1 回引くだけ。
 *
 * 鍵から引くなら、中継（地震・津波などの電文）と鍵（予報）を並べて引き、受信時刻の順に合わせる。
 * **鍵で読めなかった分は中継の警報で埋める** —— ライブで鍵の予報が切れたときに中継の VXSE43 を採るのと同じ。
 *
 * - 鍵の取得が丸ごと失敗した（例外・鍵の繋ぎ先が無い）: 窓全体を中継の警報で埋める。代わりの警報まで
 *   引けなくても地震情報は捨てず、{@link EEW_FALLBACK_FAILED_SOURCE} を読めなかった取得元に残す
 * - 鍵が一部の日だけ読めなかった（束を読めなかった・429 で見送った。`lostSourceDays` に載る日）:
 *   その日だけ中継の警報で埋める（→ {@link fillLostDays}）
 * - 止められた取得（{@link isAbortedByCaller}）は失敗として扱わず投げ直す。呼び出し元が要らないと決めた結果なので、
 *   中継の警報を取りに行く意味が無い
 *
 * **中継の地震情報が引けなければ投げる**（鍵が無い人と同じ失敗）。
 *
 * @param key 自分の鍵の繋ぎ先。`sources.keyForecast` が真なのに null なら、鍵が引けなかったときと同じく中継の警報で埋める
 */
export async function fetchReplayFromSources(
  fetchFrom: ReplayFetchFrom,
  relay: DmdataEndpoint,
  key: DmdataEndpoint | null,
  sources: RestSources,
): Promise<ReplayFetchResult> {
  if (!sources.keyForecast) return fetchFrom(relay, sources.relay)
  const relayPart = fetchFrom(relay, sources.relay)
  const keyPart = key === null
    ? Promise.resolve(null)
    : fetchFrom(key, ['eew.forecast']).catch((err: unknown) => {
      if (isAbortedByCaller(err)) throw err
      log.warn('[replay] 自分の鍵で予報を引けなかったため、中継の警報で埋めます', err)
      return null
    })
  const [relayResult, keyResult] = await Promise.all([relayPart, keyPart])
  if (keyResult !== null) {
    const merged = mergeReplayResults(relayResult, keyResult)
    if (keyResult.lostSourceDays.size === 0) return merged
    return fillLostDays(merged, keyResult, () => fetchFrom(relay, ['eew.warning']))
  }
  const fallback = await fetchFrom(relay, ['eew.warning']).catch((err: unknown) => {
    if (isAbortedByCaller(err)) throw err
    log.error('[replay] 中継の警報も引けなかったため、この窓の緊急地震速報を読めませんでした', err)
    return null
  })
  if (fallback !== null) return mergeReplayResults(relayResult, fallback)
  return { ...relayResult, failedArchiveUrls: [...relayResult.failedArchiveUrls, EEW_FALLBACK_FAILED_SOURCE] }
}

/**
 * 鍵が読めなかった日を、中継の警報で埋める。
 *
 * - **日は日本時間で区切る**（アーカイブの束も当日経路も日本時間の日ごと → `fetchDmdataReplayEvents`）
 * - **地震ごとにどちらか一方から採る。** 中継の警報のうち、読めなかった日に受けた報を 1 つでも持つ地震は、
 *   その地震の報をすべて中継の警報から採り、鍵の予報からは外す。読めた日と読めなかった日にまたがる地震で、
 *   同じ地震が予報と警報の両方から入らないようにするため。それ以外の地震は鍵の予報だけを使う
 * - **ただし警報から採るのは、その地震の報がある日がすべて中継の警報で読めているときだけ。** 中継の警報が
 *   読めなかった日（鍵は読めた日）にも報がある地震を警報から採ると、その日の報がどちらからも入らなくなる。
 *   そういう地震は鍵の予報を残し、警報の報は使わない。その地震の報が警報にある、鍵の読めなかった日は
 *   埋めきれていないので、鍵の読めなかった印を残す
 * - **埋めた日の読めなかった印は外す。** その日は中継の警報で読めているので、「読めなかった」とは出さない
 *   （ライブで鍵の予報が切れたときに中継の VXSE43 を採るのと同じ扱い）。中継の警報もその日を読めなかったときと、
 *   中継の警報が引けなかったときは埋めずに、鍵の印をそのまま残す
 * - 中継の警報の取りこぼしは、埋めた日の分だけ足す（読めた日の中継の警報は使っていない）
 *
 * @param merged 中継の地震情報と鍵の予報を合わせたもの
 * @param keyResult 鍵の予報の取得結果（`lostSourceDays` が空でないもの）
 * @param fetchWarning 窓全体の中継の警報を引く
 */
async function fillLostDays(
  merged: ReplayFetchResult,
  keyResult: ReplayFetchResult,
  fetchWarning: () => Promise<ReplayFetchResult>,
): Promise<ReplayFetchResult> {
  const keyLostDays = new Set(keyResult.lostSourceDays.values())
  let warning: ReplayFetchResult
  try {
    warning = await fetchWarning()
  } catch (err) {
    if (isAbortedByCaller(err)) throw err
    log.error(`[replay] 自分の鍵で読めなかった日（${[...keyLostDays].join(', ')}）を中継の警報でも埋められませんでした`, err)
    return merged
  }
  const relayLostDays = new Set(warning.lostSourceDays.values())
  const filledDays = new Set([...keyLostDays].filter(d => !relayLostDays.has(d)))
  const unfilled = [...keyLostDays].filter(d => !filledDays.has(d))
  if (unfilled.length > 0) {
    log.warn(`[replay] 自分の鍵で読めなかった日のうち ${unfilled.join(', ')} は、中継の警報でも読めませんでした`)
  }
  if (filledDays.size === 0) return merged

  const dayOf = (e: ReplayEntry) => toJstDateStr(e.replayTime)
  // 地震ごとに、報がある日（鍵の予報・中継の警報のどちらかに報がある日）
  const eventDays = new Map<string, Set<string>>()
  for (const e of [...keyResult.entries, ...warning.entries]) {
    const eventId = eewEventIdOf(e)
    if (eventId === undefined) continue
    const days = eventDays.get(eventId) ?? new Set<string>()
    days.add(dayOf(e))
    eventDays.set(eventId, days)
  }
  const takenEvents = new Set<string>()
  const partlyUnfilledDays = new Set<string>()
  for (const e of warning.entries) {
    const eventId = eewEventIdOf(e)
    if (eventId === undefined || !filledDays.has(dayOf(e))) continue
    const days = eventDays.get(eventId) ?? new Set<string>()
    if ([...days].every(d => !relayLostDays.has(d))) {
      takenEvents.add(eventId)
    } else {
      // 中継の警報が読めなかった日にも報がある地震は、警報からは採れない（その日の報が無くなる）。
      // 鍵の報を残し、この日は「埋められなかった日」として読めなかった印を残す
      partlyUnfilledDays.add(dayOf(e))
    }
  }
  const fromWarning = warning.entries.filter((e) => {
    const eventId = eewEventIdOf(e)
    return eventId !== undefined ? takenEvents.has(eventId) : filledDays.has(dayOf(e))
  })
  const kept = merged.entries.filter((e) => {
    const eventId = eewEventIdOf(e)
    return eventId === undefined || !takenEvents.has(eventId)
  })
  if (partlyUnfilledDays.size > 0) {
    log.warn(`[replay] 自分の鍵で読めなかった日のうち ${[...partlyUnfilledDays].join(', ')} は、中継の警報が読めなかった日にまたがる地震があるため埋めきれませんでした`)
  }
  const markClearedDays = new Set([...filledDays].filter(d => !partlyUnfilledDays.has(d)))
  const filledIds = new Set([...keyResult.lostSourceDays].filter(([, day]) => markClearedDays.has(day)).map(([id]) => id))
  const warningSkips = new Map([...warning.skippedByDay].filter(([day]) => filledDays.has(day)))
  log.info(`[replay] 自分の鍵で読めなかった日（${[...filledDays].join(', ')}）を中継の警報で埋めました（報 ${fromWarning.length} 通）`)
  return mergeReplayResults(
    {
      ...merged,
      entries: kept,
      failedArchiveUrls: merged.failedArchiveUrls.filter(id => !filledIds.has(id)),
      rateLimitedSources: merged.rateLimitedSources.filter(id => !filledIds.has(id)),
      lostSourceDays: new Map([...merged.lostSourceDays].filter(([id]) => !filledIds.has(id))),
    },
    {
      entries: fromWarning,
      skippedByDay: warningSkips,
      failedArchiveUrls: [],
      rateLimitedSources: [],
      rateLimitedTelegrams: 0,
      lostSourceDays: new Map(),
    },
  )
}

/** 緊急地震速報の報なら、その地震 ID。それ以外の電文と、地震 ID の無い報は undefined。 */
function eewEventIdOf(entry: ReplayEntry): string | undefined {
  const p = entry.payload
  return p.kind === 'event' && p.event.kind === 'eew' ? p.event.issue?.eventId : undefined
}

/** 1 つの繋ぎ先から、指定した区分で過去の緊急地震速報の最終報を引く口（`fetchDmdataEewOrigins` を期間で閉じたもの）。 */
export type EewOriginsFetchFrom = (endpoint: DmdataEndpoint, classifications: readonly DmdataClassification[]) => Promise<DmdataEewOriginsResult>

/**
 * 取り直しの間で、取りきれた中継の警報を使い回す控え。**同じ期間を引く取り直しの間だけ**共有する
 * （期間が変わったら作り直す）。
 */
export interface RelayWarningMemo {
  result: DmdataEewOriginsResult | null
}

export function createRelayWarningMemo(): RelayWarningMemo {
  return { result: null }
}

/**
 * 過去の緊急地震速報の最終報（地震カードの発生時刻の秒）を引く。鍵から引かないなら中継を 1 回引くだけ。
 *
 * 鍵から引くなら予報を鍵で引く。**予報は警報の報も兼ねる**（VXSE45 は警報の報も含む → `dmdataClassifications.ts`）
 * ので、取りきれたら中継の警報は引かない。取りきれなかったら中継の警報と合わせる。**同じ地震は発表時刻の新しい
 * 最終報を採る**（鍵の最終報が途中の報で止まっていても、中継の警報に後の報があればそちらの発生時刻・仮定震源かどうかを使う。
 * 発表時刻が同じか比べられなければ鍵の予報）。**報番号では比べない** —— 予報（VXSE45）と警報（VXSE43）は報番号の系列が別で、
 * 警報は地震ごとに第 1 報から数え直す（2023-02-25 22:28:07 は予報の第 9 報と警報の第 1 報が同じ秒）（→ `docs/spec/data-sources-spec.md`「EEW は VXSE45 だけを受ける」。ライブで
 * 経路をまたいで比べるときも発表時刻 → `utils/eew.ts` の `isOlderEewReport`）。地震 ID の無い報は合わせずに両方残す。
 * 取りきれていない印は残す —— 呼び出し側の取り直しで鍵の分を取りきれるように。
 *
 * **鍵と中継の警報のどちらかが投げても、取れた側は捨てない。** 投げた側は何も取れず取りきれていないものとして
 * 扱い、取りきれていない印を立てて取り直しに乗せる（投げたまま返すと、取れた側まで捨てられ、取り直しも走らない）。
 * 止められた取得（{@link isAbortedByCaller}）だけは投げ直す。
 *
 * @param memo 取り直しの間で共有する控え。中継の警報が取りきれていれば、2 回目以降は引き直さずに使う
 */
export async function fetchEewOriginsFromSources(
  fetchFrom: EewOriginsFetchFrom,
  relay: DmdataEndpoint,
  key: DmdataEndpoint | null,
  sources: RestSources,
  memo: RelayWarningMemo,
): Promise<DmdataEewOriginsResult> {
  if (!sources.keyForecast) return fetchFrom(relay, sources.relay)
  const keyResult: DmdataEewOriginsResult = key === null
    ? emptyOrigins()
    : await fetchFrom(key, ['eew.forecast']).catch((err: unknown) => {
      if (isAbortedByCaller(err)) throw err
      log.warn('[eew-origin] 自分の鍵で過去の予報を引けなかったため、中継の警報で埋めます', err)
      return emptyOrigins()
    })
  if (keyResult.complete) return keyResult
  let warning = memo.result
  if (warning === null) {
    warning = await fetchFrom(relay, ['eew.warning']).catch((err: unknown) => {
      if (isAbortedByCaller(err)) throw err
      log.warn('[eew-origin] 中継の過去の警報を引けませんでした（取り直しで引き直します）', err)
      return emptyOrigins()
    })
    if (warning.complete) memo.result = warning
  }
  return {
    finals: mergeFinalsByIssueTime(keyResult.finals, warning.finals),
    canceledIds: [...new Set([...keyResult.canceledIds, ...warning.canceledIds])],
    complete: false,
  }
}

/** 引けなかった側の結果。取りきれていない印を立て、呼び出し側の取り直しに乗せる。 */
function emptyOrigins(): DmdataEewOriginsResult {
  return { finals: [], canceledIds: [], complete: false }
}

/** 同じ地震 ID の最終報は発表時刻の新しいほうを採る（同じか比べられなければ `primary`）。地震 ID の無い報は両方残す。 */
function mergeFinalsByIssueTime(primary: readonly EEWAlert[], secondary: readonly EEWAlert[]): EEWAlert[] {
  const out: EEWAlert[] = []
  const byEvent = new Map<string, number>()
  for (const e of [...primary, ...secondary]) {
    const eventId = e.issue?.eventId
    if (eventId === undefined) {
      out.push(e)
      continue
    }
    const at = byEvent.get(eventId)
    if (at === undefined) {
      byEvent.set(eventId, out.length)
      out.push(e)
    } else {
      const current = eewIssueTimeMs(out[at])
      const incoming = eewIssueTimeMs(e)
      if (current !== null && incoming !== null && incoming > current) out[at] = e
    }
  }
  return out
}

/**
 * 別々の繋ぎ先から引いた 2 つの結果を合わせる。電文は受信時刻の順に並べ直し、同じ時刻は 1ms ずつずらす
 * （1 つの取得の中と同じ扱い → `fetchDmdataReplayEvents` の末尾）。取りこぼしは日ごとに足す
 * （別々のものを読んだ結果なので → `sumSkippedByDay`）。
 */
function mergeReplayResults(a: ReplayFetchResult, b: ReplayFetchResult): ReplayFetchResult {
  const entries = [...a.entries, ...b.entries].sort((x, y) => x.replayTime.getTime() - y.replayTime.getTime())
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].replayTime.getTime() <= entries[i - 1].replayTime.getTime()) {
      entries[i] = { ...entries[i], replayTime: new Date(entries[i - 1].replayTime.getTime() + 1) }
    }
  }
  return {
    entries,
    skippedByDay: sumSkippedByDay(a.skippedByDay, b.skippedByDay),
    failedArchiveUrls: [...a.failedArchiveUrls, ...b.failedArchiveUrls],
    rateLimitedSources: [...a.rateLimitedSources, ...b.rateLimitedSources],
    rateLimitedTelegrams: a.rateLimitedTelegrams + b.rateLimitedTelegrams,
    lostSourceDays: new Map([...a.lostSourceDays, ...b.lostSourceDays]),
  }
}
