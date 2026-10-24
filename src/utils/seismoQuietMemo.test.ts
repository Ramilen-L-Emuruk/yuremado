// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 合わせた時計（`serverNow()`）。端末の時計（`Date.now()`）と別に動かす。 */
let serverNowMs = 0
vi.mock('./clock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./clock')>()),
  serverNow: () => serverNowMs,
}))
import {
  flushSeismoQuietMemoForTest,
  rememberedQuietLevel,
  rememberQuietLevel,
  resetSeismoQuietMemoForTest,
  SEISMO_QUIET_STORAGE_KEY,
} from './seismoQuietMemo'

beforeEach(() => {
  serverNowMs = Date.now()
  localStorage.clear()
  resetSeismoQuietMemoForTest()
})

describe('seismoQuietMemo', () => {
  it('正: 測れた値を控え、読み直しても残る', () => {
    rememberQuietLevel('home', 1000, 0.2)
    flushSeismoQuietMemoForTest()
    resetSeismoQuietMemoForTest()
    expect(rememberedQuietLevel('home')).toBe(0.2)
    expect(JSON.parse(localStorage.getItem(SEISMO_QUIET_STORAGE_KEY) ?? '{}')).toEqual({ home: { gal: 0.2, atMs: 1000 } })
  })

  it('対照: 古いデータ時刻の測り値では書き換えない（古い地震のカードを開いても戻らない）', () => {
    rememberQuietLevel('home', 2000, 0.2)
    rememberQuietLevel('home', 1000, 1.3)
    expect(rememberedQuietLevel('home')).toBe(0.2)
    rememberQuietLevel('home', 3000, 0.3)
    expect(rememberedQuietLevel('home')).toBe(0.3)
  })

  // 先の時刻は合わせた時計と比べる。端末の時計が遅れていても、いまのデータ時刻を「先」と取り違えない。
  it('正: 端末の時計が遅れていても、合わせた時計で見て先でなければ控える', () => {
    serverNowMs = Date.now() + 60 * 60_000
    rememberQuietLevel('home', Date.now() + 30 * 60_000, 0.2)
    expect(rememberedQuietLevel('home')).toBe(0.2)
  })

  it('対照: 合わせた時計より 10 分を超えて先のデータ時刻は控えない', () => {
    rememberQuietLevel('home', serverNowMs + 10 * 60_000 + 1, 0.2)
    expect(rememberedQuietLevel('home')).toBeNull()
    rememberQuietLevel('home', serverNowMs + 10 * 60_000, 0.3)
    expect(rememberedQuietLevel('home')).toBe(0.3)
  })

  it('安全弁: 物差しの下限未満・非有限・測れなかった値は控えない', () => {
    for (const v of [0, 0.01, Number.NaN, Number.POSITIVE_INFINITY, null]) rememberQuietLevel('home', 1000, v)
    expect(rememberedQuietLevel('home')).toBeNull()
  })

  it('安全弁: 壊れた控えは捨てて null を返す', () => {
    localStorage.setItem(SEISMO_QUIET_STORAGE_KEY, '{"home":{"gal":"x","atMs":1}, "b": 3}')
    expect(rememberedQuietLevel('home')).toBeNull()
    localStorage.setItem(SEISMO_QUIET_STORAGE_KEY, 'not json')
    resetSeismoQuietMemoForTest()
    expect(rememberedQuietLevel('home')).toBeNull()
  })
})
