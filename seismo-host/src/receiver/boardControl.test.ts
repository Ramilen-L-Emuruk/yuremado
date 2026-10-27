import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  BOARD_TOKEN_HEADER,
  BOARD_ACTION_HOLD_MAX_MS,
  BOARD_ACTION_RETURN_GAP_MS,
  BoardActionGuard,
  BoardAddressBook,
  boardControlState,
  boardFetch,
  sendBoardAction,
  type BoardActionResult,
  type BoardControlDeps,
} from './boardControl'

function deps(over: Partial<BoardControlDeps> = {}, reply: { status: number } | Error = { status: 200 }) {
  const calls: { url: string; headers: Record<string, string>; method: string }[] = []
  const d: BoardControlDeps = {
    token: 'tok',
    addressOf: () => '192.0.2.10',
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, method: init.method })
      if (reply instanceof Error) throw reply
      return reply
    },
    ...over,
  }
  return { d, calls }
}

describe('sendBoardAction', () => {
  it('正: 基板の住所へトークン付きの POST を送り、200 なら頼めたと返す', async () => {
    const { d, calls } = deps()
    expect(await sendBoardAction(d, 'mac:020000000001', 'restart')).toEqual({ kind: 'sent' })
    expect(calls).toEqual([{ url: 'http://192.0.2.10/restart', method: 'POST', headers: { [BOARD_TOKEN_HEADER]: 'tok' } }])
    await sendBoardAction(d, 'mac:020000000001', 'wifi-reconnect')
    expect(calls[1]?.url).toBe('http://192.0.2.10/wifi-reconnect')
  })

  it('対照: 基板の断り方を番号ごとに分けて返す（501 と 403 を同じにしない）', async () => {
    expect(await sendBoardAction(deps({}, { status: 501 }).d, 'mac:1', 'restart')).toEqual({ kind: 'closed' })
    expect(await sendBoardAction(deps({}, { status: 403 }).d, 'mac:1', 'restart')).toEqual({ kind: 'bad-token' })
    expect(await sendBoardAction(deps({}, { status: 404 }).d, 'mac:1', 'restart')).toEqual({ kind: 'old-firmware' })
    expect(await sendBoardAction(deps({}, { status: 500 }).d, 'mac:1', 'restart')).toEqual({ kind: 'unexpected', status: 500 })
  })

  it('安全弁: 返事が無ければ投げずに「返事が無い」を返す', async () => {
    const r = await sendBoardAction(deps({}, new Error('ETIMEDOUT')).d, 'mac:1', 'restart')
    expect(r).toEqual({ kind: 'no-reply', cause: 'other', reason: 'ETIMEDOUT' })
  })

  it('正: 本物の取得で、時間切れと繋ぎを断られたのを見分ける（手元の 127.0.0.1 だけ）', async () => {
    // 受けるだけで何も返さない口（時間切れ）
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const silentPort = (silent.address() as AddressInfo).port
    // 開いて閉じた口（断られる）
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    try {
      const real = (address: string): BoardControlDeps => ({
        token: 't',
        addressOf: () => address,
        timeoutMs: 200,
        fetch: boardFetch((url, init) => fetch(url, init)),
      })
      const timeout = await sendBoardAction(real(`127.0.0.1:${silentPort}`), 'mac:1', 'restart')
      expect(timeout.kind === 'no-reply' && timeout.cause).toBe('timeout')
      const refused = await sendBoardAction(real(`127.0.0.1:${closedPort}`), 'mac:1', 'restart')
      expect(refused.kind === 'no-reply' && refused.cause).toBe('refused')
      // 記録の原文は `fetch failed` だけで終わらせない
      expect(refused.kind === 'no-reply' && refused.reason).toMatch(/ECONNREFUSED/)
    } finally {
      silent.closeAllConnections()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  it('安全弁: トークンも住所も無ければ、基板へは何も送らない', async () => {
    const a = deps({ token: null })
    expect(await sendBoardAction(a.d, 'mac:1', 'restart')).toEqual({ kind: 'no-token' })
    const b = deps({ addressOf: () => null })
    expect(await sendBoardAction(b.d, 'mac:1', 'restart')).toEqual({ kind: 'no-address' })
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(0)
  })

  it('安全弁: 空のトークンは無いのと同じに扱う（基板も空のトークンは必ず拒む）', async () => {
    const { d, calls } = deps({ token: '' })
    expect(await sendBoardAction(d, 'mac:1', 'restart')).toEqual({ kind: 'no-token' })
    expect(calls).toHaveLength(0)
  })
})

describe('BoardAddressBook', () => {
  it('正: 最後にパケットが届いた送り元を基板ごとに覚える', () => {
    const book = new BoardAddressBook()
    expect(book.addressOf('mac:1')).toBeNull()
    book.note('mac:1', '192.0.2.10')
    book.note('mac:2', '192.0.2.11')
    book.note('mac:1', '192.0.2.12')
    expect(book.addressOf('mac:1')).toBe('192.0.2.12')
    expect(book.addressOf('mac:2')).toBe('192.0.2.11')
  })
})

describe('boardControlState', () => {
  it('正: トークンの有無と、住所の分かっている基板を返す', () => {
    const book = new BoardAddressBook()
    book.note('mac:1', '192.0.2.10')
    expect(boardControlState('tok', book)).toEqual({ tokenConfigured: true, reachable: ['mac:1'] })
    expect(boardControlState(null, book)).toEqual({ tokenConfigured: false, reachable: ['mac:1'] })
    expect(boardControlState('', book).tokenConfigured).toBe(false)
  })
})

describe('BoardActionGuard', () => {
  it('安全弁: 同じ基板へ頼んでいる最中の 2 本目は送らず busy を返す', async () => {
    const guard = new BoardActionGuard(() => 0)
    let release: (r: BoardActionResult) => void = () => {}
    let sent = 0
    const first = guard.run('mac:1', () => {
      sent += 1
      return new Promise<BoardActionResult>((resolve) => {
        release = resolve
      })
    })
    expect(
      await guard.run('mac:1', async () => {
        sent += 1
        return { kind: 'sent' }
      }),
    ).toEqual({ kind: 'busy' })
    expect(sent).toBe(1)
    release({ kind: 'sent' })
    expect(await first).toEqual({ kind: 'sent' })
  })

  it('対照: 別の基板は並べて頼める・頼めなかった後なら同じ基板へまた頼める', async () => {
    const guard = new BoardActionGuard(() => 0)
    let release: (r: BoardActionResult) => void = () => {}
    const first = guard.run('mac:1', () => new Promise<BoardActionResult>((resolve) => (release = resolve)))
    expect(await guard.run('mac:2', async () => ({ kind: 'sent' }))).toEqual({ kind: 'sent' })
    release({ kind: 'no-reply', cause: 'timeout', reason: 'TimeoutError' })
    await first
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'sent' })
  })

  it('正: 頼めた後は、パケットが途切れてから届き直すまで busy', async () => {
    let now = 0
    const guard = new BoardActionGuard(() => now)
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'sent' })
    let sent = 0
    const again = async (): Promise<BoardActionResult> => {
      sent += 1
      return { kind: 'sent' }
    }
    // 落ちて戻ってきた：途切れた後に届いたパケットで解ける
    now += BOARD_ACTION_RETURN_GAP_MS
    guard.notePacket('mac:1')
    expect(await guard.run('mac:1', again)).toEqual({ kind: 'sent' })
    expect(sent).toBe(1)
  })

  it('対照: 動く前に続けて届くパケット（約 200 ms）では解けない', async () => {
    let now = 0
    const guard = new BoardActionGuard(() => now)
    await guard.run('mac:1', async () => ({ kind: 'sent' }))
    for (let i = 0; i < 10; i++) {
      now += 100
      guard.notePacket('mac:1')
    }
    // 途切れた幅が足りなければ解けない
    now += BOARD_ACTION_RETURN_GAP_MS - 1
    guard.notePacket('mac:1')
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'busy' })
    // 別の基板から届いても解けない
    now += BOARD_ACTION_RETURN_GAP_MS
    guard.notePacket('mac:2')
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'busy' })
  })

  it('安全弁: 戻ってこない基板でも、上限を過ぎれば頼み直せる', async () => {
    let now = 1_000
    const guard = new BoardActionGuard(() => now)
    await guard.run('mac:1', async () => ({ kind: 'sent' }))
    now += BOARD_ACTION_HOLD_MAX_MS - 1
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'busy' })
    now += 1
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'sent' })
  })

  it('安全弁: 送る側が投げても、その基板を最中のまま残さない', async () => {
    const guard = new BoardActionGuard(() => 0)
    await expect(
      guard.run('mac:1', async () => {
        throw new Error('壊れた')
      }),
    ).rejects.toThrow('壊れた')
    expect(await guard.run('mac:1', async () => ({ kind: 'sent' }))).toEqual({ kind: 'sent' })
  })
})

