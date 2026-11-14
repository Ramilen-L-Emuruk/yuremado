// 辞書を読めないファイル（`utils/knet`・`dmdataApiKey.ts`）が投げる失敗の文。
//
// これらは辞書の日本語と同じ字面を `message` に書き、鍵と引数を添えて投げる（→ `keyedError.ts`）。
// 片方だけ直すと、ログ・記録の文と画面の文が食い違う。ここで次の 2 つを縛る。
// - 日本語の辞書で組んだ文が `message` と同じ字面であること（入れ子の失敗も含む）
// - 英語の辞書なら、画面の文が英語になること（設定の窓の K-NET の取り込みの失敗の欄）
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { errorTextOf, type ErrorText } from './keyedError'
import { renderErrorText, screenErrorMessage } from './localizedError'
import { buildEventResultFromZip } from './knet/buildEventResultFromZip'
import { parseKnetAsciiFile, resolveComponentFromFileName } from './knet/knetAscii'
import { fftInPlace } from './knet/fft'
import { RealtimeIntensityCalculator, computeRealtimeIntensityTimeSeries } from './knet/realtimeIntensity'
import { DMDATA_API_KEY_INVALID_MESSAGE, DMDATA_API_KEY_MISSING_MESSAGE } from './dmdataApiKey'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'

/** 投げられたものを返す（投げなければテストを落とす） */
function caught(fn: () => unknown): Error {
  try {
    fn()
  } catch (e) {
    if (e instanceof Error) return e
    throw new Error(`Error でない値が投げられた: ${String(e)}`)
  }
  throw new Error('投げなかった')
}

/** 鍵と引数を持つこと、日本語の辞書で組んだ文が `message` と同じ字面であることを確かめ、鍵と引数を返す */
function expectJaMatches(err: Error): ErrorText {
  const t = errorTextOf(err)
  expect(t).toBeDefined()
  expect(renderErrorText(t!, ja.errorText)).toBe(err.message)
  return t!
}

/** K-NET の ASCII 形式の 1 ファイル。`omit` に挙げた欄は書かない */
function stationFileText(opts: { stationCode: string; originTime?: string; data: number[]; omit?: string[] }): string {
  const header: [string, string][] = [
    ['Origin Time', opts.originTime ?? '2018/09/06 03:07:59'],
    ['Lat.', '42.686'],
    ['Long.', '142.001'],
    ['Depth. (km)', '37'],
    ['Mag.', '6.7'],
    ['Station Code', opts.stationCode],
    ['Station Lat.', '42.9241'],
    ['Station Long.', '141.9503'],
    ['Station Height(m)', '145'],
    ['Record Time', '2018/09/06 03:08:04'],
    ['Sampling Freq(Hz)', '100Hz'],
    ['Duration Time(s)', '300'],
    ['Dir.', 'N-S'],
    ['Scale Factor', '1(gal)/1'],
    ['Max. Acc. (gal)', '1029.67'],
    ['Last Correction', '2019/03/07 16:11:24'],
  ]
  // 欄を外しても 17 行目の Memo. の位置は保つ（行数の検査で先に止まらないよう、外した欄は空の行にする）
  const lines = header.map(([k, v]) => (opts.omit?.includes(k) ? 'X' : `${k}\t${v}`))
  lines.push('Memo.\t')
  for (let i = 0; i < opts.data.length; i += 8) lines.push(opts.data.slice(i, i + 8).join(' '))
  return lines.join('\n')
}

/** 3 成分の揃った 1 観測点ぶん（震度を計算できる長さの正弦波） */
function stationEntries(stationCode: string, originTime?: string): Record<string, Uint8Array> {
  const data = Array.from({ length: 2048 }, (_, i) => Math.round(300 * Math.sin((2 * Math.PI * 2 * i) / 100)))
  const entries: Record<string, Uint8Array> = {}
  for (const comp of ['NS', 'EW', 'UD'] as const) {
    entries[`${stationCode}.${comp}`] = strToU8(stationFileText({ stationCode, originTime, data }))
  }
  return entries
}

