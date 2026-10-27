/**
 * **鏡像の見張りの係**（#1084）。揺れの記録が 1 件閉じるたびに（初版 `rev === 1` だけ）、その区間の生データを
 * 読み返し、同じ観測点の 2 軸のセンサーだけの基板それぞれに 1 票を入れる（`boardMirrorWindow.ts`）。
 *
 * - 票は基板ごとに**最近の `MIRROR_KEEP_VOTES` 票**まで持ち、JSON で残す（ホストを起動し直しても数え直さない ——
 *   票になる揺れは実機で 3〜4 日に 1 つしか来ないので、配布のたびに消えると永久に警告へ届かない）
 * - **校正値（基板の向きと各軸）を変えたら、その基板の票は捨てる** —— 6 面法をやり直した後に、前の向きの票で
 *   警告しない（指紋 `calibrationFingerprint`）
 * - 区間の設定は当時のもの（`configThrough`）。区間の中で設定が変わった・履歴を読めていないなら票にしない
 *
 * 1 件ずつ順に回す（揺れが続けて閉じても、読み返しを重ねない）。投げない。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ShakeEventRecord } from '../detection/shakeEvent'
import { lockTolerantRename } from './lockTolerantRename'
import { mirrorVerdict, voteOf, type MirrorVerdict, type MirrorVote } from './boardMirrorWatch'
import { compareBoardsInWindow } from './boardMirrorWindow'
import { readMseedRange, RECORD_SPAN_MAX_MS } from './mseedPacketReader'
import type { SensorPacket } from '../protocol/types'
import type { StationConfig } from './stationConfig'
import type { BoardKey } from '../protocol/types'
import type { BoardEntry } from './stationConfigTypes'

/** 基板ごとに残す票の数（最近の分だけで判じる。実機のペースでおよそ 1 か月）。 */
export const MIRROR_KEEP_VOTES = 10

/** 揺れの区間の前後に足して読む余白（帯域の切り出しの端で欠ける分）。 */
const MARGIN_MS = 5_000

const HOUR_MS = 60 * 60 * 1000

export interface MirrorVoteEntry {
  readonly atMs: number
  readonly vote: MirrorVote
  readonly current: number
  readonly mirrored: number
}

export interface MirrorBoardBook {
  readonly fingerprint: string
  readonly votes: readonly MirrorVoteEntry[]
}

/** 残す形。 */
export interface MirrorVoteBook {
  readonly version: 1
  readonly boards: Readonly<Record<string, MirrorBoardBook>>
}

export const EMPTY_MIRROR_VOTE_BOOK: MirrorVoteBook = { version: 1, boards: {} }

/** 票を捨てる契機になる、基板の校正値の指紋。 */
export function calibrationFingerprint(board: BoardEntry): string {
  return JSON.stringify({
    o: board.orientation,
    s: board.sensors.map((s) => ({ id: s.sensorId, a: s.axes.map((a) => a.vector) })),
  })
}

/** 読み戻した結果。`dropped*` は形が合わず捨てた基板と票の数、`unknownShape` は全体の形・版が読めなかった。 */
export interface MirrorVoteBookParse {
  readonly book: MirrorVoteBook
  readonly unknownShape: boolean
  readonly droppedBoards: number
  readonly droppedVotes: number
}

/** 読み戻した JSON を検める。形の合わない基板・票は捨てる（票が無いのと同じに倒れる）。捨てた数を返す。 */
export function parseMirrorVoteBookDetailed(raw: unknown): MirrorVoteBookParse {
  const unknownShape: MirrorVoteBookParse = { book: EMPTY_MIRROR_VOTE_BOOK, unknownShape: true, droppedBoards: 0, droppedVotes: 0 }
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) return unknownShape
  const boards: Record<string, MirrorBoardBook> = {}
  const src = (raw as { boards?: unknown }).boards
  if (typeof src !== 'object' || src === null) return unknownShape
  let droppedBoards = 0
  let droppedVotes = 0
  for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
    const v = value as { fingerprint?: unknown; votes?: unknown }
    if (typeof v?.fingerprint !== 'string' || !Array.isArray(v.votes)) {
      droppedBoards++
      continue
    }
    const votes = v.votes.filter(
      (e): e is MirrorVoteEntry =>
        typeof e === 'object' &&
        e !== null &&
        Number.isFinite((e as MirrorVoteEntry).atMs) &&
        ((e as MirrorVoteEntry).vote === 'mirrored' || (e as MirrorVoteEntry).vote === 'ok') &&
        Number.isFinite((e as MirrorVoteEntry).current) &&
        Number.isFinite((e as MirrorVoteEntry).mirrored),
    )
    droppedVotes += v.votes.length - votes.length
    boards[key] = { fingerprint: v.fingerprint, votes: votes.slice(-MIRROR_KEEP_VOTES) }
  }
  return { book: { version: 1, boards }, unknownShape: false, droppedBoards, droppedVotes }
}

