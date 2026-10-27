import { describe, expect, it } from 'vitest'
import {
  DETECTION_SETTINGS_DEFAULT,
  DETECTION_SECONDS_MAX,
  detectionProblems,
  parseDetectionSettings,
  sameDetectionSettings,
  type DetectionSettings,
} from './detectionSettings'
import { SHAKE_ENVELOPE_DEFAULT } from './eventClassifier'
import { MATCH_TOLERANCE_DEFAULT } from './quakeMatch'
import { TRIGGER_CONFIG_DEFAULT } from './quakeTrigger'

function withTrigger(patch: Partial<DetectionSettings['trigger']>): DetectionSettings {
  return { ...DETECTION_SETTINGS_DEFAULT, trigger: { ...DETECTION_SETTINGS_DEFAULT.trigger, ...patch } }
}

function fields(s: DetectionSettings): string[] {
  return detectionProblems(s).map((p) => `${p.field}:${p.problem}`)
}

describe('DETECTION_SETTINGS_DEFAULT', () => {
  it('正: 既定はコードの既定値そのまま（調整の口を足しても、何も変えなければ検出は変わらない）', () => {
    expect(DETECTION_SETTINGS_DEFAULT.trigger).toEqual(TRIGGER_CONFIG_DEFAULT)
    expect(DETECTION_SETTINGS_DEFAULT.envelope).toEqual(SHAKE_ENVELOPE_DEFAULT)
    expect(DETECTION_SETTINGS_DEFAULT.match).toEqual(MATCH_TOLERANCE_DEFAULT)
    expect(detectionProblems(DETECTION_SETTINGS_DEFAULT)).toEqual([])
  })
})

describe('detectionProblems', () => {
  it('正: 短い窓が長い窓以上なら断る', () => {
    expect(fields(withTrigger({ staSec: 60 }))).toEqual(['staSec:sta-not-below-lta'])
  })

  it('対照: 短い窓が長い窓より短ければ通す', () => {
    expect(fields(withTrigger({ staSec: 59.9 }))).toEqual([])
  })

  it('正: 長い窓・始めに見送る長さ・区間の長さの上限は 600 秒まで', () => {
    expect(fields(withTrigger({ ltaSec: DETECTION_SECONDS_MAX + 1 }))).toEqual(['ltaSec:over-max-seconds'])
    expect(fields(withTrigger({ warmupSec: DETECTION_SECONDS_MAX + 1 }))).toEqual(['warmupSec:over-max-seconds'])
    expect(fields(withTrigger({ maxEventSec: DETECTION_SECONDS_MAX + 1 }))).toEqual(['maxEventSec:over-max-seconds'])
  })

  it('対照: ちょうど 600 秒は通す', () => {
    expect(fields(withTrigger({ ltaSec: DETECTION_SECONDS_MAX, maxEventSec: DETECTION_SECONDS_MAX }))).toEqual([])
  })

  it('正: 帯域は 0 より大きく 50 Hz 未満で、下が上より小さい', () => {
    expect(fields(withTrigger({ triggerBandHz: [5, 50] }))).toEqual(['triggerBandHz:over-nyquist'])
    expect(fields(withTrigger({ triggerBandHz: [10, 5] }))).toEqual(['triggerBandHz:low-not-below-high'])
    expect(fields(withTrigger({ triggerBandHz: [0, 5] }))).toEqual(['triggerBandHz:not-positive'])
  })

  it('対照: 49.9 Hz までは通す', () => {
    expect(fields(withTrigger({ triggerBandHz: [5, 49.9] }))).toEqual([])
  })

  it('正: 閉じる比は始める比より小さく、閉じるまで待つ長さは区間の上限より短い', () => {
    expect(fields(withTrigger({ offRatio: 2.5 }))).toEqual(['offRatio:off-not-below-on'])
    expect(fields(withTrigger({ holdSec: 180 }))).toEqual(['holdSec:hold-not-below-max'])
  })

  it('正: 始める比・閉じる比は 1 より大きい値に限る（2026-10-27 ユーザー承認）', () => {
    expect(fields(withTrigger({ onRatio: 1, offRatio: 0.8 }))).toEqual(['onRatio:not-above-one', 'offRatio:not-above-one'])
  })

  it('対照: 1 を少しでも超えれば通す・0 以下は従来どおり「0 より大きい」で断る', () => {
    expect(fields(withTrigger({ onRatio: 1.2, offRatio: 1.01 }))).toEqual([])
    expect(fields(withTrigger({ offRatio: 0 }))).toEqual(['offRatio:not-positive'])
  })

  it('正: 0 を許す項目と許さない項目を分ける', () => {
    expect(fields(withTrigger({ holdSec: 0, warmupSec: 0 }))).toEqual([])
    expect(fields(withTrigger({ maxGapMs: 0 }))).toEqual(['maxGapMs:not-positive'])
    expect(fields(withTrigger({ holdSec: -1 }))).toEqual(['holdSec:negative'])
  })

  it('正: 数でない値は数でないと断り、ほかの比べ合いは見ない（同じ項目へ 2 つの断りを出さない）', () => {
    expect(fields(withTrigger({ staSec: Number.NaN }))).toEqual(['staSec:not-number'])
    expect(fields(withTrigger({ ltaSec: Number.POSITIVE_INFINITY }))).toEqual(['ltaSec:not-number'])
  })

  it('正: 地震らしい揺れの枠と照合の余裕', () => {
    const s: DetectionSettings = {
      ...DETECTION_SETTINGS_DEFAULT,
      envelope: { ...SHAKE_ENVELOPE_DEFAULT, verticalRatio: [0.7, 0.6], bandRatioMax: [0, 0.6, null, 0.8, 0.7] },
      match: { beforeMs: -1, afterMs: (DETECTION_SECONDS_MAX + 1) * 1000 },
    }
    expect(fields(s)).toEqual([
      'verticalRatio:low-not-below-high',
      'bandRatioMax.0:not-positive',
      'beforeMs:negative',
      'afterMs:over-max-seconds',
    ])
  })

  it('安全弁: 枠の基準の帯（5〜10 Hz）と、その帯の上限が空であることは変えさせない', () => {
    const moved: DetectionSettings = {
      ...DETECTION_SETTINGS_DEFAULT,
      envelope: { ...SHAKE_ENVELOPE_DEFAULT, referenceBandHz: [2, 5] },
    }
    expect(fields(moved)).toEqual(['referenceBandHz:fixed'])
    const filled: DetectionSettings = {
      ...DETECTION_SETTINGS_DEFAULT,
      envelope: { ...SHAKE_ENVELOPE_DEFAULT, bandRatioMax: [0.4, 0.6, 1, 0.8, 0.7] },
    }
    expect(fields(filled)).toEqual(['bandRatioMax.2:fixed'])
  })
})

