// 津波の区分を決める固定付加文の文を、原文から除く（→ docs/spec/quake-spec.md §3「地震カードには付加文を 1 つの枠で出す」）。
import { describe, it, expect } from 'vitest'
import { DOMESTIC_TSUNAMI_CODE_TEXT, domesticTsunamiCardForecastText, withoutDomesticTsunamiSentences } from './domesticTsunamiComment'
import type { DomesticTsunamiCode } from '../types/earthquake'

const EEW = 'この地震で緊急地震速報を発表しましたが、強い揺れは観測されませんでした。'
const entries = Object.entries(DOMESTIC_TSUNAMI_CODE_TEXT) as [DomesticTsunamiCode, string][]

describe('表の前提', () => {
  // 取り除く順で結果が変わらないための前提（ある文が別の文の一部なら、先に短いほうを消すと長いほうが壊れる）。
  it('どの文も別の文の一部になっていない', () => {
    for (const [a, ta] of entries) {
      for (const [b, tb] of entries) {
        if (a !== b) expect(tb.includes(ta), `${a} が ${b} に含まれる`).toBe(false)
      }
    }
  })
})

describe('withoutDomesticTsunamiSentences（読み上げ）', () => {
  it('区分の文をすべて除く', () => {
    for (const [, text] of entries) expect(withoutDomesticTsunamiSentences(text + EEW)).toBe(EEW)
  })
})

describe('domesticTsunamiCardForecastText（地震カード）', () => {
  // 正: 札が伝えきれないコードは、カード自身のコードの文を残す。
  it.each(['0211', '0212', '0213', '0214'] as const)('%s はそのコードの文を残す', code => {
    const own = DOMESTIC_TSUNAMI_CODE_TEXT[code]
    expect(domesticTsunamiCardForecastText(own + EEW, code)).toBe(own + EEW)
  })

  // 対照: 札が伝えきっているコードは除く。
  it.each(['0215', '0216', '0217', '0229', '0230'] as const)('%s はそのコードの文を除く', code => {
    expect(domesticTsunamiCardForecastText(DOMESTIC_TSUNAMI_CODE_TEXT[code] + EEW, code)).toBe(EEW)
  })

  // 安全弁: 残すのはカード自身のコードの文だけ。別のコードの文（原文が前の報のまま）は除く。
  it('カード自身のコードでない文は、残すコードの文でも除く', () => {
    expect(domesticTsunamiCardForecastText(DOMESTIC_TSUNAMI_CODE_TEXT['0212'] + EEW, '0215')).toBe(EEW)
  })

  // 安全弁: コードを持たない（区分を借りた・標準版）なら全部除く。
  it('コードが無ければ全部除く', () => {
    expect(domesticTsunamiCardForecastText(DOMESTIC_TSUNAMI_CODE_TEXT['0212'] + EEW, undefined)).toBe(EEW)
  })

  it('区分の文しか無ければ空文字', () => {
    expect(domesticTsunamiCardForecastText(DOMESTIC_TSUNAMI_CODE_TEXT['0215'], '0215')).toBe('')
  })
})
