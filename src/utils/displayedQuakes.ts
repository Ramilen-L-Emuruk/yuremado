// 地震タブに出す地震を「最低表示震度」で絞る。App が地震タブ・津波タブ・地図へ渡す一覧はこれを通す。
import type { JMAQuake, JMATsunami } from '../types/earthquake'
import { extractQuakeEventId } from './quakeMerge'
import { tsunamiEventIds } from './tsunami'

/**
 * 最低表示震度（`minDisplayScale`。負ならすべて出す）より小さい地震を一覧から外す。
 *
 * **外さないもの**
 * - 遠地地震。国外の地震を伝える情報で国内震度を持たない（maxScale は常に -1）。「最低表示震度」は
 *   国内の小さい地震を一覧から省く設定なので、震度で比べようがない遠地地震まで巻き添えで消さない
 *   （M7 以上でしか発表されない情報のため）
 * - 津波の原因地震。小さい地震でも津波を伴えば、津波タブの原因地震の欄から地震カードへ飛べる必要がある
 *   （2026-10-21 選択「直す (Recommended)」。最低表示震度より小さくても地震タブに出す）。
 *   突き合わせは津波の識別子（`tsunamiEventIds`。続報で増えた番号も含む）と地震の識別子
 *   （`extractQuakeEventId`）で、津波タブの引き当て（`linkTsunamiSources`）と同じ識別子を使う
 */
export function filterDisplayedQuakes(
  earthquakes: readonly JMAQuake[],
  minDisplayScale: number,
  tsunamis: readonly Pick<JMATsunami, 'eventId' | 'foldedReports'>[],
): JMAQuake[] {
  if (minDisplayScale < 0) return [...earthquakes]
  const sourceIds = new Set(tsunamis.flatMap(t => tsunamiEventIds(t)))
  return earthquakes.filter(q => {
    if (q.issue.type === '遠地地震') return true
    if (q.earthquake.maxScale >= minDisplayScale) return true
    const id = extractQuakeEventId(q)
    return id !== null && sourceIds.has(id)
  })
}
