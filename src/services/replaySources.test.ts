// 鍵を入れた人のリプレイで、中継と自分の鍵の 2 か所から引いた結果を合わせる（→ `replaySources.ts`）
import { describe, it, expect } from 'vitest'
import type { DmdataEndpoint } from './dmdataEndpoint'
import type { DmdataClassification } from './dmdataClassifications'
import type { ReplayEntry, ReplayFetchResult } from '../types/replay'
import type { EEWAlert } from '../types/earthquake'
import type { DmdataEewOriginsResult } from './dmdataReplay'
import { createRelayWarningMemo, fetchEewOriginsFromSources, fetchReplayFromSources } from './replaySources'

const RELAY = { apiBase: 'https://relay.example.test/v2' } as DmdataEndpoint
const KEY = { apiBase: 'https://api.dmdata.jp/v2' } as DmdataEndpoint

function entry(id: string, ms: number): ReplayEntry {
  return {
    payload: { kind: 'event', event: { id } as never },
    replayTime: new Date(ms),
    logEntry: null,
  }
}

function result(entries: ReplayEntry[], extra: Partial<ReplayFetchResult> = {}): ReplayFetchResult {
  return { entries, logOnlyEntries: [], skippedByDay: new Map(), failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0, lostSourceDays: new Map(), ...extra } as ReplayFetchResult
}

/** 呼ばれた繋ぎ先と区分を記録し、表から結果を返す偽の取得 */
function fakeFetch(table: (endpoint: DmdataEndpoint, cls: readonly DmdataClassification[]) => Promise<ReplayFetchResult>) {
  const calls: Array<[string, string]> = []
  const fetchFrom = (endpoint: DmdataEndpoint, cls: readonly DmdataClassification[]) => {
    calls.push([endpoint.apiBase, cls.join(',')])
    return table(endpoint, cls)
  }
  return { calls, fetchFrom }
}

const ids = (r: ReplayFetchResult) => r.entries.map(e => (e.payload as { event: { id: string } }).event.id)

