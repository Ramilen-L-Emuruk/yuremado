// テストボタン「長周期地震動（階級0）テスト」（`LPGM_CLASS_ZERO`）が流す電文の形を固定する。
//
// **階級 0 の報の標本は全期間に無く、この台本が実機で確かめる唯一の入口**（2026-10-24 ユーザー選択
// 「ボタンを足す (Recommended)」）。書き換えは階級・震度・地震の要素・`EventID` を一度に替えるので、
// どれか 1 つ崩れても型検査は通る —— 崩れるとボタンが黙って別の形を流す。
//
//   正  : パーサーを通した結果が、最大階級 0・区域と観測点がすべて階級 0・地震カードと同じ事象
//   対照: 書き換える前の電文（地震テストの長周期）は階級 1 以上を持つ
//   安全弁: 震度は佐渡付近の地震の最大（3）を超えない・観測情報の種類を持たない
import { describe, it, expect } from 'vitest'
// **トップレベルで読む**（→ CLAUDE.md「検証」。1 件目に読み込みの待ちを乗せない）
import { first, telegramLpgms, telegramQuakes } from '../test-utils/testTelegramFixtures'

const lpgms = await telegramLpgms('LPGM_CLASS_ZERO')
const quakes = await telegramQuakes('LPGM_CLASS_ZERO')
const notoLpgm = first(await telegramLpgms('EARTHQUAKE'), '地震テストの長周期地震動')
const categoryLpgms = await telegramLpgms('LPGM_CATEGORIES')
const categoryQuakes = await telegramQuakes('LPGM_CATEGORIES')

describe('長周期地震動（階級0）テストの電文', () => {
  const lpgm = first(lpgms, '階級 0 の長周期地震動')
  const quake = first(quakes, '佐渡付近の地震情報')

  it('最大階級が 0 で、区域と観測点もすべて階級 0', () => {
    expect(lpgm.cancelled).toBe(false)
    expect(lpgm.maxClass).toBe(0)
    expect(lpgm.regions?.length).toBeGreaterThan(0)
    expect(lpgm.regions?.every(r => r.maxLgInt === 0)).toBe(true)
    expect(lpgm.points?.length).toBeGreaterThan(0)
    expect(lpgm.points?.every(p => p.lgInt === 0)).toBe(true)
    expect(lpgm.points?.every(p => (p.periods ?? []).every(b => b.lgInt === undefined || b.lgInt === 0))).toBe(true)
  })

  it('地震カードと同じ事象（佐渡付近の地震）に付く', () => {
    expect(lpgm.eventId).toBe(quake.eventId)
    expect(quake.earthquake.hypocenter.name).toBe('佐渡付近')
  })

  it('震度は佐渡付近の地震の最大（3）を超えない', () => {
    const ints = [lpgm.maxInt, ...(lpgm.regions ?? []).map(r => r.maxInt), ...(lpgm.points ?? []).map(p => p.int)]
      .filter((v): v is NonNullable<typeof v> => v !== undefined)
    expect(ints.length).toBeGreaterThan(0)
    expect(Math.max(...ints)).toBeLessThanOrEqual(30)
  })

  it('観測情報の種類を持たない（種類の定義は最大階級 1 以上の場合しか無い）', () => {
    expect(lpgm.category).toBeUndefined()
  })

  it('書き換える前の電文（地震テストの長周期）は階級 1 以上を持つ', () => {
    expect(notoLpgm.maxClass).toBeGreaterThanOrEqual(1)
  })
})

// 「観測情報の種類」1・3 の実電文（`LPGM_CATEGORIES`）。書き換えないので、置いたファイルが本当に
// 種類 1・3 を運び、地震カードと同じ事象に付くことだけを固定する。
describe('長周期地震動（種類1・3）テストの電文', () => {
  it('種類 1 と 3 の報が、それぞれ同じ事象の地震情報と組で流れる', () => {
    const ls = categoryLpgms
    const qs = categoryQuakes
    expect(ls.map(l => l.category)).toEqual([1, 3])
    expect(ls.map(l => l.maxClass)).toEqual([2, 3])
    for (const l of ls) expect(qs.some(q => q.eventId === l.eventId)).toBe(true)
  })
})
