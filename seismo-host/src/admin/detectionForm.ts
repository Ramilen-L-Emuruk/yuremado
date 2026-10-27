// 「検出」タブの表の中身（項目・単位・文言・入力との行き来）。DOM には触らない（`viewDetection.ts` が描く）。
//
// 項目の名前・ホバーの一文・断りの文は 2026-10-27 ユーザー承認。並びは画面の並び（引き金 → 枠 → 照合）で、
// `detectionProblems` が返す断りの並びと揃えてある。
//
// **ミリ秒で持つ値（作り直す途切れ・照合の余裕）は秒で見せる。** 断りの文（「600 秒以下にしてください」）が秒で
// 書いてあるので、入力も秒にしないと読み替えが要る。

import {
  DETECTION_SETTINGS_DEFAULT,
  detectionProblems,
  type DetectionField,
  type DetectionProblem,
  type DetectionProblemKind,
  type DetectionSettings,
} from '../detection/detectionSettings'
import { FEATURE_BANDS, featureBandIndex, type TriggerConfig } from '../detection/quakeTrigger'

/** 入力欄 1 つ。範囲の項目は下と上の 2 つを持つ（`.0` が下・`.1` が上）。 */
export type DetectionInputId =
  | 'triggerBandHz.0'
  | 'triggerBandHz.1'
  | Exclude<keyof TriggerConfig, 'triggerBandHz'>
  | 'verticalRatio.0'
  | 'verticalRatio.1'
  | `bandRatioMax.${number}`
  | 'beforeMs'
  | 'afterMs'

export interface DetectionRow {
  /** 断りを結び付ける項目（`detectionProblems` の `field`）。 */
  readonly field: DetectionField
  readonly label: string
  readonly tip: string
  readonly unit: '秒' | '倍' | 'Hz'
  /** 1 つなら単独の値、2 つなら下と上。 */
  readonly inputs: readonly DetectionInputId[]
}

export interface DetectionSection {
  readonly heading: string
  readonly rows: readonly DetectionRow[]
}

const BAND_RATIO_TIP = '5〜10 Hz の水平動に対する、この帯域の水平動の倍率の上限です。超えると生活振動らしい揺れとします。'

/** 基準の帯（5〜10 Hz）の位置。この帯の上限は持たない（変えさせない）。 */
const REFERENCE_INDEX = featureBandIndex(DETECTION_SETTINGS_DEFAULT.envelope.referenceBandHz)

const BAND_RATIO_ROWS: readonly DetectionRow[] = FEATURE_BANDS.flatMap(([lo, hi], i): DetectionRow[] =>
  i === REFERENCE_INDEX
    ? []
    : [{ field: `bandRatioMax.${i}`, label: `${lo}–${hi} Hz の比の上限`, tip: BAND_RATIO_TIP, unit: '倍', inputs: [`bandRatioMax.${i}`] }],
)