describe('boardFetch', () => {
  it('安全弁: リダイレクトに付いていかない形で頼み、本文は読まずに捨てる', async () => {
    const seen: { url: string; redirect: string; method: string; headers: Record<string, string> }[] = []
    let cancelled = 0
    const f = boardFetch(async (url, init) => {
      seen.push({ url, redirect: init.redirect, method: init.method, headers: init.headers })
      return {
        status: 302,
        body: {
          cancel: async () => {
            cancelled += 1
          },
        },
      }
    })
    expect(await f('http://192.0.2.10/restart', { method: 'POST', headers: { [BOARD_TOKEN_HEADER]: 'tok' }, timeoutMs: 1000 })).toEqual({
      status: 302,
    })
    expect(seen).toEqual([{ url: 'http://192.0.2.10/restart', redirect: 'manual', method: 'POST', headers: { [BOARD_TOKEN_HEADER]: 'tok' } }])
    expect(cancelled).toBe(1)
  })

  it('対照: 本文の後始末が投げても、返事の番号は返す', async () => {
    const f = boardFetch(async () => ({
      status: 200,
      body: {
        cancel: async () => {
          throw new Error('閉じられない')
        },
      },
    }))
    expect(await f('http://192.0.2.10/restart', { method: 'POST', headers: {}, timeoutMs: 1000 })).toEqual({ status: 200 })
  })
})
