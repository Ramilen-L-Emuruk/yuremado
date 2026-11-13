import { describe, expect, it, vi } from 'vitest'
import type { EEWAlert, JMATsunami, TsunamiArea } from '../types/earthquake'
import type { SWaveArrival } from '../hooks/useSWaveCountdown'
import { buildEewDockItems, buildTsunamiDockItem, homePrefectureCode } from './alertDock'
import { eewEventKey } from './eew'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'

function eew(o: { id: string; event: string; time: string; scaleTo?: number; operationStatus?: '訓練' | '試験'; cancelled?: boolean }): EEWAlert {
  return {
    kind: 'eew', id: o.id, time: o.time, test: false, origin: 'dmdata',
    earthquake: {
      originTime: o.time, arrivalTime: o.time, condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5, magnitudeType: 'Mj' },
    },
    severity: 'Warning', cancelled: o.cancelled === true,
    ...(o.operationStatus && { operationStatus: o.operationStatus }),
    issue: { eventId: o.event, serial: '1', time: o.time },
    areas: [
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: o.scaleTo ?? 50, kindCode: '10', arrivalTime: null },
      { pref: '大分県', name: '大分県南部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null },
    ],
  } as unknown as EEWAlert
}

function arrival(key: string, over: Partial<SWaveArrival['rows'][number]> = {}, source: SWaveArrival['source'] = 'telegram'): SWaveArrival {
  return {
    source,
    areaName: '宮崎県北部平野部',
    rows: [{ key, source: source === 'own' ? 'own' : 'telegram', hypocenterName: '日向灘', provisional: false, distanceKm: 80, etaSec: 12, arrived: false, noForecast: false, ...over }],
  } as unknown as SWaveArrival
}

describe('buildEewDockItems', () => {
  it('一番新しい速報だけに登録地点の段が付き、区域の予想震度と主要動の秒数を出す', () => {
    const older = eew({ id: 'a', event: 'e1', time: '2026-01-01T12:00:00Z' })
    const newer = eew({ id: 'b', event: 'e2', time: '2026-01-01T12:00:30Z' })
    const items = buildEewDockItems([older, newer], arrival(eewEventKey(newer)), ja)
    expect(items.map(i => i.key)).toEqual([eewEventKey(newer), eewEventKey(older)])
    expect(items[0].home).toMatchObject({ area: '宮崎県北部平野部', shake: '12秒' })
    expect(items[0].home?.chip?.text).toBeTruthy()
    expect(items[1].home).toBeNull()
  })

  it('到達済み・推定中は速報カードと同じ語にする', () => {
    const e = eew({ id: 'a', event: 'e1', time: '2026-01-01T12:00:00Z' })
    expect(buildEewDockItems([e], arrival(eewEventKey(e), { arrived: true }), ja)[0].home?.shake).toBe('到達済み')
    expect(buildEewDockItems([e], arrival(eewEventKey(e), { etaSec: null }), ja)[0].home?.shake).toBe('到達時間を推定中…')
  })

  // 対照: 地点の値（自前計算）を区域名で書かない。到達予測の出ていない区域も段を出さない
  it('自前計算の到達・到達予測の無い区域では登録地点の段を出さない', () => {
    const e = eew({ id: 'a', event: 'e1', time: '2026-01-01T12:00:00Z' })
    expect(buildEewDockItems([e], arrival(eewEventKey(e), {}, 'own'), ja)[0].home).toBeNull()
    expect(buildEewDockItems([e], arrival(eewEventKey(e), { noForecast: true }), ja)[0].home).toBeNull()
    expect(buildEewDockItems([e], null, ja)[0].home).toBeNull()
  })

  // 安全弁: 取消は帯からすぐ消す・訓練の札は落とさない
  it('取り消された速報は出さず、訓練報には札を付ける', () => {
    const cancelled = eew({ id: 'a', event: 'e1', time: '2026-01-01T12:00:00Z', cancelled: true })
    const training = eew({ id: 'b', event: 'e2', time: '2026-01-01T12:00:00Z', operationStatus: '訓練' })
    const items = buildEewDockItems([cancelled, training], null, ja)
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('訓練報')
  })
})

