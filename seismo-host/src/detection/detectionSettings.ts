// 管理画面から調整できる検出の値（REQUIREMENTS.md §11・2026-10-27 ユーザー承認「検出の 3 組」）。
//
// - **引き金**（STA/LTA と帯域。`quakeTrigger.ts` の `TriggerConfig`）
// - **地震らしい揺れの枠**（`eventClassifier.ts` の `ShakeEnvelope`。基準の帯は変えさせない）
// - **気象庁の地震との照合の余裕**（`quakeMatch.ts` の `MatchTolerance`）
//
// 既定はコードの既定値そのもの。**変えた値は次の起動で効く**（同日ユーザー承認。置き場所は
// `receiver/hostSettings.ts`）。流し直し（`redetect.ts`）と評価台（`bench/bench-detect.ts`）も同じ値を読む。
//
// **震度の計算の係数・採取率は対象にしない。** 前者は気象庁・論文の値、後者は基板のファームが決める。
//
// ブラウザ（管理コンソール）でも読むので、Node 専用のものを持ち込まない。

import { SHAKE_ENVELOPE_DEFAULT, type ShakeEnvelope } from './eventClassifier'
import { MATCH_TOLERANCE_DEFAULT, type MatchTolerance } from './quakeMatch'
import { FEATURE_BANDS, TRIGGER_CONFIG_DEFAULT, featureBandIndex, type TriggerConfig } from './quakeTrigger'

export interface DetectionSettings {
  readonly trigger: TriggerConfig
  readonly envelope: ShakeEnvelope
  readonly match: MatchTolerance
}

export const DETECTION_SETTINGS_DEFAULT: DetectionSettings = {
  trigger: TRIGGER_CONFIG_DEFAULT,
  envelope: SHAKE_ENVELOPE_DEFAULT,
  match: MATCH_TOLERANCE_DEFAULT,
}

/**
 * 秒で測る項目の上限。起動時の流し込みは、前のプロセスの末尾を「長い窓＋助走」以上流す（`warmStart.ts` の
 * `warmTailMs`）ので、長い窓を伸ばしても起動し直すたびに平常時の強さが空から始まることはない。
 * 区間の長さの上限は、検出器が P/S のために抱えておく波形の長さに効く（`quakeDetector.ts` の `keepMs`）。
 * ほかの秒の項目も同じ上限に揃える（これを超える値を入れる理由が無い）。
 */
export const DETECTION_SECONDS_MAX = 600

/**
 * 合成波形の目盛り（100 Hz・`receiver/sensorFusion.ts` の `STATION_GRID_MS`）で扱える周波数の上限。
 * 帯域通過（`bandPass.ts`）はこれ以上を作れない。
 */
export const DETECTION_NYQUIST_HZ = 50

/** 断る項目。`bandRatioMax.N` は `FEATURE_BANDS` の N 番目。 */
export type DetectionField =
  | keyof TriggerConfig
  | 'referenceBandHz'
  | 'verticalRatio'
  | `bandRatioMax.${number}`
  | keyof MatchTolerance

export type DetectionProblemKind =
  | 'not-number'
  | 'not-positive'
  | 'negative'
  /** 始める比・閉じる比が 1 以下（平常時の揺らぎだけで引き金が引きっぱなしになる）。 */
  | 'not-above-one'
  | 'over-max-seconds'
  | 'over-nyquist'
  | 'low-not-below-high'
  | 'sta-not-below-lta'
  | 'off-not-below-on'
  | 'hold-not-below-max'
  /** 変えさせない値が変わっている（枠の基準の帯）。画面からは起きない。 */
  | 'fixed'

export interface DetectionProblem {
  readonly field: DetectionField
  readonly problem: DetectionProblemKind
}

const isNum = (v: number): boolean => Number.isFinite(v)

/**
 * 受け付けない値。無ければ空。**1 つの項目に断りは 1 つだけ**（数でなければ、ほかの項目との比べ合いは見ない）。
 * 並びは画面の並び（引き金 → 枠 → 照合）。
 */
