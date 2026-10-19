import type { ConnectionStatus } from '../types/earthquake'

/**
 * ライブの受信が止まっているか（地図の更新時刻に「更新停止」の警告を出すか）。
 *
 * **比較を呼び出し側へ並べないこと。** `ConnectionStatus` に値を足したとき、`===` の並びは
 * 書き忘れても型検査に掛からず、新しい状態でだけ警告が出ない形で漏れる。ここで網羅検査をすれば
 * 足した時点で型検査が止まる。
 */
export function isLiveFeedHalted(status: ConnectionStatus): boolean {
  switch (status) {
    case 'disconnected':
    case 'crowded':
    case 'contract-ended':
    case 'closed-by-user':
      return true
    case 'connecting':
    case 'connected':
    // 再生中はライブを意図的に止めている。異常ではないので警告を出さない
    case 'replay':
      return false
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}
