import { useMemo } from 'react'
import type { EEWAlert } from '../types/earthquake'
import { NO_EEW_AREA_ARRIVAL, eewAreas, mergeEewAreaArrival } from '../utils/eew'
import { pointInRings } from '../utils/geo'
import { useSubRegions } from './useSubRegions'

/**
 * 利用者が登録した地点が属する一次細分区域について、**気象庁が電文で出した**主要動の到達。
 *
 * **地点ごとの到達を自前で計算しない。** 気象庁が提供する予報資料から個別地点の震度や到達時刻を
 * 自前で予想して利用者へ提供する行為は、気象業務法第 17 条の許可を要する地震動の予報業務に当たりうる
 * （気象庁「地震動の予報業務許可についてよくお寄せいただくご質問」）。気象庁の発表内容を
 * そのまま伝えるのは該当しないので、公開版は**区域単位の発表値を、区域名を添えて伝える**。
 * 背景と線引きは `docs/spec/eew-spec.md` §6。
 *
 * そのため値の単位は区域（都道府県を 3〜4 つに分けた広さ）で、地点そのものの値ではない。
 * 区域名は呼び出し側（`useSWaveCountdown` の `SWaveArrival.areaName`）が必ず一緒に持つ。
 * **どの範囲に対する発表なのかを画面で示せないと、区域の値が地点の値として読まれる**ため。
 */
export interface HomeAreaArrival {
  /** 到達予測時刻（epoch ms）。到達済み・時刻を読めないときは null。 */
  arrivalMs: number | null
  /** 既に主要動が到達したと推測されているか。 */
  arrived: boolean
}

/**
 * 登録地点が属する区域を、区域データの点内判定で引く。
 *
 * **区域データが未取得・取得失敗のあいだは null。** 予想を自前で組み立てないので、
 * 気象庁が値を出している区域を特定できなければ出せるものが無い（カードを出さない）。
 */
export function useHomeAreaName(home: { lat: number; lng: number } | null): string | null {
  const { data: subregions } = useSubRegions()
  return useMemo(() => {
    if (!home || !subregions) return null
    // 区域は重ならないので最初に当たったものを採る。全国 188 区域の総当たりだが、
    // **依存が `home` と区域データだけ**なので、地点を動かすか区域データが届いたときしか走らない
    // （電文が届くたびには走らない）。
    for (const sr of subregions) {
      if (pointInRings(home.lat, home.lng, sr.rings)) return sr.name
    }
    return null
  }, [home, subregions])
}

/**
 * 1 件の緊急地震速報が、登録地点の区域（`areaName`）について伝えている到達。伝えていなければ null。
 *
 * **速報ごとに引く。別の地震の値と混ぜない。** 同時に複数の地震の速報が出ているとき、
 * カウントダウンは地震ごとに行を並べる（2026-10-18 ユーザー承認「1 枚に行を並べる」）。
 * 以前は全速報の値をいちばん早い時刻へ畳んでいたので、秒数と「震源から N km」が別の地震を指しえた。
 *
 * 1 件の中で同じ区域が二度出ることは無いはずだが、出ても `mergeEewAreaArrival` で畳む ——
 * PLUM 法の時刻を外す・読めない時刻を捨てる判定を、ほかの出し先（「主要動の到達（予測）」欄・
 * 地図の区域ポップアップ）と共有するため。
 */
export function homeAreaArrivalOf(eew: EEWAlert, areaName: string): HomeAreaArrival | null {
  let arrival = NO_EEW_AREA_ARRIVAL
  for (const a of eewAreas(eew)) {
    if (a.name !== areaName) continue
    arrival = mergeEewAreaArrival(arrival, a)
  }
  if (arrival.kind === 'none') return null
  return { arrivalMs: arrival.arrivalMs, arrived: arrival.kind === 'arrived' }
}
