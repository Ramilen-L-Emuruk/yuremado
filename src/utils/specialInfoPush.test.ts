import { describe, expect, it } from 'vitest'

import type {
  JMAEarthquakeCount, JMAEstimatedIntensity, JMAInternationalTsunami, JMALpgm, JMANankaiCommentary, JMAQuakeNotice,
} from '../types/earthquake'
import { notificationRegionAllowed } from './notificationGate'
import { planSpecialInfoNotification } from './specialInfoPush'

const lpgm = (over: Partial<JMALpgm> = {}): JMALpgm => ({
  id: 'l1', eventId: '20260101000000', time: '2026-01-01T00:05:00+09:00', originTime: '2026-01-01T00:00:00+09:00',
  maxClass: 2, cancelled: false, hypocenter: { name: '石川県能登地方' },
  prefs: [{ code: '17', name: '石川県', maxLgInt: 2 }, { code: '16', name: '富山県', maxLgInt: 1 }],
  ...over,
} as JMALpgm)

const noName = () => undefined

describe('planSpecialInfoNotification', () => {
  it('長周期の発表は地震情報の設定に従い、電文の都道府県で絞り、取消のために覚える', () => {
    const plan = planSpecialInfoNotification({ kind: 'lpgm', data: lpgm() }, noName)!
    expect(plan.kind).toBe('quake')
    expect(plan.prefectures).toEqual(['17', '16'])
    expect(plan.remember).toBe('lpgm:20260101000000')
    expect(plan.requires).toBeUndefined()
  })
  it('長周期の取消は、発表を通知していたときだけ出す（地名は発表で覚えた値）', () => {
    const plan = planSpecialInfoNotification({ kind: 'lpgm', data: lpgm({ cancelled: true, prefs: undefined }) }, id => (id === '20260101000000' ? '石川県能登地方' : undefined))!
    expect(plan.requires).toBe('lpgm:20260101000000')
    expect(plan.remember).toBeUndefined()
    expect(plan.notification.tag).toBe(planSpecialInfoNotification({ kind: 'lpgm', data: lpgm() }, noName)!.notification.tag)
  })
  const commentary = (serialName: string, cancelled = false) =>
    ({ id: 'c1', eventId: 'e', cancelled, serialName, headline: '南海トラフ地震関連解説情報', summary: '要約' } as unknown as JMANankaiCommentary)
  it('正: 定例の解説は定例の設定（nankaiRoutine）に従い、解説情報の音・読み上げには従わない', () => {
    const plan = planSpecialInfoNotification({ kind: 'nankaiCommentary', data: commentary('定例解説') }, noName)!
    expect(plan.kind).toBe('nankaiRoutine')
    expect(plan.commentary).toBeUndefined()
    expect(plan.remember).toBe('nankaiCommentary:c1')
    expect(plan.notification).toEqual({ title: '南海トラフ地震関連解説情報', body: '要約', tag: 'nankai-commentary', open: null })
  })
  it('対照: 臨時の解説は今どおり南海トラフの設定と解説情報の音・読み上げに従う', () => {
    const plan = planSpecialInfoNotification({ kind: 'nankaiCommentary', data: commentary('臨時解説') }, noName)!
    expect(plan.kind).toBe('nankai')
    expect(plan.commentary).toBe(true)
    expect(plan.prefectures).toBeNull()
  })
  it('安全弁: 解説情報の取消は発表を通知したものにだけ出し、種別名が定例なら定例の設定・それ以外は臨時の設定に従う', () => {
    const routine = planSpecialInfoNotification({ kind: 'nankaiCommentary', data: commentary('定例解説', true) }, noName)!
    expect(routine.kind).toBe('nankaiRoutine')
    expect(routine.requires).toBe('nankaiCommentary:c1')
    // 名称が読めず '解説情報' で埋まっても、コード 200 なら定例
    const byCode = planSpecialInfoNotification({ kind: 'nankaiCommentary', data: { ...commentary('解説情報', true), serialCode: '200' } }, noName)!
    expect(byCode.kind).toBe('nankaiRoutine')
    const other = planSpecialInfoNotification({ kind: 'nankaiCommentary', data: commentary('解説情報', true) }, noName)!
    expect(other.kind).toBe('nankai')
    expect(other.commentary).toBe(true)
    expect(other.requires).toBe('nankaiCommentary:c1')
  })
  it('お知らせはお知らせの設定に従い、地域で絞らず、本文は電文の見出し文・取消は発表を通知したものにだけ出す', () => {
    // 取消は別の電文なので id（作成時刻まで含む）は発表と違う。鍵は EventID で揃う
    const notice = (cancelled: boolean) => ({
      id: cancelled ? 'dmdata-quake-notice-20260101100500-2026-01-01T01:30:00Z' : 'dmdata-quake-notice-20260101100500-2026-01-01T01:05:12Z',
      eventId: '20260101100500', headline: ' 和歌山県の自治体震度データ入電停止のお知らせ ', cancelled,
    } as unknown as JMAQuakeNotice)
    const plan = planSpecialInfoNotification({ kind: 'quakeNotice', data: notice(false) }, noName)!
    expect(plan.kind).toBe('quakeNotice')
    expect(plan.prefectures).toBeNull()
    expect(plan.remember).toBe('quakeNotice:20260101100500')
    expect(plan.notification).toEqual({
      title: '地震・津波に関するお知らせ', body: '和歌山県の自治体震度データ入電停止のお知らせ', tag: 'quake-notice', open: null,
    })
    const cancel = planSpecialInfoNotification({ kind: 'quakeNotice', data: notice(true) }, noName)!
    expect(cancel.requires).toBe(plan.remember)
    expect(cancel.notification).toEqual({
      title: '地震・津波に関するお知らせ 取消', body: '地震・津波に関するお知らせは取り消されました', tag: 'quake-notice', open: null,
    })
  })
  it('地震回数と推計震度は地域で絞らない（推計は元の地震で絞る形にするまで）', () => {
    const count = { id: 'n1', eventId: 'e', cancelled: false, headline: '', items: [], time: '', reportDateTime: '' } as unknown as JMAEarthquakeCount
    expect(planSpecialInfoNotification({ kind: 'earthquakeCount', data: count }, noName)!.prefectures).toBeNull()
    const ei = { id: 'i', arrivalTime: '2026-01-01T00:00:00+09:00' } as unknown as JMAEstimatedIntensity
    expect(planSpecialInfoNotification({ kind: 'estimatedIntensity', data: ei, isNew: true }, noName)!.prefectures).toBeNull()
  })
  it('国際津波関連情報は津波の設定に従い、地域で絞らず、本文は読み上げの文から名乗りを除いたもの', () => {
    const x = {
      id: 'w', title: 'TSUNAMI BULLETIN NUMBER 001', time: '2020-12-25T00:03:00.000Z', originTime: '2020-12-24T23:43:00.000Z',
      isCommunicationsTest: false, text: '', epicenter: { latitude: 13.9, longitude: 120.5 }, magnitude: 6.5, evaluation: 'verySmall',
    } as JMAInternationalTsunami
    const plan = planSpecialInfoNotification({ kind: 'internationalTsunami', data: x }, noName)!
    expect(plan.kind).toBe('tsunami')
    expect(plan.prefectures).toBeNull()
    expect(plan.notification.title).toBe('国際津波関連情報')
    expect(plan.notification.body).toBe('25日8時43分頃、北緯13.9度、東経120.5度で発生したマグニチュード6.5の地震について、被害をもたらす津波の可能性は非常に小さいと発表されました。')
    expect(plan.notification.open).toEqual({ tab: 'earthquake', wepa60: '2020-12-24T23:43:00.000Z', lat: 13.9, lon: 120.5 })
    // 結べた地震カードの震源名があれば、それで言う
    expect(planSpecialInfoNotification({ kind: 'internationalTsunami', data: x, quakeName: 'フィリピン諸島' }, noName)!.notification.body)
      .toMatch(/^25日8時43分頃、フィリピン諸島で発生した/)
    // 通信試験は開き先を持たない
    const test = { ...x, isCommunicationsTest: true, title: 'NWPTA COMMUNICATIONS TEST', originTime: undefined }
    const testPlan = planSpecialInfoNotification({ kind: 'internationalTsunami', data: test }, noName)!
    expect(testPlan.notification.body).toBe('通信試験です。')
    expect(testPlan.notification.open).toBeNull()
    // 通信試験は試験報を受け取る受け手にだけ出す印が付く。地震の報には付かない
    expect(testPlan.test).toBe(true)
    expect(plan.test).toBeUndefined()
  })
  it('推計震度の時刻は端末の時間帯によらず日本時間で書く', () => {
    const ei = { id: 'i', arrivalTime: '2026-01-01T15:04:00Z' } as unknown as JMAEstimatedIntensity
    expect(planSpecialInfoNotification({ kind: 'estimatedIntensity', data: ei, isNew: true }, noName)!.notification.body)
      .toBe('0時04分頃発生した地震の推計震度分布図を受信しました')
  })
})

describe('notificationRegionAllowed', () => {
  it('正: 選んだ県に当たれば通す・地域を選んでいなければ全国', () => {
    expect(notificationRegionAllowed({ notifyPrefectures: ['17'] }, ['16', '17'])).toBe(true)
    expect(notificationRegionAllowed({ notifyPrefectures: [] }, ['47'])).toBe(true)
  })
  it('対照: 選んだ県に当たらなければ止める', () => {
    expect(notificationRegionAllowed({ notifyPrefectures: ['13'] }, ['16', '17'])).toBe(false)
  })
  it('安全弁: 地域を持たない通知は絞らない', () => {
    expect(notificationRegionAllowed({ notifyPrefectures: ['13'] }, null)).toBe(true)
  })
})
