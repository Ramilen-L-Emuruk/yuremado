import { describe, expect, it } from 'vitest'

import type { EarthquakePoint, Hypocenter, JMAQuake } from '../types/earthquake'
import { depthText } from './formatters'
import { ja } from '../i18n/messages/ja'
import { tailYearFromQuakes } from './hypocenterTail'

// 2026-11-05 00:00 JST（カタログの終端）から 11-06 12:00 JST まで取った
const FROM = Date.UTC(2026, 10, 4, 15)
const UNTIL = Date.UTC(2026, 10, 6, 3)

function quake(time: string, h: Partial<Hypocenter> = {}, maxScale = 30, points: Partial<EarthquakePoint>[] = []): JMAQuake {
  return {
    kind: 'quake', id: time, time,
    issue: { source: '', time, type: 'DetailScale', correct: 'None' },
    earthquake: {
      time,
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 3.1, ...h },
      maxScale, domesticTsunami: 'None',
    },
    points,
  } as unknown as JMAQuake
}

describe('電文の地震からカタログの末尾の年を作る', () => {
  // 正: 範囲の地震だけを時刻順に並べ、数値の列と吹き出しの語をそろえて持つ。
  it('範囲の地震だけを時刻順に入れ、時刻は分まで・震度は電文の階級で書く', () => {
    const y = tailYearFromQuakes([
      quake('2026-11-05T12:34:00+09:00', { name: '茨城県南部' }, 40),
      quake('2026-11-05T01:02:00+09:00'),
    ], FROM, UNTIL)
    expect(y.source).toBe('telegram')
    expect(y.count).toBe(2)
    expect(Array.from(y.timeMs)).toEqual([Date.parse('2026-11-05T01:02:00+09:00'), Date.parse('2026-11-05T12:34:00+09:00')])
    expect(y.telegramLabels?.map((l) => l.time)).toEqual(['2026/11/05 01:02', '2026/11/05 12:34'])
    expect(y.telegramLabels?.map((l) => l.intensity)).toEqual([{ scale: 30, orAbove: false }, { scale: 40, orAbove: false }])
    expect(y.names).toEqual(['石川県能登地方', '茨城県南部'])
    expect(Array.from(y.nameIdx)).toEqual([0, 1])
    expect(y.coveredThroughMs).toBe(UNTIL)
  })

  // 対照: 終端より前（年ファイルの側にある）・取った範囲より後・震央の座標が無い地震は入れない。
  it('終端より前・範囲より後・座標の無い地震は入れない', () => {
    const y = tailYearFromQuakes([
      quake('2026-11-04T23:59:00+09:00'),
      quake('2026-11-06T12:00:00+09:00'),
      quake('2026-11-05T03:00:00+09:00', { latitude: NaN, longitude: NaN }),
      quake('2026-11-05T00:00:00+09:00'),
    ], FROM, UNTIL)
    expect(y.count).toBe(1)
    expect(y.telegramLabels?.[0].time).toBe('2026/11/05 00:00')
  })

  // 安全弁: 数値の列で表せない電文の値を落とさない（語は吹き出しを開いたときの言語で組む）。
  it('巨大地震の説明・700km以上・5弱以上（未入電）・震源決定機関を値に残す', () => {
    const y = tailYearFromQuakes([
      quake('2026-11-05T05:00:00+09:00', { magnitude: NaN, magnitudeCondition: 'Ｍ８を超える巨大地震' }, 45, [{ scale: 45, unreceived: true }]),
      quake('2026-11-05T06:00:00+09:00', { depth: 700, depthAtLeast: true, source: 'ＵＳＧＳ' }),
      quake('2026-11-05T07:00:00+09:00', { magnitude: NaN, depth: -1 }, -1),
    ], FROM, UNTIL)
    const [huge, deep, unknown] = y.telegramLabels!
    expect(huge.magnitude).toEqual({ value: NaN, condition: 'Ｍ８を超える巨大地震', type: undefined })
    expect(huge.intensity).toEqual({ scale: 45, orAbove: true })
    expect(Number.isNaN(y.magnitude[0])).toBe(true)
    expect(deep.depth).toEqual({ km: 700, atLeast: true })
    expect(deep.source).toBe('ＵＳＧＳ')
    expect(y.external[1]).toBe(1)
    expect(y.depth[1]).toBe(700)
    expect(unknown.magnitude.condition).toBeUndefined()
    expect(Number.isNaN(unknown.magnitude.value)).toBe(true)
    expect(unknown.depth).toBeNull()
    expect(unknown.intensity).toBeNull()
    expect(Number.isNaN(y.depth[2])).toBe(true)
  })

  it('深さ 0 は値 0 のまま残す（吹き出しで「ごく浅い」と組む）', () => {
    const depth = tailYearFromQuakes([quake('2026-11-05T05:00:00+09:00', { depth: 0 })], FROM, UNTIL).telegramLabels?.[0].depth
    expect(depth).toEqual({ km: 0, atLeast: false })
    expect(depthText(depth!.km, depth!.atLeast, ja.formats)).toBe('ごく浅い')
  })
})
