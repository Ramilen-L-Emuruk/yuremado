// 震源カタログの点の吹き出しの時刻。秒は取得元の桁で出す（地震月報 0.01 秒・日別の速報値 0.1 秒）。
import { describe, it, expect } from 'vitest'
import { formatCatalogTime } from './HypocenterCatalogGL'

/** 日本時間の年月日時分秒から UTC epoch ミリ秒へ。 */
const jst = (y: number, mo: number, d: number, h: number, mi: number, sec: number) =>
  Date.UTC(y, mo - 1, d, h, mi, 0) - 9 * 3600 * 1000 + Math.round(sec * 1000)

describe('formatCatalogTime', () => {
  // 正: 地震月報の年は 0.01 秒まで出す
  it('確定値の年は 0.01 秒まで出す', () => {
    expect(formatCatalogTime(jst(2024, 1, 1, 16, 10, 9.54), false)).toBe('2024/01/01 16:10:09.54')
  })

  // 正: 日別の速報値の年は取得元の桁（0.1 秒）で出す
  it('速報値の年は 0.1 秒まで出す', () => {
    expect(formatCatalogTime(jst(2025, 3, 1, 4, 5, 6.7), true)).toBe('2025/03/01 04:05:06.7')
  })

  // 対照: 秒の欄が空白の記録がある年代でも、0 秒でなければ秒を出す
  it('1950 年以前でも 0 秒でなければ秒を出す', () => {
    expect(formatCatalogTime(jst(1923, 9, 1, 11, 58, 32.0), false)).toBe('1923/09/01 11:58:32.00')
  })

  // 安全弁: 空白の秒を 0 秒で埋めた値を「00.00 秒」と名乗らない。その年代のちょうど 0 秒は分までにする
  it('1950 年以前のちょうど 0 秒は分までにする（1951 年以降は 00.00 秒と出す）', () => {
    expect(formatCatalogTime(jst(1930, 5, 2, 3, 4, 0), false)).toBe('1930/05/02 03:04')
    expect(formatCatalogTime(jst(1951, 5, 2, 3, 4, 0), false)).toBe('1951/05/02 03:04:00.00')
  })

  // 安全弁: 浮動小数の端数で 60 秒へ繰り上がって分がずれない
  it('59.999 秒のような端数でも 60 秒や分の繰り上がりにしない', () => {
    expect(formatCatalogTime(jst(2024, 1, 1, 16, 10, 59.999), false)).toBe('2024/01/01 16:10:59.99')
  })
})
