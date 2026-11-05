import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Service Worker が `importScripts` で読み込むファイル（`vite.config.ts` の `workbox.importScripts`）は、
// `public/` に置いてビルド出力へ写す。**読み込めないと Service Worker のインストールごと失敗する** ——
// 通知を押したときの処理だけでなく、オフライン・事前キャッシュ・更新の検知までまとめて黙って止まる。
// ファイルの改名・削除で起き、型チェックにもビルドにも掛からないので、ここで止める。

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = readFileSync(`${ROOT}vite.config.ts`, 'utf-8')

/** コメント（ブロックと行）を外す（コメントに残った書き方を、実際の指定と取り違えないように）。 */
function stripLineComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
}

/** `vite.config.ts` の `importScripts: [...]` に書かれたファイル名を取り出す。 */
function importScriptNames(config: string): string[] | null {
  const m = stripLineComments(config).match(/importScripts:\s*\[([^\]]*)\]/)
  if (!m) return null
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1])
}

describe('Service Worker が読み込むファイル', () => {
  const names = importScriptNames(CONFIG)

  it('vite.config.ts に importScripts の指定がある', () => {
    expect(names).not.toBeNull()
    expect(names!.length).toBeGreaterThan(0)
  })

  it('指定したファイルがすべて public/ に在る', () => {
    for (const name of names ?? []) {
      expect(existsSync(`${ROOT}public/${name}`), `public/${name}`).toBe(true)
    }
  })

  it('対照: 取り出し方が、コメントに残った書き方を拾わない', () => {
    expect(importScriptNames("workbox: { importScripts: ['a.js', \"b.js\"] }")).toEqual(['a.js', 'b.js'])
    expect(importScriptNames("// importScripts: ['old.js']\nworkbox: {}")).toBeNull()
    expect(importScriptNames("/* importScripts: ['old.js'] */\nworkbox: {}")).toBeNull()
  })
})


// 通知を押したときの文の種類は、Service Worker（素の JS）とアプリ（`notificationClick.ts`）で別々に書いてある。
// ずれると、開いている画面へ渡した開き先が黙って捨てられる
describe('通知を押したときの文の種類', () => {
  it('Service Worker が送る種類と、アプリが受ける種類が同じ', async () => {
    const { NOTIFICATION_OPEN_MESSAGE } = await import('../src/utils/notificationClick')
    const sw = readFileSync(`${ROOT}public/sw-notification-click.js`, 'utf-8')
    expect(sw).toContain(`type: '${NOTIFICATION_OPEN_MESSAGE}'`)
  })
})
