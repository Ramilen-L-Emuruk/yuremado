import { describe, it, expect } from 'vitest'
import type { JMATsunami, TsunamiArea, TsunamiGrade, TsunamiObservation } from '../types/earthquake'
import { stepTsunamiState } from './tsunami'
import { ja } from '../i18n/messages/ja'
import {
  tsunamiCardOrderBasis, tsunamiReportDropped, isTsunamiSameGradeReport, nextTsunamiGrade, createTsunamiObsDisplayMemory,
  clearTsunamiObsDisplayMemory, rememberTsunamiObsDisplay, tsunamiObservationMarks, tsunamiIssueNotificationFor,
  tsunamiObservationNotificationFor, tsunamiEndNotificationFor, tsunamiPartialRetractionNotificationFor, partialRetractionKey,
} from './tsunamiNotifyTracker'

const area = (name: string, code: string, grade: TsunamiGrade): TsunamiArea =>
  ({ name, code, grade, immediate: false } as TsunamiArea)

const obs = (name: string, value?: number): TsunamiObservation =>
  value === undefined ? { name } : { name, height: { value, description: `${value}m` } }

function report(over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami', id: 't-1', eventId: '20240101161010', time: '2024-01-01T16:22:00+09:00',
    cancelled: false, issue: { source: '気象庁', time: '2024-01-01T16:22:00+09:00', type: 'Focus' },
    headType: 'VTSE41', areas: [area('石川県能登', '360', 'MajorWarning'), area('富山県', '350', 'Warning')],
    ...over,
  }
}

describe('通知を出すかの判定', () => {
  it('正: 等級を発表する報（VTSE41）は発表の通知を出す', () => {
    const r = report()
    expect(tsunamiIssueNotificationFor(r, tsunamiCardOrderBasis(r, undefined), ja)?.title).toBe('大津波警報')
  })

  it('対照: 津波情報（VTSE51）は区域を載せていても発表の通知を出さない（中身は直前の VTSE41 の写し）', () => {
    const r = report({ headType: 'VTSE51', id: 't-2' })
    expect(tsunamiIssueNotificationFor(r, tsunamiCardOrderBasis(r, undefined), ja)).toBeNull()
  })

  it('対照: 解除の報は発表の通知を出さない', () => {
    const r = report({ cancelled: true, cancelReason: 'lifted' })
    expect(tsunamiIssueNotificationFor(r, tsunamiCardOrderBasis(r, undefined), ja)).toBeNull()
  })

  it('正: 表示中の津波に向いた解除は解除の通知、誤報の取消は取消の通知', () => {
    const live = report()
    const lift = report({ id: 't-3', cancelled: true, cancelReason: 'lifted', areas: [] })
    expect(tsunamiEndNotificationFor(lift, stepTsunamiState(live, lift, null), ja)?.title).toBe('津波警報等の解除')
    const retract = report({ id: 't-4', cancelled: true, cancelReason: 'retracted', areas: [] })
    expect(tsunamiEndNotificationFor(retract, stepTsunamiState(live, retract, null), ja)?.title).toBe('津波警報等の取消')
  })

  it('安全弁: 別の津波の解除（表示中に当たらない）では終わりの通知を出さない', () => {
    const live = report()
    const other = report({ id: 't-5', eventId: '20240102000000', cancelled: true, cancelReason: 'lifted', areas: [] })
    const step = stepTsunamiState(live, other, null)
    expect(step.kind).toBe('ignored')
    expect(tsunamiEndNotificationFor(other, step, ja)).toBeNull()
  })

  it('正: 届いた時点で期限の過ぎた報は落とす', () => {
    const r = report({ validDateTime: '2024-01-01T18:00:00+09:00' })
    const now = new Date('2024-01-01T19:00:00+09:00')
    expect(tsunamiReportDropped(stepTsunamiState(undefined, r, now), r, now).dropped).toBe(true)
    expect(tsunamiReportDropped(stepTsunamiState(undefined, r, null), r, null).dropped).toBe(false)
  })
})

describe('等級の記憶', () => {
  it('正: 等級を読めない報（区域の無い観測情報）では進めない', () => {
    expect(nextTsunamiGrade('Warning', report({ areas: [] }))).toBe('Warning')
    expect(nextTsunamiGrade('Warning', report())).toBe('MajorWarning')
  })

  it('正: 区域の無い観測情報と、同じ等級の続報は「等級の動かない続報」、引き上げは違う', () => {
    expect(isTsunamiSameGradeReport(report({ areas: [] }), null)).toBe(true)
    expect(isTsunamiSameGradeReport(report(), 'MajorWarning')).toBe(true)
    expect(isTsunamiSameGradeReport(report(), 'Warning')).toBe(false)
  })
})

