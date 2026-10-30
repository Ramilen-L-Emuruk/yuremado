// 等級は据え置きのまま予想波高だけが動いた続報の、判定（tsunami.ts）と読み上げ文（ttsText.ts）。
// フックの結線は `hooks/useLiveEventHandler.tsunamiForecastHeight.test.ts` が見ている。
import { describe, it, expect } from 'vitest'
import { forecastHeightChangedAreas, rememberForecastHeights } from './tsunami'
import { tsunamiForecastHeightChangeToSegments, tsunamiAreaGradeChangeActionSegments } from './ttsText'
import { joinSegments } from './ttsFollow'
import type { JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

function area(name: string, code: string, grade: TsunamiGrade, height?: string, revise?: string): TsunamiArea {
  return {
    name, code, grade, immediate: false,
    ...(height !== undefined && { maxHeight: { description: height, ...(revise && { revise }) } }),
  } as TsunamiArea
}

describe('forecastHeightChangedAreas', () => {
  it('正: 声にした値から変わった区域だけを返す', () => {
    const spoken = new Map([['210', '巨大'], ['220', '巨大']])
    const changed = forecastHeightChangedAreas([
      area('岩手県', '210', 'MajorWarning', '5m'),
      area('宮城県', '220', 'MajorWarning', '巨大'),
    ], spoken)
    expect(changed.map(a => a.name)).toEqual(['岩手県'])
  })

  it('正: 記憶の無い区域は「更新」の印があれば変わったとみなす', () => {
    expect(forecastHeightChangedAreas([area('茨城県', '300', 'Warning', '3m', '更新')], new Map()).map(a => a.name)).toEqual(['茨城県'])
  })

  it('対照: 記憶の無い区域は「追加」や印なしなら返さない', () => {
    expect(forecastHeightChangedAreas([
      area('茨城県', '300', 'Warning', '3m', '追加'),
      area('千葉県九十九里・外房', '310', 'Warning', '3m'),
    ], new Map())).toEqual([])
  })

  it('安全弁: 予想波高を持たない区域と、等級の分からない区域は返さない', () => {
    const spoken = new Map([['210', '5m']])
    expect(forecastHeightChangedAreas([
      area('岩手県', '210', 'MajorWarning'),
      area('宮城県', '220', 'Unknown', '5m', '更新'),
    ], spoken)).toEqual([])
  })

  it('rememberForecastHeights は予想波高のある区域だけを進め、無い区域の記憶は消さない', () => {
    const spoken = new Map([['210', '巨大']])
    rememberForecastHeights([area('岩手県', '210', 'MajorWarning'), area('宮城県', '220', 'MajorWarning', '10m')], spoken)
    expect([...spoken]).toEqual([['210', '巨大'], ['220', '10m']])
  })
})

describe('tsunamiForecastHeightChangeToSegments', () => {
  it('等級ごとに 1 文にして「また、」で継ぐ（上の等級から）', () => {
    const text = joinSegments(tsunamiForecastHeightChangeToSegments([
      area('茨城県', '300', 'Warning', '3m'),
      area('岩手県', '210', 'MajorWarning', '10m超'),
    ], []))
    expect(text).toBe('予想される津波の高さが変わりました。岩手県で10メートル超が予想されています。また、茨城県で3メートルが予想されています。')
  })

  it('動いた区域が無ければ空', () => {
    expect(tsunamiForecastHeightChangeToSegments([], [])).toEqual([])
  })
})

describe('tsunamiAreaGradeChangeActionSegments', () => {
  const report = (areas: TsunamiArea[], warningComments?: JMATsunami['warningComments']) =>
    ({ areas, ...(warningComments && { warningComments }) } as JMATsunami)

  it('正: 警報等が残っていれば、残っている最上位の等級の呼びかけを返す', () => {
    const text = joinSegments(tsunamiAreaGradeChangeActionSegments(report([
      area('石川県能登', '360', 'Watch'), area('福岡県日本海沿岸', '711', 'Forecast'),
    ])))
    expect(text.length).toBeGreaterThan(0)
    expect(text).toBe(joinSegments(tsunamiAreaGradeChangeActionSegments(report([area('佐賀県北部', '720', 'Watch')]))))
  })

  it('対照: 予報だけが残る報には足さない', () => {
    expect(tsunamiAreaGradeChangeActionSegments(report([area('福岡県日本海沿岸', '711', 'Forecast')]))).toEqual([])
  })
})
