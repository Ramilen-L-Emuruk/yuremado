import { describe, it, expect, vi, afterEach } from 'vitest'
import { showBrowserNotification } from './notifications'
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

describe('showBrowserNotification', () => {
  it('正: 許可があれば tag と閉じるまで残すかを渡して出す', () => {
    const calls: { title: string; opts: NotificationOptions }[] = []
    stubNotification((title, opts) => calls.push({ title, opts }))
    showBrowserNotification('津波警報', '岩手県', 'tsunami', true)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts).toMatchObject({ body: '岩手県', tag: 'tsunami', requireInteraction: true })
  })

  // Android の Chrome 系は `new Notification()` で TypeError を投げる。呼び出し側は後に読み上げと
  // 記憶の後始末を続けるので、ここで止めないとそれらが丸ごと飛ぶ
  it('安全弁: 通知を作れない環境でも例外を外へ出さず、記録を残す', () => {
    stubNotification(() => { throw new TypeError('Illegal constructor') })
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(() => showBrowserNotification('津波警報等の解除', '本文', 'tsunami')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
