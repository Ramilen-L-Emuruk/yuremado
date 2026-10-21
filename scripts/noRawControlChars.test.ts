import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ソースとドキュメントに**生の制御文字**を置かない。文字が要るならエスケープで書く
// （`'\u0000'`）。
//
// **見た目では気づけない。** 生の NUL が 1 バイト入ると、エディタでは空白と区別が付かない
// 一方で **grep / ripgrep はそのファイルをバイナリとして扱い、以後どの検索にもヒットしなく
// なる**（`Binary file ... matches` としか出ない）。型チェックもテストも通り、実行時の挙動も
// エスケープ表記と完全に同じなので、**壊れているのは可検索性だけ**という形で残り続ける。
//
// 実際に `src/utils/quakePoints.ts` で起きた。市町村の鍵の区切り（`CITY_KEY_SEP`）をローカル
// 定義から export へ移したとき、`'\u0000'` と書いたつもりの箇所が生の NUL になっていた。
// **そのファイル自身のコメントが「エスケープで書くこと」と警告していた**にもかかわらず。
// 人の注意では止まらないので、ここで機械的に止める。
//
// 対象から外す制御文字は 3 つだけ —— タブ・改行・復帰。それ以外の C0 制御文字（NUL を含む）と
// DEL は、ソースにもドキュメントにも現れる理由がない。
//
// **`seismo-host/` も対象に含める。** 2026-09-30 に `seismo-host/src/admin/viewWaves.ts` で
// 同じ欠陥を作った（一覧の署名の区切りを `'\u0000'` と書いたつもりが生の NUL 1 バイト）。
// 当時ここは `src` / `scripts` / `docs` だけを見ていたので**この検査を素通りし**、
// 気づいたのは敵対的レビューがそのファイルの `grep` に失敗したとき。
// **アプリ本体と別のディレクトリにあっても、踏む罠は同じ。**

const ROOTS = ['src', 'scripts', 'docs', 'seismo-host']
const EXTENSIONS = ['.ts', '.tsx', '.md', '.mjs', '.js', '.css']

/**
 * バイト値で引いて「置いてはいけない制御文字か」を返す表。
 * タブ (09)・改行 (0A)・復帰 (0D) 以外の C0 制御文字と DEL (7F) が 1。
 *
 * **`Set` で持たない。** 全バイトを 1 つずつ問い合わせるので呼び出しは 1000 万回を超え、
 * `Set.has` だと走査だけで 0.22 秒かかる（表引きなら 0.02〜0.05 秒）。
 */
const FORBIDDEN = ((): Uint8Array => {
  const table = new Uint8Array(0x100)
  for (let code = 0x00; code < 0x20; code++) table[code] = 1
  for (const allowed of [0x09, 0x0a, 0x0d]) table[allowed] = 0
  table[0x7f] = 1
  return table
})()

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFiles(path))
    } else if (EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      out.push(path)
    }
  }
  return out
}

/** 1 件目の違反を「ファイル:行:文字コード」の形で返す（無ければ null）。 */
async function findControlChar(path: string): Promise<string | null> {
  const buf = await readFile(path)
  let line = 1
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]
    if (byte === 0x0a) { line++; continue }
    if (FORBIDDEN[byte]) {
      const hex = byte.toString(16).padStart(2, '0').toUpperCase()
      return `${path}:${line} に生の制御文字 0x${hex}（エスケープで書くこと）`
    }
  }
  return null
}

describe('生の制御文字を置かない', () => {
  // **ファイルを 1 件ずつ順番に読まない。** 対象は増え続ける（2026-09-18 に 576 件・12MB、
  // 2026-10-21 に 1176 件・24MB。走査するのは作業ツリーの実体なので、`.gitignore` された手元の
  // 使い捨てスクリプトも数に入る）。
  // 1 件ずつ `readFileSync` で読むと待ちが件数だけ積み上がり、`npm test` の並列実行で他ワーカーとの
  // 競合が乗ると既定の 5 秒を超えて**このテストだけが時間切れで落ちる**（実際に起きた。単独で
  // 回すと通ってしまうので原因が分かりにくい）。`Promise.all` でまとめて投げれば待ちを重ねられる。
  //
  // **上限は 15 秒にする**（既定は 5 秒）。2026-09-18 にまとめ読みへ替えたときは単独 1.98 秒 →
  // 0.43 秒・並列実行下で 532ms になり、5 秒に対して 9 倍の余裕があったので延ばさなかった。
  // その後に対象が 1176 件・24MB（2026-10-21 時点）へ倍増し、重い全件並列で 5013ms になって
  // 時間切れが起きた。内訳は一覧 30ms・読み込み 163〜225ms・検査 51〜81ms（単独）で、重いのは
  // 読み込みそのもの —— 検査を正規表現へ替えても 43〜51ms にしかならず、減らせる仕事が残っていない。
  // 15 秒は落ちた回の 3 倍で、`prefectures.test.ts` ほかの前例と同じ値。プロジェクト全体の上限
  // （`vitest.config.ts`）は 5 秒のまま据え置き、無関係なテストの性能劣化を見逃す網は緩めない。
  it('ソースとドキュメントに、タブ・改行・復帰以外の制御文字が無い', { timeout: 15_000 }, async () => {
    const found = await Promise.all(ROOTS.flatMap(listFiles).map(findControlChar))
    const offenders = found.filter((x): x is string => x !== null)
    expect(offenders).toEqual([])
  })
})
