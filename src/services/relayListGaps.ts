/**
 * 中継が見ていない区間（docs/relay-server-design.md §0 の「見ていない時間があった日」の行・§6 の電文一覧）。
 *
 * 中継の電文一覧は、語る範囲（`gapsSpan`）のうち中継が見ていない区間を区分ごとに `gaps` で返す。索引から作る一覧は
 * 欠けのある日も欠けの無い日と同じ形で返るので、この印が無いと「電文が無かった」と見分けが付かない。
 * 地震タブの帯（文面は段 3b-e で諮る）はこの帳面を読む。
 *
 * **観測した範囲の中は、いちばん新しい答えで置き換える。** 突き合わせが済んだ区間は次の応答から消えるので、
 * 足していくだけにすると済んだ印が残り続ける。範囲の外で前に見た印は残す。
 */

/** 見ていない区間 1 つ（区分ごと） */
export interface RelayListGap {
  readonly classification: string
  readonly fromMs: number
  readonly toMs: number
}

/** 一覧の応答 1 回が語ったこと */
export interface RelayListGaps {
  readonly span: { readonly fromMs: number; readonly toMs: number }
  readonly gaps: readonly RelayListGap[]
}

/**
 * 一覧の応答から見ていない区間を読む。`gapsSpan` が無い・読めない応答（DMDATA の一覧）は `null`。
 * 読めない区間は捨てずに範囲いっぱいの欠けとして扱う —— 黙って捨てると、見ていない時間が「見た」に化ける。
 */
export function parseRelayListGaps(json: unknown): RelayListGaps | null {
  if (typeof json !== 'object' || json === null) return null
  const body = json as { gapsSpan?: { from?: unknown; to?: unknown }; gaps?: unknown }
  const fromMs = typeof body.gapsSpan?.from === 'string' ? Date.parse(body.gapsSpan.from) : Number.NaN
  const toMs = typeof body.gapsSpan?.to === 'string' ? Date.parse(body.gapsSpan.to) : Number.NaN
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return null
  const span = { fromMs, toMs }
  const raw = Array.isArray(body.gaps) ? body.gaps : []
  const gaps: RelayListGap[] = []
  for (const g of raw as { classification?: unknown; from?: unknown; to?: unknown }[]) {
    const classification = typeof g?.classification === 'string' && g.classification !== '' ? g.classification : 'unknown'
    const from = typeof g?.from === 'string' ? Date.parse(g.from) : Number.NaN
    const to = typeof g?.to === 'string' ? Date.parse(g.to) : Number.NaN
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      gaps.push({ classification, fromMs: Math.max(from, fromMs), toMs: Math.min(to, toMs) })
    } else {
      gaps.push({ classification, fromMs, toMs })
    }
  }
  return { span, gaps: gaps.filter(g => g.fromMs < g.toMs) }
}

export interface RelayGapStore {
  /** 一覧の応答 1 回の答えを取り込む */
  note(observed: RelayListGaps): void
  /** いま分かっている見ていない区間（区分・始まりの順） */
  snapshot(): readonly RelayListGap[]
  /** 変わったら呼ぶ。返り値で外す */
  subscribe(listener: () => void): () => void
}

/** 区間 `g` から範囲 `[fromMs, toMs)` を抜いた残り（0〜2 個） */
function subtract(g: RelayListGap, fromMs: number, toMs: number): RelayListGap[] {
  if (g.toMs <= fromMs || g.fromMs >= toMs) return [g]
  const rest: RelayListGap[] = []
  if (g.fromMs < fromMs) rest.push({ ...g, toMs: fromMs })
  if (g.toMs > toMs) rest.push({ ...g, fromMs: toMs })
  return rest
}

function sameGaps(a: readonly RelayListGap[], b: readonly RelayListGap[]): boolean {
  return a.length === b.length && a.every((g, i) =>
    g.classification === b[i].classification && g.fromMs === b[i].fromMs && g.toMs === b[i].toMs)
}

export function createRelayGapStore(): RelayGapStore {
  let gaps: readonly RelayListGap[] = []
  const listeners = new Set<() => void>()
  return {
    note({ span, gaps: observed }) {
      const kept = gaps.flatMap(g => subtract(g, span.fromMs, span.toMs))
      const next = [...kept, ...observed].sort((a, b) =>
        a.classification === b.classification ? a.fromMs - b.fromMs : a.classification < b.classification ? -1 : 1)
      if (sameGaps(next, gaps)) return
      gaps = next
      for (const listener of listeners) listener()
    },
    snapshot: () => gaps,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
