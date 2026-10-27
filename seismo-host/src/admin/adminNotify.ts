// 管理画面のブラウザ通知に出す中身を決める（#313・2026-10-27 ユーザー承認。文面も同日承認）。
//
// - **知らせるのは 3 つ**: 稼働状況の警告が出た・警告が解消した・揺れを記録した（照合で判定が変わったら書き換える）。
// - **警告の出入りは対象ごとに見る**（`statusWarnings.ts`）。2 枚目の基板が黙ったら、その 1 枚だけを知らせる。
// - **見張りを始めた時点で出ている警告は知らせない。** 開いた画面の稼働状況タブに並んでいるもので、
//   開き直すたびに同じ通知が積もるのを避ける。知らせるのは、見張っている間に起きた出入りだけ。
// - **揺れの記録も同じ。** 見張りを始める前の揺れは、後から照合されても知らせない
//   （2026-10-27 ユーザー承認「出さない」）。見張りの最中の揺れは、押し出しが切れていて記録時の版を
//   受け取り損ねても、後から届いた版で知らせる。
// - **ホストの状態を読めないことも警告として知らせる**（同日ユーザー承認「通知＋通知タブ」）。
//
// ここは通知を出さない（`Notification` を呼ぶのは `notifyWatcher.ts`）。中身を決めるだけ。

import { measuredIntensityToGrade } from '../../../src/utils/measuredIntensity'
import { formatMeasured } from '../../../src/utils/measuredIntensityRounding'
import { VERDICT_LABELS, type ShakeRecordView, type ShakeVerdictView } from './shakeHistory'
import { singleWarning, type StatusWarning } from './statusWarnings'

/** 出す通知 1 つ。`tag` が同じ通知は、ブラウザが前のものを置き換える。 */
export interface AdminNotification {
  readonly title: string
  readonly body: string
  readonly tag: string
}

/** 警告の見出し（2026-10-27 ユーザー承認）。 */
export const WARNING_TITLE = '自作地震計の警告'
/** 解消の見出し（同上）。 */
export const RESOLVED_TITLE = '警告が解消した'

/** 何を知らせるか（警告の出入りに効く 2 つ）。 */
export interface WarningWants {
  readonly warnings: boolean
  readonly resolved: boolean
}

/** 対象 1 つぶんの控え。 */
interface WarningEntry {
  readonly warningKey: string
  readonly head: string
  /** 対象の無い警告では null。 */
  readonly itemKey: string | null
  readonly label: string
  readonly text: string
}

/** いま出ている警告を、対象ごとに引ける形で控えたもの。 */
export type WarningSnapshot = ReadonlyMap<string, WarningEntry>

/** 対象の鍵。警告の鍵と対象の鍵は、どちらも何でも入りうるので JSON で包む。 */
function entryKey(warningKey: string, itemKey: string | null): string {
  return JSON.stringify([warningKey, itemKey])
}

export function snapshotWarnings(warnings: readonly StatusWarning[]): WarningSnapshot {
  const out = new Map<string, WarningEntry>()
  for (const w of warnings) {
    if (w.items.length === 0) {
      out.set(entryKey(w.key, null), { warningKey: w.key, head: w.head, itemKey: null, label: w.label, text: w.text })
      continue
    }
    for (const i of w.items) {
      out.set(entryKey(w.key, i.key), { warningKey: w.key, head: w.head, itemKey: i.key, label: i.label, text: i.text })
    }
  }
  return out
}

/** 同じ警告の対象をまとめて 1 つの通知にする（2 枚が同時に黙ったら 1 つで知らせる）。 */
function grouped(
  entries: readonly WarningEntry[],
  title: string,
  part: (e: WarningEntry) => string,
  tagPrefix: string,
): AdminNotification[] {
  const byWarning = new Map<string, WarningEntry[]>()
  for (const e of entries) {
    const list = byWarning.get(e.warningKey)
    if (list === undefined) byWarning.set(e.warningKey, [e])
    else list.push(e)
  }
  const out: AdminNotification[] = []
  for (const [warningKey, list] of byWarning) {
    const first = list[0]
    if (first === undefined) continue
    // 対象の無い警告は、行そのもの（出たとき）か呼び名（解消したとき）を本文にする。
    const body = first.itemKey === null ? part(first) : `${first.head}: ${list.map(part).join('、')}`
    out.push({ title, body, tag: `${tagPrefix}:${JSON.stringify([warningKey, ...list.map((e) => e.itemKey)])}` })
  }
  return out
}

/**
 * 前の控えと今の警告を比べて、出す通知を返す。**`prev` が null（見張りを始めた最初の 1 回）なら何も出さない。**
 */
export function warningNotifications(
  prev: WarningSnapshot | null,
  next: WarningSnapshot,
  want: WarningWants,
): readonly AdminNotification[] {
  if (prev === null) return []
  const out: AdminNotification[] = []
  if (want.warnings) {
    const appeared = [...next].filter(([k]) => !prev.has(k)).map(([, e]) => e)
    out.push(...grouped(appeared, WARNING_TITLE, (e) => e.text, 'seismo-warning'))
  }
  if (want.resolved) {
    const resolved = [...prev].filter(([k]) => !next.has(k)).map(([, e]) => e)
    out.push(...grouped(resolved, RESOLVED_TITLE, (e) => e.label, 'seismo-resolved'))
  }
  return out
}

/** ホストの状態を読めないことを知らせるまでの、続けて読めなかった回数（5 秒ごとなので 15 秒）。 */
export const HOST_UNREACHABLE_AFTER = 3

/** ホストの状態を読めないときの警告（文言は 2026-10-27 ユーザー承認）。 */
export const HOST_UNREACHABLE_WARNING: StatusWarning = singleWarning('host-unreachable', 'ホストの状態を読めない')

