import { useEffect, useRef, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import { travelTimeSec } from '../utils/travelTime'
import { calcArrivalSafetyMarginSec, calcEEWAutoCancelSec, eewEventKey, isProvisionalHypocenter, S_WAVE_FALLBACK_KM_PER_SEC } from '../utils/eew'
import { hasKnownEpicenter, haversineKm } from '../utils/geo'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'
import { homeAreaArrivalOf, useHomeAreaName } from './useHomeAreaArrival'
import { computeEewCircle } from './usePsWaveCalc'

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
  /**
   * 行の出どころ。`'telegram'` = どの行も気象庁の区域ごとの発表値／`'own'` = どの行も自前の走時計算（地点）／
   * `'mixed'` = 両方の行がある（自前計算の端末で、自前計算できない地震の行だけ発表値へ戻したとき。→ 各行の `source`）
   */
  source: 'telegram' | 'own' | 'mixed'
  /** 気象庁が値を出した区域の名前。発表値の行が無ければ null。発表値の行はどれも同じ区域の値なので 1 つだけ持つ。 */
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
  /** この行の出どころ（`'telegram'` = 気象庁の区域ごとの発表値／`'own'` = 自前の走時計算）。画面は混ざった枠でこれを行ごとに出す */
  source: 'telegram' | 'own'
  /**
   * 震央地名。**短縮用震央地名（`ReduceName`）があればそちらで、無ければ通常の震央地名**
   * （→ {@link hypocenterNameOf}）。カードの見出しとは別の名前になりうる。無ければ null。
   */
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

/**
 * 到達予測の行に出す震央地名。**短縮用震央地名（`Hypocenter/Area/ReduceName`）があればそちらを使う**
 * （2026-10-22 ユーザー承認「2-A 到達予測の行」）。
 *
 * あの行は 1 行で末尾を省略するうえ、同じ行に「震源から 42 km」が並ぶので、アプリの中でいちばん
 * 幅が足りない。気象庁が電文に載せている短い呼び方を使えば、こちらで切り詰めずに済む
 * （例: 「福島県沖」→「福島沖」）。
 *
 * **使うのはここだけ。** カードの見出し・地図の吹き出し・ウィンドウタイトルは通常の震央地名を出す ——
 * 短縮名は情報を落とすことがあり（「熊本県天草・芦北地方」→「熊本県」）、幅に余裕のある場所で
 * 使うと、どこの地震か分かりにくくなる。
 *
 * **地震情報の電文は持たない。** 全期間の控えの 19,345 通で `ReduceName` は 1 件も無く、
 * 載せているのは緊急地震速報だけ（→ `docs/spec/eew-spec.md`）。
 */
function hypocenterNameOf(eew: EEWAlert | undefined): string | null {
  const name = eew?.reduceName || eew?.earthquake.hypocenter.name
  return name ? name : null
}

/**
 * 気象庁の発表値の 1 行（公開版の経路と、自前計算できない地震を戻す経路が共有する）。
 *
 * **登録地点の区域に値を出していない速報も、震源が判っていれば距離だけの行にする**（`noForecast`。
 * 2026-10-14 ユーザー承認「距離だけのカードを出す」）。震源が決まっていない報・位置不明・取消済みは距離を出せないので
 * 行を作らず null を返す。距離は同じ速報の震源から測る —— 秒数と距離が別の地震を指さないように。
 */
function telegramRow(eew: EEWAlert, home: { lat: number; lng: number }, homeAreaName: string, now: number): SWaveArrivalRow | null {
  // 取り消された速報は出さない（呼び出し元の一覧は取消済みを外してあるが、距離の判定と同じ流儀でここでも弾く）
  if (eew.cancelled || eew.cancelledAt) return null
  const area = homeAreaArrivalOf(eew, homeAreaName)
  if (area === null) {
    const distanceKm = epicenterDistanceKm(eew, home)
    if (distanceKm === null) return null
    return {
      key: eewEventKey(eew), source: 'telegram', hypocenterName: hypocenterNameOf(eew),
      provisional: false, distanceKm, etaSec: null, arrived: false, noForecast: true,
    }
  }
  const etaSec = area.arrivalMs === null ? null : Math.max(0, Math.round((area.arrivalMs - now) / 1000))
  return {
    key: eewEventKey(eew), source: 'telegram', hypocenterName: hypocenterNameOf(eew),
    provisional: isProvisionalHypocenter(eew), distanceKm: epicenterDistanceKm(eew, home),
    etaSec, arrived: area.arrived || etaSec === 0, noForecast: false,
  }
}

/** 行の並びから枠の出どころを決める（→ `SWaveArrival.source`）。 */
function arrivalOf(rows: SWaveArrivalRow[], homeAreaName: string | null): SWaveArrival | null {
  if (rows.length === 0) return null
  const hasOwn = rows.some((r) => r.source === 'own')
  const hasTelegram = rows.some((r) => r.source === 'telegram')
  const source = hasOwn && hasTelegram ? 'mixed' : hasOwn ? 'own' : 'telegram'
  return { source, areaName: hasTelegram ? homeAreaName : null, rows: rows.sort(compareArrivalRows) }
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
  // **自前計算の端末でも回す** —— 自前計算できない地震の行は発表値へ戻すので（→ 下の自前計算の経路）、その行の秒数もこれで進める
  useEffect(() => {
    if (!hasActiveEEW || home === null) return
    const id = setInterval(() => setTick((t) => t + 1), TELEGRAM_TICK_MS)
    return () => clearInterval(id)
  }, [hasActiveEEW, home])

  useEffect(() => {
    if (home === null || !hasActiveEEW) {
      tracksRef.current.clear()
      setArrival(null)
      return
    }

    if (!allowOwnCalculation) {
      // **気象庁の発表値を伝えるだけ。** 区域の値なので区域名を添える。
      // 地震ごとに、その速報が登録地点の区域について出した値を使う（別の地震の値と混ぜない。→ `telegramRow`）。
      tracksRef.current.clear()
      if (homeAreaName === null) {
        setArrival(null)
        return
      }
      const now = serverNow()
      const rows: SWaveArrivalRow[] = []
      for (const eew of eews) {
        const row = telegramRow(eew, home, homeAreaName, now)
        if (row !== null) rows.push(row)
      }
      setArrival(arrivalOf(rows, homeAreaName))
      return
    }

    // ここから下は自前計算（トークンを持つ端末だけ）。予報円 1 つ（＝地震 1 つ）ごとに行を作る。
    // 予報円は `usePsWaveCalc` の時点で、取消済み・位置不明・仮定震源要素・深さ不明・まだ発生していない
    // ものを外してある（`computeEewCircle`）。円の `eventId` は `eewEventKey` と同じ式。
    const tracks = tracksRef.current
    const live = new Set<string>()
    const rows: SWaveArrivalRow[] = []
    // 自前計算で行を作れた地震。**作れなかった地震（予報円の無い報・解除までに届かない地震）は、下で気象庁の発表値の行へ戻す**
    // —— キーの無い端末なら同じ報で発表値が出るので、キーを入れたほうが伝わる情報が減っていた
    // （2026-10-21 ユーザー承認「直す (Recommended)」）
    const ownKeys = new Set<string>()
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
      if (row !== null) { rows.push(row); ownKeys.add(row.key) }
    }
    for (const key of [...tracks.keys()]) if (!live.has(key)) tracks.delete(key)
    if (homeAreaName !== null) {
      const now = serverNow()
      for (const eew of eews) {
        const key = eewEventKey(eew)
        if (ownKeys.has(key)) continue
        // **円が作れる速報で、円がまだ届いていないだけなら待つ。** 予報円は別の更新（`usePsWaveCalc`）で作られるので、
        // 新しい速報の最初の一瞬は円が無い。ここで発表値の行を出すと、次の更新で自前計算の行へ替わって秒数が跳ぶ
        if (!live.has(key) && computeEewCircle(eew, now) !== null) continue
        const row = telegramRow(eew, home, homeAreaName, now)
        if (row !== null) rows.push(row)
      }
    }
    setArrival(arrivalOf(rows, homeAreaName))
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

  // **S 波がまだ地表に出ていない間も、解除までに届かない地震は先に見分ける**（下の判定と同じ式）。待つと「推定中」の
  // 自前計算の行を数秒出してから発表値の行へ替わり、範囲と注記が途中で入れ替わる（深い地震ほど長い）
  if (sRadiusKm <= 0 && circle.depth !== undefined && circle.magnitude !== undefined) {
    const tArrivalWithMargin = travelTimeSec('S', distanceKm, circle.depth) + calcArrivalSafetyMarginSec(distanceKm)
    if (tArrivalWithMargin >= calcEEWAutoCancelSec(circle.magnitude, circle.depth)) return null
  }

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
    source: 'own',
    hypocenterName: hypocenterNameOf(eew),
    provisional: false,
    distanceKm,
    etaSec,
    arrived,
    noForecast: false,
  }
}