export function detectionProblems(s: DetectionSettings): DetectionProblem[] {
  const out: DetectionProblem[] = []
  const t = s.trigger
  const add = (field: DetectionField, problem: DetectionProblemKind): void => {
    out.push({ field, problem })
  }
  /** 単独で見る検査。通れば true。 */
  const single = (field: DetectionField, v: number, opts: { zeroOk: boolean; seconds: number | null }): boolean => {
    if (!isNum(v)) add(field, 'not-number')
    else if (v < 0) add(field, opts.zeroOk ? 'negative' : 'not-positive')
    else if (v === 0 && !opts.zeroOk) add(field, 'not-positive')
    else if (opts.seconds !== null && opts.seconds > DETECTION_SECONDS_MAX) add(field, 'over-max-seconds')
    else return true
    return false
  }

  const [lo, hi] = t.triggerBandHz
  if (!isNum(lo) || !isNum(hi)) add('triggerBandHz', 'not-number')
  else if (!(lo > 0)) add('triggerBandHz', 'not-positive')
  else if (!(hi < DETECTION_NYQUIST_HZ)) add('triggerBandHz', 'over-nyquist')
  else if (!(lo < hi)) add('triggerBandHz', 'low-not-below-high')

  const staOk = single('staSec', t.staSec, { zeroOk: false, seconds: null })
  const ltaOk = single('ltaSec', t.ltaSec, { zeroOk: false, seconds: t.ltaSec })
  if (staOk && ltaOk && !(t.staSec < t.ltaSec)) add('staSec', 'sta-not-below-lta')
  // 長い窓の検査で既に断ったなら、短い窓の比べ合いは出さない（上の if が ltaOk を見ている）。
  /**
   * 比は 1 より大きくなければならない（2026-10-27 ユーザー承認）。始める比が 1 以下だと平常時の強さと並んだだけで
   * 始まる。閉じる比が 1 以下だと、揺れの後に短い窓が長い窓（揺れの間に押し上がっている）を下回るまで閉じず、
   * 区間が上限まで伸びやすい。
   */
  const aboveOne = (field: DetectionField, v: number): boolean => {
    if (v > 1) return true
    add(field, 'not-above-one')
    return false
  }
  const onOk = single('onRatio', t.onRatio, { zeroOk: false, seconds: null }) && aboveOne('onRatio', t.onRatio)
  const offOk = single('offRatio', t.offRatio, { zeroOk: false, seconds: null }) && aboveOne('offRatio', t.offRatio)
  if (onOk && offOk && !(t.offRatio < t.onRatio)) add('offRatio', 'off-not-below-on')
  const holdOk = single('holdSec', t.holdSec, { zeroOk: true, seconds: t.holdSec })
  const maxOk = single('maxEventSec', t.maxEventSec, { zeroOk: false, seconds: t.maxEventSec })
  if (holdOk && maxOk && !(t.holdSec < t.maxEventSec)) add('holdSec', 'hold-not-below-max')
  single('warmupSec', t.warmupSec, { zeroOk: true, seconds: t.warmupSec })
  single('maxGapMs', t.maxGapMs, { zeroOk: false, seconds: t.maxGapMs / 1000 })

  const e = s.envelope
  const ref = featureBandIndex(e.referenceBandHz)
  const refDefault = featureBandIndex(SHAKE_ENVELOPE_DEFAULT.referenceBandHz)
  if (ref !== refDefault) add('referenceBandHz', 'fixed')
  const [vLo, vHi] = e.verticalRatio
  if (!isNum(vLo) || !isNum(vHi)) add('verticalRatio', 'not-number')
  else if (vLo < 0) add('verticalRatio', 'negative')
  else if (!(vLo < vHi)) add('verticalRatio', 'low-not-below-high')
  FEATURE_BANDS.forEach((_, i) => {
    const v = e.bandRatioMax[i]
    const field: DetectionField = `bandRatioMax.${i}`
    if (i === refDefault) {
      if (v !== null) add(field, 'fixed')
      return
    }
    if (v === null || v === undefined) add(field, 'not-number')
    else single(field, v, { zeroOk: false, seconds: null })
  })

  const m = s.match
  single('beforeMs', m.beforeMs, { zeroOk: true, seconds: m.beforeMs / 1000 })
  single('afterMs', m.afterMs, { zeroOk: true, seconds: m.afterMs / 1000 })
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pair(v: unknown): readonly [number, number] | null {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null
}

/**
 * JSON から読んだ値を検出の設定として読む。**欄が欠けている・型が違う・{@link detectionProblems} を通らない
 * ものは `null`**（読む側が断り方を決める）。知らない欄は捨てる。
 */
export function parseDetectionSettings(value: unknown): DetectionSettings | null {
  const settings = detectionSettingsShape(value)
  return settings !== null && detectionProblems(settings).length === 0 ? settings : null
}

/**
 * 形だけを見て読む（欄が揃い、型が合っているか）。**値の検査はしない**（`PUT /api/detection` が、形の誤りと
 * 値の誤りを分けて返すため。値の誤りは {@link detectionProblems} で項目ごとに断る）。
 */
export function detectionSettingsShape(value: unknown): DetectionSettings | null {
  if (!isRecord(value) || !isRecord(value.trigger) || !isRecord(value.envelope) || !isRecord(value.match)) return null
  const t = value.trigger
  const band = pair(t.triggerBandHz)
  const nums = ['staSec', 'ltaSec', 'onRatio', 'offRatio', 'holdSec', 'maxEventSec', 'warmupSec', 'maxGapMs'] as const
  if (band === null || nums.some((k) => typeof t[k] !== 'number')) return null
  const n = (k: (typeof nums)[number]): number => t[k] as number
  const trigger: TriggerConfig = {
    triggerBandHz: band,
    staSec: n('staSec'),
    ltaSec: n('ltaSec'),
    onRatio: n('onRatio'),
    offRatio: n('offRatio'),
    holdSec: n('holdSec'),
    maxEventSec: n('maxEventSec'),
    warmupSec: n('warmupSec'),
    maxGapMs: n('maxGapMs'),
  }
  const e = value.envelope
  const referenceBandHz = pair(e.referenceBandHz)
  const verticalRatio = pair(e.verticalRatio)
  const maxes = e.bandRatioMax
  if (
    referenceBandHz === null ||
    verticalRatio === null ||
    !Array.isArray(maxes) ||
    maxes.length !== FEATURE_BANDS.length ||
    !maxes.every((x) => x === null || typeof x === 'number')
  ) {
    return null
  }
  const envelope: ShakeEnvelope = { referenceBandHz, verticalRatio, bandRatioMax: maxes as (number | null)[] }
  const m = value.match
  if (typeof m.beforeMs !== 'number' || typeof m.afterMs !== 'number') return null
  return { trigger, envelope, match: { beforeMs: m.beforeMs, afterMs: m.afterMs } }
}

/** 欄を決まった順に並べ直した写し（比べる前に揃える。オブジェクトの欄の順は作り方で変わる）。 */
function ordered(s: DetectionSettings): unknown[] {
  const t = s.trigger
  return [
    [...t.triggerBandHz, t.staSec, t.ltaSec, t.onRatio, t.offRatio, t.holdSec, t.maxEventSec, t.warmupSec, t.maxGapMs],
    [...s.envelope.referenceBandHz, ...s.envelope.verticalRatio, ...s.envelope.bandRatioMax],
    [s.match.beforeMs, s.match.afterMs],
  ]
}

/** 2 つの設定が同じ値か（画面の「次の再起動で変わる値がある」と、待っている変更の片付けに使う）。 */
export function sameDetectionSettings(a: DetectionSettings, b: DetectionSettings): boolean {
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))
}
