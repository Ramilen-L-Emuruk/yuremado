// 電文ログの行が、訓練の電文か試験の電文かを本文から読む。
//
// **配信元の `head.test` では分けられない。** DMDATA は訓練（`Control/Status` が「訓練」）も
// 試験（同「試験」。毎正時の配信テスト VXSE42 など）も同じ真で渡すので、電文ログで両方を
// 「訓練」と出していた。分けるには電文自身の名乗りを読むしかない。
//
// パーサー（`services/dmdataParser.ts` の `parseOperationStatus`）は文書を組んでから読むが、
// ここは**捨てる電文にも掛ける**（試験報は受け付けない設定のとき、読まずに電文ログへだけ積む）。
// 1 行のために DOM を組まないよう、`Control` の中の `Status` だけを文字で探す。
import type { TelegramOperationStatus } from '../types/earthquake'

// 開始タグの属性（名前空間の宣言など）と接頭辞を許す。`Status` は `Control` の中だけで探す
// （`Control` に `Status` が無いとき、後ろの別の要素の `Status` を拾わないように）。
const CONTROL_BLOCK = /<(?:[\w.-]+:)?Control\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Control>/
const STATUS = /<(?:[\w.-]+:)?Status\b[^>]*>\s*([^<]*?)\s*<\/(?:[\w.-]+:)?Status>/

/**
 * XML 電文の `Control/Status` が「訓練」「試験」なら返す。**「通常」・読めないときは何も返さない**。
 *
 * 二進電文（推計震度分布図）は渡さない —— 本文に `Control` が無く、運用種別は「通常かそれ以外か」
 * しか読めない（`utils/bufrEstimatedIntensity.ts` の電文の種類）。
 */
export function readTelegramOperationStatus(xml: string): TelegramOperationStatus | undefined {
  const control = CONTROL_BLOCK.exec(xml)?.[1]
  const raw = control === undefined ? undefined : STATUS.exec(control)?.[1]
  return raw === '訓練' || raw === '試験' ? raw : undefined
}
