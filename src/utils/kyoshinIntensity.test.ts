import { describe, expect, it } from 'vitest'
import { detectionScaleLabelFromValue, detectionScaleTextFromValue, kyoshinDetectionScaleLabel, kyoshinDetectionScaleText, kyoshinIndexLabelText, kyoshinIndexShortLabelText, kyoshinIndexToLabel, kyoshinSubZeroStep, KYOSHIN_SUB_ZERO_COLOR, KYOSHIN_SUB_ZERO_STEP_COLORS } from './kyoshinIntensity'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'
import { SHINDO0_COLOR } from './measuredIntensity'

// インデックスと計測震度の対応: 計測震度 = index * 0.5 - 3.0（index 6 が 0.0）
describe('揺れ検知の震度の呼び名', () => {
  // 2026-11-05 ユーザー選択「「0未満」と「<0」にする (Recommended)」
  it('正: 震度0 未満（計測震度が 0 を下回る）は「0未満」', () => {
    expect(kyoshinDetectionScaleLabel(5)).toBe('0未満')
    expect(kyoshinDetectionScaleLabel(0)).toBe('0未満')
    expect(detectionScaleLabelFromValue(-0.1)).toBe('0未満')
  })

  it('対照: 震度0 以上はいまの階級のまま', () => {
    expect(kyoshinDetectionScaleLabel(6)).toBe('0')
    expect(kyoshinDetectionScaleLabel(11)).toBe(kyoshinIndexToLabel(11))
    expect(detectionScaleLabelFromValue(0.0)).toBe('0')
    expect(detectionScaleLabelFromValue(4.4)).toBe('4')
  })

  it('安全弁: 欠測・読めない値は呼び名を持たない（「0未満」に化けない）', () => {
    expect(kyoshinDetectionScaleLabel(-1)).toBeNull()
    expect(kyoshinDetectionScaleLabel(undefined)).toBeNull()
    expect(kyoshinDetectionScaleLabel(Number.NaN)).toBeNull()
    expect(detectionScaleLabelFromValue(null)).toBeNull()
    expect(detectionScaleLabelFromValue(Number.NaN)).toBeNull()
  })

  it('安全弁: 地図・カードの点の段（kyoshinIndexToLabel）は震度0 未満を持たないまま', () => {
    expect(kyoshinIndexToLabel(5)).toBeNull()
  })
})

describe('揺れ検知の震度の呼び名（画面用・言語に合わせる形）', () => {
  it('対照: 日本語の辞書では、日本語の関数と同じ字面（インデックス 0〜20 と計測震度の全域）', () => {
    for (let i = -1; i <= 20; i++) {
      expect(kyoshinIndexLabelText(i, ja.formats)).toBe(kyoshinIndexToLabel(i))
      expect(kyoshinDetectionScaleText(i, ja.formats)).toBe(kyoshinDetectionScaleLabel(i))
    }
    for (let v = -3.5; v <= 7.5; v += 0.1) {
      expect(detectionScaleTextFromValue(v, ja.formats)).toBe(detectionScaleLabelFromValue(v))
    }
    expect(detectionScaleTextFromValue(null, ja.formats)).toBeNull()
  })

  it('正: 英語の辞書では弱・強と「0未満」を英語の語で出す。震度0 は数字のまま', () => {
    expect(kyoshinIndexLabelText(15, en.formats)).toBe('5 Lower')
    expect(kyoshinIndexLabelText(6, en.formats)).toBe('0')
    expect(kyoshinDetectionScaleText(0, en.formats)).toBe('Below 0')
    expect(detectionScaleTextFromValue(-0.1, en.formats)).toBe('Below 0')
  })

  it('安全弁: 欠測・読めない値は言語によらず呼び名を持たない', () => {
    expect(kyoshinDetectionScaleText(-1, en.formats)).toBeNull()
    expect(kyoshinDetectionScaleText(Number.NaN, en.formats)).toBeNull()
    expect(kyoshinIndexLabelText(5, en.formats)).toBeNull()
    expect(kyoshinIndexShortLabelText(5, en.formats)).toBeNull()
  })

  it('正: 枠の札の短い形は、英語なら 5- のように詰める。震度0 は数字のまま', () => {
    expect(kyoshinIndexShortLabelText(15, en.formats)).toBe('5-')
    expect(kyoshinIndexShortLabelText(6, en.formats)).toBe('0')
  })

  it('対照: 日本語の辞書では、短い形も長い形と同じ字になる', () => {
    for (let i = 6; i <= 30; i++) {
      expect(kyoshinIndexShortLabelText(i, ja.formats)).toBe(kyoshinIndexLabelText(i, ja.formats))
    }
  })
})

// 震度0 未満の 6 段の色（2026-10-30 ユーザー選択「明るさと大きさで段を付ける (Recommended)」）。
// 以前の 1 色（#c8ccd2）は震度0 の灰より明るく、強さの順と明るさの順が逆になっていた。
describe('震度0 未満の段の色', () => {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  }

  it('正: 段が上がるほど明るい', () => {
    for (let i = 1; i < KYOSHIN_SUB_ZERO_STEP_COLORS.length; i++) {
      expect(lum(KYOSHIN_SUB_ZERO_STEP_COLORS[i]!)).toBeGreaterThan(lum(KYOSHIN_SUB_ZERO_STEP_COLORS[i - 1]!))
    }
  })

  it('対照: いちばん強い段も震度0 の灰より暗い（強さの順と明るさの順を揃える）', () => {
    expect(lum(KYOSHIN_SUB_ZERO_STEP_COLORS[KYOSHIN_SUB_ZERO_STEP_COLORS.length - 1]!)).toBeLessThan(lum(SHINDO0_COLOR))
  })

  it('カードの「0未満」の行はいちばん強い段の色', () => {
    expect(KYOSHIN_SUB_ZERO_COLOR).toBe(KYOSHIN_SUB_ZERO_STEP_COLORS[5])
  })

  it('安全弁: 段は 0〜5 へ収まる（範囲外・非有限は端へ）', () => {
    expect(kyoshinSubZeroStep(0)).toBe(0)
    expect(kyoshinSubZeroStep(5)).toBe(5)
    expect(kyoshinSubZeroStep(9)).toBe(5)
    expect(kyoshinSubZeroStep(-3)).toBe(0)
    expect(kyoshinSubZeroStep(Number.NaN)).toBe(0)
  })
})
