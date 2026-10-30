import type { ReplayPayload } from '../types/replay'

/**
 * 再生用ペイロード（`ReplayPayload`）の判別子の一覧。**実地震テストシナリオとローカル履歴アーカイブの
 * 検証（`testScenarioSchema.ts`・`historicalArchiveSchema.ts`）はどちらもここから導く。**
 *
 * **`ReplayPayload['kind']` の全種別を持つ表にしておく。** 文字列を手で並べていた頃は、種別を足しても
 * 一覧へ書き忘れて、`remapPayload` が扱える `quakeNotice`・`earthquakeCount`・`estimatedIntensity` の
 * 3 種別がシナリオの読み込みで**黙って捨てられていた**（2026-10-18 に 10/16 の誤報のシナリオで、
 * 13:15 のお知らせが帯にすら出ないことで発覚）。`satisfies` で全種別を要求しているので、種別を足すと
 * 型検査がここで止まり、余分な種別を書いても止まる。
 */
const REPLAY_PAYLOAD_KIND_TABLE = {
  event: true,
  lpgm: true,
  nankai: true,
  nankaiCommentary: true,
  kohatsu: true,
  quakeNotice: true,
  earthquakeCount: true,
  estimatedIntensity: true,
  internationalTsunami: true,
} as const satisfies Record<ReplayPayload['kind'], true>

export const REPLAY_PAYLOAD_KINDS: ReadonlySet<string> = new Set(Object.keys(REPLAY_PAYLOAD_KIND_TABLE))
