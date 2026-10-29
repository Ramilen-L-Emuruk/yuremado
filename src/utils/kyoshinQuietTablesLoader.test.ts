import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { QuietTables } from './kyoshinQuietTables'
import { FALLBACK_GLOB } from './kyoshinQuietTablesLoader'

// 読み込みの口はモジュールスコープに控えと購読者を持つので、テストごとに読み直す。
async function freshModule() {
  vi.resetModules()
  return await import('./kyoshinQuietTablesLoader')
}

const tail = (n: number) => ({ n, y: new Array(12).fill(1), y3: new Array(12).fill(1) })
const SAMPLE: QuietTables = {
  version: 1,
  days: ['20260911'],
  glob: tail(1000),
  tails: { '35,135': tail(100) },
  fire: { '35,135': [1, 0.5, 0.2, 0.1, 0.05] },
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('平常のゆらぎの表の読み込み', { timeout: 15_000 }, () => {
  it('正: 取れたら表を返し、以降は取りに行かない', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const m = await freshModule()
    expect(await m.loadKyoshinQuietTables()).toEqual(SAMPLE)
    expect(m.getKyoshinQuietTables()).toEqual(SAMPLE)
    await m.loadKyoshinQuietTables()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('対照: 取れるまでの間は全体の数だけの表を返す（観測点ごとの表は空）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const m = await freshModule()
    void m.loadKyoshinQuietTables()
    const t = m.getKyoshinQuietTables()
    expect(t.glob).toEqual(FALLBACK_GLOB)
    expect(t.tails).toEqual({})
    expect(t.fire).toEqual({})
  })

  it('安全弁: 形の崩れた表は取得の失敗として扱い、全体の数だけの表のまま', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ...SAMPLE, tails: {} })))
    const m = await freshModule()
    // 取り直しは共有の規則（30 秒〜）なので、ここでは最初の失敗が取り直しへ回ったことまでを見る
    let settled = false
    void m.loadKyoshinQuietTables().then(() => { settled = true }, () => { settled = true })
    await new Promise(r => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(m.getKyoshinQuietTables().tails).toEqual({})
  })

  it('取れたら、先に登録した購読者へ 1 度だけ知らせる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const m = await freshModule()
    const fn = vi.fn()
    m.onKyoshinQuietTablesLoaded(fn)
    await m.loadKyoshinQuietTables()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(SAMPLE)
  })
})

describe('取れない間に使う全体の数', () => {
  it('配る表の全体の数と同じ（表を焼き直したら写し直す）', () => {
    const file = JSON.parse(readFileSync('public/data/kyoshin-quiet-tables.json', 'utf8')) as QuietTables
    expect(FALLBACK_GLOB).toEqual(file.glob)
  })
})

describe('表の検分', () => {
  it('配る表はそのまま通る', async () => {
    const { validateQuietTables } = await import('./kyoshinQuietTables')
    const file: unknown = JSON.parse(readFileSync('public/data/kyoshin-quiet-tables.json', 'utf8'))
    expect(() => validateQuietTables(file)).not.toThrow()
  })

  it('版が違う・観測点の数が崩れている・雑音の率が 5 段でないものは投げる', async () => {
    const { validateQuietTables } = await import('./kyoshinQuietTables')
    expect(() => validateQuietTables({ ...SAMPLE, version: 2 })).toThrow('版が違う')
    expect(() => validateQuietTables({ ...SAMPLE, tails: { a: { n: 1, y: [1], y3: [1] } } })).toThrow('a の数が崩れている')
    expect(() => validateQuietTables({ ...SAMPLE, fire: { a: [1, 2, 3] } })).toThrow('a の雑音の率が崩れている')
    expect(() => validateQuietTables({ ...SAMPLE, fire: { a: [1, 2, 3, 4, Number.NaN] } })).toThrow('a の雑音の率が崩れている')
  })
})