export const DETECTION_SECTIONS: readonly DetectionSection[] = [
  {
    heading: '引き金（STA/LTA）',
    rows: [
      { field: 'triggerBandHz', label: '帯域', tip: '引き金に使う揺れの周波数の範囲です。', unit: 'Hz', inputs: ['triggerBandHz.0', 'triggerBandHz.1'] },
      { field: 'staSec', label: '短い窓（STA）', tip: 'いまの揺れの強さを平均する長さです。', unit: '秒', inputs: ['staSec'] },
      { field: 'ltaSec', label: '長い窓（LTA）', tip: '平常時の揺れの強さを平均する長さです。', unit: '秒', inputs: ['ltaSec'] },
      { field: 'onRatio', label: '始める比', tip: '短い窓が長い窓のこの倍率を超えたら、区間を始めます。', unit: '倍', inputs: ['onRatio'] },
      { field: 'offRatio', label: '閉じる比', tip: 'この倍率を下回ったら、区間を閉じる候補にします。', unit: '倍', inputs: ['offRatio'] },
      {
        field: 'holdSec',
        label: '閉じるまで待つ',
        tip: '閉じる比を下回ってから、この長さ戻らなければ区間を閉じます。',
        unit: '秒',
        inputs: ['holdSec'],
      },
      { field: 'maxEventSec', label: '区間の長さの上限', tip: 'これより長く続いた区間は、ここで閉じます。', unit: '秒', inputs: ['maxEventSec'] },
      {
        field: 'warmupSec',
        label: '始めに見送る長さ',
        tip: '起動したときや波形が途切れた後、この長さは区間を始めません。',
        unit: '秒',
        inputs: ['warmupSec'],
      },
      {
        field: 'maxGapMs',
        label: '作り直す途切れ',
        tip: '波形がこれより長く途切れたら、平常時の強さを測り直します。',
        unit: '秒',
        inputs: ['maxGapMs'],
      },
    ],
  },
  {
    heading: '地震らしい揺れの枠',
    rows: [
      {
        field: 'verticalRatio',
        label: '上下動の比',
        tip: '5〜10 Hz の上下動が水平動の何倍かです。この範囲に入ると地震らしい揺れとします。',
        unit: '倍',
        inputs: ['verticalRatio.0', 'verticalRatio.1'],
      },
      ...BAND_RATIO_ROWS,
    ],
  },
  {
    heading: '気象庁の地震との照合',
    rows: [
      {
        field: 'beforeMs',
        label: 'P 波より前',
        tip: '気象庁の地震の P 波が届く時刻より、これだけ前に始まった揺れまで照合します。',
        unit: '秒',
        inputs: ['beforeMs'],
      },
      { field: 'afterMs', label: 'S 波より後', tip: 'S 波が届く時刻より、これだけ後に始まった揺れまで照合します。', unit: '秒', inputs: ['afterMs'] },
    ],
  },
]

/** 断りの文。`fixed` は画面から送らない値（基準の帯）なので文を持たない（{@link problemLines}）。 */
const PROBLEM_TEXT: Readonly<Record<Exclude<DetectionProblemKind, 'fixed'>, string>> = {
  'not-number': '数を入れてください',
  'not-positive': '0 より大きい値を入れてください',
  negative: '0 以上の値を入れてください',
  'not-above-one': '1 より大きい値を入れてください',
  'over-max-seconds': '600 秒以下にしてください',
  'over-nyquist': '50 Hz 未満にしてください',
  'low-not-below-high': '下を上より小さくしてください',
  'sta-not-below-lta': '長い窓より短くしてください',
  'off-not-below-on': '始める比より小さくしてください',
  'hold-not-below-max': '区間の長さの上限より短くしてください',
}

const ROWS_BY_FIELD = new Map<DetectionField, DetectionRow>(DETECTION_SECTIONS.flatMap((s) => s.rows.map((r) => [r.field, r] as const)))

/** ミリ秒で持ち、秒で見せる入力。 */
const MS_INPUTS: ReadonlySet<DetectionInputId> = new Set(['maxGapMs', 'beforeMs', 'afterMs'])

/** 設定から入力欄の値（持ち方のまま。ミリ秒の欄はミリ秒）を読む。 */
function rawOf(s: DetectionSettings, id: DetectionInputId): number {
  const [key, idx] = id.split('.') as [string, string | undefined]
  if (key === 'triggerBandHz') return s.trigger.triggerBandHz[Number(idx)]
  if (key === 'verticalRatio') return s.envelope.verticalRatio[Number(idx)]
  if (key === 'bandRatioMax') return s.envelope.bandRatioMax[Number(idx)] ?? Number.NaN
  if (key === 'beforeMs' || key === 'afterMs') return s.match[key]
  return s.trigger[key as Exclude<keyof TriggerConfig, 'triggerBandHz'>]
}

/** 見せる数。秒へ直したときの小数の誤差（0.3 × 1000 など）を丸めて消す。 */
function shownNumber(s: DetectionSettings, id: DetectionInputId): number {
  const v = rawOf(s, id)
  return MS_INPUTS.has(id) ? Math.round(v) / 1000 : v
}

function formatNumber(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toPrecision(12))) : ''
}

/** 入力欄に入れる文字。 */
export function formValues(s: DetectionSettings): Record<DetectionInputId, string> {
  const out = {} as Record<DetectionInputId, string>
  for (const section of DETECTION_SECTIONS) {
    for (const row of section.rows) for (const id of row.inputs) out[id] = formatNumber(shownNumber(s, id))
  }
  return out
}

