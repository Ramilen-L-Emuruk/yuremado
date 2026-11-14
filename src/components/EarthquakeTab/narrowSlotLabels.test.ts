import { describe, it, expect } from 'vitest'
import { orAboveWord, orAboveTilePrefix } from './QuakeListRow'
import { lpgmClassTagLabel, lpgmClassLabel } from '../../utils/lpgm'
import { intensityLabel, intensityShortLabel } from '../../utils/intensity'
import { ja } from '../../i18n/messages/ja'
import { en } from '../../i18n/messages/en'
import { es } from '../../i18n/messages/es'
import { ptBR } from '../../i18n/messages/ptBR'
import { ko } from '../../i18n/messages/ko'
import { zhHans } from '../../i18n/messages/zhHans'
import { zhHant } from '../../i18n/messages/zhHant'

// 幅の決まった欄の短い語（2026-11-14・11-15 ユーザー選択。docs/spec/i18n-spec.md「幅の決まった欄の語は短い形」）
const SHORT = { en: en.formats, es: es.formats, ptBR: ptBR.formats }
const SAME = { ja: ja.formats, ko: ko.formats, zhHans: zhHans.formats, zhHant: zhHant.formats }

describe('震度の枠の「以上」', () => {
  it('正: 英西葡は数字の前に「≥」を付け、下に添える語を出さない', () => {
    for (const f of Object.values(SHORT)) {
      expect(orAboveTilePrefix(true, f)).toBe('≥')
      expect(orAboveWord(f)).toBe('')
    }
  })
  it('対照: 「以上」でない枠には記号を付けない', () => {
    for (const f of [...Object.values(SHORT), ...Object.values(SAME)]) expect(orAboveTilePrefix(false, f)).toBe('')
  })
  it('安全弁: 日韓中は今までどおり下に「以上」を添え、記号は付けない', () => {
    expect(orAboveWord(ja.formats)).toBe('以上')
    expect(orAboveWord(ko.formats)).toBe('이상')
    expect(orAboveWord(zhHans.formats)).toBe('以上')
    expect(orAboveWord(zhHant.formats)).toBe('以上')
    for (const f of Object.values(SAME)) expect(orAboveTilePrefix(true, f)).toBe('')
  })
})

describe('長周期の階級の札', () => {
  it('正: 英西葡は「Cl. 1」', () => {
    for (const f of Object.values(SHORT)) expect(lpgmClassTagLabel(1, f)).toBe('Cl. 1')
  })
  it('対照: 読めない階級は短い「不明」の札', () => {
    expect(lpgmClassTagLabel(-1, en.formats)).toBe('Cl. ?')
  })
  it('安全弁: 日韓中の札は正式な呼び名と同じ字', () => {
    for (const f of Object.values(SAME)) {
      for (const cls of [1, 2, 3, 4]) expect(lpgmClassTagLabel(cls, f)).toBe(lpgmClassLabel(cls, f))
    }
  })
})

describe('震度の列の未入電の「以上」', () => {
  it('正: 英西葡は「≥5-」', () => {
    for (const f of Object.values(SHORT)) expect(f.orAboveShort(intensityShortLabel(45, f))).toBe('≥5-')
  })
  it('安全弁: 日韓中は正式な「以上」の形と同じ字', () => {
    for (const f of Object.values(SAME)) {
      expect(f.orAboveShort(intensityShortLabel(45, f))).toBe(f.orAbove(intensityLabel(45, f)))
    }
  })
})
