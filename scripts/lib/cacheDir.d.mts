// `cacheDir.mjs` の型宣言。**実装は JS 側が正**で、ここはそれを TypeScript から呼ぶための宣言だけ。

/** git の答えからメインの checkout のトップを決める。ワークツリーの中で答えが使えなければ投げる。 */
export function decideMainRoot(input: {
  commonDir: string | null
  gitError: string | null
  repoRoot: string
  insideWorktree: boolean
}): { root: string; warning: string | null }

/** メインの checkout のトップ（ワークツリーから呼んでもメインを指す）。 */
export function mainCheckoutRoot(): string

/** 前の置き場所（`.claude/<name>`）に控えが残り、新しい置き場所がまだ無いか。 */
export function shouldWarnLegacy(input: { newExists: boolean; legacyExists: boolean }): boolean

/** 控えの置き場所。メインの checkout の `.cache/<name>`。 */
export function cacheDir(name: string): string