/** {@link parseMirrorVoteBookDetailed} の本だけを返す形。 */
export function parseMirrorVoteBook(raw: unknown): MirrorVoteBook {
  return parseMirrorVoteBookDetailed(raw).book
}

/**
 * 残した票を読む。**無い・読めない・壊れていれば空から始める**（票が無いのと同じ）。何かあれば `problem` に理由。
 *
 * **中身が読めない・版が違うときは、元のファイルを `<名前>.unreadable-<時刻>` へ退避する** —— 次の票の
 * 保存で上書きすると、何が入っていたかを確かめる手立てが無くなる（票は 3〜4 日に 1 つしか来ない）。
 */
export async function readMirrorVoteBookFile(
  path: string,
  nowMs: number = Date.now(),
): Promise<{ book: MirrorVoteBook; problem: string | null }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { book: EMPTY_MIRROR_VOTE_BOOK, problem: null }
    return { book: EMPTY_MIRROR_VOTE_BOOK, problem: error instanceof Error ? error.message : String(error) }
  }
  let parsed: MirrorVoteBookParse | null
  try {
    parsed = parseMirrorVoteBookDetailed(JSON.parse(text))
  } catch {
    parsed = null
  }
  if (parsed === null || parsed.unknownShape) {
    const aside = `${path}.unreadable-${nowMs}`
    const why = parsed === null ? '中身が JSON として読めない' : '形か版が読めない'
    try {
      await rename(path, aside)
      return { book: EMPTY_MIRROR_VOTE_BOOK, problem: `${why}（元のファイルは ${aside} へ退避した）` }
    } catch (error) {
      return {
        book: EMPTY_MIRROR_VOTE_BOOK,
        problem: `${why}（退避もできず、次の保存で上書きされる: ${error instanceof Error ? error.message : String(error)}）`,
      }
    }
  }
  if (parsed.droppedBoards > 0 || parsed.droppedVotes > 0) {
    return { book: parsed.book, problem: `形の合わない基板 ${parsed.droppedBoards} 枚・票 ${parsed.droppedVotes} 件を捨てた` }
  }
  return { book: parsed.book, problem: null }
}

/** 票を残す。**書き切ってから改名する**（途中で落ちても半端な中身は残らない）。 */
export async function writeMirrorVoteBookFile(path: string, book: MirrorVoteBook): Promise<void> {
  const temp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, JSON.stringify(book))
  await lockTolerantRename(temp, path)
}

/** 鏡像の疑いがある基板（`/status` の欄）。 */
export interface MirrorSuspect {
  readonly boardKey: BoardKey
  readonly mirrored: number
  readonly ok: number
}

/** いまの設定に照らして、警告する基板を選ぶ（指紋の合わない票は数えない）。 */
export function mirrorSuspects(book: MirrorVoteBook, config: StationConfig): MirrorSuspect[] {
  const out: MirrorSuspect[] = []
  for (const board of config.boards) {
    const entry = book.boards[board.boardKey]
    if (entry === undefined || entry.fingerprint !== calibrationFingerprint(board)) continue
    const v: MirrorVerdict = mirrorVerdict(entry.votes.map((e) => e.vote))
    if (v.warn) out.push({ boardKey: board.boardKey, mirrored: v.mirrored, ok: v.ok })
  }
  return out
}

/** 見張っている基板 1 枚ぶんの様子（`/status` の欄）。票はいまの校正値の指紋に合う分だけ数える。 */
export interface MirrorWatchRow {
  readonly boardKey: BoardKey
  readonly mirrored: number
  readonly ok: number
  /** 最後に票を入れた揺れの始まり。まだ無ければ null。 */
  readonly lastVoteMs: number | null
}

/** 2 軸のセンサーだけの基板で、同じ観測点に比べる相手（有効な 3 軸のセンサー）があるか。 */
function isWatched(board: BoardEntry, config: StationConfig): boolean {
  if (board.sensors.length === 0 || !board.sensors.every((s) => s.axes.length === 2)) return false
  return config.boards.some((b) => b.stationId === board.stationId && b.sensors.some((s) => s.enabled && s.axes.length === 3))
}

/**
 * いまの設定で見張っている基板ごとの票（2026-10-27 ユーザー承認「稼働状況に出す」）。**票が 1 つも無い基板も
 * 載せる** —— 見張りが止まっているのと疑いが無いのを、画面から見分けるため。
 */
