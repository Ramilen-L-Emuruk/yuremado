import { describe, expect, it } from 'vitest'
import type { CorrectType, DomesticTsunami, DomesticTsunamiCode } from '../types/earthquake'
import { ja } from './messages/ja'
import { en } from './messages/en'
import { es } from './messages/es'
import { ko } from './messages/ko'
import { ptBR } from './messages/ptBR'
import { zhHans } from './messages/zhHans'
import { zhHant } from './messages/zhHant'
import {
  INTENSITY_SCALES_ASC,
  getEewAreaIntensityLabel,
  getIntensityLabel,
  getIntensityLabelWithApproxAbove,
  getIntensityLabelWithOrAbove,
  intensityLabel,
  intensityLabelWithApproxAbove,
  intensityLabelWithOrAbove,
  intensityShortLabel,
} from '../utils/intensity'
import { getLpgmClassLabel, getLpgmClassLabelWithApproxAbove, lpgmClassLabel, lpgmClassLabelWithApproxAbove } from '../utils/lpgm'
import {
  NON_JMA_MARK_TITLE,
  QUAKE_ARRIVAL_TIME_LABEL,
  QUAKE_ARRIVAL_TIME_UNKNOWN,
  QUAKE_ORIGIN_TIME_LABEL,
  TSUNAMI_WARNING_GROUP_TITLE,
  coordinateText,
  correctTypeText,
  depthText,
  domesticTsunamiText,
  formatCoordinate,
  formatCorrectType,
  formatDepth,
  formatDomesticTsunami,
  formatHypocenterSource,
  formatMagnitude,
  formatMagnitudeWithCondition,
  formatQuakeTime,
  formatQuakeTimeLabeled,
  magnitudeHeading,
  magnitudeHeadingText,
  magnitudeText,
  magnitudeConditionText,
  magnitudeWithConditionText,
  formatMagnitudeCondition,
  quakeTimeLabeledText,
  quakeTimeText,
} from '../utils/formatters'

/**
 * 日本語の書式の語は 2 か所にある —— 画面が読む辞書（`ja.formats`）と、読み上げ・通知・中継が使う
 * `utils` の日本語の関数（辞書を読まない。→ `intensity.ts`・`formatters.ts` の冒頭）。
 * **同じ字面であること**をここで確かめる。片方だけ直すと、画面と読み上げ・通知で語が食い違う。
 */
describe('日本語の書式の語は、辞書と日本語の関数で同じ字面', () => {
  const w = ja.formats
  const scales = [-1, ...INTENSITY_SCALES_ASC, 99]

  it('震度の札・以上・程度以上', () => {
    for (const s of scales) {
      expect(intensityLabel(s, w)).toBe(getIntensityLabel(s))
      expect(intensityShortLabel(s, w)).toBe(getIntensityLabel(s))
      expect(intensityLabelWithOrAbove(s, true, w)).toBe(getIntensityLabelWithOrAbove(s, true))
      expect(intensityLabelWithApproxAbove(s, true, w)).toBe(getIntensityLabelWithApproxAbove(s, true))
    }
    expect(getEewAreaIntensityLabel(30, 40, false, w)).toBe('3〜4')
  })

  it('長周期地震動階級の札', () => {
    for (const c of [-1, 0, 1, 2, 3, 4, 5]) {
      expect(lpgmClassLabel(c, w)).toBe(getLpgmClassLabel(c))
      expect(lpgmClassLabelWithApproxAbove(c, true, w)).toBe(getLpgmClassLabelWithApproxAbove(c, true))
    }
  })

  it('深さ・規模・緯度経度・見出しの語', () => {
    for (const [d, atLeast] of [[NaN, false], [0, false], [10, false], [700, true]] as const) {
      expect(depthText(d, atLeast, w)).toBe(formatDepth(d, atLeast))
    }
    for (const [m, t] of [[NaN, undefined], [6.4, 'Mj'], [7, 'Mw']] as const) {
      expect(magnitudeText(m, t, w)).toBe(formatMagnitude(m, t))
      expect(magnitudeWithConditionText(m, 'Ｍ８を超える巨大地震', t, w)).toBe(formatMagnitudeWithCondition(m, 'Ｍ８を超える巨大地震', t))
      expect(magnitudeWithConditionText(m, undefined, t, w)).toBe(formatMagnitudeWithCondition(m, undefined, t))
      expect(magnitudeWithConditionText(m, 'Ｍ不明', t, w)).toBe(formatMagnitudeWithCondition(m, 'Ｍ不明', t))
      expect(magnitudeHeadingText(t, w)).toBe(magnitudeHeading(t))
    }
    for (const [lat, lng] of [[37.5, 137.25], [-12.3, -77.1], [NaN, 1]] as const) {
      expect(coordinateText(lat, lng, 1, w)).toBe(formatCoordinate(lat, lng, 1))
    }
    expect(w.hypocenterSource('USGS')).toBe(formatHypocenterSource('USGS'))
    expect(w.originTime).toBe(QUAKE_ORIGIN_TIME_LABEL)
    expect(w.arrivalTime).toBe(QUAKE_ARRIVAL_TIME_LABEL)
    expect(w.arrivalTimeUnknown).toBe(QUAKE_ARRIVAL_TIME_UNKNOWN)
    expect(w.tsunamiGroupTitle).toBe(TSUNAMI_WARNING_GROUP_TITLE)
    expect(w.nonJmaStation).toBe(NON_JMA_MARK_TITLE)
  })

  it('国内の津波の区分と訂正の種類', () => {
    const types: DomesticTsunami[] = ['なし', '不明', '調査中', '海面変動の可能性', '若干の海面変動', '注意報', '警報等']
    const codes: (DomesticTsunamiCode | undefined)[] = [undefined, '0211', '0212', '0213', '0214', '0215', '0216', '0217', '0229', '0230']
    for (const t of types) for (const c of codes) {
      expect(domesticTsunamiText(t, c, w)).toEqual(formatDomesticTsunami(t, c))
    }
    const corrects: CorrectType[] = ['なし', '不明', '訂正', '震度のみ訂正', '震源を訂正', '震度・震源を訂正']
    for (const c of corrects) expect(correctTypeText(c, w)).toBe(formatCorrectType(c))
  })

  it('地震の時刻（「11月11日 11:32」）', () => {
    for (const iso of ['2026-11-11T11:32:00+09:00', '2026-01-05T03:07:00+09:00', 'not a date']) {
      expect(quakeTimeText(iso, w)).toBe(formatQuakeTime(iso))
      expect(quakeTimeLabeledText(iso, w)).toBe(formatQuakeTimeLabeled(iso))
    }
  })
})

