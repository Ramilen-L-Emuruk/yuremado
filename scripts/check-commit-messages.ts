/**
 * これから公開するコミットのメッセージに、英語の文が無いかを確かめる。
 * 判定は `scripts/lib/japaneseOnly.ts` の `checkCommitMessage`。
 *
 *   npx tsx scripts/check-commit-messages.ts --pre-push <remote>   git の pre-push フックから（標準入力に送る ref）
 *   npx tsx scripts/check-commit-messages.ts --range <rev-list の引数…> 例: --range origin/main..HEAD
 *
 * **push の前に見る理由。** コミットした瞬間に止める形（commit-msg フック）は 2026-10-12 に「もういらない」と
 * 取りやめた。push の前なら、まだ公開していないので `git commit --amend` や `git rebase` で安く書き直せる。
 * 公開した後に見つけても、直すには force push が要る。
 *
 * **ソース側は `scripts/japaneseOnly.test.ts` が見る**（コミットメッセージはテストを回す時点ではまだ無い）。
 *
 * 範囲の決め方は `scripts/check-personal-info.ts` と同じ —— 相手にいまある先端（`git ls-remote`）より
 * 後ろの、まだ公開していないコミットだけ。手元の追跡ブランチは古いことがあるので使わない。
 *
 * 終了コード: 0 = 見つからなかった、1 = 見つかった、2 = 調べられなかった。
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkCommitMessage } from './lib/japaneseOnly'

const ZERO = /^0+$/
const SHA = /^[0-9a-f]{40,64}$/
const MAX_BUFFER = 256 * 1024 * 1024

function git(args: readonly string[], input?: string): string {
  return execFileSync('git', [...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, input })
}

/** 相手にいまある先端のうち、手元にもあるもの。手元に無い先端は境にできないので外す（調べる範囲が広がるだけ）。 */
function liveRemoteTips(remote: string): string[] {
  const tips = [...new Set(git(['ls-remote', remote]).split('\n').map((l) => l.split('\t')[0] ?? '').filter((s) => SHA.test(s)))]
  if (tips.length === 0) return []
  return git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], tips.join('\n') + '\n')
    .split('\n')
    .filter((l) => / (commit|tag)$/.test(l))
    .map((l) => l.split(' ')[0] as string)
}

export interface CommitFinding {
  sha: string
  line: number
  text: string
}

/** rev-list の引数（`stdinRevs` を渡すと標準入力から）で選んだコミットのメッセージを調べる。 */
function scanRevs(revArgs: readonly string[], stdinRevs?: readonly string[]): CommitFinding[] {
  const input = stdinRevs === undefined ? undefined : stdinRevs.join('\n') + '\n'
  const args = stdinRevs === undefined ? revArgs : [...revArgs, '--stdin']
  // 区切りは NUL と SOH。メッセージの中に改行があっても崩れない
  const out = git(['log', '--format=%H%x00%B%x01', ...args], input)
  const findings: CommitFinding[] = []
  for (const record of out.split('\x01')) {
    const [rawSha, message] = record.replace(/^\n/, '').split('\x00')
    const sha = (rawSha ?? '').trim()
    if (!SHA.test(sha) || message === undefined) continue
    for (const p of checkCommitMessage(message)) findings.push({ sha, line: p.line, text: p.text })
  }
  return findings
}

/** pre-push フックの標準入力（`<local ref> <local sha> <remote ref> <remote sha>`）から、送るコミットだけを調べる。 */
function scanPrePush(remote: string, stdin: string): CommitFinding[] {
  const findings: CommitFinding[] = []
  let tips: string[] | null = null
  for (const line of stdin.split('\n')) {
    if (line.trim() === '') continue // 送る ref が無い push では空で届く
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/)
    if (localRef === undefined || remoteRef === undefined || !SHA.test(localSha ?? '') || !SHA.test(remoteSha ?? '')) {
      throw new Error(`pre-push の入力が読めない: ${line}`)
    }
    if (ZERO.test(localSha as string)) continue // 削除
    // **タグも同じ範囲で見る。** タグだけを送る push（`git push origin v1`）で、どのブランチにも載っていない
    // コミットが出ていくことがある。ブランチと一緒に送れば、同じコミットは下で 1 度だけ数える
    tips ??= liveRemoteTips(remote)
    // 上書きする ref の先端（remote sha）も境に入れる。**手元に無ければ入れない** —— 相手が先に進んでいる
    // だけなので、git 自身が「fetch してから」と断る。ここで rev-list を失敗させて分かりにくく止めない
    const remoteTip = remoteSha as string
    const boundary = ZERO.test(remoteTip) || !hasObject(remoteTip) ? tips : [...new Set([...tips, remoteTip])]
    findings.push(...scanRevs([], [localSha as string, ...boundary.map((s) => `^${s}`)]))
  }
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = `${f.sha}\u0000${f.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hasObject(sha: string): boolean {
  return / (?:commit|tag)$/.test(git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], sha + '\n').trim())
}

function report(findings: readonly CommitFinding[]): void {
  for (const f of findings) console.log(`commit ${f.sha.slice(0, 8)} の ${f.line} 行目  ${f.text}`)
  if (findings.length === 0) {
    console.log('[コミットメッセージの検査] 英語の文は見つからなかった')
    return
  }
  const commits = new Set(findings.map((f) => f.sha)).size
  console.log(
    `[コミットメッセージの検査] ${commits} 本のコミットに英語の文が ${findings.length} 行ある。` +
      'まだ公開していないので、`git commit --amend`（最後の 1 本）か `git rebase -i` で日本語に書き直してから push すること。' +
      'コマンドやパスはバッククォートで囲めば数えない',
  )
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let findings: CommitFinding[]
  if (args[0] === '--pre-push') {
    findings = scanPrePush(args[1] ?? 'origin', await readStdin())
  } else if (args[0] === '--range' && args.length > 1) {
    findings = scanRevs(args.slice(1))
  } else {
    console.error('使い方: --pre-push <remote> | --range <rev-list の引数…>')
    process.exit(2)
  }
  report(findings)
  process.exit(findings.length === 0 ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[コミットメッセージの検査] 調べられない: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(2)
  })
}
