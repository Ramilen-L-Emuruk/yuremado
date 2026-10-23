// テストボタンの電文（`public/data/test-telegrams/`）への `fetch` を、ファイル読み込みへ向ける。
//
// **アプリは電文を `fetch` で取る**（→ `utils/testTelegrams.ts`）。ブラウザでは
// `public/` が配信されるのでそれでよいが、テスト環境にはその配信元が無い。向け直さないと
// テストボタンを押しても**何も起きないだけ**で、例外もログも出ない。
//
// **置き換えるのはこの電文への取得だけ。** ほかの `fetch` はそのまま元へ渡す —— 取得そのものを
// モックしているテスト（配信元の応答を組み立てるもの）を壊さないため。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 置き場所。**`new URL(`…${file}`, import.meta.url)` の形で書かないこと**（Vite が静的な資材の参照へ書き換える）。 */
const TELEGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/data/test-telegrams')

const MARKER = 'data/test-telegrams/'

/** 既に入れたか（テストごとに読み込まれても二重に包まない）。 */
let installed = false

export function installTestTelegramFetch(): void {
  if (installed) return
  installed = true
  const original = globalThis.fetch?.bind(globalThis)
  // **`async` で包まないこと。** 包むと、電文と無関係な取得にもマイクロタスクが 1 段増える。
  // テストは「1 回の `await Promise.resolve()`」で実装の非同期を流し切る作りなので
  // （`useEarthquakes.wiring.test.ts` の `flush`）、段が増えると**接続が終わる前に確かめに入り**、
  // 注入した電文が画面へ出ないまま落ちる（実際に 29 件が落ちた）。
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const at = url.indexOf(MARKER)
    if (at < 0) {
      if (!original) throw new Error(`テスト環境に fetch がありません: ${url}`)
      return original(input, init)
    }
    const file = url.slice(at + MARKER.length)
    try {
      // **バイト列で読む。** XML も二進電文（推計震度分布図）も同じ口を通る
      const bytes = readFileSync(join(TELEGRAM_DIR, file))
      return Promise.resolve(new Response(new Uint8Array(bytes), { status: 200 }))
    } catch (err) {
      // **404 に化かすのは「ファイルが無い」ときだけ。** 権限・パスの取り違え・読み取りの失敗まで
      // 404 にすると、台本が指す電文の綴り間違いと、環境の不具合が同じ顔で出る。
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      return Promise.resolve(new Response(null, { status: 404 }))
    }
  }) as typeof fetch
}