/** 行の値の見せ方（単位なし）。範囲は「下〜上」。 */
export function rowValueText(row: DetectionRow, s: DetectionSettings): string {
  return row.inputs.map((id) => formatNumber(shownNumber(s, id))).join('〜')
}

/** 行の値が既定と違うか。 */
export function differsFromDefault(row: DetectionRow, s: DetectionSettings): boolean {
  return rowValueText(row, s) !== rowValueText(row, DETECTION_SETTINGS_DEFAULT)
}

/** 全角の数字・小数点・マイナスを半角へ寄せる（日本語入力のまま打っても読めるように）。 */
function normalizeDigits(text: string): string {
  return text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.')
    .replace(/[－−]/g, '-')
}

/** 入力の文字を数へ。読めなければ `NaN`（`detectionProblems` が「数を入れてください」で断る）。 */
export function parseInput(text: string): number {
  const t = normalizeDigits(text)
  if (t.length === 0) return Number.NaN
  const v = Number(t)
  return Number.isFinite(v) ? v : Number.NaN
}

/**
 * 入力欄から設定を組み立てる。**基準の帯とその帯の上限は既定のまま入れる**（画面からは変えさせない）。
 * 読めない欄は `NaN` のまま入れ、断るのは {@link problemsOf}。
 */
export function settingsFromForm(values: Readonly<Record<DetectionInputId, string>>): DetectionSettings {
  const n = (id: DetectionInputId): number => {
    const v = parseInput(values[id] ?? '')
    return MS_INPUTS.has(id) && Number.isFinite(v) ? Math.round(v * 1000) : v
  }
  const d = DETECTION_SETTINGS_DEFAULT
  return {
    trigger: {
      triggerBandHz: [n('triggerBandHz.0'), n('triggerBandHz.1')],
      staSec: n('staSec'),
      ltaSec: n('ltaSec'),
      onRatio: n('onRatio'),
      offRatio: n('offRatio'),
      holdSec: n('holdSec'),
      maxEventSec: n('maxEventSec'),
      warmupSec: n('warmupSec'),
      maxGapMs: n('maxGapMs'),
    },
    envelope: {
      referenceBandHz: d.envelope.referenceBandHz,
      verticalRatio: [n('verticalRatio.0'), n('verticalRatio.1')],
      bandRatioMax: FEATURE_BANDS.map((_, i) => (i === REFERENCE_INDEX ? null : n(`bandRatioMax.${i}`))),
    },
    match: { beforeMs: n('beforeMs'), afterMs: n('afterMs') },
  }
}

/** 送る前に画面で確かめる（ホストも同じ関数で確かめ直す）。 */
export function problemsOf(s: DetectionSettings): DetectionProblem[] {
  return detectionProblems(s)
}

/**
 * 断りを「項目名: 文」の行にする。**表に無い項目の断り**（基準の帯の `fixed` など。画面は基準の帯を既定のまま
 * 送る —— {@link settingsFromForm} —— ので、画面を通らない本文か、ホストとの版の食い違いでしか起きない）は
 * 黙って捨てず、項目の名前を並べた 1 行にまとめる（2026-10-27 ユーザー承認）。
 */
export function problemLines(problems: readonly DetectionProblem[]): string[] {
  const out: string[] = []
  const unknown: string[] = []
  for (const p of problems) {
    const row = ROWS_BY_FIELD.get(p.field)
    if (row === undefined || p.problem === 'fixed') {
      if (!unknown.includes(p.field)) unknown.push(p.field)
      continue
    }
    out.push(`${row.label}: ${PROBLEM_TEXT[p.problem]}`)
  }
  if (unknown.length > 0) out.push(`ホストが受け付けなかった値がある（項目: ${unknown.join('、')}）`)
  return out
}

/** 行に断りが付いているか（入力欄を赤くする）。 */
export function rowHasProblem(row: DetectionRow, problems: readonly DetectionProblem[]): boolean {
  return problems.some((p) => p.field === row.field && p.problem !== 'fixed')
}
