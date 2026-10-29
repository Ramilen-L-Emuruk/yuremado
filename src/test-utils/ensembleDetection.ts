/**
 * テスト用の組み合わせの検知（`EnsembleDetection`）を作る。
 *
 * 既定値はどのテストの主張にも関わらない値で埋めてある。テストが見る欄だけを `overrides` で渡すこと。
 * `drawnKeys`（地図に描く点）を渡さなければ `memberKeys` と同じにする（外した点の無い束）。
 */
import type { EnsembleDetection } from '../utils/kyoshinEnsembleTracker'

export function fakeEnsembleDetection(overrides: Partial<EnsembleDetection> = {}): EnsembleDetection {
  return {
    id: 'e1',
    confidence: 'likely',
    epicenter: [35, 135],
    originTimeMs: 0,
    memberKeys: [],
    maxIntensity: null,
    firstConfirmedAtMs: null,
    sources: ['stat'],
    lastReportMs: 0,
    confirmedSnapshot: null,
    ...overrides,
    drawnKeys: overrides.drawnKeys ?? overrides.memberKeys ?? [],
  }
}
