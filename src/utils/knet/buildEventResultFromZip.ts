// K-NET/KiK-netのZIP（NIEDからダウンロードした生データ、1地震ぶん）から、観測点ごとの震度時系列を
// 算出する。ネットワーク・ファイルI/Oを含まない純粋な変換部分だけをここに切り出し、Node CLI
// （capture-kyoshin-waveform.ts）とブラウザ内インポート（useKyoshinImport.ts）の両方から呼ぶ。

import { groupIntoStations } from './knetAscii'
import { parseAllStationFiles } from './parseAllStationFiles'
import { computeRealtimeIntensityTimeSeries } from './realtimeIntensity'
import type { EventResult, StationSeries } from './kyoshinEventMerge'
import { log } from '../logger'

/**
 * 3成分が揃わない観測点の割合がこれを超えたら失敗として止める。
 *
 * 外した観測点の**合計**（3 成分が揃わない・読めない・震度を計算できない）の割合にも同じ値を使う
 * （2026-10-24 ユーザー選択「ZIP ごと断る (Recommended)」・「合わせて数える (Recommended)」）。
 * 別々に判定すると、両方が 4 割ずつのとき合わせて 8 割が欠けた記録が通る。
 */
const INCOMPLETE_STATION_RATIO_LIMIT = 0.5

/** `buildEventResultFromZip` の結果。 */
export interface ZipEventBuild {
  /** 保存する地震 1 件ぶん（読めた観測点だけ）。 */
  event: EventResult
  /**
   * 読めないファイルを持つ、または震度を計算できなかったために外した観測点の数（`excluded` の件数）。
   * **保存する記録（`event`）には入れない** —— 取り込んだその場で利用者へ知らせるためだけの値。
   * 3 成分が揃わない観測点は含めない（以前から黙って外していたもので、知らせる対象にしていない）。
   */
  excludedStations: number
  /** 外した観測点ごとの名前（観測点コード、読めないときはファイル名の拡張子を除いた部分）と理由。 */
  excluded: { station: string; reason: string }[]
}

/** 地中（KiK-net の `.NS1` 等）のファイルか。取り込みに使わないので、読めなくても数えない。 */
function isBoreholeFileName(fileName: string): boolean {
  return /\.(NS|EW|UD)1$/i.test(fileName)
}

/**
 * 1 観測点ぶんのファイルに共通する名前（拡張子を除いた部分）。読めなかったファイルは中身の
 * `Station Code` を取れないので、同じ観測点のほかの成分をこの名前で見つける。
 */
function stationFileStem(fileName: string): string {
  return fileName.replace(/\.(NS|EW|UD)[12]?$/i, '')
}

/** UTCのDateを、K-NETヘッダーの原時刻表記と同じ "YYYYMMDDHHMMSS"（JST）へ変換する。 */
function toJstTimestamp(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}`
    + `${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
  )
}

/** "YYYYMMDDHHMMSS"（JST）をUTCのDateへ変換する。`toJstTimestamp`の逆変換。 */
export function parseJstTimestamp(ts: string): Date {
  const y = Number(ts.slice(0, 4))
  const mo = Number(ts.slice(4, 6))
  const d = Number(ts.slice(6, 8))
  const h = Number(ts.slice(8, 10))
  const mi = Number(ts.slice(10, 12))
  const s = Number(ts.slice(12, 14))
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3600_000)
}

/**
 * K-NET/KiK-netのZIP（1地震ぶん）を解析し、観測点ごとの震度時系列を算出する。
 *
 * **震度は強震モニタと同じリアルタイム震度**（`realtimeIntensity.ts`）。自作地震計のホストと
 * 同じ方式なので、同じ画面に並べても物差しが揃う。
 *
 * 地震の識別（`EventResult.originTimeJst`）は、呼び出し側から渡された値ではなく、ZIP内の
 * ファイル自身が持つヘッダーの `Origin Time` から求める。ブラウザ内インポートでは呼び出し側が
 * 対応する地震を事前に知らない（ファイルの中身から判定する）ため、これが唯一の情報源になる。
 *
 * **読めないファイルがあっても ZIP 全体は断らない。** その観測点だけを外し、外した数を返す
 * （2026-10-22 ユーザー選択「その観測点だけ外す (Recommended)」）。震度を計算できなかった観測点も
 * 同じく外す（2026-10-24 ユーザー選択「外して数える (Recommended)」）。外した観測点が半数を超えたら、
 * 3 成分が揃わないときと同じく止める。別の地震のファイルが混ざっているときは今どおり断る。
 */
