// 電文ログの保持（どこまで持つかと、古い行の捨て方）。
//
// **枠は経路ごとに分ける。** 1 本の枠にすると、テストボタンを数回押しただけで本物の受信の
// 記録が古い側から押し出される —— 実地震の直後にテストを試した人が、まさにその地震の
// 受信記録を失う。例外もログも出ないので、画面からは「その電文は届かなかった」のと
// 見分けが付かない（2026-10-23 ユーザー選択「守る（推奨）」）。
import type { TelegramLogEntry, TelegramOrigin } from '../types/earthquake'

/**
 * ライブの行を持つ長さ（ミリ秒）。**件数ではなく時間で持つ。**
 *
 * 件数（以前は 200 件）で切ると、持てる期間が地震の多さで変わる —— 全期間の控えで数えると
 * 200 件が覆う期間は中央値 185.6 時間・最短 0.72 時間で、大きな地震の直後ほど短くなり、
 * まさにその地震の受信記録から消えていった（2026-10-23 ユーザー選択「直近 24 時間ぶんを持つ (Recommended)」）。
 * 24 時間ぶんの最大は 2024-01-01〜02 の 2,022 件・約 18MB（本文を丸ごと持つため）。
 */
export const TELEGRAM_LOG_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * テストと再生の行の保持件数。**この 2 つは件数のまま**（2026-10-25 ユーザー選択「ライブだけ24時間 (Recommended)」）。
 *
 * テストの電文は 1 通が大きく（能登の地震情報は約 40 万字）、続けて押すと 24 時間ぶんでは数十 MB に
 * なりうる。どちらも同じものをもう一度流せるので、ライブほど厚く持つ理由が無い。
 */
export const TELEGRAM_LOG_COUNT_LIMITS: Readonly<Record<Exclude<TelegramOrigin, 'live'>, number>> = {
  test: 50,
  replay: 100,
}

/**
 * ライブの行を、受け取った時刻で見て捨てるか。
 *
 * **物差しは行の `receivedAt` と同じ時計（`serverDate`）で渡す。** 再生中はこの時計が再生時刻を名乗るので、
 * 再生前にライブで受けた行は「未来」に見えて残る（再生のあいだにライブの記録が消えない）。
 * 時刻を読めない行は捨てない（測れないため）。
 */
function isExpiredLive(entry: TelegramLogEntry, nowMs: number): boolean {
  const t = entry.receivedAt.getTime()
  return Number.isFinite(t) && Number.isFinite(nowMs) && t < nowMs - TELEGRAM_LOG_LIVE_WINDOW_MS
}

/**
 * 1 行積む。ライブは 24 時間より古い行を、テストと再生は件数の上限を超えたぶんを、
 * **それぞれ同じ経路の行からだけ**捨てる。
 *
 * @param nowMs 行の `receivedAt` と同じ時計の「いま」（→ {@link isExpiredLive}）
 */
export function appendToTelegramLog(
  log: readonly TelegramLogEntry[],
  entry: TelegramLogEntry,
  nowMs: number,
): TelegramLogEntry[] {
  const next = [entry, ...log]
  if (entry.origin === 'live') return pruneTelegramLog(next, nowMs)
  const limit = TELEGRAM_LOG_COUNT_LIMITS[entry.origin]
  let seen = 0
  // **捨てるのは同じ経路の行だけ。** 全体の末尾から切ると、ライブの行が溜まっているときに
  // テストの 1 通がライブの最古を押し出す（枠を分けた意味が無くなる）。
  const kept = next.filter((e) => {
    if (e.origin !== entry.origin) return true
    seen += 1
    return seen <= limit
  })
  return pruneTelegramLog(kept, nowMs)
}

/**
 * ライブの行のうち 24 時間より古いものを捨てる。何も捨てなければ**同じ配列を返す**
 * （定期的に呼ぶので、変わっていないのに描き直させない）。
 *
 * 新しい行が届いたときだけ捨てると、何も届かない間は古い行がいつまでも残る。そのため積む側が
 * 一定の間隔でも呼ぶ（`useEarthquakes.ts`）。
 */
export function pruneTelegramLog<T extends readonly TelegramLogEntry[]>(log: T, nowMs: number): T | TelegramLogEntry[] {
  if (!log.some(e => e.origin === 'live' && isExpiredLive(e, nowMs))) return log
  return log.filter(e => !(e.origin === 'live' && isExpiredLive(e, nowMs)))
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
