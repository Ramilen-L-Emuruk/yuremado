// 取消の通知のための「発表を通知したか」の記憶（長周期・地震回数・南海トラフ地震関連解説情報・地震・津波に関するお知らせ）を
// 端末に保つ（2026-11-09 ユーザー選択「端末に保存＋出したときだけ覚える (Recommended)」）。メモリだけだと、毎朝の定期の
// 読み直し・版の更新で消え、通知した発表の取消が出なくなる。保存は localStorage（閉じた帯の記録と同じ置き方）。
//
// **同じ端末で開いた複数のタブが 1 つの保存値を共有する。** 各タブは起動時に読んだ記憶を持つので、全量で上書きすると
// 後から書いたタブの分しか残らない。保存の直前に読み直し、ほかのタブが足した鍵を合わせてから書く。このタブで消した鍵
// （取消を通知した発表）は、合わせるときに生き返らせない。
import type { SpecialInfoGate } from './specialInfoPush'
import { log } from './logger'

/** 保存先の localStorage のキー */
export const NOTIFIED_SPECIAL_INFO_KEY = 'notified-special-info'

/** 覚える件数の上限。超えたら古いものから捨てる（全期間の控えで、覆う種類の発表は年に最大 38 件） */
export const NOTIFIED_SPECIAL_INFO_MAX = 200

export interface NotifiedSpecialInfo {
  /** 鍵（`<種別>:<識別子>`）→ 発表を通知したときの設定。挿入順が古い順 */
  readonly gates: Map<string, SpecialInfoGate>
  /** 長周期の EventID → 発表で読んだ震央地名（取消の通知で地名を言うため） */
  readonly lpgmNames: Map<string, string>
  /** このタブで消した鍵（ほかのタブの保存値と合わせるときに生き返らせない） */
  readonly removedGates: Set<string>
  readonly removedLpgmNames: Set<string>
}

interface Stored {
  gates: [string, SpecialInfoGate][]
  lpgmNames: [string, string][]
}

function isGate(v: unknown): v is SpecialInfoGate {
  return typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string'
}

function emptyMemory(): NotifiedSpecialInfo {
  return { gates: new Map(), lpgmNames: new Map(), removedGates: new Set(), removedLpgmNames: new Set() }
}

/** 保存値を読む。読めなければ null（記録に残す）。形の合わない項目は捨て、捨てた件数を記録に残す */
function readStored(): Pick<NotifiedSpecialInfo, 'gates' | 'lpgmNames'> | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(NOTIFIED_SPECIAL_INFO_KEY)
  } catch (e) {
    log.warn('[notify] 通知した特別な情報の記憶を読めない（取消の通知が出ないことがある）', e)
    return null
  }
  if (!raw) return { gates: new Map(), lpgmNames: new Map() }
  let parsed: Partial<Stored> | null
  try {
    parsed = JSON.parse(raw) as Partial<Stored> | null
  } catch (e) {
    log.warn(`[notify] 通知した特別な情報の記憶が壊れているので、空から始める（${raw.length} 文字。取消の通知が出ないことがある）`, e)
    return null
  }
  const gates = new Map<string, SpecialInfoGate>()
  const lpgmNames = new Map<string, string>()
  let dropped = 0
  for (const e of Array.isArray(parsed?.gates) ? parsed.gates : []) {
    if (Array.isArray(e) && typeof e[0] === 'string' && isGate(e[1])) gates.set(e[0], e[1])
    else dropped++
  }
  for (const e of Array.isArray(parsed?.lpgmNames) ? parsed.lpgmNames : []) {
    if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') lpgmNames.set(e[0], e[1])
    else dropped++
  }
  if (dropped > 0) log.warn(`[notify] 通知した特別な情報の記憶のうち、形の合わない ${dropped} 件を捨てた`)
  return { gates, lpgmNames }
}

