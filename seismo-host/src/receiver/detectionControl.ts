// 検出の値の口（`GET`/`PUT /api/detection`）の実体（#313・2026-10-27 ユーザー承認「検出の 3 組」）。
//
// **変える操作は「次の起動で使う値を設定ファイルへ書く」だけ**（同日ユーザー承認「次の起動で」）。稼働中の
// 検出器は作り直さない —— 作り直すと長い窓（平常時の強さ）と始めに見送る長さを捨てて、その間の揺れを拾わない。
// 起動時の昇格は `hostSettings.ts` の `resolveDetection`。

import {
  DETECTION_SETTINGS_DEFAULT,
  detectionProblems,
  detectionSettingsShape,
  sameDetectionSettings,
  type DetectionProblem,
  type DetectionSettings,
} from '../detection/detectionSettings'
import type { HostSettingsFile } from './hostSettings'

export interface DetectionReport {
  /** この起動で使っている値。 */
  readonly active: DetectionSettings
  /** 次の起動で使う値。待っている変更が無ければ `null`。 */
  readonly pending: DetectionSettings | null
  /** コードの既定値（画面の「既定の値に戻す」と「既定 2.5」の添え字に使う）。 */
  readonly defaults: DetectionSettings
  /**
   * この起動で、設定ファイルの待っている変更が読めずに捨てたときの理由（`field=problem、…` か `形が違う`）。
   * 捨てていなければ `null`。次に起動するまで出し続ける（2026-10-27 ユーザー承認「タブにも出す」）。
   */
  readonly discardedPending: string | null
}

export type SetDetectionResult =
  | { readonly ok: true }
  /** 本文の形が違う（欄が欠けている・型が違う）。画面からは起きない。 */
  | { readonly ok: false; readonly problem: 'invalid-body' }
  /** 値が受け付けられない。項目ごとの断り（画面は「項目名: 文」で並べる）。 */
  | { readonly ok: false; readonly problem: 'invalid-values'; readonly problems: readonly DetectionProblem[] }
  /** 設定ファイルを書けない。 */
  | { readonly ok: false; readonly problem: 'not-writable'; readonly detail: string }

export interface DetectionOps {
  get(): DetectionReport
  /** 次の起動で使う値を置く。`null` は待っている変更の取り消し。 */
  setPending(value: unknown): SetDetectionResult
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DetectionControl implements DetectionOps {
  constructor(
    private readonly opts: {
      /** この起動で使っている値（起動時に 1 回だけ決めたもの）。 */
      readonly active: DetectionSettings
      /** 設定ファイルの書き手（保存先の係と同じものを渡す）。 */
      readonly settingsFile: HostSettingsFile
      /** 起動時に待っている変更を捨てた理由（{@link DetectionReport.discardedPending}）。 */
      readonly discardedPending: string | null
    },
  ) {}

  get(): DetectionReport {
    return {
      active: this.opts.active,
      pending: this.opts.settingsFile.get().pendingDetection,
      defaults: DETECTION_SETTINGS_DEFAULT,
      discardedPending: this.opts.discardedPending,
    }
  }

  setPending(value: unknown): SetDetectionResult {
    let next: DetectionSettings | null = null
    if (value !== null) {
      const shaped = detectionSettingsShape(value)
      if (shaped === null) return { ok: false, problem: 'invalid-body' }
      const problems = detectionProblems(shaped)
      if (problems.length > 0) return { ok: false, problem: 'invalid-values', problems }
      // **いまと同じ値は待たせない**（「次の再起動で変わる値がある」と出し続けないため）。
      next = sameDetectionSettings(shaped, this.opts.active) ? null : shaped
    }
    try {
      this.opts.settingsFile.update((s) => ({ ...s, pendingDetection: next }))
    } catch (error) {
      return { ok: false, problem: 'not-writable', detail: messageOf(error) }
    }
    return { ok: true }
  }
}