function area(o: Partial<TsunamiArea> & { name: string; grade: TsunamiArea['grade'] }): TsunamiArea {
  return { immediate: false, ...o } as TsunamiArea
}

function tsunami(areas: TsunamiArea[], over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami', id: 't1', eventId: 'ev', time: '2026-01-01T12:05:00Z', cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:05:00Z', type: 'Focus' },
    areas,
    ...over,
  } as unknown as JMATsunami
}

const ZONES = { '千葉県九十九里・外房': ['12'], '千葉県内房': ['12'], '東京湾内湾': ['12', '13'], '岩手県': ['03'] }

describe('buildTsunamiDockItem', () => {
  it('登録地点の県で一番重い区域を出し、残りの区域を数える', () => {
    const t = tsunami([
      area({ name: '岩手県', grade: 'MajorWarning', maxHeight: { description: '巨大' } }),
      area({ name: '千葉県内房', grade: 'Watch', maxHeight: { description: '1m', value: 1 } }),
      area({ name: '千葉県九十九里・外房', grade: 'Warning', maxHeight: { description: '3m', value: 3 }, firstHeight: { condition: 'ただちに津波来襲と予測' } }),
      area({ name: '東京湾内湾', grade: 'Watch', maxHeight: { description: '1m', value: 1 } }),
    ])
    const item = buildTsunamiDockItem([t], '12', ZONES, ja)!
    expect(item.title).toBe('大津波警報')
    expect(item.chip?.text).toBe('巨大')
    expect(item.home).toMatchObject({ zone: '千葉県九十九里・外房', arrival: { label: '到達予想', text: 'ただちに津波来襲と予測' }, rest: 2 })
    expect(item.home?.height?.text).toBe('3m')
  })

  // 対照: 県が引けない・県に発表が無いときは登録地点の段を出さない
  it('登録地点の県に発表が無ければ段を出さない', () => {
    const t = tsunami([area({ name: '岩手県', grade: 'Warning' })])
    expect(buildTsunamiDockItem([t], '12', ZONES, ja)!.home).toBeNull()
    expect(buildTsunamiDockItem([t], null, ZONES, ja)!.home).toBeNull()
  })

  it('第1波は「到達を確認」の区域だけを数え、「到達中と推測」は数えない', () => {
    const t = tsunami([
      area({ name: '岩手県', grade: 'Warning', firstHeight: { condition: '第１波の到達を確認' } }),
      area({ name: '千葉県内房', grade: 'Watch', firstHeight: { condition: '津波到達中と推測' } }),
    ])
    expect(buildTsunamiDockItem([t], null, ZONES, ja)!.firstWave).toEqual({ first: '岩手県', rest: 0 })
  })

  // 安全弁: 第1波の判定を表から引いても、半角の「第1波」の語も拾う（表に両方の綴りがある）
  it('半角の「第1波の到達を確認」も第1波として数える', () => {
    const t = tsunami([area({ name: '岩手県', grade: 'Warning', firstHeight: { condition: '第1波の到達を確認' } })])
    expect(buildTsunamiDockItem([t], null, ZONES, ja)!.firstWave).toEqual({ first: '岩手県', rest: 0 })
  })

  it('等級の読める区域が無ければ帯を出さず、記録を残す', async () => {
    const { log } = await import('./logger')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const t = tsunami([area({ name: '岩手県', grade: 'Unknown' })], { id: 'unknown-only' } as Partial<JMATsunami>)
    expect(buildTsunamiDockItem([t], null, ZONES, ja)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  // 安全弁: 解除・取消の報だけなら帯を出さない
  it('取り消し・解除された津波は出さない', () => {
    const t = tsunami([area({ name: '岩手県', grade: 'Warning' })], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>)
    expect(buildTsunamiDockItem([t], null, ZONES, ja)).toBeNull()
  })
})

describe('homePrefectureCode', () => {
  // 北緯 33.5〜34.0 度・東経 133.0〜133.5 度の四角を「高知県」とする（頂点は 0.01 度おき＝約 1 km）
  const edge: [number, number][] = []
  for (let i = 0; i <= 50; i++) edge.push([33.5, 133.0 + i * 0.01])
  for (let i = 0; i <= 50; i++) edge.push([33.5 + i * 0.01, 133.5])
  for (let i = 0; i <= 50; i++) edge.push([34.0, 133.5 - i * 0.01])
  for (let i = 0; i <= 50; i++) edge.push([34.0 - i * 0.01, 133.0])
  const shapes = { 高知県: { rings: [edge] } }
  const prefs = [{ name: '高知県', code: '39' }]

  it('県の境界の中なら、その県を返す', () => {
    expect(homePrefectureCode(33.7, 133.2, shapes, prefs)).toBe('39')
  })

  // 簡略化した境界の外（海の側）に落ちた海岸近くの地点
  it('境界の外でも 5 km 以内なら、最寄りの県へ寄せる', () => {
    expect(homePrefectureCode(33.48, 133.2, shapes, prefs)).toBe('39')
  })

  // 安全弁: 遠く離れた地点を、いちばん近い県へ寄せない
  it('5 km より離れていれば、どの県も返さない', () => {
    expect(homePrefectureCode(33.0, 133.2, shapes, prefs)).toBeNull()
  })
})

// 段 9b: 語はいま出している言語の辞書から引く。区域名・震源名・県名は電文のまま
describe('帯の語は辞書から引く', () => {
  it('英語の辞書では区分・訓練の札・主要動の秒数・到達済みを英語で組む', () => {
    const e = eew({ id: 'a', event: 'e1', time: '2026-01-01T12:00:00Z', operationStatus: '訓練' })
    const [item] = buildEewDockItems([e], arrival(eewEventKey(e)), en)
    expect(Object.values(en.realtime.eewKind)).toContain(item.title)
    expect(item.status).toBe('Drill')
    expect(item.home).toMatchObject({ area: '宮崎県北部平野部', shake: '12 s' })
    expect(buildEewDockItems([e], arrival(eewEventKey(e), { arrived: true }), en)[0].home?.shake).toBe('Arrived')
    expect(item.hypocenter?.name).toBe('日向灘')
  })

  it('英語の辞書では「ただちに津波来襲と予測」を名目なしの Arriving soon にし、等級名と高さを訳す', () => {
    const t = tsunami([
      area({ name: '岩手県', grade: 'MajorWarning', maxHeight: { description: '巨大' } }),
      area({ name: '千葉県九十九里・外房', grade: 'Warning', maxHeight: { description: '3m', value: 3 }, firstHeight: { condition: 'ただちに津波来襲と予測' } }),
    ])
    const item = buildTsunamiDockItem([t], '12', ZONES, en)!
    expect(item.title).toBe('Major Tsunami Warning')
    expect(item.chip?.text).toBe('Huge')
    expect(item.home).toMatchObject({ zone: '千葉県九十九里・外房', arrival: { label: null, text: 'Arriving soon' } })
    expect(item.home?.grade.text).toBe('Tsunami Warning')
  })

  // 対照: 到達予想の時刻があれば名目つきで出す（英語でも名目は付く）
  it('到達予想の時刻がある区域は英語でも名目 Est. arrival を付ける', () => {
    const t = tsunami([area({ name: '千葉県内房', grade: 'Watch', firstHeight: { arrivalTime: '2026-01-01T12:30:00Z', condition: '' } })])
    expect(buildTsunamiDockItem([t], '12', ZONES, en)!.home?.arrival?.label).toBe('Est. arrival')
  })
})
