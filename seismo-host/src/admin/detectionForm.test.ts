import { describe, expect, it } from 'vitest'
import { DETECTION_SETTINGS_DEFAULT, sameDetectionSettings } from '../detection/detectionSettings'
import {
  DETECTION_SECTIONS,
  differsFromDefault,
  formValues,
  parseInput,
  problemLines,
  problemsOf,
  rowValueText,
  settingsFromForm,
} from './detectionForm'

const rowOf = (field: string) => DETECTION_SECTIONS.flatMap((s) => s.rows).find((r) => r.field === field)!

describe('detectionForm', () => {
  it('正: 既定の値を入力欄へ入れて読み戻すと、同じ設定になる（秒で見せる欄もミリ秒へ戻る）', () => {
    const values = formValues(DETECTION_SETTINGS_DEFAULT)
    expect(values.maxGapMs).toBe('1')
    expect(values.beforeMs).toBe('5')
    expect(values['triggerBandHz.1']).toBe('10')
    expect(sameDetectionSettings(settingsFromForm(values), DETECTION_SETTINGS_DEFAULT)).toBe(true)
  })

  it('正: 表は承認の並び（引き金 9・枠 5・照合 2）で、基準の帯（5–10 Hz）の行を持たない', () => {
    expect(DETECTION_SECTIONS.map((s) => [s.heading, s.rows.length])).toEqual([
      ['引き金（STA/LTA）', 9],
      ['地震らしい揺れの枠', 5],
      ['気象庁の地震との照合', 2],
    ])
    const labels = DETECTION_SECTIONS[1].rows.map((r) => r.label)
    expect(labels).toEqual(['上下動の比', '0.5–2 Hz の比の上限', '2–5 Hz の比の上限', '10–20 Hz の比の上限', '20–45 Hz の比の上限'])
  })

  it('正: 小数の秒をミリ秒へ戻すとき、誤差を残さない', () => {
    const values = { ...formValues(DETECTION_SETTINGS_DEFAULT), beforeMs: '0.3' }
    expect(settingsFromForm(values).match.beforeMs).toBe(300)
  })

  it('正: 全角の数字と小数点も読む', () => {
    expect(parseInput('２．５')).toBe(2.5)
    expect(parseInput(' 3 ')).toBe(3)
  })

  it('対照: 空・数でない欄は NaN にし、「数を入れてください」で断る', () => {
    expect(parseInput('')).toBeNaN()
    expect(parseInput('abc')).toBeNaN()
    const values = { ...formValues(DETECTION_SETTINGS_DEFAULT), onRatio: '' }
    expect(problemLines(problemsOf(settingsFromForm(values)))).toEqual(['始める比: 数を入れてください'])
  })

  it('正: 断りを「項目名: 文」の行にする（承認の文）', () => {
    const values = {
      ...formValues(DETECTION_SETTINGS_DEFAULT),
      staSec: '90',
      'triggerBandHz.1': '60',
      offRatio: '3',
      ltaSec: '700',
      'bandRatioMax.3': '0',
    }
    expect(problemLines(problemsOf(settingsFromForm(values)))).toEqual([
      '帯域: 50 Hz 未満にしてください',
      '長い窓（LTA）: 600 秒以下にしてください',
      '閉じる比: 始める比より小さくしてください',
      '10–20 Hz の比の上限: 0 より大きい値を入れてください',
    ])
  })

  it('正: 表に無い項目の断りは、項目の名前を並べた 1 行にまとめる（承認の文）', () => {
    expect(
      problemLines([
        { field: 'referenceBandHz', problem: 'fixed' },
        { field: 'bandRatioMax.2', problem: 'fixed' },
        { field: 'onRatio', problem: 'not-above-one' },
      ]),
    ).toEqual(['始める比: 1 より大きい値を入れてください', 'ホストが受け付けなかった値がある（項目: referenceBandHz、bandRatioMax.2）'])
  })

  it('対照: 表にある項目だけの断りには、まとめの行を足さない', () => {
    expect(problemLines([{ field: 'offRatio', problem: 'not-above-one' }])).toEqual(['閉じる比: 1 より大きい値を入れてください'])
  })

  it('正: 値の見せ方と、既定と違うかの判定', () => {
    expect(rowValueText(rowOf('triggerBandHz'), DETECTION_SETTINGS_DEFAULT)).toBe('5〜10')
    const tuned = { ...DETECTION_SETTINGS_DEFAULT, trigger: { ...DETECTION_SETTINGS_DEFAULT.trigger, onRatio: 3 } }
    expect(differsFromDefault(rowOf('onRatio'), tuned)).toBe(true)
    expect(differsFromDefault(rowOf('offRatio'), tuned)).toBe(false)
  })
})