export function buildEventResultFromZip(zip: Uint8Array, stepSec: number): ZipEventBuild {
  // stepSecが非整数だと、下のepochSec算出（Math.round(p.tSec)）で異なるtSecが同じ整数秒に
  // 丸められて衝突し、mergeEvents側のMap.set()で後着が先着を無警告で上書き・消失させる
  // （実データが欠落した状態で「成功」してしまう）。CLI（parseCliArgs）は既に検証しているが、
  // ブラウザ内インポートはCLI引数解析を経由しないため、共有関数自身でも検証する。
  if (!Number.isInteger(stepSec) || stepSec <= 0) throw new Error('stepSec は正の整数（秒）で指定してください')

  const parsed = parseAllStationFiles(zip)
  // 読めなかった地表のファイルを持つ観測点は、読めたほかの成分ごと外す。残すと 3 成分が揃わない
  // 観測点に数えられ、「成分の判定の誤り」を疑う安全弁（下の incompleteRatio）を読めないファイルで
  // 鳴らしてしまう。地中のファイルは初めから使わないので、読めなくても外さない。
  const unreadable = new Map<string, string>()
  for (const f of parsed.failures) {
    if (isBoreholeFileName(f.fileName)) continue
    const stem = stationFileStem(f.fileName)
    if (!unreadable.has(stem)) unreadable.set(stem, `${f.fileName}: ${f.message}`)
  }
  const unreadableStems = new Set(unreadable.keys())
  const files = parsed.files.filter((f) => !unreadableStems.has(stationFileStem(f.fileName))).map((f) => f.file)
  if (files.length === 0) {
    if (parsed.failures.length > 0) {
      throw new Error(
        `${parsed.failures.length}件のファイルでパースに失敗し、読めた観測点がありません: `
        + parsed.failures.slice(0, 20).map((f) => `${f.fileName}: ${f.message}`).join(' / ')
        + (parsed.failures.length > 20 ? ' ...' : ''),
      )
    }
    throw new Error('ZIP内にNS/EW/UD波形ファイルが1件も見つかりませんでした')
  }

  // 全ファイルが同一の地震を指している前提。異なるOrigin Timeが混在していれば、複数の地震の
  // ファイルを誤って1つのZIPにまとめてしまったユーザー操作ミスの可能性が高く、無警告で
  // どちらか一方のOrigin Timeを採用して混合データを作ってしまうより、ここで止める方が安全。
  const originTimes = new Set(files.map((f) => f.originTime.getTime()))
  if (originTimes.size > 1) {
    throw new Error(
      `ZIP内に異なる地震のOrigin Timeが混在しています（${originTimes.size}種類）。`
      + '複数の地震のファイルを1つのZIPにまとめていないか確認してください',
    )
  }
  const originTimeJst = toJstTimestamp(files[0].originTime)

  const { stations, skippedIncomplete } = groupIntoStations(files)
  if (stations.length === 0) throw new Error(`origin=${originTimeJst}: 3成分が揃った観測点が0件です`)
  // 除外が大半を占める場合、component/depthKindの判定ロジック（resolveComponentFromFileName）に
  // 系統的な誤りがある可能性が高い。無警告で続けると、実質ほぼ空のデータが「成功」として
  // 扱われるのに気付けない。
  const incompleteRatio = skippedIncomplete / (skippedIncomplete + stations.length)
  if (incompleteRatio > INCOMPLETE_STATION_RATIO_LIMIT) {
    throw new Error(
      `origin=${originTimeJst}: 3成分が揃わない観測点が${Math.round(incompleteRatio * 100)}%に達しました`
      + '（成分・深度の判定ロジックに誤りがある可能性があります）',
    )
  }

  const stationSeries: StationSeries[] = []
  const uncomputable: { station: string; reason: string }[] = []
  for (const station of stations) {
    const startEpochSec = Math.round(station.recordStartTime.getTime() / 1000)
    let series: ReturnType<typeof computeRealtimeIntensityTimeSeries>
    try {
      series = computeRealtimeIntensityTimeSeries(
        station.components.NS,
        station.components.EW,
        station.components.UD,
        station.samplingHz,
        stepSec,
      )
    } catch (error) {
      // 近似フィルタはサンプリング周波数が低いと発散するので作る時点で止まる
      // （`RealtimeIntensityCalculator`）。その観測点だけを外し、理由を控える。
      uncomputable.push({
        station: station.stationCode,
        reason: `毎秒 ${station.samplingHz} 回: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    const points = series.map((p) => ({
      epochSec: startEpochSec + Math.round(p.tSec),
      intensity: p.intensity,
    }))
    stationSeries.push({ stationCode: station.stationCode, latitude: station.latitude, longitude: station.longitude, points })
  }

  const excluded = [
    ...[...unreadable].map(([station, reason]) => ({ station, reason: `読めない（${reason}）` })),
    ...uncomputable.map((u) => ({ station: u.station, reason: `震度を計算できない（${u.reason}）` })),
  ]
  // 外した観測点を合わせて数える（3 成分が揃わない・読めない・震度を計算できない）
  const removed = skippedIncomplete + excluded.length
  const removedRatio = removed / (removed + stationSeries.length)
  if (removedRatio > INCOMPLETE_STATION_RATIO_LIMIT) {
    throw new Error(
      `origin=${originTimeJst}: 外した観測点が${Math.round(removedRatio * 100)}%に達しました`
      + `（3成分が揃わない ${skippedIncomplete}点・読めない ${unreadable.size}点・震度を計算できない ${uncomputable.length}点）。`
      + `例: ${excluded.slice(0, 5).map((x) => `${x.station} ${x.reason}`).join(' / ')}`,
    )
  }
  if (excluded.length > 0) {
    // 画面には件数だけを出すので、どの観測点をなぜ外したかは記録に残す
    log.warn(
      `[knet] origin=${originTimeJst}: 観測点 ${excluded.length} 点を外して取り込む（先頭 10 件）: `
      + excluded.slice(0, 10).map((x) => `${x.station} ${x.reason}`).join(' / '),
    )
  }

  let peakIntensity = -Infinity
  for (const s of stationSeries) {
    for (const p of s.points) {
      if (p.intensity !== null && p.intensity > peakIntensity) peakIntensity = p.intensity
    }
  }
  // 全ウィンドウがデータ不足でnullだった場合、-1（欠測）だけのフレームが無警告で書き出されて
  // しまうため、他のイベントを巻き込む前にここで止める。
  if (!Number.isFinite(peakIntensity)) {
    throw new Error(
      `origin=${originTimeJst}: 有効な計測震度を1件も算出できませんでした（全ウィンドウがデータ不足でnullでした）。`
      + 'サンプリング周波数・スケールファクタ等、算出パイプラインの誤りを疑ってください',
    )
  }

  return { event: { originTimeJst, stationSeries, peakIntensity }, excludedStations: excluded.length, excluded }
}
