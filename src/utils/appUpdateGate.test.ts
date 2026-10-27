import { describe, expect, it } from 'vitest'
import { SETTINGS_DIALOG_ATTR, SETTINGS_IDLE_HOLD_LIMIT_MS, decideReloadGate, isTextEntryElement, isTypingOutsideSettings, type ReloadGateInput } from './appUpdateGate'

const calm: ReloadGateInput = {
  updateWaiting: false,
  periodicDue: false,
  alertActive: false,
  replaying: false,
  typing: false,
  settingsLastActivityMs: null,
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
    expect(decideReloadGate({ ...calm, periodicDue: true, settingsLastActivityMs: 1_000 }))
      .toEqual({ kind: 'held', reason: 'periodic', cause: 'settings' })
    expect(decideReloadGate({ ...calm, updateWaiting: true, reading: true }))
      .toEqual({ kind: 'held', reason: 'update', cause: 'reading' })
  })

  it('「後で」の期限の手前は待ち、期限ちょうどから秒読みへ戻る（境界）', () => {
    const postponed = { ...calm, updateWaiting: true, postponedUntilMs: 5_000 }
    expect(decideReloadGate({ ...postponed, nowMs: 4_999 })).toEqual({ kind: 'held', reason: 'update', cause: 'postponed' })
    expect(decideReloadGate({ ...postponed, nowMs: 5_000 })).toEqual({ kind: 'countdown', reason: 'update' })
  })

  it('設定の窓を開いたまま操作が無く 30 分経ったら、窓の後ろで秒読みする（正・境界）', () => {
    const open = { ...calm, periodicDue: true, settingsLastActivityMs: 10_000 }
    expect(decideReloadGate({ ...open, nowMs: 10_000 + SETTINGS_IDLE_HOLD_LIMIT_MS - 1 }))
      .toEqual({ kind: 'held', reason: 'periodic', cause: 'settings' })
    expect(decideReloadGate({ ...open, nowMs: 10_000 + SETTINGS_IDLE_HOLD_LIMIT_MS }))
      .toEqual({ kind: 'countdown', reason: 'periodic' })
  })

  it('待つ長さは 30 分（2026-10-27 ユーザー承認の値を固定する）', () => {
    expect(SETTINGS_IDLE_HOLD_LIMIT_MS).toBe(30 * 60 * 1000)
  })

  it('窓を閉じていれば、最後の操作の時刻が古くても待たない（対照）', () => {
    expect(decideReloadGate({ ...calm, updateWaiting: true, settingsLastActivityMs: null, nowMs: 5_000 }))
      .toEqual({ kind: 'countdown', reason: 'update' })
  })

  it('窓の待ちが明けても、入力中なら待つ（安全弁: 窓の時間切れが入力中の待ちを越えない）', () => {
    expect(decideReloadGate({ ...calm, updateWaiting: true, typing: true, settingsLastActivityMs: 0, nowMs: SETTINGS_IDLE_HOLD_LIMIT_MS * 2 }))
      .toEqual({ kind: 'held', reason: 'update', cause: 'typing' })
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

describe('isTypingOutsideSettings', () => {
  // DOM の無い環境で走るので、使う形（tagName・type・closest）だけ持つ要素で確かめる
  const input = (insideDialog: boolean) => ({
    tagName: 'INPUT',
    type: 'text',
    closest: (selector: string) => (insideDialog && selector === `[${SETTINGS_DIALOG_ATTR}]` ? {} : null),
  }) as unknown as Element

  it('窓の外の入力欄は入力中、窓の中の入力欄は入力中に数えない', () => {
    expect(isTypingOutsideSettings(input(false))).toBe(true)
    expect(isTypingOutsideSettings(input(true))).toBe(false)
    expect(isTypingOutsideSettings(null)).toBe(false)
  })
})
