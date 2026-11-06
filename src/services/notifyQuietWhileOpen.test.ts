// @vitest-environment jsdom
//
// 設定「アプリを開いている間は通知しない」（notifyQuietWhileOpen）。画面内の通知・中継への名乗りと問いの答え・
// Service Worker の問いの答えを確かめる。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

import {
  answerPushProbe,
  attachRelaySocket,
  installNotifyQuietVisibilityWatch,
  installServiceWorkerQuietAnswer,
  quietNow,
  resetNotifyQuietWhileOpenForTest,
  setNotifyQuietWhileOpen,
  setPushQuietBinding,
} from './notifyQuietWhileOpen'
import { deliverBrowserNotification, showTestBrowserNotification } from '../utils/notifications'

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  resetNotifyQuietWhileOpenForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** `new Notification()` で出た通知の題を集める（Service Worker の無い環境なので、ページから同期で出る） */
function stubNotification(): string[] {
  const shown: string[] = []
  const Fake = function (this: unknown, title: string) { shown.push(title) } as unknown as typeof Notification
  Object.defineProperty(Fake, 'permission', { value: 'granted' })
  vi.stubGlobal('Notification', Fake)
  vi.stubGlobal('navigator', {})
  return shown
}

const BINDING = { endpoint: 'https://push.example/abc', auth: 'secret' }

describe('画面内の通知', () => {
  it('正: 設定が入っていて画面に出ている間は出さない', async () => {
    const shown = stubNotification()
    setNotifyQuietWhileOpen(true)
    await deliverBrowserNotification('地震情報', { tag: 'quake' })
    expect(shown).toEqual([])
  })

  it('対照: 画面に出ていなければ出す', async () => {
    const shown = stubNotification()
    setNotifyQuietWhileOpen(true)
    visibility = 'hidden'
    await deliverBrowserNotification('地震情報', { tag: 'quake' })
    expect(shown).toEqual(['地震情報'])
  })

  it('対照: 設定が切れていれば、画面に出ていても出す', async () => {
    const shown = stubNotification()
    await deliverBrowserNotification('地震情報', { tag: 'quake' })
    expect(shown).toEqual(['地震情報'])
  })

  // 押すときはいつも画面に出ているので、止めると押しても何も起きないボタンになる
  it('安全弁: 通知テストは設定によらず出す', () => {
    const shown = stubNotification()
    setNotifyQuietWhileOpen(true)
    showTestBrowserNotification('地震情報テスト', '本文', 'test-notification')
    expect(shown).toEqual(['地震情報テスト'])
  })
})

describe('中継への名乗り', () => {
  it('正: 設定と購読が揃ったら、登録した接続すべてへ名乗り、どちらかが外れたら取り下げる', () => {
    const a: string[] = []
    const b: string[] = []
    attachRelaySocket(t => a.push(t))
    attachRelaySocket(t => b.push(t))
    setNotifyQuietWhileOpen(true)
    // 購読がまだ無いので名乗らない
    expect(a).toEqual([])
    setPushQuietBinding(BINDING)
    const bind = JSON.stringify({ type: 'push-quiet-bind', endpoint: BINDING.endpoint, auth: BINDING.auth })
    expect(a).toEqual([bind])
    expect(b).toEqual([bind])
    // 同じ値を入れ直しても名乗り直さない
    setNotifyQuietWhileOpen(true)
    expect(a).toHaveLength(1)
    setNotifyQuietWhileOpen(false)
    expect(a).toEqual([bind, '{"type":"push-quiet-unbind"}'])
  })

  it('正: 条件が揃った後に繋いだ接続には、登録した時点で名乗る', () => {
    setNotifyQuietWhileOpen(true)
    setPushQuietBinding(BINDING)
    const sent: string[] = []
    attachRelaySocket(t => sent.push(t))
    expect(sent).toHaveLength(1)
  })

  // 裏のタブは接続が生きたまま返事をしないので、名乗ったままだと中継が毎回待つ
  it('正: 画面から隠れたら名乗りを取り下げ、戻ったら名乗り直す', () => {
    const uninstall = installNotifyQuietVisibilityWatch()
    const sent: string[] = []
    attachRelaySocket(t => sent.push(t))
    setNotifyQuietWhileOpen(true)
    setPushQuietBinding(BINDING)
    const bind = JSON.stringify({ type: 'push-quiet-bind', endpoint: BINDING.endpoint, auth: BINDING.auth })
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sent).toEqual([bind, '{"type":"push-quiet-unbind"}', bind])
    uninstall()
  })

  it('対照: 隠れている間に設定と購読が揃っても名乗らない', () => {
    visibility = 'hidden'
    const sent: string[] = []
    attachRelaySocket(t => sent.push(t))
    setNotifyQuietWhileOpen(true)
    setPushQuietBinding(BINDING)
    expect(sent).toEqual([])
  })

  it('安全弁: 外した接続へは送らない', () => {
    const sent: string[] = []
    const detach = attachRelaySocket(t => sent.push(t))
    detach()
    setNotifyQuietWhileOpen(true)
    setPushQuietBinding(BINDING)
    expect(sent).toEqual([])
  })
})

