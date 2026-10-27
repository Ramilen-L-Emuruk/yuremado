import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { checkCommitMessage, hasJapanese, hasEnglishProse } from './lib/japaneseOnly'
import {
  type ExtractedText,
  extractFromFirmware,
  extractFromMarkdown,
  extractFromScript,
  extractFromToml,
  extractFromWorkflow,
} from './lib/japaneseOnlySources'

// エラー・ログの文面、Codex の設定、CI の名前に**英語の文を置かない**。
//
// 2026-10-21 の棚卸しで、コメントと資料の地の文は日本語だったのに、エラー・ログの文面に英語が 111 行
// （ファームの出力を除く）、Codex の設定 15 本がほぼ丸ごと英語で残っていた。エラーの文面は地震タブや設定の窓にそのまま
// 出る経路がある。書いた本人は気づかないので、人の注意では止まらない。ここで機械的に止める。
//
// **判定は「日本語を 1 文字も含まないのに、英単語が残る」**（`scripts/lib/japaneseOnly.ts`）。英語らしさ
// では見ない —— それだと `fix` のような 1 語や、機能語の無い短い文がすり抜ける。
//
// コミットメッセージはここでは見られない（テストを回す時点ではまだ無い）。push の前のフックで
// `scripts/check-commit-messages.ts` が見る。

const ROOT = join(import.meta.dirname, '..')

/**
 * 日本語にしなくてよい文面。**足すときは理由を書く。** 文面で分岐する合図と、
 * 外の道具が読む欄だけを置く。「英語の方が分かりやすい」は理由にしない。
 */
const ALLOWED: readonly { file: string; text: string; reason: string }[] = [
  {
    file: 'src/services/dmdata.ts',
    text: 'auth',
    reason: '文面で分岐する合図（`err.message === \'auth\'`）。画面には出さず、受け手が別の文に置き換える',
  },
  {
    file: 'src/hooks/useEarthquakes.ts',
    text: 'cancelled',
    reason: '文面で分岐する合図（`err.message === \'cancelled\'`）。取り直しで捨てた回を見分けるだけで、画面には出さない',
  },
]

/**
 * 走査するファイル。**git が追跡しているものと、まだ追加していない新しいファイル**（`.gitignore` されたもの
 * ——依存・生成物・手元の控え——は入らない）。ディレクトリを自前で辿ると、名前で外した `data` の中の
 * ソースを取りこぼし（`src/data/jma2001TravelTime.ts`）、別のセッションが置いた一時ファイルで落ちる。
 */
function repoFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f !== '' && existsSync(join(ROOT, f))) // 消して未コミットのものは外す
}

/** TS/JS の文面を見る場所。ファームの道具（`firmware/tools`）と、トップの設定ファイルも入れる。 */
const SCRIPT_FILE = /^(?:src|scripts|seismo-host|firmware|relay)\/.*\.(?:[cm]?[jt]sx?)$|^[^/]+\.config\.[cm]?[jt]s$/
/** テストとテスト用の素材・一時ファイルは外す（英語の文面を入力として与えるものがある）。 */
const NOT_TARGET = /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$|\.tmp\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/

interface Target {
  path: string
  extract: (source: string, path: string) => ExtractedText[]
}

function targets(): Target[] {
  const out: Target[] = []
  for (const file of repoFiles()) {
    const path = join(ROOT, file)
    if (SCRIPT_FILE.test(file) && !NOT_TARGET.test(file)) {
      out.push({ path, extract: (s, p) => extractFromScript(p, s) })
    } else if (/^firmware\/.*\.(?:ino|h)$/.test(file)) {
      out.push({ path, extract: extractFromFirmware })
    } else if (/^\.codex\/.*\.toml$/.test(file)) {
      out.push({ path, extract: extractFromToml })
    } else if (/^\.agents\/.*\.md$/.test(file)) {
      out.push({ path, extract: extractFromMarkdown })
    } else if (/^\.github\/workflows\/.*\.ya?ml$/.test(file)) {
      out.push({ path, extract: extractFromWorkflow })
    }
  }
  return out
}

