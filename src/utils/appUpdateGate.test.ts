import { describe, expect, it } from 'vitest'
import { decideReloadGate, isTextEntryElement, type ReloadGateInput } from './appUpdateGate'

const calm: ReloadGateInput = {
  updateWaiting: false,
  periodicDue: false,
  alertActive: false,
  replaying: false,
  typing: false,
  reading: false,
  postponedUntilMs: null,
  nowMs: 1_000,
}

describe('decideReloadGate', () => {
  it('読み直す理由が無ければ何もしない', () => {
    expect(decideReloadGate(calm)).toEqual({ kind: 'none' })
  })

  it('新しい版が待っていて静かなら秒読みする（正）', () => {
    expect(decideReloadGate({ ...calm, updateWaiting: true })).toEqual({ kind: 'countdown', reason: 'update' })
  })

  it('定期の読み直しも静かなら秒読みする', () => {
    expect(decideReloadGate({ ...calm, periodicDue: true })).toEqual({ kind: 'countdown', reason: 'periodic' })
  })

  it('両方が待っているときは新しい版の適用を選ぶ（適用で定期の分も済む）', () => {
    expect(decideReloadGate({ ...calm, updateWaiting: true, periodicDue: true }))
      .toEqual({ kind: 'countdown', reason: 'update' })
  })

  it('発表中・再生中・入力中は待つ（対照）', () => {
    expect(decideReloadGate({ ...calm, updateWaiting: true, alertActive: true }))
      .toEqual({ kind: 'held', reason: 'update', cause: 'alert' })
    expect(decideReloadGate({ ...calm, updateWaiting: true, replaying: true }))
      .toEqual({ kind: 'held', reason: 'update', cause: 'replay' })
    expect(decideReloadGate({ ...calm, periodicDue: true, typing: true }))
      .toEqual({ kind: 'held', reason: 'periodic', cause: 'typing' })
    expect(decideReloadGate({ ...calm, updateWaiting: true, reading: true }))
      .toEqual({ kind: 'held', reason: 'update', cause: 'reading' })
  })

  it('「後で」の期限の手前は待ち、期限ちょうどから秒読みへ戻る（境界）', () => {
    const postponed = { ...calm, updateWaiting: true, postponedUntilMs: 5_000 }
    expect(decideReloadGate({ ...postponed, nowMs: 4_999 })).toEqual({ kind: 'held', reason: 'update', cause: 'postponed' })
    expect(decideReloadGate({ ...postponed, nowMs: 5_000 })).toEqual({ kind: 'countdown', reason: 'update' })
  })

  it('「後で」の期限が過ぎても、発表中なら待つ（安全弁: 延期の明けが発表中の待ちを越えない）', () => {
    expect(decideReloadGate({ ...calm, updateWaiting: true, postponedUntilMs: 5_000, nowMs: 9_000, alertActive: true }))
      .toEqual({ kind: 'held', reason: 'update', cause: 'alert' })
  })
})

describe('isTextEntryElement', () => {
  const el = (tagName: string, props: Record<string, unknown> = {}) => ({ tagName, ...props }) as unknown as Element

  it('文字を打つ欄は入力中と見なす', () => {
    expect(isTextEntryElement(el('TEXTAREA'))).toBe(true)
    expect(isTextEntryElement(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTextEntryElement(el('INPUT', { type: 'number' }))).toBe(true)
    expect(isTextEntryElement(el('INPUT', { type: 'datetime-local' }))).toBe(true)
    expect(isTextEntryElement(el('DIV', { isContentEditable: true }))).toBe(true)
  })

  it('押して切り替えるだけの部品は入力中と見なさない（押した後にフォーカスが残るため）', () => {
    expect(isTextEntryElement(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTextEntryElement(el('INPUT', { type: 'range' }))).toBe(false)
    expect(isTextEntryElement(el('BUTTON'))).toBe(false)
    expect(isTextEntryElement(el('SELECT'))).toBe(false)
    expect(isTextEntryElement(null)).toBe(false)
  })
})
