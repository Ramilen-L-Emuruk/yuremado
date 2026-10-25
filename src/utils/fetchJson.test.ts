import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchJsonWithTimeout, DATA_FETCH_TIMEOUT_MS, NO_RETRY } from './fetchJson'
import { retryDelayAfter } from './retrySchedule'

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

/**
 * signal が abort されるまで解決しない fetch。
 * 「接続は張れたが応答が返らない」状態（TCP は繋がっているのにヘッダが来ない）の再現。
 */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      }),
  )
}

/**
 * ヘッダは返すが body が流れてこない fetch。
 * res.json() 側で止まるケースの再現（fetch() の解決だけでは検知できない）。
 */
function headerOnlyFetch() {
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    return {
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    } as unknown as Response
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchJsonWithTimeout', () => {
  it('取得に成功すると JSON を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))

    expect(await fetchJsonWithTimeout('/data/x.json', 'x')).toEqual({ ok: 1 })
  })

  it('HTTP エラーはステータス付きの例外にする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))

    await expect(fetchJsonWithTimeout('/data/x.json', 'x', { retryDelay: NO_RETRY })).rejects.toThrow('x を取得できなかった: 404')
  })

  it('応答が返らないときはタイムアウトで失敗する（永久に pending にしない）', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000, retryDelay: NO_RETRY })).rejects.toThrow(
      'x の取得が 5000ms で時間切れになった',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('ヘッダだけ返って body が来ないときもタイムアウトで失敗する', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', headerOnlyFetch())

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000, retryDelay: NO_RETRY })).rejects.toThrow(
      'x の取得が 5000ms で時間切れになった',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('タイムアウト前に届いた応答は切らない', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string) =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(okResponse({ ok: 1 })), 4000)
          }),
      ),
    )

    const p = fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(4000)

    expect(await p).toEqual({ ok: 1 })
  })

  it('成功しても失敗してもタイムアウト用タイマーを片付ける（後から誤発火させない）', async () => {
    vi.useFakeTimers()

    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    await fetchJsonWithTimeout('/data/x.json', 'x')
    expect(vi.getTimerCount()).toBe(0)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    await expect(fetchJsonWithTimeout('/data/x.json', 'x', { retryDelay: NO_RETRY })).rejects.toThrow(/500/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('時間切れの直後に届いた別種の例外はタイムアウトに化けさせない（本当の原因を残す）', async () => {
    vi.useFakeTimers()
    // 配信データが壊れていて、abort が届いた時点で JSON のパースが失敗するケース
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new SyntaxError('Unexpected token < in JSON at position 0'))
              })
            }),
        } as unknown as Response
      }),
    )

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000, retryDelay: NO_RETRY })).rejects.toThrow(
      'Unexpected token <',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('通信エラーはタイムアウトに化けさせず、そのまま伝える', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    await expect(fetchJsonWithTimeout('/data/x.json', 'x', { retryDelay: NO_RETRY })).rejects.toThrow('network down')
  })

  it('既定のタイムアウトは 60 秒', () => {
    expect(DATA_FETCH_TIMEOUT_MS).toBe(60_000)
  })
})