describe('英語の文を置かない', () => {
  // 読むのは 1,000 件余り。1 件ずつ待つと全件並列の `npm test` で時間切れになりうるので、まとめて投げる
  // （`noRawControlChars.test.ts` と同じ理由）。構文解析が重いので上限も延ばす。
  it('エラー・ログの文面・Codex の設定・CI の名前に、日本語を含まない文が無い', async () => {
    const list = targets()
    expect(list.length).toBeGreaterThan(500) // 数え漏れ（根の書き間違い）で 0 件のまま通らないように
    const sources = await Promise.all(list.map((t) => readFile(t.path, 'utf8')))
    const violations: string[] = []
    const used = new Set<number>()
    list.forEach((t, i) => {
      const file = relative(ROOT, t.path).replace(/\\/g, '/')
      for (const { line, text } of t.extract(sources[i] as string, t.path)) {
        if (!hasEnglishProse(text)) continue
        const allowed = ALLOWED.findIndex((a) => a.file === file && text.trim() === a.text)
        if (allowed >= 0) {
          used.add(allowed)
          continue
        }
        violations.push(`${file}:${line}  ${text.trim().slice(0, 120)}`)
      }
    })
    expect(violations, '日本語で書き直すこと（引用なら理由を添えて ALLOWED へ）').toEqual([])
    const stale = ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.text}`)
    expect(stale, 'ALLOWED に、もう現れない文面が残っている（消すこと）').toEqual([])
  }, 30_000)
})

describe('判定（hasEnglishProse）', () => {
  it.each([
    ['fix', true],
    ['custom layer add failed', true],
    ['[EewEpicentersGL] WebGL context restored, re-adding custom layer', true],
    ['Archive list failed: ', true],
    ['admin disabled: no ADMIN_TOKEN on this board', true],
    ['# wifi up ip=%s rssi=%d', true],
    ['[kyoshin] 時計の較正が外れた', false],
    ['取得に失敗しました: 500', false],
    ['viewport 1272x768。', false], // 和文の句点も日本語として数える
    ['[data] ', false], // 札だけ
    ['%s=%d', false],
    ['`npm run build-hypocenter-catalog`', false], // バッククォートの中はコード
    ['1.2〜3.4 s → 16〜18 ms', false],
    ['https://example.com/path', false],
    ['station-coords', false], // 識別子
    ['WebGL MapLibre JMA', false],
    ['Archive fetch failed: 取得元 3 件すべてを読み取れませんでした', true], // 日本語の文に英語の句を継ぎ足した形
    ['Socket Start 失敗', false], // 英単語 2 語までは日本語の文に混ぜてよい
    ['「Invalid LngLat latitude value」と投げる', true], // 英語の引用はバッククォートで囲む
    ['`Invalid LngLat latitude value` と投げる', false],
    ['使い方: `npx tsx scripts/x.ts [--out <TSV>] <ディレクトリかファイル…>`', false], // 日本語を含む引用
    ['Failed to fetch 取得失敗', true], // 機能語 `to` を数える
    ['[Failed to connect to the server]', true], // 角括弧の中の文は札ではない
    ['[EewEpicentersGL] カスタムレイヤーを足せなかった', false],
  ])('%s → %s', (text, expected) => {
    expect(hasEnglishProse(text)).toBe(expected)
  })

  it('カタカナ・ひらがな・漢字のどれでも日本語と数える', () => {
    expect(hasJapanese('テスト')).toBe(true)
    expect(hasJapanese('てすと')).toBe(true)
    expect(hasJapanese('試験')).toBe(true)
    expect(hasJapanese('test')).toBe(false)
  })
})

describe('コミットメッセージ（checkCommitMessage）', () => {
  it('件名が英語なら落とす（1 語でも）', () => {
    expect(checkCommitMessage('fix')).toEqual([{ line: 1, text: 'fix' }])
    expect(checkCommitMessage('chore: add Codex configuration')).toHaveLength(1)
  })

  it('日本語の件名と本文は通す', () => {
    expect(checkCommitMessage('fix: 取得の時間切れを日本語で伝える\n\n地震タブに出る文を直した。\n')).toEqual([])
  })

  it('本文の英語の行を行番号つきで返す', () => {
    const msg = 'fix: 衝突を解いた\n\nResolve conflicts by preserving both histories.\n'
    expect(checkCommitMessage(msg)).toEqual([{ line: 3, text: 'Resolve conflicts by preserving both histories.' }])
  })

  it('git が書く件名・版番号・トレーラー・衝突の一覧は通す', () => {
    for (const subject of [
      '5.58.2',
      "Merge branch 'ready/fix/static-scan-test-timeouts'",
      "Merge branch 'main' into worktree/fix/x",
      'Merge main into worktree/feat/replay',
      'Merge pull request #3 from someone/topic',
    ]) {
      expect(checkCommitMessage(subject), subject).toEqual([])
    }
    const body = [
      "Merge branch 'ready/fix/x'",
      '',
      '# Conflicts:',
      '#\tdocs/spec/quake-spec.md',
      '',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    ].join('\n')
    expect(checkCommitMessage(body)).toEqual([])
  })

  it('トレーラーは決まったキーだけ通す', () => {
    expect(checkCommitMessage('fix: 直した\n\nSigned-off-by: someone <a@example.com>\n')).toEqual([])
    expect(checkCommitMessage('fix: 直した\n\nRelease-Note: Something happened here <a@example.com>\n')).toHaveLength(1)
  })

  it('字下げしても英語の行は通さない（コードはバッククォートで囲む）', () => {
    expect(checkCommitMessage('test: 件数を書いた\n\n  npm test 6834 passed\n')).toHaveLength(1)
    expect(checkCommitMessage('test: 件数を書いた\n\n`npm test` 6834 件通過\n')).toEqual([])
  })
})
