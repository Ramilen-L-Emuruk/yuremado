import { useEffect, useRef, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import { travelTimeSec } from '../utils/travelTime'
import { calcArrivalSafetyMarginSec, calcEEWAutoCancelSec, eewEventKey, isProvisionalHypocenter, S_WAVE_FALLBACK_KM_PER_SEC } from '../utils/eew'
import { hasKnownEpicenter, haversineKm } from '../utils/geo'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'
import { homeAreaArrivalOf, useHomeAreaName } from './useHomeAreaArrival'

/**
 * 登録地点への主要動到達の見込み。**地震ごとに 1 行**（`rows`）。
 *
 * **同時に複数の地震の緊急地震速報が出ているときは、地震ごとに並べる**（2026-10-14 ユーザー決定
 * 「地震ごとに並べて出す」。見せ方・並び順・上限・音は 2026-10-18 ユーザー承認 —— 「1 枚に行を並べる」
 * 「到達の早い順」「上限なし」「いちばん早く届く地震」）。以前は S 波の円がいちばん大きい 1 件だけを
 * 相手にしていたので、近い別の地震を取りこぼし、公開版では秒数と距離が別の地震を指しえた。
 *
 * **出どころが 2 つあり、既定は気象庁の発表値。** 自前の走時計算で「その地点へ何秒後」を出すのは
 * 気象業務法第 17 条の許可を要する地震動の予報業務に当たりうるため（→ `useHomeAreaArrival`）、
 * 公開版は気象庁が区域ごとに出した到達予測時刻をそのまま伝える。自前計算は発行済みトークンを
 * 持つ端末でだけ有効になる（→ `docs/spec/eew-spec.md` §6）。
 *
 * **`source` を画面へ必ず反映すること。** 区域の値と地点の値は精度も意味も違うので、
 * どちらを出しているか判らない表示にすると、区域の値が地点の値として読まれる。
 */
export interface SWaveArrival {
  /** `'telegram'` = 気象庁の区域ごとの発表値／`'own'` = 自前の走時計算（地点） */
  source: 'telegram' | 'own'
  /** 気象庁が値を出した区域の名前。`source === 'own'` では null。どの行も同じ区域の値なので 1 つだけ持つ。 */
  areaName: string | null
  /**
   * 地震ごとの行。**1 件以上**（出す行が無ければ `SWaveArrival` ごと null）。
   * 並びは**到達済み → 残りの早い順 → 推定中 → 到達予測の出ていない行**（{@link compareArrivalRows}）。どの行も同じ速さで秒が減るので、
   * 続報で時刻が変わらない限り順番は入れ替わらない。
   */
  rows: readonly SWaveArrivalRow[]
}

/** 1 つの地震について、登録地点への主要動到達の見込み。 */
export interface SWaveArrivalRow {
  /** 地震の鍵（`eewEventKey`）。行の見分けと、並びが同点のときの決め手。 */
  key: string
  /** 震央地名（緊急地震速報のカードの見出しと同じもの）。無ければ null。 */
  hypocenterName: string | null
  /**
   * 震源が決まっていない報か（→ `isProvisionalHypocenter`）。地名は「揺れを捉えた観測点の所在地」で
   * 震源ではないので、画面はカードの見出しと同じく「（震源未確定）」を添える。距離は出さない。
   */
  provisional: boolean
  /** 震源から登録地点までの距離 [km]。震源が判らなければ null（距離は観測事実で予想ではない）。 */
  distanceKm: number | null
  /** 到達までの秒数。到達済みは 0、推定不能は null。 */
  etaSec: number | null
  arrived: boolean
  /**
   * 登録地点の区域について、その速報が到達予測時刻を出していないか（公開版の経路だけ。自前計算の行は常に false）。
   *
   * 真の行は**距離だけを伝える**（2026-10-14 ユーザー承認「距離だけのカードを出す」、行の並べ方は 2026-10-19 ユーザー承認
   * 「行として最後に並べる (推奨)」）。`etaSec` は null・`arrived` は false で、`distanceKm` は必ず数値
   * （震源が決まっていない報・位置不明・取消済みは距離を出せないので行を作らない）。並びは最後、秒読みの音の相手にもしない。
   */
  noForecast: boolean
}

/**
 * 行の並び。**到達済みを先頭、残りは残り秒数の短い順、推定中（秒数が null）、到達予測の出ていない行（`noForecast`）を最後。**
 * 同点は地震の鍵で決める（描き直しのたびに並びが揺れないように）。
 */
export function compareArrivalRows(a: SWaveArrivalRow, b: SWaveArrivalRow): number {
  if (a.noForecast !== b.noForecast) return a.noForecast ? 1 : -1
  if (a.arrived !== b.arrived) return a.arrived ? -1 : 1
  if (!a.arrived) {
    if (a.etaSec === null && b.etaSec !== null) return 1
    if (a.etaSec !== null && b.etaSec === null) return -1
    if (a.etaSec !== null && b.etaSec !== null && a.etaSec !== b.etaSec) return a.etaSec - b.etaSec
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * 秒読みの音を鳴らす相手。**まだ届いていない地震のうち、到達がいちばん早いもの**
 * （2026-10-18 ユーザー承認「いちばん早く届く地震」）。音はいつも 1 本で、その地震が届いた後は
 * 次の地震の残り秒数へ移る。鳴らす相手が無ければ null。
 *
 * **地震の鍵も返す。** 呼び出し側は「同じ秒数を二度鳴らさない」判定を地震の鍵と組で行う ——
 * 秒数だけで比べると、地震が替わった直後に前の地震と同じ秒数だったときに鳴らない。
 */
export function countdownBeepTarget(arrival: SWaveArrival | null): { key: string; etaSec: number } | null {
  if (arrival === null) return null
  for (const row of arrival.rows) {
    // 到達予測の出ていない行は秒数を持たないが、型の上で null であることに頼らず明示して外す（2026-10-19 ユーザー承認「秒読みの音には加えない」）
    if (row.noForecast) continue
    if (!row.arrived && row.etaSec !== null) return { key: row.key, etaSec: row.etaSec }
  }
  return null
}

const SPEED_SMOOTH_FRAMES = 3   // 移動平均フレーム数
const MIN_VALID_SPEED = 0.5     // この速度(km/s)未満はフォールバック使用
/**
 * 発表値の残り秒数を進める間隔。
 *
 * **予報円の更新に相乗りしない。** いまは `usePsWaveCalc` が 100ms ごとに新しい配列を返すので
 * 秒数はそれでも動くが、それは**あちらが同一参照を返さないという偶然**に頼っている。
 * 空のときは同じ参照を返す、といった最適化が入った瞬間に秒数が黙って止まるので、
 * 発表値を出す経路は自分で計時する。
 */
const TELEGRAM_TICK_MS = 1000

/**
 * 1 件の速報の震源から登録地点までの距離 [km]。**震源が本物でなければ null。**
 *
 * 予報円の有無に依存させない（深さが判らない報は円を出さないが、距離は緯度経度だけで決まる観測事実）。
 * **外すものが 3 つある。**
 *
 * - **取消済み** —— 画面から消えたものの距離を出さない
 * - **位置不明**（センチネル `-200`）—— 判定は `hasKnownEpicenter` を通す。有限なので
 *   `Number.isFinite` ではすり抜ける（→ `docs/spec/quake-spec.md` §5）
 * - **震源が決まっていない報**（仮定震源要素・「非常に強い揺れを検知」の報。→ `isProvisionalHypocenter`）
 *   —— 地名も座標も「揺れを捉えた観測点の所在地」であって震源ではない
 *   （→ `docs/spec/eew-spec.md` §5）。ここまでの距離を「震源から N km」と出したら嘘になる
 */
function epicenterDistanceKm(eew: EEWAlert, home: { lat: number; lng: number }): number | null {
  if (eew.cancelled || eew.cancelledAt) return null
  if (isProvisionalHypocenter(eew)) return null
  const { latitude, longitude } = eew.earthquake.hypocenter
  if (!hasKnownEpicenter(latitude, longitude)) return null
  return haversineKm(latitude, longitude, home.lat, home.lng)
}

function hypocenterNameOf(eew: EEWAlert | undefined): string | null {
  const name = eew?.earthquake.hypocenter.name
  return name ? name : null
}

/** 自前計算の経路で、地震ごとに持ち越す値（S 波の波面がまだ地表に出ていない間の速度の見積もり）。 */
interface OwnCalcTrack {
  prevSRadius: number | null
  speedHistory: number[]
  /** 判定の記録を報ごとに 1 回へ絞る鍵（規模と深さ）。 */
  lastLoggedKey: string | null
  /** 行を作らなかったことを記録したか（地震ごとに 1 回）。 */
  skipLogged: boolean
}

export function useSWaveCountdown(
  psWave: PsWaveCircle[],
  eews: EEWAlert[],
  home: { lat: number; lng: number } | null,
  hasActiveEEW: boolean,
  /**
   * 自前の走時計算を使ってよいか（発行済みトークンの検証結果）。
   *
   * **既定値を持たせない。** 渡し忘れたときに黙って自前計算へ倒れると、公開版が
   * 許可の要る形で動いてしまう。呼び出し側に必ず決めさせる。
   */
  allowOwnCalculation: boolean,
): SWaveArrival | null {
  const [arrival, setArrival] = useState<SWaveArrival | null>(null)
  // 地震ごと（予報円の `eventId`）。発表が終わった地震の分は毎回捨てる。
  const tracksRef = useRef(new Map<string, OwnCalcTrack>())
  const homeAreaName = useHomeAreaName(home)

  // 発表値を使う経路の計時。予報円の更新に相乗りできない理由は TELEGRAM_TICK_MS のコメント。
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!hasActiveEEW || home === null || allowOwnCalculation) return
    const id = setInterval(() => setTick((t) => t + 1), TELEGRAM_TICK_MS)
    return () => clearInterval(id)
  }, [hasActiveEEW, home, allowOwnCalculation])

  useEffect(() => {
    if (home === null || !hasActiveEEW) {
      tracksRef.current.clear()
      setArrival(null)
      return
    }

    if (!allowOwnCalculation) {
      // **気象庁の発表値を伝えるだけ。** 区域の値なので区域名を添える。
      // 地震ごとに、その速報が登録地点の区域について出した値を使う（別の地震の値と混ぜない）。
      // 距離も同じ速報の震源から測る —— 秒数と距離が別の地震を指さないように。
      //
      // **登録地点の区域に値を出していない速報も、震源が判っていれば距離だけの行にする**（`noForecast`。
      // 2026-10-14 ユーザー承認「距離だけのカードを出す」）。以前は行ごと捨てていたので、距離は観測事実なのに
      // 「区域が載らない地震」では何も出なかった。震源が決まっていない報・位置不明・取消済みは距離を出せないので行を作らない。
      tracksRef.current.clear()
      if (homeAreaName === null) {
        setArrival(null)
        return
      }
      const now = serverNow()
      const rows: SWaveArrivalRow[] = []
      for (const eew of eews) {
        const area = homeAreaArrivalOf(eew, homeAreaName)
        if (area === null) {
          const distanceKm = epicenterDistanceKm(eew, home)
          if (distanceKm === null) continue
          rows.push({
            key: eewEventKey(eew),
            hypocenterName: hypocenterNameOf(eew),
            provisional: false,
            distanceKm,
            etaSec: null,
            arrived: false,
            noForecast: true,
          })
          continue
        }
        const etaSec = area.arrivalMs === null ? null : Math.max(0, Math.round((area.arrivalMs - now) / 1000))
        rows.push({
          key: eewEventKey(eew),
          hypocenterName: hypocenterNameOf(eew),
          provisional: isProvisionalHypocenter(eew),
          distanceKm: epicenterDistanceKm(eew, home),
          etaSec,
          arrived: area.arrived || etaSec === 0,
          noForecast: false,
        })
      }
      setArrival(rows.length === 0 ? null : { source: 'telegram', areaName: homeAreaName, rows: rows.sort(compareArrivalRows) })
      return
    }

    // ここから下は自前計算（トークンを持つ端末だけ）。予報円 1 つ（＝地震 1 つ）ごとに行を作る。
    // 予報円は `usePsWaveCalc` の時点で、取消済み・位置不明・仮定震源要素・深さ不明・まだ発生していない
    // ものを外してある（`computeEewCircle`）。円の `eventId` は `eewEventKey` と同じ式。
    const tracks = tracksRef.current
    const live = new Set<string>()
    const rows: SWaveArrivalRow[] = []
    for (const circle of psWave) {
      live.add(circle.eventId)
      let track = tracks.get(circle.eventId)
      if (track === undefined) {
        track = { prevSRadius: null, speedHistory: [], lastLoggedKey: null, skipLogged: false }
        tracks.set(circle.eventId, track)
      }
      const eew = eews.find((e) => eewEventKey(e) === circle.eventId)
      // **円を作った速報を引けない・震源が決まっていない報なら行を作らない**（`pickArrivalEews` と同じ方針）。
      // 前者は予報円と速報の一覧の更新がずれた一瞬、後者は `computeEewCircle` が円を作らないはずの形。
      // どちらも行の地名や「震源から N km」を出せないので、別の地震の名前で埋めたり「震源調査中」と出したりしない。
      // 黙って消えないよう、地震ごとに 1 回だけ記録する。
      if (eew === undefined || isProvisionalHypocenter(eew)) {
        if (!track.skipLogged) {
          track.skipLogged = true
          log.debug('[eew] 主要動到達の行を作らない', {
            eventId: circle.eventId,
            reason: eew === undefined ? '予報円を作った速報が一覧に無い' : '震源が決まっていない報',
          })
        }
        track.prevSRadius = circle.sRadius
        continue
      }
      const row = ownCalcRow(circle, home, track, eew)
      track.prevSRadius = circle.sRadius
      if (row !== null) rows.push(row)
    }
    for (const key of [...tracks.keys()]) if (!live.has(key)) tracks.delete(key)
    setArrival(rows.length === 0 ? null : { source: 'own', areaName: null, rows: rows.sort(compareArrivalRows) })
    // `eews` は行の地名と、発表値の経路で区域の値を引くのに要る。
  }, [psWave, eews, home, hasActiveEEW, allowOwnCalculation, homeAreaName, tick])

  return arrival
}

