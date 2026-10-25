import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CDX_LIMIT,
  MAX_CONSECUTIVE_UNAVAILABLE,
  MAX_RETRIES,
  PoliteFetcher,
  REQUEST_INTERVAL_MS,
  RETRY_WAIT_MS,
  USER_AGENT,
  WaybackUnavailableError,
  isInWindow,
  pageMatchesEventId,
  pageUrl,
  parseCdxListing,
} from './waybackFcHist'

const HEADER = ['original', 'timestamp', 'statuscode']

describe('parseCdxListing', () => {
  it('正: index.html だけを EventID ごとに 1 件ずつ取り出す（:80 付きと無しの重複は先に出たほう）', () => {
    const rows = [
      HEADER,
      ['http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416012510/index.html', '20160422053408', '200'],
      ['http://www.data.jma.go.jp/svd/eew/data/nc/fc_hist/2016/04/20160416012510/index.html', '20170101000000', '200'],
      ['http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416012510/img/reachtime.png', '20160422053409', '200'],
      ['http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416000000/index.html', '20160422050000', '200'],
    ]
    expect(parseCdxListing('20160416', rows)).toEqual([
      { eventId: '20160416000000', timestamp: '20160422050000', original: 'http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416000000/index.html' },
      { eventId: '20160416012510', timestamp: '20160422053408', original: 'http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416012510/index.html' },
    ])
  })

  it('対照: 空の応答は 0 件（控えが無いのとは別。控えるかどうかは取得側が決める）', () => {
    expect(parseCdxListing('20160418', [])).toEqual([])
  })

  it('安全弁: 上限（limit）ちょうどまで返ってきた目録は、取りこぼしを疑って止める', () => {
    const row = (i: number) => [`http://www.data.jma.go.jp/svd/eew/data/nc/fc_hist/2016/04/2016041600${String(i).padStart(4, '0')}/index.html`, '20160422050000', '200']
    const full = [HEADER, ...Array.from({ length: CDX_LIMIT }, (_, i) => row(i))]
    expect(() => parseCdxListing('20160416', full)).toThrow(/上限/)
    expect(parseCdxListing('20160416', [HEADER, ...Array.from({ length: CDX_LIMIT - 1 }, (_, i) => row(i))])).toHaveLength(CDX_LIMIT - 1)
  })

  it('安全弁: 行があるのに個別ページを 1 件も拾えない目録は止める（画像だけの応答など）', () => {
    const rows = [HEADER, ['http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416012510/img/reachtime.png', '20160422053409', '200']]
    expect(() => parseCdxListing('20160416', rows)).toThrow(/1 件も拾えません/)
  })

  it('安全弁: 見出しが違う・別の日の EventID が混ざる応答は例外', () => {
    expect(() => parseCdxListing('20160416', [['url', 'ts', 'status']])).toThrow()
    expect(() =>
      parseCdxListing('20160416', [HEADER, ['http://www.data.jma.go.jp/svd/eew/data/nc/fc_hist/2016/04/20160417000000/index.html', '20160422050000', '200']]),
    ).toThrow(/別の日/)
  })
})

describe('pageUrl', () => {
  it('Wayback の書き換えを外した原本（id_）を、控えられた元の URL のまま取る', () => {
    expect(pageUrl({ eventId: '20160416012510', timestamp: '20160422053408', original: 'http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416012510/index.html' })).toBe(
      'https://web.archive.org/web/20160422053408id_/http://www.data.jma.go.jp:80/svd/eew/data/nc/fc_hist/2016/04/20160416012510/index.html',
    )
  })
})

describe('isInWindow', () => {
  const start = new Date('2016-04-14T12:00:00+09:00')
  const end = new Date('2016-04-20T00:00:00+09:00')
  it('正: 始まりは含む', () => expect(isInWindow('20160414120000', start, end)).toBe(true))
  it('対照: 始まりの前は含まない', () => expect(isInWindow('20160414115959', start, end)).toBe(false))
  it('安全弁: 終わりは含まない（半開区間）', () => expect(isInWindow('20160420000000', start, end)).toBe(false))
})

/** 応答を順に返す偽の fetch と、待ち時間を記録するだけの待ち。 */
function harness(statuses: number[], maxRequests = 100, maxRetries = MAX_RETRIES) {
  const calls: { url: string; ua: string | null }[] = []
  const waits: number[] = []
  const queue = [...statuses]
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ua: new Headers(init?.headers).get('user-agent') })
    const status = queue.shift() ?? 200
    return new Response(status === 200 ? 'ok' : 'error', { status })
  }) as unknown as typeof fetch
  const fetcher = new PoliteFetcher({ maxRetries, maxRequests }, fakeFetch, async (ms) => {
    waits.push(ms)
  })
  return { fetcher, calls, waits }
}