export function mirrorWatchRows(book: MirrorVoteBook, config: StationConfig): MirrorWatchRow[] {
  return config.boards
    .filter((b) => isWatched(b, config))
    .map((board) => {
      const entry = book.boards[board.boardKey]
      const votes = entry !== undefined && entry.fingerprint === calibrationFingerprint(board) ? entry.votes : []
      const mirrored = votes.filter((v) => v.vote === 'mirrored').length
      return {
        boardKey: board.boardKey,
        mirrored,
        ok: votes.length - mirrored,
        lastVoteMs: votes.length > 0 ? votes[votes.length - 1]!.atMs : null,
      }
    })
}

/**
 * 生データの `[fromMs, toMs]` のパケットを読む（書き手が溜めた分を吐き出してから、時の本を順に読む）。
 * 吐き出せなければ null。時の本が 1 冊も無ければ空。
 */
export async function readRawPacketsBetween(
  flush: () => Promise<boolean>,
  readHour: (atMs: number) => Promise<Uint8Array | null>,
  fromMs: number,
  toMs: number,
): Promise<SensorPacket[] | null> {
  if (!(await flush())) return null
  const packets: SensorPacket[] = []
  // レコードは自分の先頭の時刻が属する時の本へ入るので、区間の手前の本も見る（`rewaveRunner.ts` と同じ）。
  const firstHour = Math.floor((fromMs - RECORD_SPAN_MAX_MS) / HOUR_MS) * HOUR_MS
  for (let at = firstHour; at < toMs; at += HOUR_MS) {
    const buf = await readHour(at)
    if (buf === null) continue
    for (const p of readMseedRange(buf, fromMs, toMs).packets) packets.push(p.packet)
  }
  return packets
}

export interface BoardMirrorRunnerDeps {
  readonly configThrough: (fromMs: number, toMs: number) => StationConfig | 'changed' | null
  /** `readRawPacketsBetween` を渡す。吐き出せなければ null。 */
  readonly readPackets: (fromMs: number, toMs: number) => Promise<SensorPacket[] | null>
  /** 起動時に残しておいた票。 */
  readonly initial: MirrorVoteBook
  /** 票が変わったら残す。投げてよい（`onEvent` へ失敗として出す）。 */
  readonly save: (book: MirrorVoteBook) => Promise<void>
  readonly onEvent: (event: BoardMirrorEvent) => void
}

/**
 * 票にしなかった理由。
 * - `config-changed`: 区間の中で設定が変わった／設定の履歴を読めていない
 * - `no-history`: 生データの書き手が溜めた分を書き終えられなかった
 * - `no-packets`: 区間に生データが 1 つも無い
 * - `no-reference`: 同じ観測点の 3 軸のセンサーの揺れが区間に無い（設定に無い・届いていない・校正が解けない）
 * - `no-board-packets`: その基板の生データが区間に無い
 * - `not-decisive`: 比べたが、揃った目盛りが足りない・相関が弱い・軸が 3 方向へ散っていない
 */
export type MirrorSkipReason =
  | 'config-unread'
  | 'config-changed'
  | 'stale-calibration'
  | 'no-history' | 'no-packets' | 'no-reference' | 'no-board-packets' | 'not-decisive'

export type BoardMirrorEvent =
  | { readonly kind: 'voted'; readonly boardKey: BoardKey; readonly vote: MirrorVote; readonly current: number; readonly mirrored: number }
  | {
      readonly kind: 'skipped'
      readonly reason: MirrorSkipReason
      readonly stationId: string
      /** 基板ごとの理由（`no-board-packets`・`not-decisive`）のときだけ。 */
      readonly boardKey?: BoardKey
      readonly comparison?: { readonly current: number; readonly mirrored: number; readonly aligned: number }
    }
  /** 校正値が変わったので、その基板の前の票を捨てた。 */
  | { readonly kind: 'reset'; readonly boardKey: BoardKey; readonly dropped: number }
  | { readonly kind: 'failed'; readonly stage: 'run' | 'save'; readonly detail: string }

