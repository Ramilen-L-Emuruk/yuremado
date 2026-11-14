// 海岸線の吹き出しに区域のコードを出すための配線（地物の属性 → 吹き出しの組み立て）。
// 地物の属性へ載せ忘れても、組み立て側（`tsunamiLinePopupHtml` の第 4 引数）には `undefined` が渡るだけで型も他のテストも通る。
import { describe, it, expect } from 'vitest'
import { buildTsunamiLinesFC, tsunamiGradeLabel, tsunamiLinePopupHtml } from './TsunamiLinesGL'
import { TSUNAMI_STYLE } from '../../utils/tsunamiStyle'
import { JA_MESSAGES } from '../../i18n/messages'
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
    const html = tsunamiLinePopupHtml('岩手県', '大津波警報', [], '210', JA_MESSAGES)
    expect(html).toContain('コード 210')
  })

  it('対照: コードを渡さなければ「コード」の行は出ない', () => {
    expect(tsunamiLinePopupHtml('岩手県', '大津波警報', [], undefined, JA_MESSAGES)).not.toContain('コード')
  })
})

// 海岸線の吹き出しの等級の語は、地物の属性の等級（`grade`）から辞書で引く。
describe('tsunamiGradeLabel', () => {
  it('正: 各等級は辞書の語になる', () => {
    expect(tsunamiGradeLabel('MajorWarning', JA_MESSAGES)).toBe('大津波警報')
    expect(tsunamiGradeLabel('Warning', JA_MESSAGES)).toBe('津波警報')
    expect(tsunamiGradeLabel('Watch', JA_MESSAGES)).toBe('津波注意報')
    expect(tsunamiGradeLabel('Forecast', JA_MESSAGES)).toBe('津波予報')
  })

  it('対照: 表に無い値・欠けた属性・原型の名前は「津波予報」の語に落とす', () => {
    for (const g of [undefined, null, 3, 'toString', 'constructor', '']) {
      expect(tsunamiGradeLabel(g, JA_MESSAGES)).toBe('津波予報')
    }
  })

  it('安全弁: 日本語の語は、地図の海岸線の色の表の語と同じ', () => {
    for (const g of ['MajorWarning', 'Warning', 'Watch', 'Forecast', 'Unknown'] as const) {
      expect(tsunamiGradeLabel(g, JA_MESSAGES)).toBe(TSUNAMI_STYLE[g].label)
    }
  })
})
