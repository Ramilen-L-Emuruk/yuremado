import { describe, expect, it } from 'vitest'
import { steim2Record } from '../test-utils/mseed2Fixture'
import { decodePublicQuakeWave, hasSamplesFrom, PUBLIC_QUAKE_COLUMNS, publicQuakeColumns } from './publicQuakeColumns'
import type { PublicStationEpoch } from './publicStations'

const SENS = 1e9 // カウント/(m/s)。1 カウント = 0.001 μm/s

const epoch: PublicStationEpoch = {
  code: 'JMM',
  nameJa: '宮城丸森',
  siteName: 'Marumori',
  lat: 37.9,
  lon: 140.8,
  elevation: 0,
  start: '2000-01-01T00:00:00',
  end: null,
  channels: (['BHE', 'BHN', 'BHZ'] as const).map((code) => ({ code, sampleRate: 20, sensitivity: SENS, sensitivityFreq: 1, azimuth: 0, dip: 0 })),
}

/** 2026-10-13 11:44:29.1234 UTC（通日 286） から 20 Hz で始まるレコード（mseed2Fixture の既定の時刻）。 */
const START = Date.UTC(2026, 9, 13, 11, 44, 29) + 123.4

function constant(value: number, n: number): Int32Array {
  return new Int32Array(n).fill(value)
}

