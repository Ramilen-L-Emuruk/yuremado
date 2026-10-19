import type { EewOrigin } from '../types/earthquake'
import { log } from './logger'

const EEW_ORIGINS: ReadonlySet<string> = new Set<EewOrigin>(['dmdata', 'p2pquake', 'yahoo', 'archive', 'test'])

/**
 * 保存しておいた JSON（ローカル履歴アーカイブ・テストシナリオ）から読んだ積荷に、緊急地震速報の
 * 出どころ（`EEWAlert.origin`）を補う。
 *
 * **型では必須の欄だが、保存データは出どころの欄ができる前に作られている。** 読み込みの検証で
 * 補わないと、型を信じた統合（`mergeEewReport`）が `undefined` を経路として扱うことになる。
 * 既に入っている正しい値は上書きしない。**知らない値（手で書いた JSON の綴り違いなど）は記録して
 * 置き換える** —— 残すと台帳（`EewAcceptance`）がその値を別の経路として数え、同じ報を新しい報と見なす。
 */
export function withStoredEewOrigin<T>(payload: T, origin: EewOrigin): T {
  const p = payload as { kind?: unknown; event?: { kind?: unknown; origin?: unknown; id?: unknown } }
  if (p.kind !== 'event' || !p.event || p.event.kind !== 'eew') return payload
  const stored = p.event.origin
  if (typeof stored === 'string' && EEW_ORIGINS.has(stored)) return payload
  if (stored !== undefined) {
    log.warn(`[eew] 保存データの出どころ（origin）が読めないため "${origin}" で置き換えます: origin=${JSON.stringify(stored)} id=${String(p.event.id)}`)
  }
  return { ...payload, event: { ...p.event, origin } } as T
}
