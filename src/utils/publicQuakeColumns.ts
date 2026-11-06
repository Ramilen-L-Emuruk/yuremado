import type { Mseed2Record } from './miniseed2'
import { splitMseed2Stream } from './miniseed2Stream'
import type { PublicWaveRange as PublicQuakeRange } from './publicQuakeRange'
import { PublicWaveBuffer, type PublicPushResult } from './publicWaveBuffer'
import type { PublicChannelCode, PublicStationEpoch } from './publicStations'
import type { SeismoWaveWindow } from './seismoWaveBuffer'
import { appendWaveWindow, type TimedColumns } from './seismoWaveColumns'

/**
 * 公開観測点の波形を、地震カードに描く列と詳細の窓に描く生のサンプルへ組み立てる（`docs/public-waveform-design.md` §6）。
 * 材料は保存庫が返した miniSEED の生バイト（端末に控えたもの）。
 */

/** カードの列の本数。**自作地震計のカードと同じ**（`hooks/useSeismoQuakeWaves.ts` の `WAVE_HISTORY_COLUMNS`）。 */
export const PUBLIC_QUAKE_COLUMNS = 1200

/**
 * レコード 1 本を入れ物へ置く。**観測点・成分を表のエポックで引き当て、その感度で速度へ直す。**
 * 下部の波形（SeedLink）と地震カード（保存庫）で同じ置き方にするため、ここ 1 か所に置く。
 * 置かなかった理由は戻り値で返す（表に無い観測点・成分は `unknown`）。
 */
export function pushPublicRecord(
  buffer: PublicWaveBuffer,
  epoch: PublicStationEpoch | undefined,
  rec: Mseed2Record,
): PublicPushResult | { readonly kind: 'unknown' } {
  if (epoch === undefined || epoch.code !== rec.station) return { kind: 'unknown' }
  const channel = epoch.channels.find((c) => c.code === rec.channel)
  if (channel === undefined) return { kind: 'unknown' }
  return buffer.push(channel.code as PublicChannelCode, rec.startMs, rec.sampleRate, rec.samples, channel.sensitivity)
}

export interface DecodedPublicQuakeWave {
  /** 範囲の生のサンプル（μm/s・各成分から窓の平均を引いたもの）。1 つも置けなければ `null`。 */
  readonly window: SeismoWaveWindow | null
  /** 読めなかったレコードの数。 */
  readonly unreadable: number
  /** 読めたが置かなかったレコードの数（別の観測点・表に無い成分・採取率の食い違い）。全部が範囲の外のレコードは数えない。 */
  readonly rejected: number
}

/**
 * レコードのうち、範囲 `[fromMs, toMs]` に入るサンプルだけを残したもの。1 つも入らなければ `null`。
 * 時刻はサンプルの番号を数え直さずに済むよう、残した最初のサンプルの時刻へずらす。
 */
export function clipRecordToRange(rec: Mseed2Record, range: PublicQuakeRange): Mseed2Record | null {
  if (!Number.isFinite(range.fromMs) || !Number.isFinite(range.toMs)) return null
  if (!(rec.sampleRate > 0) || !Number.isFinite(rec.startMs)) return rec // 置く側が invalid として数える
  const ms = 1000 / rec.sampleRate
  const first = Math.max(0, Math.ceil((range.fromMs - rec.startMs) / ms - 1e-6))
  const last = Math.min(rec.samples.length - 1, Math.floor((range.toMs - rec.startMs) / ms + 1e-6))
  if (last < first) return null
  if (first === 0 && last === rec.samples.length - 1) return rec
  return { ...rec, startMs: rec.startMs + first * ms, samples: rec.samples.subarray(first, last + 1) }
}

/** 生バイトを読み、範囲のぶんを入れ物へ置いて取り出す。 */
export function decodePublicQuakeWave(params: {
  readonly bytes: Uint8Array
  readonly epoch: PublicStationEpoch
  readonly range: PublicQuakeRange
}): DecodedPublicQuakeWave {
  const { bytes, epoch, range } = params
  const stream = splitMseed2Stream(bytes)
  // **範囲の外のサンプルは置かない。** 控えには、観測点をまとめて取った問い合わせの広さ（いちばん遠い観測点の範囲の終わり）まで
  // 入っている。そのまま置くと入れ物の最新が範囲の外へ進み、抱えられる長さからはみ出した範囲の頭が古い端から落ちる。
  // 範囲の中だけを置くので、抱える長さは範囲ぶん（端の丸めに 1 秒の余裕）で足りる
  const buffer = new PublicWaveBuffer(Math.ceil((range.toMs - range.fromMs) / 1000) + 1)
  let rejected = 0
  for (const rec of stream.records) {
    const clipped = clipRecordToRange(rec, range)
    if (clipped === null) continue
    if (pushPublicRecord(buffer, epoch, clipped).kind !== 'ok') rejected += 1
  }
  return { window: buffer.snapshot(range.fromMs), unreadable: stream.unreadable.length, rejected }
}

/**
 * その時刻以降に値のあるサンプルが 1 つでもあるか。**地震の発生より後が 1 つも無い間は、カードに載せない**
 * （保存庫に後ろがまだ入っていない＝取得の途中。取得中は何も出さない。`docs/public-waveform-design.md` §0）。
 */
export function hasSamplesFrom(window: SeismoWaveWindow | null, fromMs: number): boolean {
  if (window === null || !(window.msPerSample > 0)) return false
  const start = Math.max(0, Math.ceil((fromMs - window.firstSampleMs) / window.msPerSample))
  for (const axis of window.gal) {
    for (let i = start; i < axis.length; i += 1) if (Number.isFinite(axis[i])) return true
  }
  return false
}

/** 生のサンプルを、範囲を {@link PUBLIC_QUAKE_COLUMNS} 本に割った列へ落とす。範囲の終わりより後ろは入れない。 */
export function publicQuakeColumns(window: SeismoWaveWindow | null, range: PublicQuakeRange): TimedColumns {
  const base: TimedColumns = {
    fromMs: range.fromMs,
    columnSpanMs: (range.toMs - range.fromMs) / PUBLIC_QUAKE_COLUMNS,
    columns: [],
  }
  return appendWaveWindow({ base, window, limitMs: range.toMs })
}
