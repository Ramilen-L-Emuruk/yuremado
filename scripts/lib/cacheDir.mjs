// 生成・調査スクリプトが取ったものを控える置き場所（キャッシュ）を決める。
//
// **置き場所はメインの checkout の `.cache/<名前>`。ワークツリーから走らせても同じ場所を指す。**
// ワークツリーごとに置くと、そのワークツリーで走らせるたびに配信元から取り直し、容量もその分だけ増える。
//
// **`.claude/` の下には置かない。** デスクトップアプリはセッション用のワークツリーを作るとき、
// メインの `.claude/` の中身を Git の管理外のものまで丸ごとコピーする（`worktrees/` は除く）。
// 2026-10-27 に、アプリが作ったワークツリー 5 つへ控えが複製され、ディスクの空きが無くなった
// （実測: 1 つあたり約 9 GB・5 つで約 43 GB。うち `seismo-bench-cache` が 8.29 GB）。リポジトリ直下の Git 管理外のもの（`node_modules`・`.env.local`）は
// コピーされていなかったので、`.cache/` はこの複製から外れる。
//
// TypeScript から呼ぶための宣言は `cacheDir.d.mts` にある（`.mjs` にしてあるのは、素の node で動かす
// `.mjs` のスクリプトからも import するため）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO } from './repo-root.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * git が答えた共通ディレクトリから、メインの checkout のトップを決める。純関数（テストで固定する）。
 *
 * - 共通ディレクトリが `<トップ>/.git` なら、その親を返す（メインからでもワークツリーからでも同じ値になる）
 * - **ワークツリーの中（`.git` がファイル）で答えが使えないときは投げる。** 自分の位置へ倒すと、そのワークツリーの
 *   空の `.cache/` を見て配信元から全件を取り直し、容量もワークツリーごとに増える（この部品が防ぎたい形そのもの）
 * - メインの checkout や `.git` の無い写しで答えが使えないときは、自分の位置から導いた根へ倒し、理由を `warning` で返す
 *
 * @param {{ commonDir: string | null, gitError: string | null, repoRoot: string, insideWorktree: boolean }} input
 * @returns {{ root: string, warning: string | null }}
 */
export function decideMainRoot({ commonDir, gitError, repoRoot, insideWorktree }) {
  let reason = null
  if (commonDir === null) {
    reason = `git からメインの checkout を引けませんでした（${gitError ?? '理由不明'}）`
  } else if (path.basename(commonDir) !== '.git') {
    reason = `git の共通ディレクトリが \`.git\` ではありません（${commonDir}）`
  } else {
    return { root: path.dirname(commonDir), warning: null }
  }
  if (insideWorktree) {
    throw new Error(
      `[cacheDir] ${reason}。ワークツリーの中なので、控えの置き場所を決められません。` +
        'このまま進めると控えを使わずに配信元から取り直すので止めます（git を直すか、メインの checkout で走らせてください）',
    )
  }
  return { root: repoRoot, warning: `[cacheDir] ${reason}。控えはこのリポジトリの \`.cache/\`（${repoRoot}）に置きます` }
}

let rootMemo = null

/** メインの checkout のトップ（ワークツリーから呼んでもメインを指す）。決め方は `decideMainRoot`。 */
export function mainCheckoutRoot() {
  if (rootMemo !== null) return rootMemo
  let commonDir = null
  let gitError = null
  try {
    commonDir = execFileSync('git', ['-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    const stderr = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr).trim() : ''
    gitError = stderr || (e instanceof Error ? e.message : String(e))
  }
  let insideWorktree = false
  try {
    insideWorktree = fs.statSync(path.join(REPO, '.git')).isFile()
  } catch {
    // `.git` が無い写し。ワークツリーではない
  }
  const { root, warning } = decideMainRoot({ commonDir, gitError, repoRoot: REPO, insideWorktree })
  if (warning !== null) console.warn(warning)
  rootMemo = root
  return rootMemo
}

const warnedLegacy = new Set()

/**
 * 前の置き場所（`.claude/<name>`）に控えが残っていて、新しい置き場所がまだ無いか。純関数（テストで固定する）。
 * 残ったまま走らせると、新しい場所が空なので配信元から全件を取り直す。
 *
 * @param {{ newExists: boolean, legacyExists: boolean }} input
 */
export function shouldWarnLegacy({ newExists, legacyExists }) {
  return legacyExists && !newExists
}

/**
 * 前の置き場所の候補。`.claude/<name>` と、呼び出し側が渡した場所（メインの checkout のトップからの相対）。純関数（テストで固定する）。
 *
 * @param {{ root: string, name: string, legacy: readonly string[] }} input
 * @returns {string[]}
 */
export function legacyCacheDirs({ root, name, legacy }) {
  return [path.join(root, '.claude', name), ...legacy.map((p) => path.join(root, p))]
}

/**
 * メインの checkout の `.cache/<name>`。前の置き場所に控えが残っていれば、1 回だけ移すよう知らせる。
 *
 * `options.legacy` には、`.claude/<name>` のほかに前の置き場所だった場所を、メインの checkout のトップからの相対で渡す
 * （強震モニタの評価台の控えは、リポジトリ直下の `.probe-cache` だった）。
 *
 * @param {string} name
 * @param {{ legacy?: readonly string[] }} [options]
 */
export function cacheDir(name, options = {}) {
  const root = mainCheckoutRoot()
  const dir = path.join(root, '.cache', name)
  if (!warnedLegacy.has(name)) {
    warnedLegacy.add(name)
    const newExists = fs.existsSync(dir)
    for (const legacy of legacyCacheDirs({ root, name, legacy: options.legacy ?? [] })) {
      if (shouldWarnLegacy({ newExists, legacyExists: fs.existsSync(legacy) })) {
        console.warn(
          `[cacheDir] 前の置き場所 ${legacy} に控えが残っています。${dir} へ移してください（移さないと配信元から取り直します）`,
        )
      }
    }
  }
  return dir
}
