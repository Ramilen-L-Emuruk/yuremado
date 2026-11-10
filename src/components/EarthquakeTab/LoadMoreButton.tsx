import { useEffect, useState } from 'react'
import { loadMoreDrainsAt } from '../../services/dmdataRequestGates'
import { relayThrottleRemainingMs } from '../../services/relayEndpoint'
import { formatLoadMoreThrottleLeft } from '../../utils/telegramLoss'
import { useMessages } from '../../i18n/I18nProvider'

/**
 * 残り時間を読み直す間隔。**表示が秒単位なので 1 秒より細かくしない。**
 *
 * 門（`utils/requestGate.ts`）は React の外にいて購読の口を持たないので、
 * `hooks/useFetchThrottled.ts` と同じくポーリングで読む。
 */
const POLL_MS = 1000

interface Props {
  onLoadMore: () => void
  isLoadingMore: boolean
  /**
   * 取得制限の待ちを見張るか。`false` なら門を読まず「取得中…」のまま（`useFetchThrottled` の `enabled` と同じ）。
   */
  watchThrottle: boolean
}

/**
 * 地震一覧の末尾の「もっと見る」。
 *
 * **押した後、配信元の上限で待たされている間は残り時間を出す**（例「取得制限中（あと 2:15）」）。
 * 一覧の上の帯（`FETCH_THROTTLED_NOTICE`）は、ボタンを押した位置からは見えないため。
 * 押す前には出さない（文言・押した後だけ出すこととも 2026-10-06 ユーザー承認）。
 *
 * **部品を分けているのは、毎秒の描き直しをこのボタンだけに閉じるため。** 一覧（`EarthquakeTab`）で
 * 数えると、待っている間ずっと一覧全体が 1 秒ごとに描き直される。
 *
 * 数えるのは「この『もっと見る』の取得（押すたびに作る印）が門を通り終えるまで」
 * （`loadMoreDrainsAt`）。同じ門に並ぶ他の待ちは、印の取得より前にいる分だけが効く。
 * 中継へ繋いでいるときは、中継の門が明けるまで（`relayThrottleRemainingMs`）も数える。中継の門は
 * 中継への要求を一律に待たせるので、押している間に待っていれば、それはこの取得の待ちでもある。
 * 両方で待っていれば遅いほうを出す。
 * 待ちが解けたあとの読み込み・反映はまだ続くので、そこは従来どおり「取得中…」に戻る。
 */
export function LoadMoreButton({ onLoadMore, isLoadingMore, watchThrottle }: Props) {
  const w = useMessages().quake.list
  const remainingMs = useThrottleRemaining(watchThrottle && isLoadingMore)
  const label = !isLoadingMore
    ? w.loadMore
    : remainingMs !== null ? w.throttled(formatLoadMoreThrottleLeft(remainingMs)) : w.fetching
  return (
    <button
      onClick={onLoadMore}
      disabled={isLoadingMore}
      className="w-full py-2.5 text-sm text-secondary hover:text-white bg-card border border-border hover:border-blue-600 rounded-lg transition-colors disabled:opacity-50"
    >
      {label}
    </button>
  )
}

/** 門の待ちが解けるまでの残り（ミリ秒）。見張っていない・待っていなければ `null`。 */
function useThrottleRemaining(enabled: boolean): number | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) {
      setRemainingMs(null)
      return
    }
    const read = () => {
      const at = loadMoreDrainsAt()
      // 上限 0 件の窓（永久に待つ）は数えられないので「取得中…」のままにする
      if (at !== null && !Number.isFinite(at)) {
        setRemainingMs(null)
        return
      }
      // DMDATA の門は `Date.now()` で数えているので、残りも同じ時計で測る（`serverNow` と混ぜない）。
      // 中継の門は自分で残りを返す（単調な時計で数えている）
      const dmdata = at === null ? null : at - Date.now()
      const relay = relayThrottleRemainingMs()
      setRemainingMs(dmdata === null ? relay : relay === null ? dmdata : Math.max(dmdata, relay))
    }
    // **最初の 1 回はすぐ読む。** 押した直後から 1 秒「取得中…」と出るのを避ける
    read()
    const id = setInterval(read, POLL_MS)
    return () => clearInterval(id)
  }, [enabled])
  return remainingMs
}
