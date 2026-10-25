import { describe, it, expect, vi, afterEach } from 'vitest'
import { deliverBrowserNotification, showBrowserNotification, SW_REGISTRATION_TIMEOUT_MS, SW_SHOW_TIMEOUT_MS } from './notifications'
import { log } from './logger'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubNotification(ctor: (title: string, opts: NotificationOptions) => void) {
  const Fake = function (this: unknown, title: string, opts: NotificationOptions) { ctor(title, opts) } as unknown as typeof Notification
  Object.defineProperty(Fake, 'permission', { value: 'granted' })
  vi.stubGlobal('Notification', Fake)
}

/** Service Worker を持つ navigator に差し替える。`registration` は `getRegistration()` が返すもの。 */
function stubServiceWorker(registration: Partial<ServiceWorkerRegistration> | undefined) {
  // スコープはこのページのもの（テストでは `import.meta.env.BASE_URL` が '/'）
  const withScope = registration && { scope: 'http://localhost/', ...registration }
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: () => Promise.resolve(withScope) },
  })
}

/** 投げられた非同期の後始末（catch の記録など）を流し切る。 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('showBrowserNotification', () => {
  it('正: 許可があれば tag と閉じるまで残すかを渡して出す', () => {
    const calls: { title: string; opts: NotificationOptions }[] = []
    stubNotification((title, opts) => calls.push({ title, opts }))
    showBrowserNotification('津波警報', '岩手県', 'tsunami', true)
    // Service Worker に非対応の環境では同期のまま出す
    expect(calls).toHaveLength(1)
    expect(calls[0].opts).toMatchObject({ body: '岩手県', tag: 'tsunami', requireInteraction: true })
  })

  // Android の Chrome 系は Service Worker の無いときに `new Notification()` で TypeError を投げる。
  // 呼び出し側は後に読み上げと記憶の後始末を続けるので、ここで止めないとそれらが丸ごと飛ぶ
  it('安全弁: 通知を作れない環境でも例外を外へ出さず、記録を残す', async () => {
    stubNotification(() => { throw new TypeError('Illegal constructor') })
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    expect(() => showBrowserNotification('津波警報等の解除', '本文', 'tsunami')).not.toThrow()
    await flush()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('対照: 許可が無ければ何もしない', async () => {
    const calls: string[] = []
    const Fake = function (this: unknown, title: string) { calls.push(title) } as unknown as typeof Notification
    Object.defineProperty(Fake, 'permission', { value: 'default' })
    vi.stubGlobal('Notification', Fake)
    const show = vi.fn(() => Promise.resolve())
    stubServiceWorker({ active: {} as ServiceWorker, showNotification: show })
    showBrowserNotification('津波警報', '岩手県', 'tsunami')
    await flush()
    expect(calls).toHaveLength(0)
    expect(show).not.toHaveBeenCalled()
  })
})

describe('deliverBrowserNotification', () => {
  it('正: 動いている Service Worker があればそこから出し、ページからは出さない', async () => {
    const pageCalls: string[] = []
    stubNotification(title => pageCalls.push(title))
    const show = vi.fn((_title: string, _opts?: NotificationOptions) => Promise.resolve())
    stubServiceWorker({ active: {} as ServiceWorker, showNotification: show })
    await deliverBrowserNotification('緊急地震速報 警報', { body: '石川県能登地方', tag: 'eew-1', requireInteraction: true })
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0][0]).toBe('緊急地震速報 警報')
    expect(show.mock.calls[0][1]).toMatchObject({ body: '石川県能登地方', tag: 'eew-1', requireInteraction: true })
    expect(pageCalls).toHaveLength(0)
  })

  // dev サーバーは Service Worker を登録しない。`ready` を待つ作りだとここで永遠に止まる
  it('対照: 登録が無ければページから出す', async () => {
    const pageCalls: string[] = []
    stubNotification(title => pageCalls.push(title))
    stubServiceWorker(undefined)
    await deliverBrowserNotification('地震情報', { tag: 'q' })
    expect(pageCalls).toEqual(['地震情報'])
  })

  // 初回訪問で Service Worker がまだ入りきっていない（active が無い）
  it('対照: 登録はあっても動いていなければページから出す', async () => {
    const pageCalls: string[] = []
    stubNotification(title => pageCalls.push(title))
    const show = vi.fn(() => Promise.resolve())
    stubServiceWorker({ active: null, showNotification: show })
    await deliverBrowserNotification('地震情報', { tag: 'q' })
    expect(show).not.toHaveBeenCalled()
    expect(pageCalls).toEqual(['地震情報'])
  })

  it('安全弁: Service Worker が出せなければ、記録を残してページから出し直す', async () => {
    const pageCalls: string[] = []
    stubNotification(title => pageCalls.push(title))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    stubServiceWorker({ active: {} as ServiceWorker, showNotification: () => Promise.reject(new TypeError('no permission')) })
    await deliverBrowserNotification('地震情報', { tag: 'q' })
    expect(pageCalls).toEqual(['地震情報'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('安全弁: どちらからも出せなければ reject する（呼び出し側が「出せなかった」と扱えるように）', async () => {
    stubNotification(() => { throw new TypeError('Illegal constructor') })
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    stubServiceWorker({ active: {} as ServiceWorker, showNotification: () => Promise.reject(new TypeError('x')) })
    await expect(deliverBrowserNotification('地震情報', { tag: 'q' })).rejects.toThrow('Illegal constructor')
  })

  it('正: renotify を受け付けなければ外して出し直す（Service Worker 経由）', async () => {
    const opts: (NotificationOptions & { renotify?: boolean })[] = []
    const show = vi.fn((_title: string, o?: NotificationOptions & { renotify?: boolean }) => {
      opts.push(o ?? {})
      return o?.renotify ? Promise.reject(new TypeError('renotify')) : Promise.resolve()
    })
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    stubServiceWorker({ active: {} as ServiceWorker, showNotification: show })
    await deliverBrowserNotification('地震情報', { tag: 'q', renotify: true })
    expect(opts).toHaveLength(2)
    expect(opts[0].renotify).toBe(true)
    expect('renotify' in opts[1]).toBe(false)
  })

  // 同じオリジンに standard 版（/yuremado/）と DMDSS 版（/yuremado/dmdss/）が同居する。DMDSS 版の登録が
  // まだ無いと standard 版の登録が返るが、それで出すと同じ tag の通知が登録をまたいで置き換わらない
  it('対照: 別のスコープの登録は使わず、ページから出す', async () => {
    const pageCalls: string[] = []
    stubNotification(title => pageCalls.push(title))
    vi.spyOn(log, 'debug').mockImplementation(() => {})
    const show = vi.fn(() => Promise.resolve())
    stubServiceWorker({ scope: 'http://localhost/other/', active: {} as ServiceWorker, showNotification: show })
    await deliverBrowserNotification('地震情報', { tag: 'q' })
    expect(show).not.toHaveBeenCalled()
    expect(pageCalls).toEqual(['地震情報'])
  })

  it('安全弁: 登録を引けなければ、記録を残してページから出す', async () => {
    const pageCalls: string[] = []
    stubNotification(title => pageCalls.push(title))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => Promise.reject(new Error('SecurityError')) } })
    await deliverBrowserNotification('地震情報', { tag: 'q' })
    expect(pageCalls).toEqual(['地震情報'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // 返事が来ないまま待ち続けると、通知が出ないうえ記録も残らない
  it('安全弁: 登録の返事が来なければ、上限で諦めてページから出す', async () => {
    vi.useFakeTimers()
    try {
      const pageCalls: string[] = []
      stubNotification(title => pageCalls.push(title))
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => new Promise(() => {}) } })
      const done = deliverBrowserNotification('地震情報', { tag: 'q' })
      await vi.advanceTimersByTimeAsync(SW_REGISTRATION_TIMEOUT_MS - 1)
      expect(pageCalls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(pageCalls).toEqual(['地震情報'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // 地震の通知は同じ地震ごとに列へ並ぶので、ここで返らないとその地震の以後の通知が止まる
  it('安全弁: Service Worker の返事が来なければ、上限で諦めてページから出し直す', async () => {
    vi.useFakeTimers()
    try {
      const pageCalls: string[] = []
      stubNotification(title => pageCalls.push(title))
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      stubServiceWorker({ active: {} as ServiceWorker, showNotification: () => new Promise<void>(() => {}) })
      const done = deliverBrowserNotification('地震情報', { tag: 'q' })
      await vi.advanceTimersByTimeAsync(SW_SHOW_TIMEOUT_MS - 1)
      expect(pageCalls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(pageCalls).toEqual(['地震情報'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  /** 返事を遅らせられる Service Worker の登録。`shown` は表示中の通知（`close` で消える）。 */
  function stubLateServiceWorker() {
    let release!: () => void
    const shown: { title: string; body: string; close: () => void }[] = []
    const showNotification = (title: string, opts?: NotificationOptions) => new Promise<void>(resolve => {
      release = () => {
        const n = { title, body: opts?.body ?? '', close: () => { shown.splice(shown.indexOf(n), 1) } }
        shown.push(n)
        resolve()
      }
    })
    const other = { title: '別の通知', body: '本文', close: () => { shown.splice(shown.indexOf(other), 1) } }
    shown.push(other)
    stubServiceWorker({ active: {} as ServiceWorker, showNotification, getNotifications: async () => [...shown] as unknown as Notification[] })
    return { shown, release: () => release() }
  }

  // Service Worker の通知とページの通知は、同じ tag でも置き換わらないことがある。諦めた方が遅れて出たら閉じる
  it('正: 上限で諦めた後に Service Worker から遅れて出たら、それを閉じる（ページから出し直せたとき）', async () => {
    vi.useFakeTimers()
    try {
      stubNotification(() => {})
      vi.spyOn(log, 'warn').mockImplementation(() => {})
      vi.spyOn(log, 'debug').mockImplementation(() => {})
      const sw = stubLateServiceWorker()
      const done = deliverBrowserNotification('地震情報', { tag: 'q', body: '本文' })
      await vi.advanceTimersByTimeAsync(SW_SHOW_TIMEOUT_MS)
      await done
      sw.release()
      await vi.advanceTimersByTimeAsync(0)
      // 遅れて出た「地震情報」だけが閉じ、題の違う通知は残る
      expect(sw.shown.map(n => n.title)).toEqual(['別の通知'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('対照: ページから出し直せなかったとき（Android）は、遅れて出た通知を残す', async () => {
    vi.useFakeTimers()
    try {
      stubNotification(() => { throw new TypeError('Illegal constructor') })
      vi.spyOn(log, 'warn').mockImplementation(() => {})
      const sw = stubLateServiceWorker()
      const done = deliverBrowserNotification('地震情報', { tag: 'q', body: '本文' })
      const settled = done.catch(() => 'rejected')
      await vi.advanceTimersByTimeAsync(SW_SHOW_TIMEOUT_MS)
      expect(await settled).toBe('rejected')
      sw.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(sw.shown.map(n => n.title)).toEqual(['別の通知', '地震情報'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('正: renotify を受け付けなければ外して出し直す（ページから）', async () => {
    const opts: (NotificationOptions & { renotify?: boolean })[] = []
    stubNotification((_title, o: NotificationOptions & { renotify?: boolean }) => {
      opts.push(o)
      if (o.renotify) throw new TypeError('renotify')
    })
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    await deliverBrowserNotification('地震情報', { tag: 'q', renotify: true })
    expect(opts).toHaveLength(2)
    expect('renotify' in opts[1]).toBe(false)
  })
})
