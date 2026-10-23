// 電文ログの保持（上限と、古い行の捨て方）。
//
// **枠は経路ごとに分ける。** 1 本の枠にすると、テストボタンを数回押しただけで本物の受信の
// 記録が古い側から押し出される —— 実地震の直後にテストを試した人が、まさにその地震の
// 受信記録を失う。例外もログも出ないので、画面からは「その電文は届かなかった」のと
// 見分けが付かない（2026-10-23 ユーザー選択「守る（推奨）」）。
import type { TelegramLogEntry, TelegramOrigin } from '../types/earthquake'

/**
 * 経路ごとの保持件数。
 *
 * **ライブを厚く持つ。** あれは後から「本物がいつ何を受け取ったか」を調べる唯一の記録で、
 * 作り直せない。テストと再生は同じものをもう一度流せる。
 */
export const TELEGRAM_LOG_LIMITS: Readonly<Record<TelegramOrigin, number>> = {
  live: 200,
  test: 50,
  replay: 100,
}

/** 1 行積む。その経路の上限を超えたぶんは、その経路の古い行から捨てる。 */
export function appendToTelegramLog(
  log: readonly TelegramLogEntry[],
  entry: TelegramLogEntry,
): TelegramLogEntry[] {
  const next = [entry, ...log]
  const limit = TELEGRAM_LOG_LIMITS[entry.origin]
  let seen = 0
  // **捨てるのは同じ経路の行だけ。** 全体の末尾から切ると、ライブの行が溜まっているときに
  // テストの 1 通がライブの最古を押し出す（枠を分けた意味が無くなる）。
  return next.filter((e) => {
    if (e.origin !== entry.origin) return true
    seen += 1
    return seen <= limit
  })
}

/**
 * 指定した経路の行だけを落とす（リプレイの開始・停止で使う）。
 *
 * **ライブの行は残す。** 再生は「その窓を見る」ための機能なので再生・テストの行は窓に
 * 合わせて空にするが、その前後にライブで受けた記録まで消す理由は無い。再生中に再生のぶん
 * だけを見たいときは、経路の絞り込みで「再生」を選ぶ。
 */
export function dropTelegramLogOrigins(
  log: readonly TelegramLogEntry[],
  origins: readonly TelegramOrigin[],
): TelegramLogEntry[] {
  return log.filter(e => !origins.includes(e.origin))
}
