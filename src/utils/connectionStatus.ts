import type { ConnectionStatus } from '../types/earthquake'
import type { RelayUpstreamStatus } from '../services/dmdata'

/**
 * ライブの受信が止まっているか（地図の更新時刻に「更新停止」の警告を出すか）。
 *
 * **比較を呼び出し側へ並べないこと。** `ConnectionStatus` に値を足したとき、`===` の並びは
 * 書き忘れても型検査に掛からず、新しい状態でだけ警告が出ない形で漏れる。ここで網羅検査をすれば
 * 足した時点で型検査が止まる。
 *
 * **中継と繋がっていても、中継が DMDATA.JP と切れていれば止まっている**（`upstream`。電文が届かないので）。
 * 地図には新しい文を足さず、いまの赤い更新時刻で示す（2026-10-31 ユーザー選択「設定の行＋地図は今の赤い更新時刻 (Recommended)」）。
 * 自分の鍵の予報の接続が切れても地図には出さない（同じ選択肢の説明「予報の切断は地図に出さない」）。
 */
export function isLiveFeedHalted(status: ConnectionStatus, upstream: RelayUpstreamStatus | null): boolean {
  switch (status) {
    case 'disconnected':
    case 'crowded':
    case 'contract-ended':
    case 'closed-by-user':
      return true
    case 'connected':
      return upstream !== null && !upstream.connected
    case 'connecting':
    // 再生中はライブを意図的に止めている。異常ではないので警告を出さない
    case 'replay':
      return false
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}