describe('中継の問いへの答え', () => {
  it('正: 設定が入っていて画面に出ていれば答える', () => {
    setNotifyQuietWhileOpen(true)
    const sent: string[] = []
    answerPushProbe({ type: 'relay-push-probe', probe: 'p1' }, t => sent.push(t))
    expect(sent).toEqual(['{"type":"push-probe-ack","probe":"p1"}'])
  })

  // 「送って」と答えると、中継は待たずに送る（裏のタブで毎回待たせない）
  it('対照: 画面に出ていない・設定が切れているときは「送って」と答える', () => {
    const sent: string[] = []
    answerPushProbe({ type: 'relay-push-probe', probe: 'p1' }, t => sent.push(t))
    setNotifyQuietWhileOpen(true)
    visibility = 'hidden'
    answerPushProbe({ type: 'relay-push-probe', probe: 'p2' }, t => sent.push(t))
    expect(sent).toEqual(['{"type":"push-probe-nack","probe":"p1"}', '{"type":"push-probe-nack","probe":"p2"}'])
  })

  it('安全弁: 読めない問いには答えない', () => {
    setNotifyQuietWhileOpen(true)
    const sent: string[] = []
    answerPushProbe({ type: 'relay-push-probe' }, t => sent.push(t))
    answerPushProbe({ type: 'relay-push-probe', probe: 'x'.repeat(65) }, t => sent.push(t))
    expect(sent).toEqual([])
  })
})

describe('Service Worker の問いへの答え', () => {
  function stubServiceWorker(): { ask: (data: unknown) => unknown[] } {
    let listener: ((ev: MessageEvent) => void) | null = null
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (_: string, fn: (ev: MessageEvent) => void) => { listener = fn },
        removeEventListener: () => { listener = null },
      },
    })
    return {
      ask: (data) => {
        const replies: unknown[] = []
        listener?.({ data, ports: [{ postMessage: (r: unknown) => replies.push(r) }] } as unknown as MessageEvent)
        return replies
      },
    }
  }

  it('正: いま止めるかを返す', () => {
    const sw = stubServiceWorker()
    const uninstall = installServiceWorkerQuietAnswer()
    expect(sw.ask({ type: 'push-quiet-query' })).toEqual([{ quiet: false }])
    setNotifyQuietWhileOpen(true)
    expect(quietNow()).toBe(true)
    expect(sw.ask({ type: 'push-quiet-query' })).toEqual([{ quiet: true }])
    uninstall()
    expect(sw.ask({ type: 'push-quiet-query' })).toEqual([])
  })

  it('安全弁: ほかの知らせには答えない', () => {
    const sw = stubServiceWorker()
    installServiceWorkerQuietAnswer()
    setNotifyQuietWhileOpen(true)
    expect(sw.ask({ type: 'notification-open' })).toEqual([])
  })
})
