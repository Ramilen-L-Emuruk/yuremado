// 組み合わせの揺れ検知器（kyoshinEnsembleTracker）の検知を、検知カードの「判定の根拠」の言葉へ変える
// 純粋ユーティリティ。検知器の出力を読むだけで、判定には関与しない。
//
// 文面はすべて 2026-10-29 ユーザー選択（「今と同じ形」「4 行」「働きで呼ぶ」「補足は消し脚注は言い換え」、
// 早い段の一行は「早い段にも一行を出す」「点数を外す (Recommended)」）。
//
// **要求値は出さない。** 組み合わせの検知器は「あと何点で確定」のような要求値を持たないので、出せるのは
// 「何が支えたか・何点が加わったか・最大震度・確定までの秒」という事実だけ。要求値らしいものを
// 作って添えると、実装が持っていない判定を画面が名乗ることになる。

import type { EnsembleSource } from './kyoshinEnsembleDetector'
import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import { detectionScaleTextFromValue, type DetectionScaleWords } from './kyoshinIntensity'
import type { Messages } from '../i18n/messages'

/** 検知の根拠の語（辞書の `realtime.evidence`） */
export type EvidenceWords = Messages['realtime']['evidence']

/** 「判定した仕組み」の行に並べる順。呼び名は辞書の `realtime.evidence.sources` */
export const ENSEMBLE_SOURCE_ORDER: readonly EnsembleSource[] = ['stat', 'cluster', 'fast', 'sparse']

/** 内訳の表の 1 行 */
export interface EvidenceRow {
  label: string
  value: string
}

/**
 * 計測震度 → 震度階級ラベル。震度0 未満は辞書の `belowZero`（日本語は「0未満」）、欠測は `—`（`kyoshinIntensity.ts` の
 * `detectionScaleTextFromValue`）。**0.5 刻みのインデックスへ丸めてから引かない** —— 計測震度 4.4 が「5弱」になる
 */
function scaleLabel(value: number | null, f: DetectionScaleWords): string {
  return detectionScaleTextFromValue(value, f) ?? '—'
}

/** 支えた部分の呼び名を `ENSEMBLE_SOURCE_ORDER` の順に並べる */
function sourceLabels(d: EnsembleDetection, w: EvidenceWords): string[] {
  return ENSEMBLE_SOURCE_ORDER
    .filter(s => d.sources.includes(s))
    .map(s => w.sources[s])
}

/**
 * カードの 1 行の要約。確かな段なら確定した瞬間の内訳で「6点・震度2で確定」。
 * 早い段は、支えた部分だけで「揺れの広がりで反応」（2026-10-29 ユーザー選択「早い段にも一行を出す」・
 * 点数はユーザー選択「点数を外す (Recommended)」で外した —— 本文の「N観測点で反応」と同じ数が並ぶか、数え方の違いで
 * 食い違って見えるため）。支えた部分が無ければ null（呼び出し側は行ごと出さない）。
 */
export function ensembleSummary(d: EnsembleDetection, w: EvidenceWords, f: DetectionScaleWords): string | null {
  if (d.confidence === 'confirmed') {
    if (d.confirmedSnapshot === null) return null
    return w.confirmedAt(d.confirmedSnapshot.size, scaleLabel(d.confirmedSnapshot.maxIntensity, f))
  }
  const labels = sourceLabels(d, w)
  if (labels.length === 0) return null
  return w.reactedBy(labels.join(w.sourceSeparator))
}

/** 「判定の内訳」の表。値はいまのもの（確定までの秒だけは確定した時点で決まる） */
export function ensembleRows(d: EnsembleDetection, w: EvidenceWords, f: DetectionScaleWords): EvidenceRow[] {
  const sources = sourceLabels(d, w)
  const untilConfirmed = d.firstConfirmedAtMs === null
    ? '—'
    : w.untilConfirmed(Math.max(0, Math.round((d.firstConfirmedAtMs - d.originTimeMs) / 1000)))
  return [
    { label: w.rowSources, value: sources.length > 0 ? sources.join(w.sourceSeparator) : '—' },
    { label: w.rowMembers, value: w.members(d.memberKeys.length) },
    { label: w.rowMaxIntensity, value: d.maxIntensity === null ? '—' : w.maxIntensity(scaleLabel(d.maxIntensity, f)) },
    { label: w.rowUntilConfirmed, value: untilConfirmed },
  ]
}
