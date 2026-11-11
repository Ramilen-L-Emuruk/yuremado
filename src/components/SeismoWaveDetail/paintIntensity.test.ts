import { describe, expect, it, vi } from 'vitest'

import { log } from '../../utils/logger'
import { intensityYRange, paintIntensitySeries } from './paintIntensity'
import { intensityLabel } from '../../utils/intensity'
import { ja } from '../../i18n/messages/ja'
import { en } from '../../i18n/messages/en'

vi.mock('../../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger')>()
  return { ...actual, log: { ...actual.log, error: vi.fn() } }
})

describe('paintIntensitySeries', () => {
  // 安全弁: 描けないことを黙らない（「推移が無い」と区別が付かなくなる）。間引くので 2 回目は書かない。
  it('2D コンテキストが取れなければ記録し、続けては書かない', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
    const range = { fromMs: 0, toMs: 1000 }
    paintIntensitySeries(canvas, range, [], [], String)
    paintIntensitySeries(canvas, range, [], [], String)
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  // 正: 境目の名前は渡した組み立て方で描く（日本語の辞書なら今の字面「震度5弱」、英語なら英語の札）
  it('境目の横線に、震度の値から組んだ名前を添える', () => {
    const drawn: string[] = []
    const noop = () => {}
    const ctx = new Proxy({ fillText: (t: string) => { drawn.push(t) } } as Record<string, unknown>, {
      get: (target, key) => (key in target ? target[key as string] : noop),
      set: () => true,
    })
    const canvas = { getContext: () => ctx, clientWidth: 100, clientHeight: 50, width: 100, height: 50 } as unknown as HTMLCanvasElement
    const segments = [[{ atMs: 0, value: 4.8 }, { atMs: 500, value: 5.2 }]]
    // このファイルは DOM を持たない環境で走るので、描く側が読む画素の比だけを置く
    vi.stubGlobal('window', { devicePixelRatio: 1 })
    paintIntensitySeries(canvas, { fromMs: 0, toMs: 1000 }, segments, [], (scale) => ja.quake.section.scale(intensityLabel(scale, ja.formats)))
    expect(drawn).toEqual(['震度1', '震度2', '震度3', '震度4', '震度5弱', '震度5強'])
    drawn.length = 0
    paintIntensitySeries(canvas, { fromMs: 0, toMs: 1000 }, segments, [], (scale) => intensityLabel(scale, en.formats))
    expect(drawn).toContain('5 Lower')
    vi.unstubAllGlobals()
  })
})

describe('intensityYRange', () => {
  // 安全弁: 値が無くても幅を持つ（描く側が max - min で割る）。
  it('値が無ければ 0〜1.5', () => {
    expect(intensityYRange([])).toEqual({ min: 0, max: 1.5 })
  })

  // 対照: 静穏時の小さな値では上の下限（震度2 の境目）が効く。
  it('小さな値では上は 1.5 のまま', () => {
    expect(intensityYRange([0.2, 0.46])).toEqual({ min: 0, max: 1.5 })
  })

  // 正: 値が大きければ余白を足して 0.5 刻みへ切り上げる。
  it('大きな値では余白を足して切り上げる', () => {
    expect(intensityYRange([2.34])).toEqual({ min: 0, max: 3 })
  })

  it('負の値があれば下を広げる', () => {
    expect(intensityYRange([-0.3, 0.1])).toEqual({ min: -0.5, max: 1.5 })
  })

  it('有限でない値は無視する', () => {
    expect(intensityYRange([Number.NaN, Number.POSITIVE_INFINITY])).toEqual({ min: 0, max: 1.5 })
  })
})