const HOST_UNREACHABLE_ENTRY_KEY = entryKey(HOST_UNREACHABLE_WARNING.key, null)

/**
 * 警告の出入りを見る係。`/status` を読めた回は {@link onStatus}、読めなかった回は {@link onFailure} を呼ぶ。
 *
 * - **読めなかった回は、出ている警告の控えを動かさない**（戻ったときに「解消した」と取り違えない）
 * - **続けて {@link HOST_UNREACHABLE_AFTER} 回読めなければ、「ホストの状態を読めない」を出た警告として控えに足す。**
 *   読めた回に控えから外れるので、「警告が解消した」として知らせる
 * - **一度も読めないまま繋がらなくなったときは、戻った回の警告を「出た」と言わない。** 見張りを始めた最初の 1 回と同じで、
 *   稼働状況タブを開けば並んでいるもの。「ホストの状態を読めない」の解消だけを知らせる
 */
export class WarningTracker {
  private prev: WarningSnapshot | null = null
  /** `prev` が一度でも `/status` から作られたか。 */
  private seenStatus = false
  private failures = 0

  /** ホストの状態を読めないと見なしているか（通知タブの 1 行に使う）。 */
  get hostUnreachable(): boolean {
    return this.prev?.has(HOST_UNREACHABLE_ENTRY_KEY) ?? false
  }

  onStatus(warnings: readonly StatusWarning[], want: WarningWants): readonly AdminNotification[] {
    const next = snapshotWarnings(warnings)
    const out = this.seenStatus
      ? warningNotifications(this.prev, next, want)
      : warningNotifications(this.prev, next, { warnings: false, resolved: want.resolved })
    this.prev = next
    this.seenStatus = true
    this.failures = 0
    return out
  }

  onFailure(want: WarningWants): readonly AdminNotification[] {
    this.failures += 1
    if (this.failures < HOST_UNREACHABLE_AFTER || this.hostUnreachable) return []
    const base = this.prev ?? new Map<string, WarningEntry>()
    const next = new Map(base)
    for (const [k, e] of snapshotWarnings([HOST_UNREACHABLE_WARNING])) next.set(k, e)
    const out = warningNotifications(base, next, want)
    this.prev = next
    return out
  }
}

/** 揺れの記録の、通知に要る控え（版と判定）。 */
export interface ShakeSeenEntry {
  readonly rev: number
  readonly verdict: ShakeVerdictView
  /** 見張りを始める前に始まった揺れか（どの版が届いても知らせない）。 */
  readonly beforeWatch: boolean
}

/** 揺れの記録の本文（例「最大 震度2（計測 1.8）・地震（石川県能登地方 M4.2）」。2026-10-27 ユーザー承認）。 */
export function shakeBody(r: ShakeRecordView): string {
  const verdict = VERDICT_LABELS[r.verdict]
  const q = r.matchedQuake
  const judged =
    q === null ? verdict : `${verdict}（${q.magnitude === null ? q.name : `${q.name} M${q.magnitude.toFixed(1)}`}）`
  // 上下動を測れなかった揺れは震度を持たない。無い値を「—」で埋めず、判定だけを言う。
  const grade = r.maxIntensity === null ? null : measuredIntensityToGrade(r.maxIntensity)
  if (r.maxIntensity === null || grade === null) return judged
  return `最大 震度${grade.label}（計測 ${formatMeasured(r.maxIntensity)}）・${judged}`
}

/** 判定を覚えておく揺れの数。届いた順に古いものから忘れる（忘れた記録の新しい版は、知らせ直すだけで済む）。 */
export const SHAKE_SEEN_MAX = 500

/**
 * 揺れの記録の版を覚えて、出す通知を決める係。
 *
 * - **初めて見た記録（版 1）と、判定が変わった版だけ知らせる。** 照合後の通知は記録時と同じ `tag` で出す（ブラウザが置き換える）
 * - **前に見た版より古い版は捨てる**（届く順が入れ替わっても、照合後の通知を古い内容へ戻さない）
 * - **見張りを始める前に始まった揺れは、控えるだけで知らせない**（照合後の版が後から届いても、その後に判定が変わっても）。
 *   ただし控えの上限で忘れた後に届いた版は、初めて見た記録として揺れの始まりの時刻で見分け直す。
 *   見るのは版の番号ではなく揺れの始まりの時刻 —— 版で見分けると、押し出しが切れていた間に記録された揺れの
 *   照合後の版まで「開く前の記録」に見えて、見張りの最中の揺れを黙って落とす
 */
export class ShakeTracker {
  private readonly seen = new Map<string, ShakeSeenEntry>()

  /** @param startedAtMs 見張りを始めた時刻。これより前に始まった揺れは知らせない。 */
  constructor(private readonly startedAtMs: number) {}

  onRecord(r: ShakeRecordView): AdminNotification | null {
    const before = this.seen.get(r.id)
    if (before !== undefined && r.rev <= before.rev) return null
    const beforeWatch = before?.beforeWatch ?? r.startMs < this.startedAtMs
    this.seen.delete(r.id)
    this.seen.set(r.id, { rev: r.rev, verdict: r.verdict, beforeWatch })
    if (this.seen.size > SHAKE_SEEN_MAX) {
      const oldest = this.seen.keys().next()
      if (oldest.done !== true) this.seen.delete(oldest.value)
    }
    if (beforeWatch || (before !== undefined && before.verdict === r.verdict)) return null
    return { title: `揺れを記録: ${r.stationId}`, body: shakeBody(r), tag: `seismo-shake:${r.id}` }
  }
}