describe('fetchReplayFromSources', () => {
  it('鍵から引かないなら、中継を 1 回だけ引いてそのまま返す', async () => {
    const relayResult = result([entry('q', 1000)])
    const { calls, fetchFrom } = fakeFetch(async () => relayResult)
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake', 'eew.warning'], keyForecast: false })
    expect(got).toBe(relayResult)
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake,eew.warning']])
  })

  it('鍵から引くなら、中継の地震情報と鍵の予報を合わせ、受信時刻の順に並べる', async () => {
    const { calls, fetchFrom } = fakeFetch(async (endpoint) => endpoint === RELAY
      ? result([entry('q1', 1000), entry('q2', 3000)], { skippedByDay: new Map([['2026-10-31', 1]]), failedArchiveUrls: ['r1'] })
      : result([entry('f1', 2000), entry('f2', 3000)], { skippedByDay: new Map([['2026-10-31', 2]]), rateLimitedSources: ['k1'], rateLimitedTelegrams: 4 }))
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true })
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake'], [KEY.apiBase, 'eew.forecast']])
    expect(ids(got)).toEqual(['q1', 'f1', 'q2', 'f2'])
    // 同じ時刻は 1ms ずつずらして別の刻みで出す（1 つの取得の中と同じ扱い）
    expect(got.entries.map(e => e.replayTime.getTime())).toEqual([1000, 2000, 3000, 3001])
    expect(got.skippedByDay.get('2026-10-31')).toBe(3)
    expect(got.failedArchiveUrls).toEqual(['r1'])
    expect(got.rateLimitedSources).toEqual(['k1'])
    expect(got.rateLimitedTelegrams).toBe(4)
  })

  // 鍵の予報が引けないなら、中継の警報で埋める（ライブで鍵の予報が切れたときに中継の VXSE43 を採るのと同じ）
  it('鍵の取得が失敗したら、中継の警報を引いて合わせる', async () => {
    const { calls, fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) throw new Error('取得できない')
      return cls.includes('eew.warning') ? result([entry('w1', 1500)]) : result([entry('q1', 1000)])
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true })
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake'], [KEY.apiBase, 'eew.forecast'], [RELAY.apiBase, 'eew.warning']])
    expect(ids(got)).toEqual(['q1', 'w1'])
  })

  // 代わりの警報まで引けなければ、地震情報は捨てずに返し、緊急地震速報を読めなかったことを取りこぼしの印に残す
  it('代わりの警報も引けなければ、地震情報だけ返して読めなかった取得元に印を残す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY || cls.includes('eew.warning')) throw new Error('取得できない')
      return result([entry('q1', 1000)])
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true })
    expect(ids(got)).toEqual(['q1'])
    expect(got.failedArchiveUrls).toEqual(['eew:relay-fallback'])
  })

  it('鍵から引くと決まったのに鍵の繋ぎ先が無ければ、中継の警報で埋める', async () => {
    const { calls, fetchFrom } = fakeFetch(async (_e, cls) => (cls.includes('eew.warning') ? result([entry('w1', 1500)]) : result([entry('q1', 1000)])))
    const got = await fetchReplayFromSources(fetchFrom, RELAY, null, { relay: ['telegram.earthquake'], keyForecast: true })
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake'], [RELAY.apiBase, 'eew.warning']])
    expect(ids(got)).toEqual(['q1', 'w1'])
  })

  // 中継の地震情報が引けないのは鍵が無い人と同じ失敗。合わせずにそのまま投げる
  it('中継の地震情報が引けなければ投げる', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint) => {
      if (endpoint === RELAY) throw new Error('中継に繋がらない')
      return result([entry('f1', 2000)])
    })
    await expect(fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }))
      .rejects.toThrow('中継に繋がらない')
  })

  // 止められた取得は失敗ではない。中継の警報へ倒さず、そのまま投げ直す
  it('鍵の取得が止められたら、中継の警報を引かずに投げ直す', async () => {
    const { calls, fetchFrom } = fakeFetch(async (endpoint) => {
      if (endpoint === KEY) throw new DOMException('取得を止めました', 'AbortError')
      return result([entry('q1', 1000)])
    })
    await expect(fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake'], [KEY.apiBase, 'eew.forecast']])
  })

  it('代わりの警報の取得が止められたら、印を残して返さずに投げ直す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) throw new Error('取得できない')
      if (cls.includes('eew.warning')) throw new DOMException('取得を止めました', 'AbortError')
      return result([entry('q1', 1000)])
    })
    await expect(fetchReplayFromSources(fetchFrom, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

/** 2026-10-30 / 10-31 の日本時間の正午（取得元の日は日本時間で区切る） */
const DAY30 = Date.UTC(2026, 9, 30, 3)
const DAY31 = Date.UTC(2026, 9, 31, 3)

function eewEntry(id: string, eventId: string, ms: number): ReplayEntry {
  return {
    payload: { kind: 'event', event: { kind: 'eew', id, issue: { eventId } } as never },
    replayTime: new Date(ms),
    logEntry: null,
  }
}

// 鍵が一部の日だけ読めなかったら、その日だけ中継の警報で埋める（2026-10-31 ユーザー決定「欠けた日だけ埋める」）
describe('fetchReplayFromSources: 鍵が読めなかった日だけ埋める', () => {
  const SOURCES = { relay: ['telegram.earthquake'] as DmdataClassification[], keyForecast: true }
  const relayQuake = () => result([entry('q1', DAY30 - 1000)])
  /** 鍵: 10-30 は読めて地震 A の予報、10-31 は束を読めなかった */
  const keyPartial = (extra: Partial<ReplayFetchResult> = {}) => result([eewEntry('fA', 'A', DAY30)], {
    failedArchiveUrls: ['k31'], lostSourceDays: new Map([['k31', '2026-10-31']]), ...extra,
  })
  /** 中継の警報: 10-30 に地震 A、10-31 に地震 B */
  const relayWarning = (extra: Partial<ReplayFetchResult> = {}) => result(
    [eewEntry('wA', 'A', DAY30 + 1000), eewEntry('wB', 'B', DAY31)],
    { skippedByDay: new Map([['2026-10-30', 5], ['2026-10-31', 2]]), ...extra },
  )

  it('正: 読めなかった日だけ中継の警報で埋め、その日の読めなかった印を外す', async () => {
    const { calls, fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial()
      return cls.includes('eew.warning') ? relayWarning() : relayQuake()
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake'], [KEY.apiBase, 'eew.forecast'], [RELAY.apiBase, 'eew.warning']])
    // 読めた 10-30 の地震 A は鍵の予報だけ。中継の警報 wA は入れない（同じ地震を二重にしない）
    expect(ids(got)).toEqual(['q1', 'fA', 'wB'])
    expect(got.failedArchiveUrls).toEqual([])
    // 埋めた日の取りこぼしだけを足す（読めた日の中継の警報は使っていない）
    expect(got.skippedByDay.get('2026-10-30')).toBeUndefined()
    expect(got.skippedByDay.get('2026-10-31')).toBe(2)
  })

  it('正: 429 で見送った日も埋め、見送りの印を外す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial({ failedArchiveUrls: [], rateLimitedSources: ['k31'] })
      return cls.includes('eew.warning') ? relayWarning() : relayQuake()
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(ids(got)).toEqual(['q1', 'fA', 'wB'])
    expect(got.rateLimitedSources).toEqual([])
  })

  it('正: 読めなかった日に掛かる地震は、読めた日の分も含めて中継の警報から採る', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial({ entries: [eewEntry('fC', 'C', DAY30)] })
      if (!cls.includes('eew.warning')) return relayQuake()
      return result([eewEntry('wC1', 'C', DAY30 + 1000), eewEntry('wC2', 'C', DAY31)])
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(ids(got)).toEqual(['q1', 'wC1', 'wC2'])
  })

  // 電文ログにだけ積む行も、埋めた日の分だけ中継の警報から採る（読めた日の分は鍵側の行があるので重ねない）。
  // 鍵側の行は消さない。連結した後は再生時刻の順に並ぶ
  it('正: 電文ログにだけ積む行も、埋めた日の分だけ中継から採り、鍵側の行と時刻順に並べる', async () => {
    const logRow = (id: string, ms: number) => ({
      replayTime: new Date(ms),
      logEntry: { id, receivedAt: new Date(ms), source: 'dmdss', origin: 'replay', headType: 'VXSE42', isTest: true, status: 'filtered', rawBody: '' },
    }) as ReplayFetchResult['logOnlyEntries'][number]
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial({ logOnlyEntries: [logRow('k30', DAY30 + 5000)] })
      return cls.includes('eew.warning')
        ? relayWarning({ logOnlyEntries: [logRow('r30', DAY30 + 6000), logRow('r31', DAY31 + 1000)] })
        : relayQuake()
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(got.logOnlyEntries.map(e => e.logEntry.id)).toEqual(['k30', 'r31'])
  })

  it('対照: 鍵がすべての日を読めたら、中継の警報は引かない', async () => {
    const { calls, fetchFrom } = fakeFetch(async (endpoint) => (endpoint === KEY
      ? result([eewEntry('fA', 'A', DAY30)], { failedArchiveUrls: ['eew:A'] })
      : relayQuake()))
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(calls).toEqual([[RELAY.apiBase, 'telegram.earthquake'], [KEY.apiBase, 'eew.forecast']])
    // 日を丸ごと失ったのではない印（地震 1 つ分）はそのまま残す
    expect(got.failedArchiveUrls).toEqual(['eew:A'])
  })

  it('安全弁: 中継の警報もその日を読めなければ埋めず、鍵の読めなかった印を残す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial()
      return cls.includes('eew.warning')
        ? relayWarning({ entries: [eewEntry('wA', 'A', DAY30 + 1000)], failedArchiveUrls: ['r31'], lostSourceDays: new Map([['r31', '2026-10-31']]) })
        : relayQuake()
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(ids(got)).toEqual(['q1', 'fA'])
    expect(got.failedArchiveUrls).toEqual(['k31'])
  })

  // 鍵が 10-31 を、中継の警報が 10-30 を読めず、地震 C が両日にまたがる。C を警報から採ると、
  // 10-30 の C の報がどちらからも入らない（警報は 10-30 を読めず、鍵の報は外される）
  it('正: 中継の警報が読めなかった日にも報がある地震は鍵の報を残し、その地震で埋めきれない日の印を残す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial({ entries: [eewEntry('fC', 'C', DAY30)] })
      if (!cls.includes('eew.warning')) return relayQuake()
      return result([eewEntry('wC2', 'C', DAY31), eewEntry('wB', 'B', DAY31 + 1000)], {
        failedArchiveUrls: ['r30'], lostSourceDays: new Map([['r30', '2026-10-30']]),
      })
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    // C は鍵の報だけ（警報の wC2 は使わない）。10-31 にしか報の無い B は警報から採る（安全弁: 巻き添えにしない）
    expect(ids(got)).toEqual(['q1', 'fC', 'wB'])
    // 10-31 は C の分を埋めきれていないので、鍵の読めなかった印を残す
    expect(got.failedArchiveUrls).toEqual(['k31'])
    expect([...got.lostSourceDays]).toEqual([['k31', '2026-10-31']])
  })

  it('対照: 地震の報がある日をすべて中継の警報で読めていれば、警報から採って印を外す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial({ entries: [eewEntry('fC', 'C', DAY30)] })
      if (!cls.includes('eew.warning')) return relayQuake()
      // 中継の警報が読めなかったのは、C の報が無い別の日
      return result([eewEntry('wC1', 'C', DAY30 + 1000), eewEntry('wC2', 'C', DAY31)], {
        failedArchiveUrls: ['r29'], lostSourceDays: new Map([['r29', '2026-10-29']]),
      })
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(ids(got)).toEqual(['q1', 'wC1', 'wC2'])
    expect(got.failedArchiveUrls).toEqual([])
    expect(got.lostSourceDays.size).toBe(0)
  })

  it('安全弁: 中継の警報が引けなければ、鍵の読めた分と読めなかった印を返す', async () => {
    const { fetchFrom } = fakeFetch(async (endpoint, cls) => {
      if (endpoint === KEY) return keyPartial()
      if (cls.includes('eew.warning')) throw new Error('取得できない')
      return relayQuake()
    })
    const got = await fetchReplayFromSources(fetchFrom, RELAY, KEY, SOURCES)
    expect(ids(got)).toEqual(['q1', 'fA'])
    expect(got.failedArchiveUrls).toEqual(['k31'])
  })
})

