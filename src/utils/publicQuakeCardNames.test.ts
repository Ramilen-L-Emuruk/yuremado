import { describe, expect, it } from 'vitest'
import type { PublicQuakeWave } from '../hooks/usePublicQuakeWaves'
import { localizePublicQuakeCards, type PublicCardNameCache } from './publicQuakeCardNames'

/** 見出しだけを見るので、札はほかの欄を省いた形で作る */
function wave(nameJa: string, number: number): PublicQuakeWave {
  return { nameJa, number, card: { stationId: `public:${nameJa}`, displayName: `#${number} ${nameJa}` } } as unknown as PublicQuakeWave
}

describe('地震カードの公開観測点の見出しを画面の言語にする', () => {
  it('正: 日本語以外の画面では、見出しの名前を訳す（番号はそのまま）', () => {
    const out = localizePublicQuakeCards(new Map([['q', [wave('宮城丸森', 3), wave('えりも', 1)]]]), 'ko', new WeakMap())
    expect(out.get('q')!.map((c) => c.displayName)).toEqual(['#3 미야기 마루모리', '#1 에리모'])
  })

  it('対照: 日本語の画面では元の札をそのまま返す', () => {
    const w = wave('宮城丸森', 3)
    const out = localizePublicQuakeCards(new Map([['q', [w]]]), 'ja', new WeakMap())
    expect(out.get('q')![0]).toBe(w.card)
  })

  it('表に無い名前は日本語の名前のまま', () => {
    const out = localizePublicQuakeCards(new Map([['q', [wave('架空観測点', 2)]]]), 'en', new WeakMap())
    expect(out.get('q')![0].displayName).toBe('#2 架空観測点')
  })

  it('安全弁: 元の札と言語が同じなら前回の札と同じ参照を返し、言語を変えたら作り直す', () => {
    const cache: PublicCardNameCache = new WeakMap()
    const waves = new Map([['q', [wave('佐渡島銀山', 5)]]])
    const first = localizePublicQuakeCards(waves, 'en', cache).get('q')![0]
    const again = localizePublicQuakeCards(waves, 'en', cache).get('q')![0]
    expect(again).toBe(first)
    expect(first.displayName).toBe('#5 Sadogashima Ginzan')
    const zh = localizePublicQuakeCards(waves, 'zh-Hans', cache).get('q')![0]
    expect(zh).not.toBe(first)
    expect(zh.displayName).toBe('#5 佐渡岛银山')
  })
})