// resetModules ＋動的 import の再評価コストで既定タイムアウトを割ることがある（理由は prefectures.test.ts）。
describe('取得状況の集約', { timeout: 15_000 }, () => {
  // 取得状況はモジュールスコープに溜まるため、テストごとに読み直して独立させる
  async function freshModule() {
    vi.resetModules()
    return await import('./fetchJson')
  }

  /** 呼び出し側から解決・棄却を制御できる fetch。 */
  function controllableFetch() {
    let settle!: (value: Response | PromiseLike<Response>) => void
    let fail!: (reason: unknown) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve, reject) => {
          settle = resolve
          fail = reject
        }),
    )
    return { fetchMock, resolve: (r: Response) => settle(r), reject: (e: unknown) => fail(e) }
  }

  it('取得中は pending に数え、完了したら戻す', async () => {
    const { fetchMock, resolve } = controllableFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const p = fetchJsonWithTimeout('/data/x.json', 'x')
    expect(getDataLoadStatus()).toMatchObject({ pending: 1, failed: 0 })

    resolve(okResponse({ ok: 1 }))
    await p

    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 0 })
  })

  // validate をこの関数の中で呼ぶ理由がここにある。呼び出し側の .then() で検証すると、
  // 既に「成功」として数え終わった後なので、地図の「〇〇を取り込めず」に出ない。
  it('validate が投げたら通信失敗と同じく failed に数える', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})))
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    await expect(
      fetchJsonWithTimeout('/data/x.json', 'x', {
        retryDelay: NO_RETRY,
        validate: (data) => {
          if (!data || Object.keys(data).length === 0) throw new Error('x fetch returned no data')
        },
      }),
    ).rejects.toThrow(/no data/)
    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 1 })
  })

  it('validate が通れば失敗には数えず、前回の失敗の記録も消す', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce(okResponse({ a: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()
    const validate = (data: unknown) => {
      if (!data || Object.keys(data).length === 0) throw new Error('x fetch returned no data')
    }

    await expect(fetchJsonWithTimeout('/data/x.json', 'x', { validate, retryDelay: NO_RETRY })).rejects.toThrow()
    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 1 })

    expect(await fetchJsonWithTimeout('/data/x.json', 'x', { validate })).toEqual({ a: 1 })
    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('失敗を failed に数え、取り直しに成功したら消す', async () => {
    const { fetchMock, reject } = controllableFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const failing = fetchJsonWithTimeout('/data/x.json', 'x', { retryDelay: NO_RETRY })
    reject(new Error('network down'))
    await expect(failing).rejects.toThrow('network down')
    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 1 })

    // 同じ label を取り直して成功させる（フォールバックからの復帰）
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    await fetchJsonWithTimeout('/data/x.json', 'x')

    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('状態が変わったときだけ購読者に通知する', async () => {
    const { fetchMock, resolve } = controllableFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, subscribeDataLoadStatus } = await freshModule()

    let notified = 0
    const unsubscribe = subscribeDataLoadStatus(() => { notified += 1 })

    const p = fetchJsonWithTimeout('/data/x.json', 'x')
    expect(notified).toBe(1)  // pending 0 → 1

    resolve(okResponse({ ok: 1 }))
    await p
    expect(notified).toBe(2)  // pending 1 → 0

    unsubscribe()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    await fetchJsonWithTimeout('/data/y.json', 'y')
    expect(notified).toBe(2)  // 解除後は届かない
  })

  it('同じ label の取得が重なったら本数で数える（1 本終わっただけで解除しない）', async () => {
    // 実地震テストシナリオの連続再生のように、同じ label で複数の取得が並行しうる
    const settlers: Array<(r: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { settlers.push(resolve) })),
    )
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const first = fetchJsonWithTimeout('/data/a.json', 'scenario')
    const second = fetchJsonWithTimeout('/data/b.json', 'scenario')
    expect(getDataLoadStatus()).toMatchObject({ pending: 1, failed: 0 })

    settlers[0](okResponse({ ok: 1 }))
    await first
    expect(getDataLoadStatus()).toMatchObject({ pending: 1, failed: 0 })  // 2 本目が残っている

    settlers[1](okResponse({ ok: 2 }))
    await second
    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('trackStatus: false のデータは数えない（地図と無関係な失敗を地図上に出さない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    await expect(
      fetchJsonWithTimeout('/data/x.json', 'tts-phrase-break-dict', { trackStatus: false }),
    ).rejects.toThrow(/404/)

    expect(getDataLoadStatus()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('状態が同じ間は同じ参照を返す（useSyncExternalStore の再レンダリング要件）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const before = getDataLoadStatus()
    expect(getDataLoadStatus()).toBe(before)

    await fetchJsonWithTimeout('/data/x.json', 'x')

    // pending が 0 → 1 → 0 と戻るので、値としては初期状態と等しい
    expect(getDataLoadStatus()).toEqual(before)
  })
})

describe('取り直し', { timeout: 15_000 }, () => {
  async function freshModule() {
    vi.resetModules()
    return await import('./fetchJson')
  }

  // 本番の既定: 数えるデータだけ共有の規則で取り直す（テスト実行中は取り直さない理由は defaultRetryDelay）
  it('既定では数えるデータだけ取り直す', async () => {
    const { defaultRetryDelay } = await freshModule()
    // 読み直したモジュールでは関数の同一性が変わるので、値で比べる（30 秒から・6 回目で諦める）
    expect(defaultRetryDelay(true, 'production')(1)).toBe(30_000)
    expect(defaultRetryDelay(true, 'production')(6)).toBeNull()
    expect(defaultRetryDelay(true, 'development')(1)).toBe(30_000)
    expect(defaultRetryDelay(false, 'production')(1)).toBeNull()
    expect(defaultRetryDelay(true, 'test')(1)).toBeNull()
  })

  // 正: 地図のデータ（取得状況に数えるもの）は、失敗しても間隔を空けて取り直し、取れたら同じ Promise で返す
  it('数えるデータは 30 秒あけて取り直し、取れたら返して失敗の記録を消す', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse({ ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const p = fetchJsonWithTimeout('/data/x.json', 'prefectures', { retryDelay: retryDelayAfter })
    await vi.advanceTimersByTimeAsync(0)
    expect(getDataLoadStatus().failures).toEqual([{ label: 'prefectures', state: 'retrying' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getDataLoadStatus().failures).toEqual([])
  })

  // 安全弁: 取り直しには上限がある（5 回で諦め、最後の失敗を投げる）
  it('5 回取り直しても取れなければ諦めて投げ、「諦めた」と記録する', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'active-faults', { retryDelay: retryDelayAfter })).rejects.toThrow('network down')
    // 30 秒 → 1 分 → 2 分 → 4 分 → 5 分
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 240_000 + 300_000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(getDataLoadStatus().failures).toEqual([{ label: 'active-faults', state: 'gaveUp' }])
  })

  // 対照: 数えないデータ（呼び手が自分の取り直しを持つ）はここで取り直さない（二重にしない）
  it('数えないデータは取り直さずにすぐ投げる', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout } = await freshModule()

    await expect(fetchJsonWithTimeout('/data/x.json', 'hypocenter-index', { trackStatus: false })).rejects.toThrow('network down')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
