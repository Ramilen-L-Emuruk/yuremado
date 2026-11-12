import { describe, it, expect } from 'vitest'
import { formatScaleGal, formatWaveTally } from './waveLabels'
import { ja } from '../../i18n/messages/ja'
import { en } from '../../i18n/messages/en'

describe('formatScaleGal', () => {
  it('1 以上 10 未満は小数 1 桁で出す', () => {
    expect(formatScaleGal(2)).toBe('±2.0 gal')
    expect(formatScaleGal(1)).toBe('±1.0 gal')
  })

  // 正: 静かな観測点では縦が 1 gal を切るので、小数 2 桁まで出す。
  it('1 未満は小数 2 桁で出す（静穏時はここで動く）', () => {
    expect(formatScaleGal(0.5)).toBe('±0.50 gal')
    expect(formatScaleGal(0.076)).toBe('±0.08 gal')
  })

  it('大きい値は整数へ丸める', () => {
    expect(formatScaleGal(12.3)).toBe('±12 gal')
    expect(formatScaleGal(150.6)).toBe('±151 gal')
  })

  it('数として読めない値は出さない', () => {
    expect(formatScaleGal(NaN)).toBe('—')
    expect(formatScaleGal(Infinity)).toBe('—')
  })
})

describe('formatWaveTally', () => {
  // 対照: 常時「欠測 0」を出すと、本当に起きたときの変化が目に入らない。
  it('何も起きていなければ出さない', () => {
    expect(formatWaveTally({ gapSamples: 0, restarts: 0, droppedSamples: 0 }, ja.waveChart)).toBe(null)
  })

  it('0 でないものだけを並べる', () => {
    expect(formatWaveTally({ gapSamples: 120, restarts: 0, droppedSamples: 0 }, ja.waveChart)).toBe('欠測 120')
    expect(formatWaveTally({ gapSamples: 0, restarts: 2, droppedSamples: 0 }, ja.waveChart)).toBe('引き直し 2')
    expect(formatWaveTally({ gapSamples: 0, restarts: 0, droppedSamples: 30 }, ja.waveChart)).toBe('重複 30')
  })

  it('複数あれば並べて出す', () => {
    expect(formatWaveTally({ gapSamples: 120, restarts: 2, droppedSamples: 30 }, ja.waveChart)).toBe(
      '欠測 120 / 引き直し 2 / 重複 30',
    )
  })

  it('英語の辞書なら英語の札で並べる', () => {
    expect(formatWaveTally({ gapSamples: 120, restarts: 2, droppedSamples: 30 }, en.waveChart)).toBe('Gaps 120 / Restarts 2 / Duplicates 30')
  })
})

// 段の名前・印・成分の名前（地図の下端の波形グラフ）
describe('波形グラフの札', () => {
  it('日本語は前と同じ字面、英語は訳の語', () => {
    expect([ja.waveChart.stale, ja.waveChart.compositeStopped, ja.waveChart.sensorLane, ja.waveChart.publicRefused]).toEqual(['波形 途絶', '合成 途絶', '単独', '公開観測点 接続数の上限'])
    expect(ja.waveChart.axes).toEqual(['東西', '南北', '上下'])
    expect(en.waveChart.axes).toEqual(['E-W', 'N-S', 'U-D'])
    expect([en.waveChart.stale, en.waveChart.compositeStopped, en.waveChart.publicRefused]).toEqual(['Waveform interrupted', 'Composite interrupted', 'Public stations: connection limit'])
  })
})