export class BoardMirrorRunner {
  private book: MirrorVoteBook
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BoardMirrorRunnerDeps) {
    this.book = deps.initial
  }

  get votes(): MirrorVoteBook {
    return this.book
  }

  /** 揺れの記録を受ける（初版だけ）。終わりを待たずに返る。 */
  onShake(rec: ShakeEventRecord): void {
    if (rec.rev !== 1) return
    this.chain = this.chain.then(() => this.run(rec)).catch((error: unknown) => {
      this.emit({ kind: 'failed', stage: 'run', detail: error instanceof Error ? error.message : String(error) })
    })
  }

  /**
   * 知らせを渡す。**知らせる側が投げても列を止めない** —— `catch` の中で投げ直すと、以後の揺れが
   * 1 件も回らなくなる。知らせる口そのものが壊れているので、ここで拾った例外を伝える先は無い。
   */
  private emit(event: BoardMirrorEvent): void {
    try {
      this.deps.onEvent(event)
    } catch {
      // 上のとおり、伝える先が無い。
    }
  }

  /** テスト・締めくくり用: 積んだ分を回し終えるまで待つ。 */
  idle(): Promise<void> {
    return this.chain
  }

  private async run(rec: ShakeEventRecord): Promise<void> {
    const stationId = rec.stationId
    const config = this.deps.configThrough(rec.startMs, rec.endMs)
    // **読めていないのと、区間の中で変わったのは分けて知らせる**（前者は設定の履歴の不調の兆し）。
    if (config === null) {
      this.emit({ kind: 'skipped', reason: 'config-unread', stationId })
      return
    }
    if (config === 'changed') {
      this.emit({ kind: 'skipped', reason: 'config-changed', stationId })
      return
    }
    const targets = config.boards.filter(
      (b) => b.stationId === stationId && b.sensors.length > 0 && b.sensors.every((s) => s.axes.length === 2),
    )
    // 見張る基板の無い観測点では何も知らせない（揺れのほとんどはこれ）。
    if (targets.length === 0) return
    // 比べる相手が設定に無いなら、生データを読む前に抜ける（読むと時の本を丸ごと読む）。
    const hasReference = config.boards.some(
      (b) => b.stationId === stationId && b.sensors.some((s) => s.enabled && s.axes.length === 3),
    )
    if (!hasReference) {
      this.emit({ kind: 'skipped', reason: 'no-reference', stationId })
      return
    }
    const fromMs = rec.startMs - MARGIN_MS
    const toMs = rec.endMs + MARGIN_MS
    const packets = await this.deps.readPackets(fromMs, toMs)
    if (packets === null) {
      this.emit({ kind: 'skipped', reason: 'no-history', stationId })
      return
    }
    if (packets.length === 0) {
      this.emit({ kind: 'skipped', reason: 'no-packets', stationId })
      return
    }
    const results = compareBoardsInWindow({ stationId, fromMs, toMs, packets, config })
    if (results.length === 0) {
      this.emit({ kind: 'skipped', reason: 'no-reference', stationId })
      return
    }
    for (const t of targets) {
      if (!results.some((r) => r.boardKey === t.boardKey)) {
        this.emit({ kind: 'skipped', reason: 'no-board-packets', stationId, boardKey: t.boardKey })
      }
    }
    let changed = false
    const boards = { ...this.book.boards }
    for (const r of results) {
      const vote = voteOf(r.comparison)
      if (vote === null) {
        this.emit({ kind: 'skipped', reason: 'not-decisive', stationId, boardKey: r.boardKey, comparison: r.comparison })
        continue
      }
      const board = config.boards.find((b) => b.boardKey === r.boardKey)!
      const fingerprint = calibrationFingerprint(board)
      const prev = boards[r.boardKey]
      const sameCalibration = prev !== undefined && prev.fingerprint === fingerprint
      // **区間より新しい揺れの票が別の校正値で入っていれば、古い区間の票で上書きしない**（校正を直した直後に、
      // 直す前の揺れが遅れて回ってきた形。上書きすると新しい校正値の票が消える）。
      const latest = prev?.votes.at(-1)
      if (!sameCalibration && latest !== undefined && latest.atMs > rec.startMs) {
        this.emit({ kind: 'skipped', reason: 'stale-calibration', stationId, boardKey: r.boardKey })
        continue
      }
      if (prev !== undefined && !sameCalibration && prev.votes.length > 0) {
        this.emit({ kind: 'reset', boardKey: r.boardKey, dropped: prev.votes.length })
      }
      const kept = sameCalibration ? prev.votes : []
      const entry: MirrorVoteEntry = { atMs: rec.startMs, vote, current: r.comparison.current, mirrored: r.comparison.mirrored }
      boards[r.boardKey] = { fingerprint, votes: [...kept, entry].slice(-MIRROR_KEEP_VOTES) }
      changed = true
      this.emit({ kind: 'voted', boardKey: r.boardKey, vote, current: entry.current, mirrored: entry.mirrored })
    }
    if (!changed) return
    this.book = { version: 1, boards }
    try {
      await this.deps.save(this.book)
    } catch (error) {
      this.emit({ kind: 'failed', stage: 'save', detail: `票を残せず: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
}
