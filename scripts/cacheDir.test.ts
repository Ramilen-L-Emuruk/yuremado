import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { decideMainRoot, legacyCacheDirs, shouldWarnLegacy } from './lib/cacheDir.mjs'

const repo = path.join('C:', 'repo', '.claude', 'worktrees', 'wt')
const main = path.join('C:', 'repo')

describe('decideMainRoot', () => {
  it('共通ディレクトリが .git なら、その親（メインの checkout）を返す', () => {
    const r = decideMainRoot({ commonDir: path.join(main, '.git'), gitError: null, repoRoot: repo, insideWorktree: true })
    expect(r).toEqual({ root: main, warning: null })
  })

  it('ワークツリーの中で git が答えられなければ、倒さずに投げる（ワークツリーの .cache で取り直させない）', () => {
    expect(() =>
      decideMainRoot({ commonDir: null, gitError: 'unknown option', repoRoot: repo, insideWorktree: true }),
    ).toThrow(/ワークツリーの中/)
  })

  it('ワークツリーの中で共通ディレクトリが .git でないときも投げる', () => {
    expect(() =>
      decideMainRoot({ commonDir: path.join(main, '.git', 'modules', 'x'), gitError: null, repoRoot: repo, insideWorktree: true }),
    ).toThrow(/\.git` ではありません/)
  })

  it('ワークツリーの外で git が答えられなければ、自分の根へ倒し、理由を知らせる', () => {
    const r = decideMainRoot({ commonDir: null, gitError: 'git: not found', repoRoot: main, insideWorktree: false })
    expect(r.root).toBe(main)
    expect(r.warning).toMatch(/git: not found/)
  })
})

describe('shouldWarnLegacy', () => {
  it('前の置き場所だけにあるときに知らせる', () => {
    expect(shouldWarnLegacy({ newExists: false, legacyExists: true })).toBe(true)
  })
  it('新しい置き場所があれば知らせない（移し終えた後）', () => {
    expect(shouldWarnLegacy({ newExists: true, legacyExists: true })).toBe(false)
  })
  it('どちらも無ければ知らせない（初めて取る）', () => {
    expect(shouldWarnLegacy({ newExists: false, legacyExists: false })).toBe(false)
  })
})

describe('legacyCacheDirs', () => {
  it('.claude/<name> を先頭に、渡した場所をトップからの相対で並べる', () => {
    expect(legacyCacheDirs({ root: main, name: 'kyoshin-bench', legacy: ['.probe-cache'] })).toEqual([
      path.join(main, '.claude', 'kyoshin-bench'),
      path.join(main, '.probe-cache'),
    ])
  })
  it('渡さなければ .claude/<name> だけ', () => {
    expect(legacyCacheDirs({ root: main, name: 'x', legacy: [] })).toEqual([path.join(main, '.claude', 'x')])
  })
})