describe('K-NET の取り込みの失敗', () => {
  it('欄が見つからない: 日本語は前と同じ字面、英語は英語の文（欄の名前はファイルの語のまま）', () => {
    const err = caught(() => parseKnetAsciiFile(stationFileText({ stationCode: 'AAA001', data: [1, 2, 3], omit: ['Station Code'] }), 'AAA001.NS'))
    expect(err.message).toBe('AAA001.NS: Station Code が見つかりません')
    expectJaMatches(err)
    expect(screenErrorMessage(err, en.errorText)).toBe('AAA001.NS: Station Code not found')
  })

  it('全部読めない: ファイルごとの失敗を入れ子にしたまま、言語の辞書で組む', () => {
    const zip = zipSync({ 'AAA001.NS': strToU8(stationFileText({ stationCode: 'AAA001', data: [1, 2], omit: ['Origin Time'] })) })
    const err = caught(() => buildEventResultFromZip(zip, 5))
    expect(err.message).toBe('1件のファイルでパースに失敗し、読めた観測点がありません: AAA001.NS: AAA001.NS: Origin Time が見つかりません')
    expectJaMatches(err)
    expect(screenErrorMessage(err, en.errorText))
      .toBe('Could not read 1 file and no stations could be read: AAA001.NS: AAA001.NS: Origin Time not found')
  })

  it('Origin Time の混在', () => {
    const zip = zipSync({ ...stationEntries('AAA001', '2018/09/06 03:07:59'), ...stationEntries('BBB002', '2018/10/05 08:58:53') })
    const err = caught(() => buildEventResultFromZip(zip, 5))
    expect(err.message).toBe('ZIP内に異なる地震のOrigin Timeが混在しています（2種類）。複数の地震のファイルを1つのZIPにまとめていないか確認してください')
    expectJaMatches(err)
    expect(screenErrorMessage(err, en.errorText))
      .toBe('The ZIP mixes Origin Times of different earthquakes (2). Check that it does not combine files from several earthquakes')
  })

  it('外した観測点が多すぎる: 例の理由（読めないファイルの失敗）まで言語の辞書で組む', () => {
    const entries: Record<string, Uint8Array> = { ...stationEntries('AAA001') }
    for (const code of ['BBB002', 'CCC003']) {
      Object.assign(entries, stationEntries(code))
      entries[`${code}.UD`] = strToU8('壊れたファイル')
    }
    const err = caught(() => buildEventResultFromZip(zipSync(entries), 5))
    expectJaMatches(err)
    const shown = screenErrorMessage(err, en.errorText)
    expect(shown).toMatch(/^origin=20180906030759: 67% of stations were excluded \(0 incomplete, 2 unreadable, 0 intensity not computable\) e\.g\. /)
    expect(shown).toContain('BBB002 unreadable (BBB002.UD: BBB002.UD: shorter than the 17 header lines)')
    // 日本語の文が混じらない（入れ子の失敗まで英語で組めている）
    expect(shown).not.toMatch(/[ぁ-んァ-ヶ一-龠]/)
  })

  it('普段は出ない実装の誤りの文は、英語では Internal error: を頭に付ける', () => {
    const cases: Error[] = [
      caught(() => buildEventResultFromZip(zipSync(stationEntries('AAA001')), 0.5)),
      caught(() => computeRealtimeIntensityTimeSeries([], [], [], 100, 0)),
      caught(() => new RealtimeIntensityCalculator(0)),
      caught(() => fftInPlace(new Float64Array(4), new Float64Array(2), false)),
      caught(() => fftInPlace(new Float64Array(3), new Float64Array(3), false)),
    ]
    for (const err of cases) {
      expectJaMatches(err)
      expect(screenErrorMessage(err, en.errorText)).toMatch(/^Internal error: /)
    }
    expect(screenErrorMessage(cases[0], en.errorText)).toBe('Internal error: stepSec must be a positive integer (seconds)')
    expect(screenErrorMessage(cases[3], en.errorText)).toBe('Internal error: real and imaginary parts differ in length: 4/2')
  })

  it('ファイルの中身の失敗（日本語の字面の突き合わせ）', () => {
    const cases: Error[] = [
      caught(() => resolveComponentFromFileName('AAA001.XX')),
      caught(() => parseKnetAsciiFile('短い', 'AAA001.NS')),
      caught(() => parseKnetAsciiFile(stationFileText({ stationCode: 'AAA001', data: [1, 'x' as unknown as number] }), 'AAA001.NS')),
      caught(() => parseKnetAsciiFile(stationFileText({ stationCode: 'AAA001', data: [] }), 'AAA001.NS')),
      caught(() => new RealtimeIntensityCalculator(100).push(Number.NaN, 0, 0)),
    ]
    for (const err of cases) expectJaMatches(err)
    expect(screenErrorMessage(cases[2], en.errorText)).toBe('AAA001.NS: non-numeric token in data ("x", line 18)')
  })

  // 対照: 鍵を持たない失敗は、どの言語でも `message` をそのまま出す
  it('対照: 鍵を持たない失敗は message のまま', () => {
    expect(screenErrorMessage(new Error('なにか'), en.errorText)).toBe('なにか')
    expect(screenErrorMessage('x', en.errorText)).toBe('x')
  })
})

describe('API キーの文', () => {
  it('ファイルに置いた日本語の文は、辞書の日本語と同じ字面', () => {
    expect(DMDATA_API_KEY_INVALID_MESSAGE).toBe(ja.errorText.apiKeyInvalid())
    expect(DMDATA_API_KEY_MISSING_MESSAGE).toBe(ja.errorText.apiKeyMissing())
  })
})