/** 保存された記憶を読む。読めなければ空 */
export function loadNotifiedSpecialInfo(): NotifiedSpecialInfo {
  const stored = readStored()
  const memory = emptyMemory()
  if (!stored) return memory
  for (const [k, v] of stored.gates) memory.gates.set(k, v)
  for (const [k, v] of stored.lpgmNames) memory.lpgmNames.set(k, v)
  return memory
}

/** 上限を超えた分を古い順に捨てる（Map は挿入順） */
function trim<V>(map: Map<string, V>): void {
  while (map.size > NOTIFIED_SPECIAL_INFO_MAX) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** ほかのタブが足した鍵を、このタブの記憶の前（古い側）へ合わせる。このタブで消した鍵は足さない */
function mergeOthers<V>(mine: Map<string, V>, others: Map<string, V>, removed: Set<string>): void {
  const added = [...others].filter(([k]) => !mine.has(k) && !removed.has(k))
  if (added.length === 0) return
  const merged = [...added, ...mine]
  mine.clear()
  for (const [k, v] of merged) mine.set(k, v)
}

// 保存の失敗は 1 回だけ warn にする（容量超過やプライベートモードでは毎回失敗するので、同じ記録で埋めない）
let saveFailureReported = false

/** 記憶を保存する。保存できない環境（プライベートモード・容量超過）でも、この場の記憶は使い続ける（記録に残す） */
export function saveNotifiedSpecialInfo(memory: NotifiedSpecialInfo): void {
  const stored = readStored()
  if (stored) {
    mergeOthers(memory.gates, stored.gates, memory.removedGates)
    mergeOthers(memory.lpgmNames, stored.lpgmNames, memory.removedLpgmNames)
  }
  trim(memory.gates)
  trim(memory.lpgmNames)
  try {
    const out: Stored = { gates: [...memory.gates], lpgmNames: [...memory.lpgmNames] }
    localStorage.setItem(NOTIFIED_SPECIAL_INFO_KEY, JSON.stringify(out))
  } catch (e) {
    if (!saveFailureReported) {
      saveFailureReported = true
      log.warn('[notify] 通知した特別な情報の記憶を保存できない（この場の記憶だけで続ける。読み直すと取消の通知が出ないことがある）', e)
    } else {
      log.debug('[notify] 通知した特別な情報の記憶を保存できない（続けて失敗）', e)
    }
  }
}

/** 発表を通知したことを覚える（同じ鍵は新しい側へ寄せる）。長周期なら地名も一緒に覚える。保存までする */
export function rememberNotifiedSpecialInfo(memory: NotifiedSpecialInfo, key: string, gate: SpecialInfoGate, lpgm?: { eventId: string; name: string }): void {
  memory.gates.delete(key)
  memory.gates.set(key, gate)
  memory.removedGates.delete(key)
  if (lpgm) {
    memory.lpgmNames.delete(lpgm.eventId)
    memory.lpgmNames.set(lpgm.eventId, lpgm.name)
    memory.removedLpgmNames.delete(lpgm.eventId)
  }
  saveNotifiedSpecialInfo(memory)
}

/** 取消を通知した発表を忘れる（長周期なら地名も）。保存までする。どちらも覚えていなければ何もしない */
export function forgetNotifiedSpecialInfo(memory: NotifiedSpecialInfo, key: string | undefined, lpgmEventId?: string): void {
  let changed = false
  if (key !== undefined) {
    changed = memory.gates.delete(key) || changed
    memory.removedGates.add(key)
  }
  if (lpgmEventId !== undefined) {
    changed = memory.lpgmNames.delete(lpgmEventId) || changed
    memory.removedLpgmNames.add(lpgmEventId)
  }
  if (changed) saveNotifiedSpecialInfo(memory)
}

/** テスト用: 保存失敗の記録の間引きを戻す */
export function resetNotifiedSpecialInfoStoreForTest(): void {
  saveFailureReported = false
}