describe('地図の震度の丸の中の札は、どの言語でも 2 文字まで', () => {
  // 丸は 2 文字までの大きさ（→ components/Map/gl/intensityIcons.ts の drawBadge）。
  // 「5 Lower」「5 débil」は丸からはみ出すので、英西葡は「5- 5+」の短い形にした（2026-11-11 ユーザー選択「丸だけ短い形 (Recommended)」）
  // 「不明」も同じ。英西葡の Unknown などは丸に収めると読めない大きさに縮むので「?」にした（2026-11-11 ユーザー選択「英西葡だけ「?」 (Recommended)」）
  const all = { ja, en, es, ko, ptBR, zhHans, zhHant }
  for (const [name, dict] of Object.entries(all)) {
    it(name, () => {
      for (const s of [-1, ...INTENSITY_SCALES_ASC]) {
        expect([...intensityShortLabel(s, dict.formats)].length).toBeLessThanOrEqual(2)
      }
    })
  }
})

describe('どの言語の辞書も、震度の札の長い形と短い形を全階級と「不明」で持つ', () => {
  // 鍵が欠けると、実在する震度が黙って「不明」に落ちる（→ utils/intensity.ts の intensityLabel）。型は鍵の欠けを見ないので、ここで見る
  const all = { ja, en, es, ko, ptBR, zhHans, zhHant }
  for (const [name, dict] of Object.entries(all)) {
    it(name, () => {
      const long: Readonly<Record<string, string>> = dict.formats.intensity
      const short: Readonly<Record<string, string>> = dict.formats.intensityShort
      for (const key of [...INTENSITY_SCALES_ASC.map(String), '-1']) {
        expect(long[key], `intensity[${key}]`).toBeTruthy()
        expect(short[key], `intensityShort[${key}]`).toBeTruthy()
      }
    })
  }
})

describe('どの言語の辞書も、規模の条件の 2 種の訳を持つ', () => {
  // 鍵が欠けると、その言語でも電文の日本語のまま出る（→ utils/formatters.ts の magnitudeConditionText）
  const all = { ja, en, es, ko, ptBR, zhHans, zhHant }
  for (const [name, dict] of Object.entries(all)) {
    it(name, () => {
      for (const raw of ['Ｍ不明', 'Ｍ８を超える巨大地震']) {
        expect(magnitudeConditionText(raw, dict.formats), raw).not.toBe('')
        const conditions: Readonly<Record<string, string>> = dict.formats.magnitudeConditions
        expect(conditions[formatMagnitudeCondition(raw)], raw).toBeTruthy()
      }
    })
  }
  it('訳の無い字面は電文のまま（半角へ揃えて）出す', () => {
    expect(magnitudeConditionText('Ｍ９以上', en.formats)).toBe('M9以上')
  })
})

describe('日本語以外の日付の書式は、読めない日時で落ちずに「—」を返す', () => {
  it('Invalid Date', () => {
    expect(en.formats.monthDayTime(new Date(Number.NaN))).toBe('—')
    expect(en.formats.fullDate(new Date(Number.NaN))).toBe('—')
    expect(en.formats.monthDay(new Date(2026, 10, 11))).not.toBe('—')
  })
})

describe('規模の条件の日本語の写しは、辞書と同じ字面', () => {
  it('2 種', () => {
    for (const raw of ['Ｍ不明', 'Ｍ８を超える巨大地震']) {
      expect(magnitudeConditionText(raw, ja.formats)).toBe(formatMagnitudeCondition(raw))
    }
  })
})