/**
 * 自前計算の 1 行。**解除までに届かない地震は null**（その地震の行だけを出さない。ほかの地震の行は残る）。
 * `track.prevSRadius` はこの呼び出しの後で呼び出し側が進める。
 */
function ownCalcRow(
  circle: PsWaveCircle,
  home: { lat: number; lng: number },
  track: OwnCalcTrack,
  eew: EEWAlert,
): SWaveArrivalRow | null {
  const distanceKm = haversineKm(circle.lat, circle.lng, home.lat, home.lng)
  const sRadiusKm = circle.sRadius
  let arrived = sRadiusKm >= distanceKm

  let etaSec: number | null
  if (circle.depth !== undefined && sRadiusKm > 0) {
    // JMA2001 走時表から理論上のS波到達走時を引き、安全マージンを加算する
    // （震源近傍は直達波がそのまま立ち上がるが、遠方ほど表面波の分離・コーダ波の重畳で
    //  揺れの立ち上がりがなだらかになり、S波理論到達より体感開始が遅れる傾向があるため）
    const marginSec = calcArrivalSafetyMarginSec(distanceKm)
    const tNow = travelTimeSec('S', sRadiusKm, circle.depth)
    const tArrivalWithMargin = travelTimeSec('S', distanceKm, circle.depth) + marginSec
    arrived = tNow >= tArrivalWithMargin
    etaSec = arrived ? 0 : Math.max(0, Math.round(tArrivalWithMargin - tNow))

    // EEW解除前にS波が自宅に到達しない場合は、その地震の行を出さない
    // （安全マージン込みの到達時刻で判定する。マージン無しの理論到達時刻だけで解除前と
    //   判定すると、実際の体感到達は解除後にずれ込むケースをカードで見せてしまうため）
    if (!arrived && circle.magnitude !== undefined) {
      const autoCancelSec = calcEEWAutoCancelSec(circle.magnitude, circle.depth)
      const willArriveBeforeCancel = tArrivalWithMargin < autoCancelSec
      const logKey = `${circle.magnitude}-${circle.depth}`
      if (track.lastLoggedKey !== logKey) {
        track.lastLoggedKey = logKey
        log.debug('[eew] S波到達判定（EEW更新）', {
          eventId: circle.eventId,
          sRadiusKm: Number(sRadiusKm.toFixed(1)),
          distanceToHomeKm: Number(distanceKm.toFixed(1)),
          etaSec,
          marginSec: Number(marginSec.toFixed(1)),
          autoCancelSec: Number(autoCancelSec.toFixed(1)),
          tArrivalWithMargin: Number(tArrivalWithMargin.toFixed(1)),
          willArriveBeforeCancel,
        })
      }
      if (!willArriveBeforeCancel) return null
    }
  } else if (arrived) {
    etaSec = 0
  } else {
    // S波がまだ地表に出ていない場合: フレーム差分で速度を推定
    // ※更新間隔は約100ms〜1秒なので delta ≈ km/s として扱える
    let speed = S_WAVE_FALLBACK_KM_PER_SEC
    if (track.prevSRadius !== null) {
      const delta = sRadiusKm - track.prevSRadius
      if (delta > 0) {
        track.speedHistory.push(delta)
        if (track.speedHistory.length > SPEED_SMOOTH_FRAMES) track.speedHistory.shift()
        const avg = track.speedHistory.reduce((sum, v) => sum + v, 0) / track.speedHistory.length
        if (avg >= MIN_VALID_SPEED) speed = avg
      }
    }
    etaSec = sRadiusKm === 0 ? null : Math.max(0, Math.round((distanceKm - sRadiusKm) / speed))
  }
  // 残りが 0 秒へ丸まった行は到達済みとして扱う（発表値の経路の `arrived: area.arrived || etaSec === 0` と揃える）。
  // 未到達のまま 0 秒を出すと、並びでも見出しでも「まだ来ていない」側に残る。
  if (etaSec === 0) arrived = true

  return {
    key: circle.eventId,
    hypocenterName: hypocenterNameOf(eew),
    provisional: false,
    distanceKm,
    etaSec,
    arrived,
    noForecast: false,
  }
}