/** {@link START} から `offsetSec` 秒ずらした時刻に始まる、`n` サンプルのレコード（値は一定）。 */
function recordAt(offsetSec: number, n: number, channel: 'BHE' | 'BHN' | 'BHZ'): Uint8Array {
  const sec = 11 * 3600 + 44 * 60 + 29 + offsetSec
  const rec = steim2Record(constant(7, n), {
    station: 'JMM',
    channel,
    factor: 20,
    multiplier: 1,
    hms: [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60],
  })
  expect(rec.count).toBe(n) // 1 本に収まりきること（収まらないと時刻の前提が崩れる）
  return rec.bytes
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('decodePublicQuakeWave', () => {
  it('3 成分を感度で μm/s に直し、窓の平均を引いて返す', () => {
    const recs = (['BHE', 'BHN', 'BHZ'] as const).map((channel, i) =>
      steim2Record(constant(1000 * (i + 1), 200), { station: 'JMM', channel, factor: 20, multiplier: 1 }).bytes,
    )
    const bytes = new Uint8Array(recs.reduce((n, r) => n + r.length, 0))
    let at = 0
    for (const r of recs) {
      bytes.set(r, at)
      at += r.length
    }
    const range = { fromMs: START - 1000, toMs: START + 60_000 }
    const got = decodePublicQuakeWave({ bytes, epoch, range })
    expect(got.unreadable).toBe(0)
    expect(got.rejected).toBe(0)
    expect(got.window).not.toBeNull()
    // 一定値なので平均を引けば 0
    for (let a = 0; a < 3; a += 1) expect(Math.abs(got.window!.gal[a][0])).toBeLessThan(1e-6)
  })

  // 正: 控えに範囲より後ろの分まで入っていても（観測点をまとめて取った問い合わせの広さ）、範囲の頭から返す。
  // 範囲の外まで置くと入れ物の最新が先へ進み、範囲の頭が古い端から落ちていた（2026-10-25 小笠原で +30〜+68 秒から描かれた）。
  it('範囲より後ろまでレコードがあっても、範囲の頭から返す', () => {
    const range = { fromMs: START, toMs: START + 60_000 }
    // 範囲の終わりから 140 秒後ろまで、10 秒ずつのレコード 20 本
    const bytes = concat(Array.from({ length: 20 }, (_, i) => recordAt(i * 10, 200, 'BHZ')))
    const got = decodePublicQuakeWave({ bytes, epoch, range })
    expect(got.rejected).toBe(0)
    const w = got.window!
    // 入れ物は時刻を刻みの格子へ丸めるので、頭は 1 サンプル以内
    expect(w.firstSampleMs).toBeGreaterThanOrEqual(START - 50)
    expect(w.firstSampleMs).toBeLessThanOrEqual(START + 50)
    expect(Number.isFinite(w.gal[2][0])).toBe(true)
    // 範囲の終わりより後ろは入れない
    expect(w.firstSampleMs + (w.gal[2].length - 1) * w.msPerSample).toBeLessThanOrEqual(range.toMs)
  })

  // 正: 範囲をまたぐレコードはサンプルの単位で切る（範囲の前・後ろのぶんを置かない）。
  it('範囲をまたぐレコードは範囲の端で切る', () => {
    const range = { fromMs: START, toMs: START + 15_000 }
    const bytes = recordAt(-10, 600, 'BHZ') // 範囲の 10 秒前から 30 秒ぶん
    const w = decodePublicQuakeWave({ bytes, epoch, range }).window!
    expect(w.firstSampleMs).toBeGreaterThanOrEqual(START - 50)
    expect(w.firstSampleMs).toBeLessThanOrEqual(START + 50)
    // 15 秒 × 20 Hz（格子への丸めで端の 1 本が出入りする）
    expect(w.gal[2].length).toBeGreaterThanOrEqual(300)
    expect(w.gal[2].length).toBeLessThanOrEqual(301)
    expect(w.gal[2].every((v) => Number.isFinite(v))).toBe(true)
  })

  // 対照: 範囲にまったく入らないレコードだけなら、何も置かず、置かなかった数にも数えない。
  it('範囲の外のレコードだけなら窓は空で、置かなかった数に数えない', () => {
    const range = { fromMs: START, toMs: START + 15_000 }
    const got = decodePublicQuakeWave({ bytes: concat([recordAt(30, 200, 'BHZ'), recordAt(-30, 200, 'BHZ')]), epoch, range })
    expect(got.window).toBeNull()
    expect(got.rejected).toBe(0)
  })

  // 安全弁: 別の観測点・表に無い成分のレコードは置かず、数える（黙って混ぜない）。
  it('別の観測点・表に無い成分は置かずに数える', () => {
    const other = steim2Record(constant(5, 50), { station: 'YOJ', channel: 'BHZ', factor: 20, multiplier: 1 }).bytes
    const odd = steim2Record(constant(5, 50), { station: 'JMM', channel: 'HHZ', factor: 20, multiplier: 1 }).bytes
    const bytes = new Uint8Array(other.length + odd.length)
    bytes.set(other, 0)
    bytes.set(odd, other.length)
    const got = decodePublicQuakeWave({ bytes, epoch, range: { fromMs: START - 1000, toMs: START + 60_000 } })
    expect(got.rejected).toBe(2)
    expect(got.window).toBeNull()
  })
})

describe('publicQuakeColumns', () => {
  it('範囲を一定の本数に割り、範囲の外は入れない', () => {
    const range = { fromMs: 0, toMs: 120_000 }
    const window = {
      firstSampleMs: 0,
      msPerSample: 1000,
      gal: [new Float32Array(200).fill(1), new Float32Array(200).fill(2), new Float32Array(200).fill(3)] as [Float32Array, Float32Array, Float32Array],
      memberCount: new Float32Array(200).fill(Infinity),
    }
    const cols = publicQuakeColumns(window, range)
    expect(cols.columnSpanMs).toBe(120_000 / PUBLIC_QUAKE_COLUMNS)
    expect(cols.columns.length).toBeLessThanOrEqual(PUBLIC_QUAKE_COLUMNS + 1)
  })

  it('サンプルが無ければ列も無い', () => {
    expect(publicQuakeColumns(null, { fromMs: 0, toMs: 1000 }).columns).toEqual([])
  })
})

describe('hasSamplesFrom', () => {
  const window = {
    firstSampleMs: 0,
    msPerSample: 1000,
    gal: [Float32Array.from([1, 1, NaN]), Float32Array.from([1, 1, NaN]), Float32Array.from([1, 1, NaN])] as [Float32Array, Float32Array, Float32Array],
    memberCount: new Float32Array(3).fill(Infinity),
  }
  // 正: その時刻以降に値があれば真。
  it('その時刻以降に値があれば真', () => expect(hasSamplesFrom(window, 1000)).toBe(true))
  // 対照: その時刻以降が欠け（NaN）か範囲の外なら偽（発生より後がまだ届いていない）。
  it('以降が欠けか範囲の外なら偽', () => {
    expect(hasSamplesFrom(window, 2000)).toBe(false)
    expect(hasSamplesFrom(window, 10_000)).toBe(false)
    expect(hasSamplesFrom(null, 0)).toBe(false)
  })
})
