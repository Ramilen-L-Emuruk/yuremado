import { useEffect, useState } from 'react'
import { serverNow } from '../utils/clock'

/**
 * 1 分ごとに進む「今」（サーバーと合わせた時刻。再生中は再生時刻）。`enabled` が偽の間は 0 を返して進めない
 * （使わないのに 1 分ごとに描き直させない）。
 *
 * 地震タブの期間（今から遡る時間）の絞りが、時間が経って範囲から出た地震を外すために使う。
 */
export function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => (enabled ? serverNow() : 0))
  useEffect(() => {
    if (!enabled) {
      setNow(0)
      return
    }
    setNow(serverNow())
    const id = setInterval(() => setNow(serverNow()), 60_000)
    return () => clearInterval(id)
  }, [enabled])
  // 偽から真へ変わった描画では state がまだ 0（effect が後で入れる）。その 1 回も「今」で絞る（0 だと全件が期間に入る）
  if (!enabled) return 0
  return now !== 0 ? now : serverNow()
}