describe('観測点の印と観測の通知', () => {
  const vtse52 = (observations: TsunamiObservation[], id = 'o-1') =>
    report({ headType: 'VTSE52', id, areas: [], infoName: '沖合の津波観測に関する情報', observations })

  it('正: 初めて載った観測点に印が付き、観測の通知に挙がる', () => {
    const memory = createTsunamiObsDisplayMemory()
    const r = vtse52([obs('輪島港', 1.2), obs('珠洲市長橋')])
    const marks = tsunamiObservationMarks(r, memory, { sameGradeReport: true, newFire: false })
    expect(marks.entries.map(([n]) => n)).toEqual(['輪島港', '珠洲市長橋'])
    const n = tsunamiObservationNotificationFor(r, marks, tsunamiCardOrderBasis(r, undefined), ja)
    expect(n?.body).toContain('輪島港 1.2m')
  })

  it('対照: 同じ値の再送では印が付かず、観測の通知も出さない', () => {
    const memory = createTsunamiObsDisplayMemory()
    const first = vtse52([obs('輪島港', 1.2)])
    rememberTsunamiObsDisplay(first.observations!, memory)
    const again = vtse52([obs('輪島港', 1.2)], 'o-2')
    const marks = tsunamiObservationMarks(again, memory, { sameGradeReport: true, newFire: false })
    expect(marks.entries).toEqual([])
    expect(tsunamiObservationNotificationFor(again, marks, tsunamiCardOrderBasis(again, first), ja)).toBeNull()
  })

  it('正: 波高が上がった観測点は changed の印', () => {
    const memory = createTsunamiObsDisplayMemory()
    rememberTsunamiObsDisplay([obs('輪島港', 1.2)], memory)
    const marks = tsunamiObservationMarks(vtse52([obs('輪島港', 2.0)]), memory, { sameGradeReport: true, newFire: false })
    expect(marks.entries).toEqual([['輪島港', expect.objectContaining({ status: 'changed' })]])
  })

  it('安全弁: 新しい津波（newFire）では前の津波の記憶と比べず、全件を new で印付ける', () => {
    const memory = createTsunamiObsDisplayMemory()
    rememberTsunamiObsDisplay([obs('輪島港', 1.2)], memory)
    const r = report({ observations: [obs('輪島港', 1.2)] })
    const marks = tsunamiObservationMarks(r, memory, { sameGradeReport: false, newFire: true })
    expect(marks.entries).toEqual([['輪島港', expect.objectContaining({ status: 'new' })]])
  })

  it('安全弁: 等級を発表する報は観測の通知を出さない（発表の通知が担う）', () => {
    const memory = createTsunamiObsDisplayMemory()
    const r = report({ observations: [obs('輪島港', 1.2)] })
    const marks = tsunamiObservationMarks(r, memory, { sameGradeReport: false, newFire: true })
    expect(marks.entries.length).toBe(1)
    expect(tsunamiObservationNotificationFor(r, marks, tsunamiCardOrderBasis(r, undefined), ja)).toBeNull()
  })

  it('正: 記憶を落とすと全部空になる', () => {
    const memory = createTsunamiObsDisplayMemory()
    rememberTsunamiObsDisplay([obs('輪島港', 1.2), obs('富山')], memory)
    clearTsunamiObsDisplayMemory(memory)
    expect([memory.seenNames.size, memory.maxHeights.size, memory.reportedHeights.size]).toEqual([0, 0, 0])
  })
})

// 津波情報だけの取消の通知（2026-11-09 ユーザー選択「音は全部・通知は通知した報だけ (Recommended)」）。
//   正  : 観測情報を通知した報への取消は、電文の本文で出す／対照: 通知していない報への取消は出さない／
//   安全弁: 津波警報等の取消（VTSE41）はこの判定を通らない
describe('津波情報だけの取消の通知', () => {
  const retraction = (over: Partial<JMATsunami> = {}) => report({
    headType: 'VTSE51', id: 't-9', cancelled: true, cancelReason: 'retracted', infoName: '各地の満潮時刻・津波到達予想時刻に関する情報',
    cancelText: '先ほどの、各地の満潮時刻と津波到達予想時刻に関する情報を取り消します。', areas: [], ...over,
  })
  it('正: 観測情報を通知した報への取消は、題「津波情報の取消」・本文は電文のまま', () => {
    const r = retraction()
    const n = tsunamiPartialRetractionNotificationFor(r, new Set([partialRetractionKey(r)]), ja)!
    expect(n.title).toBe('津波情報の取消')
    expect(n.body).toBe('先ほどの、各地の満潮時刻と津波到達予想時刻に関する情報を取り消します。')
    // 本文が無ければ情報名で言う
    expect(tsunamiPartialRetractionNotificationFor(retraction({ cancelText: undefined }), new Set([partialRetractionKey(r)]), ja)!.body)
      .toBe('各地の満潮時刻・津波到達予想時刻に関する情報は取り消されました。')
  })
  it('対照: 観測情報を通知していない報への取消は出さない', () => {
    expect(tsunamiPartialRetractionNotificationFor(retraction(), new Set(), ja)).toBeNull()
  })
  it('正: 原因地震が加わって EventID が伸びた後の取消でも、同じ種類の観測を通知していれば出す', () => {
    const before = retraction({ eventId: '20240101161010' })
    const after = retraction({ eventId: '20240101161010 20240101161800' })
    expect(tsunamiPartialRetractionNotificationFor(after, new Set([partialRetractionKey(before)]), ja)).not.toBeNull()
  })
  it('対照: 別の種類（沖合の観測）を通知していても、津波情報の取消では出さない', () => {
    const r = retraction()
    expect(tsunamiPartialRetractionNotificationFor(r, new Set([partialRetractionKey(retraction({ headType: 'VTSE52' }))]), ja)).toBeNull()
  })
  it('安全弁: 津波警報等の取消（VTSE41）はこの判定では出さない', () => {
    const r = retraction({ headType: 'VTSE41' })
    expect(tsunamiPartialRetractionNotificationFor(r, new Set([partialRetractionKey(r)]), ja)).toBeNull()
  })
})
