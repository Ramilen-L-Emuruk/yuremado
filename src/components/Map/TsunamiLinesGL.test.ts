// 海岸線の吹き出しに区域のコードを出すための配線（地物の属性 → 吹き出しの組み立て）。
// 地物の属性へ載せ忘れても、組み立て側（`tsunamiLinePopupHtml` の第 4 引数）には `undefined` が渡るだけで型も他のテストも通る。
import { describe, it, expect } from 'vitest'
import { buildTsunamiLinesFC, tsunamiLinePopupHtml } from './TsunamiLinesGL'
import type { TsunamiLine } from '../../hooks/useTsunamiLayerData'

const line: TsunamiLine = {
  name: '岩手県',
  grade: 'MajorWarning',
  segments: [[[39.6, 141.95], [39.7, 141.96]]],
  area: { name: '岩手県', code: '210', grade: 'MajorWarning', immediate: false },
} as TsunamiLine

describe('海岸線の地物に区域のコードを載せる', () => {
  it('正: 属性に区域のコードを持つ', () => {
    expect(buildTsunamiLinesFC([line], 1).features[0].properties?.code).toBe('210')
  })

  it('属性のコードを渡すと吹き出しの末尾に「コード」の行が出る', () => {
    const html = tsunamiLinePopupHtml('岩手県', '大津波警報', [], '210')
    expect(html).toContain('コード 210')
  })

  it('対照: コードを渡さなければ「コード」の行は出ない', () => {
    expect(tsunamiLinePopupHtml('岩手県', '大津波警報', [], undefined)).not.toContain('コード')
  })
})
