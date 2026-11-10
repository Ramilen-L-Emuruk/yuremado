import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, isLocale, JA_MESSAGES, LOCALES, loadMessages, localeTag, type Messages } from './messages'

// 日本語以外の辞書を先に一度読んでおく。`loadMessages` は `import()` で読むので、初回の変換の待ちが
// テスト本体に乗ると、全件を並列で回したときだけ既定の 5 秒を超える（実際に 2 件が時間切れになった）
await Promise.all(LOCALES.map((l) => loadMessages(l.id)))

/** 辞書の形（キーの並びと、値が文字列か関数か）を平らに書き出す。 */
function shapeOf(tree: unknown, prefix = ''): string[] {
  if (typeof tree === 'string') return [`${prefix}:string`]
  if (typeof tree === 'function') return [`${prefix}:function/${tree.length}`]
  if (tree === null || typeof tree !== 'object') return [`${prefix}:${typeof tree}`]
  return Object.keys(tree).sort().flatMap((k) => shapeOf((tree as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k))
}

describe('辞書の形', () => {
  it('どの言語の辞書も日本語の辞書と同じキー・同じ種類の値を持つ（型を `as` で外した辞書も実行時に落とす）', async () => {
    const jaShape = shapeOf(JA_MESSAGES)
    for (const { id } of LOCALES) {
      const messages = await loadMessages(id)
      expect(shapeOf(messages), id).toEqual(jaShape)
    }
  })

  it('どの言語の辞書にも空の文字列が無い（訳し忘れを空で埋めない）', async () => {
    const empties: string[] = []
    const walk = (tree: unknown, path: string) => {
      if (typeof tree === 'string') { if (tree.trim() === '') empties.push(path); return }
      if (tree && typeof tree === 'object') for (const [k, v] of Object.entries(tree)) walk(v, `${path}.${k}`)
    }
    for (const { id } of LOCALES) walk(await loadMessages(id), id)
    expect(empties).toEqual([])
  })

  it('キーが欠けた辞書・余った辞書は型チェックで落ちる', () => {
    // 正: 欠けている
    // @ts-expect-error nav.telegrams が無い
    const missing: Messages = { nav: { earthquake: 'a', realtime: 'a', tsunami: 'a', catalog: 'a', settings: 'a' } }
    // 安全弁: 余っている（欠けを防いでも、別名で足したキーは素通りしない）
    const extra: Messages = {
      // @ts-expect-error nav.unknown は日本語の辞書に無い
      nav: { earthquake: 'a', realtime: 'a', tsunami: 'a', catalog: 'a', settings: 'a', telegrams: 'a', unknown: 'a' },
    }
    // 対照: そろっていれば通る
    const complete: Messages = { nav: { earthquake: 'a', realtime: 'a', tsunami: 'a', catalog: 'a', settings: 'a', telegrams: 'a' } }
    expect([missing, extra, complete]).toHaveLength(3)
  })
})

describe('言語の表', () => {
  it('既定の言語は日本語で、表に載っている', () => {
    expect(DEFAULT_LOCALE).toBe('ja')
    expect(isLocale(DEFAULT_LOCALE)).toBe(true)
  })

  it('表に無い値は言語として受け取らない', () => {
    expect(isLocale('xx')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLocale(1)).toBe(false)
  })

  it('言語の id は重ならず、言語タグは空でない', () => {
    const ids = LOCALES.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const { id } of LOCALES) expect(localeTag(id)).not.toBe('')
  })
})
