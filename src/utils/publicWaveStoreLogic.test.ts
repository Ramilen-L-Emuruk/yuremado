import { describe, expect, it } from 'vitest'
import {
  PUBLIC_WAVE_MAX_RETRIES,
  planPublicWaveEviction,
  publicWaveCacheVerdict,
  storedFromMs,
  type PublicWaveEntryMeta,
} from './publicWaveStoreLogic'
import { WAVE_HISTORY_LEAD_MS } from '../services/seismoWaveHistory'

const meta = (over: Partial<PublicWaveEntryMeta> & { key: string }): PublicWaveEntryMeta => ({
  originMs: 0,
  bytes: 100,
  state: 'settled',
  toMs: 1_000,
  fetchedAtMs: 0,
  retries: 0,
  ...over,
})

describe('planPublicWaveEviction', () => {
  // 対照: 上限の内なら何も捨てない。
  it('上限の内なら空', () => {
    expect(planPublicWaveEviction([meta({ key: 'a' })], { maxBytes: 1000, maxEntries: 10 })).toEqual([])
  })

  // 正: 超えたら地震の発生が古い順に、上限の内へ戻るまで捨てる（控えた順ではない）。
  it('発生の古い順に、上限へ戻るまで捨てる', () => {
    const metas = [
      meta({ key: 'new', originMs: 300, bytes: 400 }),
      meta({ key: 'old', originMs: 100, bytes: 400 }),
      meta({ key: 'mid', originMs: 200, bytes: 400 }),
    ]
    expect(planPublicWaveEviction(metas, { maxBytes: 800, maxEntries: 10 })).toEqual(['old'])
    expect(planPublicWaveEviction(metas, { maxBytes: 300, maxEntries: 10 })).toEqual(['old', 'mid', 'new'])
  })

  // 安全弁: 0 バイトの不在の項目も件数の上限で捨てる。
  it('件数の上限でも捨てる', () => {
    const metas = [meta({ key: 'x', originMs: 1, bytes: 0, state: 'absent' }), meta({ key: 'y', originMs: 2, bytes: 0, state: 'absent' })]
    expect(planPublicWaveEviction(metas, { maxBytes: 1000, maxEntries: 1 })).toEqual(['x'])
  })
})

describe('publicWaveCacheVerdict', () => {
  it('入りきってから取った控えと確かな不在はそのまま使う', () => {
    expect(publicWaveCacheVerdict(meta({ key: 'a' }), { fromMs: 0, toMs: 1_000 }, true)).toBe('use')
    expect(publicWaveCacheVerdict(meta({ key: 'a', state: 'absent' }), { fromMs: 0, toMs: 1_000 }, true)).toBe('use')
  })

  // 正: 仮の控えは範囲が入りきるまで待ち、入りきったら取り直す。
  it('仮の控えは入りきるまで待ち、入りきったら取り直す', () => {
    const m = meta({ key: 'a', state: 'provisional' })
    expect(publicWaveCacheVerdict(m, { fromMs: 0, toMs: 1_000 }, false)).toBe('wait')
    expect(publicWaveCacheVerdict(m, { fromMs: 0, toMs: 1_000 }, true)).toBe('refetch')
  })

  // 安全弁: 取り直しは 1 回まで（保存庫を繰り返し問い合わせない）。
  it('1 回取り直した仮の控えはそのまま使う', () => {
    const m = meta({ key: 'a', state: 'provisional', retries: PUBLIC_WAVE_MAX_RETRIES })
    expect(PUBLIC_WAVE_MAX_RETRIES).toBe(1)
    expect(publicWaveCacheVerdict(m, { fromMs: 0, toMs: 1_000 }, true)).toBe('use')
  })

  // 正: 次の地震で切った位置が緩み、欲しい範囲が後ろへ伸びたら取り直す。
  it('欲しい範囲が伸びたら取り直す', () => {
    expect(publicWaveCacheVerdict(meta({ key: 'a', toMs: 1_000 }), { fromMs: 0, toMs: 2_000 }, true)).toBe('refetch')
  })
})

describe('範囲の始まりが前へ伸びたとき', () => {
  // 正: 電文の地震発生時刻が分かって欲しい範囲が前へ伸びたら、入りきった控えでも取り直す（深い地震・遠い地震）
  it('欲しい始まりが控えの始まりより前なら取り直す', () => {
    expect(publicWaveCacheVerdict(meta({ key: 'a', fromMs: -60_000 }), { fromMs: -95_000, toMs: 1_000 }, true)).toBe('refetch')
  })

  // 対照: 始まりが同じか後ろなら使う（取り直しを増やさない）
  it('欲しい始まりが控えの始まり以降なら使う', () => {
    expect(publicWaveCacheVerdict(meta({ key: 'a', fromMs: -95_000 }), { fromMs: -95_000, toMs: 1_000 }, true)).toBe('use')
    expect(publicWaveCacheVerdict(meta({ key: 'a', fromMs: -95_000 }), { fromMs: -60_000, toMs: 1_000 }, true)).toBe('use')
  })

  // 安全弁: 始まりを持たない古い控えは、そのときの決め方（カードの時刻の手前の幅）で取ったものとして比べる。
  // ふだんの地震（始まりが変わらない）で、古い控えを全部取り直さない
  it('始まりを持たない控えは、カードの時刻の手前の幅で取ったものとして比べる', () => {
    const old = meta({ key: 'a', originMs: 1_000_000 })
    expect(storedFromMs(old)).toBe(1_000_000 - WAVE_HISTORY_LEAD_MS)
    expect(publicWaveCacheVerdict(old, { fromMs: 1_000_000 - WAVE_HISTORY_LEAD_MS, toMs: 1_000 }, true)).toBe('use')
    expect(publicWaveCacheVerdict(old, { fromMs: 1_000_000 - WAVE_HISTORY_LEAD_MS - 35_000, toMs: 1_000 }, true)).toBe('refetch')
  })
})
