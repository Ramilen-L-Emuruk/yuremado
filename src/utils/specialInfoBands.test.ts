import { describe, expect, it } from 'vitest'

import {
  CONVEYED_CANCELS_MAX, cancelOverOtherUnit, decideDispatch, earthquakeCountBandDecision, expired, kohatsuBandDecision,
  nankaiBandDecision, nankaiCommentaryBandDecision, quakeNoticeListDecision,
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

// お知らせ（VZSE40）。アプリの帯と中継のプッシュ通知が同じ答えを出す（2026-11-04 ユーザー選択「気象庁どおりすべて外す (Recommended)」）
describe('quakeNoticeListDecision', () => {
  const shown = (id: string, eventId: string, reportDateTime = '2026-11-02T10:00:00Z', operationStatus?: '訓練') =>
    ({ id, eventId, reportDateTime, operationStatus })
  const notice = (over: Partial<Parameters<typeof quakeNoticeListDecision>[1]> = {}) => ({
    id: 'n1', eventId: 'E1', cancelled: false, reportDateTime: '2026-11-02T10:00:00Z', expireAt: FUTURE, ...over,
  })

  it('正: 取消は EventID と運用種別が同じものを全件外す', () => {
    const list = [shown('a1', 'E1'), shown('a2', 'E1'), shown('b', 'E2')]
    expect(quakeNoticeListDecision(list, notice({ id: 'c', cancelled: true }), NOW)).toEqual({ apply: true, removeIds: ['a1', 'a2'] })
  })
  it('対照: 運用種別の違う取消・別の EventID への取消は当てない', () => {
    const list = [shown('a1', 'E1')]
    expect(quakeNoticeListDecision(list, notice({ id: 'c', cancelled: true, operationStatus: '訓練' }), NOW))
      .toEqual({ apply: false, reason: 'otherUnit' })
    expect(quakeNoticeListDecision(list, notice({ id: 'c', eventId: 'E9', cancelled: true }), NOW))
      .toEqual({ apply: false, reason: 'otherUnit' })
  })
  it('安全弁: EventID が空の取消は、空の EventID の報が出ていても照合しない', () => {
    expect(quakeNoticeListDecision([shown('a', '')], notice({ id: 'c', eventId: '', cancelled: true }), NOW))
      .toEqual({ apply: false, reason: 'noEventId' })
  })
  it('一覧が空なら取消は notShown（期限は見ない）', () => {
    expect(quakeNoticeListDecision([], notice({ cancelled: true, expireAt: PAST }), NOW)).toEqual({ apply: false, reason: 'notShown' })
  })
  it('発表は期限内なら当て、期限切れ・読めない期限は当てない', () => {
    expect(quakeNoticeListDecision([], notice(), NOW)).toEqual({ apply: true, removeIds: [] })
    expect(quakeNoticeListDecision([], notice({ expireAt: PAST }), NOW)).toEqual({ apply: false, reason: 'expired' })
    expect(quakeNoticeListDecision([], notice({ expireAt: '壊れた日時' }), NOW)).toEqual({ apply: false, reason: 'badExpire' })
  })
  it('正: 同じ id のより新しい報が出ていれば、遅れて届いた報は当てない', () => {
    const list = [shown('n1', 'E1', '2026-11-02T11:00:00Z')]
    expect(quakeNoticeListDecision(list, notice(), NOW)).toEqual({ apply: false, reason: 'stale' })
  })
  it('対照: 同じ id でも同じか古い報なら置き換えに当て、別の id の新しい報は見ない', () => {
    expect(quakeNoticeListDecision([shown('n1', 'E1', '2026-11-02T10:00:00Z')], notice(), NOW)).toEqual({ apply: true, removeIds: [] })
    expect(quakeNoticeListDecision([shown('n2', 'E1', '2026-11-02T11:00:00Z')], notice(), NOW)).toEqual({ apply: true, removeIds: [] })
  })
})