describe('PoliteFetcher', () => {
  it('正: 名乗って取り、2 件目の前は間隔をあける', async () => {
    const { fetcher, calls, waits } = harness([200, 200])
    await fetcher.get('https://example.test/a', () => true)
    await fetcher.get('https://example.test/b', () => true)
    expect(calls.map((c) => c.ua)).toEqual([USER_AGENT, USER_AGENT])
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(REQUEST_INTERVAL_MS - 1000)
    expect(fetcher.requestCount).toBe(2)
  })

  it('正: 失敗したら 30 秒あけて取り直す（最大 2 回）。それでも取れなければ例外', async () => {
    const { fetcher, calls, waits } = harness([500, 500, 500, 200])
    await expect(fetcher.get('https://example.test/a', () => true)).rejects.toThrow(/HTTP 500/)
    expect(calls).toHaveLength(1 + MAX_RETRIES)
    expect(waits.filter((w) => w === RETRY_WAIT_MS)).toHaveLength(MAX_RETRIES)
  })

  it('対照: 形の合わない 200 も取り直しに数える', async () => {
    const { fetcher, calls } = harness([200, 200])
    let n = 0
    await fetcher.get('https://example.test/a', () => ++n === 2)
    expect(calls).toHaveLength(2)
  })

  it('正: 異なる URL が続けて 5xx を返したら、5 つ目で全体を止める例外を投げる（HTTP 500 も数える）', async () => {
    const before = MAX_CONSECUTIVE_UNAVAILABLE - 1
    const { fetcher } = harness(Array(before * (1 + MAX_RETRIES) + 1).fill(500))
    for (let i = 0; i < before; i++) {
      const err = await fetcher.get(`https://example.test/${i}`, () => true).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(WaybackUnavailableError)
    }
    await expect(fetcher.get('https://example.test/last', () => true)).rejects.toBeInstanceOf(WaybackUnavailableError)
    // 4 ページ × 3 回（取り直し 2 回）と、5 ページ目の 1 回目で止まる
    expect(fetcher.requestCount).toBe(before * (1 + MAX_RETRIES) + 1)
  })

  it('対照: 1 ページの取り直しで続いた 5xx は数えない（そのページは失敗として返り、次へ進める）', async () => {
    const { fetcher } = harness(Array(12).fill(500), 100, 5)
    // 同じ URL が 6 回続けて 500 を返しても、全体は止めずに「取れなかった」で返る
    const err = await fetcher.get('https://example.test/a', () => true).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(WaybackUnavailableError)
    expect((err as Error).message).toMatch(/HTTP 500/)
    expect(fetcher.requestCount).toBe(6)
  })

  it('安全弁: 5xx の間に 5xx 以外が挟まれば数え直す（続いたときだけ止める）', async () => {
    const { fetcher } = harness([...Array(12).fill(500), 200, 500, 500, 500])
    for (const u of ['a', 'b', 'c', 'd']) {
      await expect(fetcher.get(`https://example.test/${u}`, () => true)).rejects.toThrow(/HTTP 500/)
    }
    await expect(fetcher.get('https://example.test/ok', () => true)).resolves.toBe('ok')
    // 数え直したので、次の 5xx のページは止めずに失敗として返る
    const err = await fetcher.get('https://example.test/f', () => true).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(WaybackUnavailableError)
  })

  it('安全弁: 取り直しを含めた総リクエスト数が上限に達したら、次の 1 件は送らずに止める', async () => {
    const { fetcher, calls } = harness([500, 500, 500, 500], 2)
    await expect(fetcher.get('https://example.test/a', () => true)).rejects.toBeInstanceOf(WaybackUnavailableError)
    expect(calls).toHaveLength(2)
  })

  it('正: 30 秒で打ち切る合図（signal）を渡し、時間切れは失敗として取り直しへ回す', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    let n = 0
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal)
      if (n++ === 0) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const fetcher = new PoliteFetcher({ maxRetries: 1, maxRequests: 10 }, fakeFetch, async () => {})
    await expect(fetcher.get('https://example.test/a', () => true)).resolves.toBe('ok')
    expect(signals).toHaveLength(2)
    expect(signals.every((sig) => sig instanceof AbortSignal)).toBe(true)
  })
})

describe('pageMatchesEventId', () => {
  const sample = readFileSync(join(__dirname, 'fc-hist-20160416012510.fixture.html'), 'utf-8')
  it('正: 発生時刻（01:25）が EventID（01:25:10）と合うページは控えてよい', () => {
    expect(pageMatchesEventId(sample, '20160416012510')).toBe(true)
  })
  it('安全弁: 別の地震の EventID とは合わない（控えない）', () => {
    expect(pageMatchesEventId(sample, '20160416014412')).toBe(false)
  })
})