function eew(eventId: string): EEWAlert {
  return { id: `e-${eventId}`, issue: { eventId } } as EEWAlert
}

function origins(ids: string[], complete: boolean, canceledIds: string[] = []): DmdataEewOriginsResult {
  return { finals: ids.map(eew), canceledIds, complete }
}

describe('fetchEewOriginsFromSources', () => {
  it('鍵から引かないなら、中継の区分で 1 回だけ引く', async () => {
    const calls: string[] = []
    const got = await fetchEewOriginsFromSources(async (e, cls) => {
      calls.push(`${e.apiBase} ${cls.join(',')}`)
      return origins(['A'], true)
    }, RELAY, KEY, { relay: ['telegram.earthquake', 'eew.warning'], keyForecast: false }, createRelayWarningMemo())
    expect(calls).toEqual([`${RELAY.apiBase} telegram.earthquake,eew.warning`])
    expect(got.finals.map(e => e.issue?.eventId)).toEqual(['A'])
  })

  // 予報は警報報も兼ねる（VXSE45 は警報の報も含む）ので、鍵で取りきれたら中継の警報は要らない
  it('鍵の予報で取りきれたら、中継の警報は引かない', async () => {
    const calls: string[] = []
    const got = await fetchEewOriginsFromSources(async (e, cls) => {
      calls.push(`${e.apiBase} ${cls.join(',')}`)
      return origins(['A', 'B'], true)
    }, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(calls).toEqual([`${KEY.apiBase} eew.forecast`])
    expect(got.finals.map(e => e.issue?.eventId)).toEqual(['A', 'B'])
    expect(got.complete).toBe(true)
  })

  // 鍵で取りきれなかったら中継の警報で埋める。同じ地震は鍵の予報（報番号の大きい最終報）を採る。
  // 取り直しで鍵の分を取りきれるよう、取りきれていない印は残す
  it('鍵で取りきれなかったら中継の警報で足りない地震を埋め、取りきれていない印は残す', async () => {
    const got = await fetchEewOriginsFromSources(async (e) => (e === KEY
      ? origins(['A'], false, ['X'])
      : origins(['A', 'B'], true, ['Y'])), RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got.finals.map(e => e.id)).toEqual(['e-A', 'e-B'])
    expect(got.canceledIds).toEqual(['X', 'Y'])
    expect(got.complete).toBe(false)
  })

  // 鍵の最終報が途中の報で止まっていたら、中継の警報の新しい報を採る
  it('正: 同じ地震は発表時刻の新しいほうを採る（中継の警報が新しければそちら）', async () => {
    const got = await fetchEewOriginsFromSources(async (e) => (e === KEY
      ? { finals: [issuedEew('k', 'A', '10', '11:00:10'), issuedEew('k', 'B', '9', '11:00:40')], canceledIds: [], complete: false }
      : { finals: [issuedEew('r', 'A', '5', '11:00:30'), issuedEew('r', 'B', '7', '11:00:20')], canceledIds: [], complete: true }),
    RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got.finals.map(e => e.id).sort()).toEqual(['k-B', 'r-A'])
  })

  // 予報と警報は報番号の系列が別（警報の第 3 報が予報の第 30 報にあたる）。報番号の大小で選ぶと古い報を採る
  it('正: 報番号では比べない（予報の第 30 報より後に出た警報の第 3 報を採る）', async () => {
    const got = await fetchEewOriginsFromSources(async (e) => (e === KEY
      ? { finals: [issuedEew('k', 'A', '30', '11:00:50')], canceledIds: [], complete: false }
      : { finals: [issuedEew('r', 'A', '3', '11:01:05')], canceledIds: [], complete: true }),
    RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got.finals.map(e => e.id)).toEqual(['r-A'])
  })

  it('対照: 発表時刻が同じ・読めないなら鍵の予報を採る', async () => {
    const got = await fetchEewOriginsFromSources(async (e) => (e === KEY
      ? { finals: [issuedEew('k', 'A', '5', '11:00:30'), issuedEew('k', 'B', '5', '')], canceledIds: [], complete: false }
      : { finals: [issuedEew('r', 'A', '9', '11:00:30'), issuedEew('r', 'B', '9', '11:00:30')], canceledIds: [], complete: true }),
    RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got.finals.map(e => e.id)).toEqual(['k-A', 'k-B'])
  })

  it('安全弁: 地震 ID の無い報どうしは同じ地震として潰さない', async () => {
    const noId = (id: string) => ({ id, issue: { serial: '1' } }) as EEWAlert
    const got = await fetchEewOriginsFromSources(async (e) => (e === KEY
      ? { finals: [noId('k-1')], canceledIds: [], complete: false }
      : { finals: [noId('r-1')], canceledIds: [], complete: true }),
    RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got.finals.map(e => e.id)).toEqual(['k-1', 'r-1'])
  })

  // 取り直しで引き直すのは鍵の分だけ。中継の警報は取りきれていれば使い回す
  it('正: 同じ控えで取り直したら、取りきれた中継の警報は引き直さない', async () => {
    const calls: string[] = []
    const fetchFrom = async (e: DmdataEndpoint, cls: readonly DmdataClassification[]) => {
      calls.push(`${e.apiBase} ${cls.join(',')}`)
      return e === KEY ? origins(['A'], false) : origins(['B'], true)
    }
    const memo = createRelayWarningMemo()
    const src = { relay: ['telegram.earthquake'] as DmdataClassification[], keyForecast: true }
    await fetchEewOriginsFromSources(fetchFrom, RELAY, KEY, src, memo)
    const second = await fetchEewOriginsFromSources(fetchFrom, RELAY, KEY, src, memo)
    expect(calls).toEqual([`${KEY.apiBase} eew.forecast`, `${RELAY.apiBase} eew.warning`, `${KEY.apiBase} eew.forecast`])
    expect(second.finals.map(e => e.id)).toEqual(['e-A', 'e-B'])
  })

  it('対照: 中継の警報が取りきれていなければ、取り直しで引き直す', async () => {
    const calls: string[] = []
    const fetchFrom = async (e: DmdataEndpoint, cls: readonly DmdataClassification[]) => {
      calls.push(`${e.apiBase} ${cls.join(',')}`)
      return origins([], false)
    }
    const memo = createRelayWarningMemo()
    const src = { relay: ['telegram.earthquake'] as DmdataClassification[], keyForecast: true }
    await fetchEewOriginsFromSources(fetchFrom, RELAY, KEY, src, memo)
    await fetchEewOriginsFromSources(fetchFrom, RELAY, KEY, src, memo)
    expect(calls.filter(c => c.startsWith(RELAY.apiBase))).toHaveLength(2)
  })

  // 投げた側を空として扱う（以前は投げたまま返し、取れた鍵の分まで捨てて取り直しも走らなかった）
  it('安全弁: 中継の警報が投げても鍵の分は返し、控えに残さず取り直しで引き直す', async () => {
    let relayCalls = 0
    const fetchFrom = async (e: DmdataEndpoint) => {
      if (e === KEY) return origins(['A'], false)
      relayCalls++
      if (relayCalls === 1) throw new Error('取得できない')
      return origins(['B'], true)
    }
    const memo = createRelayWarningMemo()
    const src = { relay: ['telegram.earthquake'] as DmdataClassification[], keyForecast: true }
    const first = await fetchEewOriginsFromSources(fetchFrom, RELAY, KEY, src, memo)
    expect(first.finals.map(e => e.id)).toEqual(['e-A'])
    expect(first.complete).toBe(false)
    expect(memo.result).toBeNull()
    const second = await fetchEewOriginsFromSources(fetchFrom, RELAY, KEY, src, memo)
    expect(relayCalls).toBe(2)
    expect(second.finals.map(e => e.id)).toEqual(['e-A', 'e-B'])
  })

  it('正: 鍵が投げても中継の警報の分は返し、取りきれていない印を立てる', async () => {
    const got = await fetchEewOriginsFromSources(async (e) => {
      if (e === KEY) throw new Error('鍵で取得できない')
      return origins(['B'], true, ['Y'])
    }, RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got.finals.map(e => e.id)).toEqual(['e-B'])
    expect(got.canceledIds).toEqual(['Y'])
    // 中継の警報が取りきれていても、鍵の分を取り直すために印は立てたまま
    expect(got.complete).toBe(false)
  })

  it('対照: 両方が投げたら空で返し、取りきれていない印を立てる', async () => {
    const got = await fetchEewOriginsFromSources(async () => { throw new Error('取得できない') },
      RELAY, KEY, { relay: ['telegram.earthquake'], keyForecast: true }, createRelayWarningMemo())
    expect(got).toEqual({ finals: [], canceledIds: [], complete: false })
  })

  it('安全弁: 止められた取得は空として扱わず投げ直す（鍵・中継の警報のどちらでも）', async () => {
    const src = { relay: ['telegram.earthquake'] as DmdataClassification[], keyForecast: true }
    const aborted = () => new DOMException('取得を止めました', 'AbortError')
    await expect(fetchEewOriginsFromSources(async (e) => {
      if (e === KEY) throw aborted()
      return origins(['B'], true)
    }, RELAY, KEY, src, createRelayWarningMemo())).rejects.toMatchObject({ name: 'AbortError' })
    await expect(fetchEewOriginsFromSources(async (e) => {
      if (e === KEY) return origins(['A'], false)
      throw aborted()
    }, RELAY, KEY, src, createRelayWarningMemo())).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/** 発表時刻（日本時間の時:分:秒。空なら読めない時刻）と報番号を持つ最終報 */
function issuedEew(prefix: string, eventId: string, serial: string, hms: string): EEWAlert {
  const time = hms === '' ? '' : `2026-10-31T${hms}+09:00`
  return { id: `${prefix}-${eventId}`, time, issue: { eventId, serial, time } } as EEWAlert
}
