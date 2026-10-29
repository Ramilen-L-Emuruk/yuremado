// 組み合わせの揺れ検知器（kyoshinEnsembleTracker）の検知を、検知カードの「判定の根拠」の言葉へ変える
// 純粋ユーティリティ。検知器の出力を読むだけで、判定には関与しない。
//
// 文面はすべて 2026-10-29 ユーザー選択（「今と同じ形」「4 行」「働きで呼ぶ」「補足は消し脚注は言い換え」）。
//
// **要求値は出さない。** 組み合わせの検知器は「あと何点で確定」のような要求値を持たないので、出せるのは
// 「何が支えたか・何点が加わったか・最大震度・確定までの秒」という事実だけ。要求値らしいものを
// 作って添えると、実装が持っていない判定を画面が名乗ることになる。

import type { EnsembleSource } from './kyoshinEnsembleDetector'
import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import { detectionScaleLabelFromValue } from './kyoshinIntensity'

/** 「判定した仕組み」の行に出す呼び名。並べる順もこの順 */
export const ENSEMBLE_SOURCE_LABELS: Record<EnsembleSource, string> = {
  stat: '平常時のゆらぎ',
  cluster: '揺れの広がり',
  fast: '強い揺れの急な上昇',
  sparse: '観測点の少ない地域',
}

/** 内訳の表の下に添える脚注。カードの「N観測点で反応」（いま震度0以上の点）と、表の点数（束に一度でも加わった点）は数え方が違う */
export const ENSEMBLE_EVIDENCE_FOOTNOTE = '※「加わった観測点」は、上の観測点数と数え方が異なります'

/** 内訳の表の 1 行 */
export interface EvidenceRow {
  label: string
  value: string
}

/**
 * 計測震度 → 震度階級ラベル。震度0 未満は「0以下」、欠測は `—`（`kyoshinIntensity.ts` の
 * `detectionScaleLabelFromValue`）。**0.5 刻みのインデックスへ丸めてから引かない** —— 計測震度 4.4 が「5弱」になる
 */
function scaleLabel(value: number | null): string {
  return detectionScaleLabelFromValue(value) ?? '—'
}

/**
 * カードの 1 行の要約。確かな段なら確定した瞬間の内訳で「6点・震度2で確定」。
 * 早い段は言えることが無いので null（呼び出し側は行ごと出さない）。
 */
export function ensembleSummary(d: EnsembleDetection): string | null {
  if (d.confidence !== 'confirmed' || d.confirmedSnapshot === null) return null
  return `${d.confirmedSnapshot.size}点・震度${scaleLabel(d.confirmedSnapshot.maxIntensity)}で確定`
}

/** 「判定の内訳」の表。値はいまのもの（確定までの秒だけは確定した時点で決まる） */
export function ensembleRows(d: EnsembleDetection): EvidenceRow[] {
  const sources = (Object.keys(ENSEMBLE_SOURCE_LABELS) as EnsembleSource[]).filter(s => d.sources.includes(s))
  const untilConfirmed = d.firstConfirmedAtMs === null
    ? '—'
    : `検知から${Math.max(0, Math.round((d.firstConfirmedAtMs - d.originTimeMs) / 1000))}秒`
  return [
    { label: '判定した仕組み', value: sources.length > 0 ? sources.map(s => ENSEMBLE_SOURCE_LABELS[s]).join('・') : '—' },
    { label: '加わった観測点', value: `${d.memberKeys.length}点` },
    { label: '最大震度', value: d.maxIntensity === null ? '—' : `震度${scaleLabel(d.maxIntensity)}` },
    { label: '確定まで', value: untilConfirmed },
  ]
}
