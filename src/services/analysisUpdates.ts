// 解析の答えが変わった地震の知らせ（中継の `relay-analysis-updated`）と、見張りを回した知らせ（`relay-analysis-checked`）
// （docs/relay-server-design.md §6.8「端末へ知らせる」）。
// 中継の WebSocket（dmdata.ts）が受けてここへ流し、開いている地震カード（useQuakeAnalysis）がその地震のときだけ問い合わせ直す。
// 知らせは繋いでいる全員へ届くので、カードを開いていない地震の分はここで誰にも渡さずに捨てる。

type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

/** EventID の地震の解析が変わったら呼ばれるようにする。戻り値で外す */
export function subscribeAnalysisUpdated(eventId: string, listener: Listener): () => void {
  let set = listeners.get(eventId)
  if (!set) {
    set = new Set()
    listeners.set(eventId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(eventId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(eventId)
  }
}

/** 中継の知らせの本文から EventID を取り出す。形が違えば null */
export function readAnalysisUpdated(msg: Record<string, unknown>): string[] | null {
  const ids = msg.eventIds
  if (!Array.isArray(ids) || ids.length === 0) return null
  if (!ids.every((id): id is string => typeof id === 'string' && /^\d{14}$/.test(id))) return null
  return ids
}

/**
 * 見張りを回した知らせ（`relay-analysis-checked`）から、開いているカードが訊き直すまでの間をばらす幅（ms）。
 * 知らせは全員へ同時に届くので、ばらさないと開いている端末の問い合わせが中継へ一度に集まる
 */
export const ANALYSIS_CHECKED_SPREAD_MS = 30_000

/**
 * 見張りを回した知らせを、開いているカードすべてへ渡す（中身が変わらない確かめでも「確かめた時刻」を新しくするため）。
 * カードごとに `delayMs()` だけ待ってから渡し、その間に閉じたカードには渡さない
 */
export function publishAnalysisChecked(delayMs: () => number = () => Math.random() * ANALYSIS_CHECKED_SPREAD_MS): void {
  for (const [id, set] of listeners) {
    for (const listener of set) {
      setTimeout(() => {
        if (listeners.get(id)?.has(listener)) listener()
      }, delayMs())
    }
  }
}

/** 知らせを、その地震を待っているカードへ渡す */
export function publishAnalysisUpdated(eventIds: readonly string[]): void {
  for (const id of new Set(eventIds)) {
    const set = listeners.get(id)
    if (!set) continue
    for (const listener of [...set]) listener()
  }
}