describe('parseDetectionSettings', () => {
  it('正: 既定を JSON に通して読み戻すと同じもの', () => {
    expect(parseDetectionSettings(JSON.parse(JSON.stringify(DETECTION_SETTINGS_DEFAULT)))).toEqual(DETECTION_SETTINGS_DEFAULT)
  })

  it('正: 欄が欠けている・型が違う・検証を通らないものは読まない', () => {
    const { staSec: _drop, ...noSta } = DETECTION_SETTINGS_DEFAULT.trigger
    expect(parseDetectionSettings({ ...DETECTION_SETTINGS_DEFAULT, trigger: noSta })).toBeNull()
    expect(parseDetectionSettings({ ...DETECTION_SETTINGS_DEFAULT, match: { beforeMs: '5000', afterMs: 15000 } })).toBeNull()
    expect(parseDetectionSettings(withTrigger({ staSec: 600 }))).toBeNull()
    expect(parseDetectionSettings(null)).toBeNull()
    expect(parseDetectionSettings([])).toBeNull()
  })

  it('対照: 知らない欄は捨てて読む', () => {
    const extra = { ...JSON.parse(JSON.stringify(DETECTION_SETTINGS_DEFAULT)), note: 'x' }
    expect(parseDetectionSettings(extra)).toEqual(DETECTION_SETTINGS_DEFAULT)
  })
})

describe('sameDetectionSettings', () => {
  it('正: 欄の並びが違っても同じ値なら同じ', () => {
    const t = DETECTION_SETTINGS_DEFAULT.trigger
    const reordered: DetectionSettings = {
      match: { afterMs: 15_000, beforeMs: 5_000 },
      envelope: { bandRatioMax: [0.4, 0.6, null, 0.8, 0.7], verticalRatio: [0.3, 0.65], referenceBandHz: [5, 10] },
      trigger: { maxGapMs: t.maxGapMs, warmupSec: t.warmupSec, maxEventSec: t.maxEventSec, holdSec: t.holdSec, offRatio: t.offRatio, onRatio: t.onRatio, ltaSec: t.ltaSec, staSec: t.staSec, triggerBandHz: [5, 10] },
    }
    expect(sameDetectionSettings(reordered, DETECTION_SETTINGS_DEFAULT)).toBe(true)
  })

  it('対照: 1 つでも違えば違う', () => {
    expect(sameDetectionSettings(withTrigger({ onRatio: 2.6 }), DETECTION_SETTINGS_DEFAULT)).toBe(false)
  })
})
