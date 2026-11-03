import { describe, expect, it } from 'vitest'

import {
  CONVEYED_CANCELS_MAX, cancelOverOtherUnit, decideDispatch, earthquakeCountBandDecision, expired, kohatsuBandDecision,
  nankaiBandDecision, nankaiCommentaryBandDecision,
} from './specialInfoBands'

const NOW = Date.parse('2026-11-03T00:00:00Z')
const FUTURE = '2026-11-10T00:00:00Z'
const PAST = '2026-11-02T00:00:00Z'

describe('expired', () => {
  it('期限を過ぎたら真、まだなら偽、読めない日時は null', () => {
    expect(expired(PAST, NOW)).toBe(true)
    expect(expired(FUTURE, NOW)).toBe(false)
    expect(expired('壊れた日時', NOW)).toBeNull()
  })
})

describe('nankaiBandDecision', () => {
  it('取消でない報（調査終了を含む）は、出している情報単位によらず当てる', () => {
    expect(nankaiBandDecision('A', { eventId: 'B', cancelled: false })).toEqual({ apply: true })
  })
  it('正: 別の情報単位への取消（retracted）は当てない', () => {
    expect(nankaiBandDecision('A', { eventId: 'B', cancelled: true, retracted: true })).toEqual({ apply: false, reason: 'otherUnit' })
    expect(nankaiBandDecision(null, { eventId: 'B', cancelled: true, retracted: true })).toEqual({ apply: false, reason: 'notShown' })
  })
  it('対照: 出している情報単位への取消は当てる', () => {
    expect(nankaiBandDecision('A', { eventId: 'A', cancelled: true, retracted: true })).toEqual({ apply: true })
  })
})

describe('kohatsuBandDecision', () => {
  it('正: 期限切れ・読めない期限の報は当てない', () => {
    expect(kohatsuBandDecision(null, { eventId: 'A', cancelled: false, expireAt: PAST }, NOW)).toEqual({ apply: false, reason: 'expired' })
    expect(kohatsuBandDecision(null, { eventId: 'A', cancelled: false, expireAt: 'x' }, NOW)).toEqual({ apply: false, reason: 'badExpire' })
  })
  it('対照: 期限内の報は当てる', () => {
    expect(kohatsuBandDecision(null, { eventId: 'A', cancelled: false, expireAt: FUTURE }, NOW)).toEqual({ apply: true })
  })
  it('取消の照合は臨時情報と同じ', () => {
    expect(kohatsuBandDecision('A', { eventId: 'B', cancelled: true, retracted: true, expireAt: '' }, NOW).apply).toBe(false)
    expect(kohatsuBandDecision('A', { eventId: 'A', cancelled: true, retracted: true, expireAt: '' }, NOW).apply).toBe(true)
  })
})

describe('nankaiCommentaryBandDecision', () => {
  it('取消は出している号（id）にだけ当てる（eventId が同じ別の号には当てない）', () => {
    expect(nankaiCommentaryBandDecision('E-2', { id: 'E-2', cancelled: true, expireAt: '' }, NOW).apply).toBe(true)
    expect(nankaiCommentaryBandDecision('E-2', { id: 'E-1', cancelled: true, expireAt: '' }, NOW)).toEqual({ apply: false, reason: 'otherUnit' })
  })
  it('期限切れの報は当てない', () => {
    expect(nankaiCommentaryBandDecision(null, { id: 'E-1', cancelled: false, expireAt: PAST }, NOW)).toEqual({ apply: false, reason: 'expired' })
    expect(nankaiCommentaryBandDecision(null, { id: 'E-1', cancelled: false, expireAt: FUTURE }, NOW)).toEqual({ apply: true })
  })
})

describe('earthquakeCountBandDecision', () => {
  const base = { eventId: 'G', cancelled: false, items: [], body: '', expireAt: FUTURE } as unknown as Parameters<typeof earthquakeCountBandDecision>[1]
  it('正: 回数も本文も無い報は当てない', () => {
    expect(earthquakeCountBandDecision(null, base, NOW)).toEqual({ apply: false, reason: 'empty' })
  })
  it('対照: 本文だけの報（区間 0 件）は当てる', () => {
    expect(earthquakeCountBandDecision(null, { ...base, body: '本文' }, NOW)).toEqual({ apply: true })
  })
  it('期限切れは当てない。取消は群発（eventId）で照合する', () => {
    expect(earthquakeCountBandDecision(null, { ...base, body: '本文', expireAt: PAST }, NOW).apply).toBe(false)
    expect(earthquakeCountBandDecision('G', { ...base, cancelled: true }, NOW).apply).toBe(true)
    expect(earthquakeCountBandDecision('H', { ...base, cancelled: true }, NOW).apply).toBe(false)
  })
})

describe('cancelOverOtherUnit', () => {
  it('出している別の情報単位の下で届いた取消（retracted）だけを真にする', () => {
    expect(cancelOverOtherUnit('A', { eventId: 'B', cancelled: true, retracted: true })).toBe(true)
    expect(cancelOverOtherUnit(null, { eventId: 'B', cancelled: true, retracted: true })).toBe(false)
    expect(cancelOverOtherUnit('A', { eventId: 'A', cancelled: true, retracted: true })).toBe(false)
    expect(cancelOverOtherUnit('A', { eventId: 'B', cancelled: true })).toBe(false)
  })
})

describe('decideDispatch', () => {
  const report = { id: 'X', time: '2026-11-03T00:00:00Z', cancelled: false }
  const cancel = { ...report, cancelled: true }
  it('取消でない報は帯へ当てたかで決め、サイレント注入は流さない', () => {
    expect(decideDispatch(new Set(), 'nankai', report, true, false, false)).toBe('dispatch')
    expect(decideDispatch(new Set(), 'nankai', report, false, false, false)).toBe('notApplied')
    expect(decideDispatch(new Set(), 'nankai', report, true, true, false)).toBe('silentReplayInit')
  })
  it('取消は帯へ当てたかによらず流し、同じ取消の 2 通目は止める', () => {
    const conveyed = new Set<string>()
    expect(decideDispatch(conveyed, 'nankai', cancel, false, false, false)).toBe('dispatch')
    expect(decideDispatch(conveyed, 'nankai', cancel, false, false, false)).toBe('notDispatched')
  })
  it('正: 別の情報単位の帯が出ているときの古い単位への取消は流さない', () => {
    expect(decideDispatch(new Set(), 'nankai', cancel, false, false, true)).toBe('notApplied')
  })
  it('安全弁: サイレント注入の取消も「伝えた」に数え、後から同じ取消が届いても流さない', () => {
    const conveyed = new Set<string>()
    expect(decideDispatch(conveyed, 'kohatsu', cancel, true, true, false)).toBe('silentReplayInit')
    expect(decideDispatch(conveyed, 'kohatsu', cancel, true, false, false)).toBe('notDispatched')
  })
  it('発表時刻が違えば別の取消として流す（id だけでは取り違える）', () => {
    const conveyed = new Set<string>()
    decideDispatch(conveyed, 'nankai', cancel, true, false, false)
    expect(decideDispatch(conveyed, 'nankai', { ...cancel, time: '2026-11-03T01:00:00Z' }, true, false, false)).toBe('dispatch')
  })
  it('記憶は上限で空にする', () => {
    const conveyed = new Set<string>(Array.from({ length: CONVEYED_CANCELS_MAX }, (_, i) => `k${i}`))
    decideDispatch(conveyed, 'nankai', cancel, true, false, false)
    expect(conveyed.size).toBe(1)
  })
})
