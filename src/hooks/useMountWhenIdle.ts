import { useEffect, useState } from 'react'
import { whenIdle } from '../components/Map/gl/whenIdle'

/**
 * 起動の後の手空きで中身を置いておくための旗。`openNow` が真になったら（手空きを待たずに開かれたら）その描画で立て、
 * そうでなければ起動から `delayMs` 待ってから、ブラウザの手が空いたとき（遅くとも `idleTimeoutMs`）に立てる。
 * 一度立てたら下ろさない。外されたら待っている予約を取り消す。
 *
 * 設定の窓の中身（`App.tsx` の `SettingsTab`）に使う。チャンクは分けたまま、初めて開いたときに中身を組み立てる
 * 重いフレーム（実測 200〜256 ms）を、利用者が待っていない時間へ移すため（2026-11-18 ユーザー選択
 * 「起動の後の手空きで組んでおく (Recommended)」）
 */
export function useMountWhenIdle(openNow: boolean, delayMs: number, idleTimeoutMs: number): boolean {
  const [mounted, setMounted] = useState(false)
  if (openNow && !mounted) setMounted(true)

  useEffect(() => {
    if (mounted) return
    let cancelIdle: (() => void) | null = null
    const delayId = setTimeout(() => {
      cancelIdle = whenIdle(() => setMounted(true), idleTimeoutMs)
    }, delayMs)
    return () => {
      clearTimeout(delayId)
      cancelIdle?.()
    }
  }, [mounted, delayMs, idleTimeoutMs])

  return mounted
}
