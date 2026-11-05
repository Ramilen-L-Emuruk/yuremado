import { afterEach, describe, expect, it, vi } from 'vitest'
import { PENDING_SPEECH_STALE_MS, hasPendingSpeech, isSpeechPending, registerPendingSpeechProbe, type PendingSpeechState } from './pendingSpeech'

const empty: PendingSpeechState = {
  scheduledSpeeches: 0, eewChainPending: 0, eewPhase2Timers: 0, eewStabilityWaits: 0, eewCancelPending: 0, scheduledPriorities: 0,
}

describe('isSpeechPending', () => {
  it('何も残っていなければ控えていない', () => {
    expect(isSpeechPending(empty)).toBe(false)
  })
  it.each(Object.keys(empty) as (keyof PendingSpeechState)[])('%s が 1 つでも残っていれば控えている', key => {
    expect(isSpeechPending({ ...empty, [key]: 1 })).toBe(true)
  })
})

describe('hasPendingSpeech', () => {
  let unregister: (() => void) | null = null
  afterEach(() => { unregister?.(); unregister = null })

  it('登録が無ければ偽', () => {
    expect(hasPendingSpeech(false, 0)).toBe(false)
  })

  it('登録した状態を引く', () => {
    let s = empty
    unregister = registerPendingSpeechProbe(() => s)
    expect(hasPendingSpeech(false, 0)).toBe(false)
    s = { ...empty, scheduledSpeeches: 1 }
    expect(hasPendingSpeech(false, 1)).toBe(true)
  })

  /** 0 から `untilMs` まで 1 秒刻みで問い合わせ、最後の答えを返す（続けて見ている状態を作る） */
  const observeEverySecond = (untilMs: number): boolean => {
    let last = false
    for (let t = 0; t <= untilMs; t += 1_000) last = hasPendingSpeech(false, t)
    return last
  }

  it('読み上げが始まらないまま上限を超えて残った控えは数えない（後始末の漏れ）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    unregister = registerPendingSpeechProbe(() => ({ ...empty, scheduledPriorities: 1 }))
    expect(observeEverySecond(PENDING_SPEECH_STALE_MS)).toBe(true)
    expect(hasPendingSpeech(false, PENDING_SPEECH_STALE_MS + 1_000)).toBe(false)
    // ロガーの時刻の頭書きが時計の未較正を警告することがあるので、こちらの文面だけを数える
    const mine = warn.mock.calls.filter(c => c.some(a => typeof a === 'string' && a.includes('時報では数えない')))
    expect(mine).toHaveLength(1)
    warn.mockRestore()
  })

  it('間を空けた 2 回の問い合わせでは、前の控えの時刻を引き継がない（別の控えかもしれない）', () => {
    unregister = registerPendingSpeechProbe(() => ({ ...empty, eewPhase2Timers: 1 }))
    expect(hasPendingSpeech(false, 0)).toBe(true)
    // 次の境（5 分後）に見た控えは、数え直して真
    expect(hasPendingSpeech(false, PENDING_SPEECH_STALE_MS + 60_000)).toBe(true)
  })

  it('読み上げの最中は、控えが長く続いても数え続ける（対照）', () => {
    unregister = registerPendingSpeechProbe(() => ({ ...empty, eewChainPending: 1 }))
    expect(hasPendingSpeech(true, 0)).toBe(true)
    expect(hasPendingSpeech(true, PENDING_SPEECH_STALE_MS * 2)).toBe(true)
    // 読み上げが終わった直後から数え直す
    expect(hasPendingSpeech(false, PENDING_SPEECH_STALE_MS * 2 + 1)).toBe(true)
  })

  it('問い合わせが投げても偽を返す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    unregister = registerPendingSpeechProbe(() => { throw new Error('壊れた') })
    expect(hasPendingSpeech(false, 0)).toBe(false)
    warn.mockRestore()
  })
})
