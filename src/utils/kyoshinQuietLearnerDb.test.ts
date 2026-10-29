// 平常のゆらぎの学び直しの保存先（IndexedDB）。開けなかった後に開き直すこと・警告を文面ごとに絞ること。
import 'fake-indexeddb/auto'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuietTableBaker } from './kyoshinQuietTables'
import type { QuietLearnerState } from './kyoshinQuietLearner'

const state = (): QuietLearnerState => ({ counts: new QuietTableBaker().counts(), hourSec: new Array<number>(24).fill(60) })

// 接続と警告の旗はモジュールが持つので、テストごとに読み直す（記録の口も読み直した側を見張る）
async function freshDb() {
  vi.resetModules()
  const { log } = await import('./logger')
  return { ...(await import('./kyoshinQuietLearnerDb')), log }
}

describe('kyoshinQuietLearnerDb', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('正: 残した状態を読み戻せる。まだ何も残していなければ読めたうえで null', async () => {
    const db = await freshDb()
    expect(await db.loadQuietLearnerState()).toEqual({ readable: true, state: null })
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    const loaded = await db.loadQuietLearnerState()
    expect(loaded.readable).toBe(true)
    expect(loaded.state?.hourSec).toEqual(state().hourSec)
  })

  it('正: 開けなかった次の読み書きで開き直す（失敗した接続を持ち続けない）', async () => {
    const db = await freshDb()
    vi.spyOn(db.log, 'warn').mockImplementation(() => {})
    const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw new Error('見本の失敗') })
    expect(await db.loadQuietLearnerState()).toEqual({ readable: false, state: null })
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('正: 開くのが決着しないまま上限を過ぎたら、読めなかったとして返し、次の読み書きで開き直す', async () => {
    const db = await freshDb()
    const warn = vi.spyOn(db.log, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // 成功も失敗も返さない要求（一部のブラウザで知られる形）
      const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => ({}) as IDBOpenDBRequest)
      const loading = db.loadQuietLearnerState()
      await vi.advanceTimersByTimeAsync(db.QUIET_LEARNER_OPEN_TIMEOUT_MS)
      expect(await loading).toEqual({ readable: false, state: null })
      expect(String(warn.mock.calls[0][0])).toContain('開けませんでした')
      vi.useRealTimers()
      expect(await db.saveQuietLearnerState(state())).toBe(true)
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('正: 読み書きに失敗したら接続を捨て、次の読み書きで開き直す（閉じた知らせの届かない死んだ接続を持ち続けない）', async () => {
    const db = await freshDb()
    vi.spyOn(db.log, 'warn').mockImplementation(() => {})
    const open = vi.spyOn(indexedDB, 'open')
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => { throw new Error('見本の失敗') })
    expect(await db.saveQuietLearnerState(state())).toBe(false)
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('正: 開く要求があとから失敗を知らせても、次の読み書きで開き直す', async () => {
    const db = await freshDb()
    vi.spyOn(db.log, 'warn').mockImplementation(() => {})
    const req = {} as IDBOpenDBRequest
    const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => req)
    const loading = db.loadQuietLearnerState()
    await Promise.resolve()
    req.onerror?.(new Event('error'))
    expect(await loading).toEqual({ readable: false, state: null })
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('正: ブラウザが接続を閉じたら（onclose）、次の読み書きで開き直す', async () => {
    const db = await freshDb()
    const requests: IDBOpenDBRequest[] = []
    const realOpen = indexedDB.open.bind(indexedDB)
    const open = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
      const r = realOpen(name, version)
      requests.push(r)
      return r
    })
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    const conn = requests[0].result
    conn.onclose?.(new Event('close'))
    expect(await db.saveQuietLearnerState(state())).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('安全弁: 版を上げられずに諦めた後で開けた接続は、使わずに閉じる', async () => {
    const db = await freshDb()
    vi.spyOn(db.log, 'warn').mockImplementation(() => {})
    const close = vi.fn()
    const req = { result: { close } } as unknown as IDBOpenDBRequest
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => req)
    const loading = db.loadQuietLearnerState()
    await Promise.resolve()
    req.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)
    expect(await loading).toEqual({ readable: false, state: null })
    req.onsuccess?.(new Event('success'))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('対照: 開けている間は接続を使い回す（読み書きのたびに開かない）', async () => {
    const db = await freshDb()
    const open = vi.spyOn(indexedDB, 'open')
    await db.saveQuietLearnerState(state())
    await db.loadQuietLearnerState()
    await db.saveQuietLearnerState(state())
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('安全弁: 開けないが続いても警告は 1 行（毎時の保存のたびに積み上げない）', async () => {
    const db = await freshDb()
    const warn = vi.spyOn(db.log, 'warn').mockImplementation(() => {})
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('見本の失敗') })
    await db.loadQuietLearnerState()
    await db.loadQuietLearnerState()
    await db.saveQuietLearnerState(state())
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('IndexedDB を開けませんでした')
  })
})
