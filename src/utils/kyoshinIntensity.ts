// 強震モニタのリアルタイム震度インデックス（0〜20, 計測震度 = index * 0.5 - 3.0）を
// JMA 震度階級へ変換する。
//
// **階級の境目はここに持たない。** 表は `measuredIntensity.ts` が単一情報源で、
// ここはインデックスを計測震度へ直してから渡すだけ（同じ表を自作地震計の震度も通る）。
//
// 地図のラベルバッジ（KyoshinPoints）と右パネルの検知カード（RealtimeTab）で
// 共通利用し、変換ロジックの二重管理を避ける。

import { intensityGradeColor, measuredIntensityToGrade, type IntensityGrade } from './measuredIntensity'

export function kyoshinIndexToJma(index: number | undefined): IntensityGrade | null {
  if (index == null) return null
  const value = -3.0 + index * 0.5
  // **震度0 未満は階級を返さない。** これは強震モニタ側の決め事（階級の付いたバッジを出す下限）で、
  // 気象庁の階級表の話ではない —— あちらの震度0 に下限は無い（2026-10-22 ユーザー選択「今のまま記録する (Recommended)」）。
  // 検知に入った点だけは、階級の付かない印で地図に描く（`gl/kyoshinDetectedFeatures.ts`。
  // 2026-10-29 ユーザー「検知しているなら描画するべきだと思います」）。
  if (!(value >= 0.0)) return null
  return measuredIntensityToGrade(value)
}

/** 震度階級ラベルのみが必要なときの簡易版。 */
export function kyoshinIndexToLabel(index: number | undefined): string | null {
  return kyoshinIndexToJma(index)?.label ?? null
}

/**
 * 揺れ検知の震度を通知・検知カードへ出すときの呼び名。震度0 未満（計測震度が 0 を下回る）は「0以下」と呼ぶ
 * （2026-10-29 ユーザー選択「「震度0以下」と出す (Recommended)」）。組み合わせの検知器は震度1 に届かない揺れも
 * 確かな段にするので、全員が震度0 未満のまま確かな段になりうる。欠測（負のインデックス）・読めない値は null
 */
export function kyoshinDetectionScaleLabel(index: number | undefined): string | null {
  if (index == null || !Number.isFinite(index) || index < 0) return null
  return kyoshinIndexToLabel(index) ?? DETECTION_BELOW_ZERO_LABEL
}

/** 計測震度から、揺れ検知の震度の呼び名（{@link kyoshinDetectionScaleLabel} と同じ決め事）。読めない値は null */
export function detectionScaleLabelFromValue(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  if (value < 0) return DETECTION_BELOW_ZERO_LABEL
  return measuredIntensityToGrade(value)?.label ?? null
}

/** 震度0 未満の揺れ検知の呼び名 */
const DETECTION_BELOW_ZERO_LABEL = '0以下'

/**
 * 検知に入った震度0 未満の点の色。インデックス 0〜5（計測震度 −3.0〜−0.5）の 6 段で、
 * 弱いほど地図の背景（#0a0c10）に近い暗い灰、強いほど震度0 の配色（`SHINDO0_COLOR` = #9ca3af）の手前の灰へ上がる。
 * 弱い→強いが「暗い灰 → 明るい灰 → 震度0 の灰 → 震度1 の水色」と一続きになるので、震源側ほど明るい点が集まって
 * 広がりが読める（2026-10-30 ユーザー選択「明るさと大きさで段を付ける (Recommended)」。それまでは 6 段とも
 * 1 色で、しかも震度0 より明るい #c8ccd2 だったため、強さの順と明るさの順が逆になっていた）
 */
export const KYOSHIN_SUB_ZERO_STEP_COLORS = ['#363b44', '#444a54', '#535a65', '#626a76', '#727a86', '#828a96'] as const

/** 震度0 未満の段の数（インデックス 0〜{@link KYOSHIN_SUB_ZERO_STEPS} − 1） */
export const KYOSHIN_SUB_ZERO_STEPS = KYOSHIN_SUB_ZERO_STEP_COLORS.length

/**
 * 震度0 未満のインデックスを段（0〜5）へ収める。範囲の外は端へ寄せる
 * （呼ぶ側は震度0 未満と分かった点だけを渡す。欠測は渡さない）
 */
export function kyoshinSubZeroStep(index: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(KYOSHIN_SUB_ZERO_STEPS - 1, Math.floor(index)))
}

/**
 * 段を 0（いちばん弱い）〜1（いちばん強い）の比へ直す。印の半径・白フチの濃さはこの比で段を付ける
 * （補間の式を描く側ごとに持つと、片方だけ変えたときに段の付き方がずれるため 1 箇所に置く）
 */
export function kyoshinSubZeroStepRatio(step: number): number {
  return KYOSHIN_SUB_ZERO_STEPS > 1 ? kyoshinSubZeroStep(step) / (KYOSHIN_SUB_ZERO_STEPS - 1) : 1
}

/**
 * 検知カードの「0以下」の行の色。行は段をまとめて数えるので、いちばん強い段の色を使う
 * （2026-10-30 ユーザー選択「明るさと大きさで段を付ける (Recommended)」の説明文「カードの「0以下」の行の色は、
 * いちばん強い段の色に合わせる」）
 */
export const KYOSHIN_SUB_ZERO_COLOR = KYOSHIN_SUB_ZERO_STEP_COLORS[KYOSHIN_SUB_ZERO_STEPS - 1]

/**
 * 計測震度からリアルタイム震度インデックス(0〜20)を求める（kyoshinIndexToJmaの逆変換）。
 * ローカル生成の強震モニタ風アーカイブ（scripts/capture-kyoshin-waveform.ts）が、実波形から
 * 算出した計測震度をこのインデックス形式へ変換する際に使う。範囲外は0/20へクランプする
 * （観測点集合の型はYahoo由来・NIED由来を問わず同じ0〜20の規約に統一しているため）。
 *
 * **画面へ出す階級を引くのにこれを噛ませないこと。** 0.5 刻みへ丸めるので、
 * 計測震度 4.4 が「5弱」になる（`round(7.4/0.5)=15` → 4.5）。計測震度を持っているなら
 * `measuredIntensityToGrade` を直に呼ぶ。
 */
export function kyoshinValueToIndex(value: number): number {
  const index = Math.round((value + 3.0) / 0.5)
  return Math.max(0, Math.min(20, index))
}

/**
 * リアルタイム震度インデックスの表示色（気象庁の震度配色に統一）。
 *   震度0未満 → null（表示しない）
 *   震度0     → 灰色（SHINDO0_COLOR）
 *   震度1以上 → 気象庁の震度配色（getIntensityColor）
 */
export function kyoshinIntensityColor(index: number | undefined): string | null {
  const jma = kyoshinIndexToJma(index)
  if (!jma) return null
  return intensityGradeColor(jma)
}
