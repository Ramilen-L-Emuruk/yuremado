// 自作地震計の観測点ごとに、**最後に測れた静かさ**（gal）を端末へ控える。
//
// 静かさを測れない間（ホストの起動直後・0 の手前に記録が無い地震・繋いだ直後の 10 秒）は、縦の下限を
// 決め打ちの値（`utils/seismoQuietScale.ts` の `QUIET_SCALE_FALLBACK_GAL`。普段の下限の約 17 倍）にしていた。
// 静かな絵が平らに見えるだけでなく、小さな揺れまで平らに潰れる。**測れた値があるなら、それを使う**
// （2026-10-24 ユーザー選択「アプリが最後に測った値 (Recommended)」）。一度も測れていない観測点だけ決め打ちへ倒す。
//
// **ホストからは取れない。** `/status` の「普段」は計測震度だけで、静かさを gal では返していない。
//
// **新しいデータ時刻の測り値だけで書き換える。** 地震カードは過去の地震の 0 の手前で測るので、古いカードを開いた
// だけで最近の値が昔の値に戻らないようにする。

import { serverNow } from './clock'
import { log } from './logger'
import { QUIET_LEVEL_MIN_GAL } from './seismoQuietScale'

/** `localStorage` の鍵（`docs/privacy-policy.md` の一覧に載せてある）。 */
export const SEISMO_QUIET_STORAGE_KEY = 'seismo-quiet-levels'

/** 書き出しをまとめる間隔（ms）。下端の波形は 1 秒ごとに測るので、そのたびに書くと無駄が多い。 */
const FLUSH_INTERVAL_MS = 60_000

/** 先の時刻とみなすまでの余裕（ms）。端末とホストの時計のずれを跨げる長さ。 */
const FUTURE_TOLERANCE_MS = 10 * 60_000

/** 控えておく観測点の数の上限（古いデータ時刻のものから捨てる）。観測点は数個の前提で、壊れた値で膨らまないための歯止め。 */
const MAX_STATIONS = 32

interface Entry {
  readonly gal: number
  readonly atMs: number
}

let memo: Map<string, Entry> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pagehideHooked = false

/** **閉じる前に書き出す。** 書き出しをまとめているので、間隔の途中で閉じると最後の値を落とす。 */
function hookPagehide(): void {
  if (pagehideHooked || typeof window === 'undefined') return
  pagehideHooked = true
  window.addEventListener('pagehide', () => {
    if (flushTimer === null) return
    clearTimeout(flushTimer)
    flush()
  })
}

let warnedNoStorage = false

/** 端末の保存領域。**使えなければ `null`**（使えないことは 1 回だけ記録する —— 縦の下限が決め打ちへ戻ったことがどこにも残らないため）。 */
function storage(): Storage | null {
  let s: Storage | null = null
  try {
    s = typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    s = null
  }
  if (s === null && !warnedNoStorage && typeof window !== 'undefined') {
    warnedNoStorage = true
    log.warn('[seismo] 端末の保存領域が使えないので、静かさを控えない（測れない間の縦の下限は決め打ちの値）')
  }
  return s
}

function load(): Map<string, Entry> {
  if (memo !== null) return memo
  memo = new Map()
  let raw: string | null = null
  try {
    raw = storage()?.getItem(SEISMO_QUIET_STORAGE_KEY) ?? null
  } catch (error) {
    log.warn('[seismo] 静かさの控えを読めなかった（決め打ちの縦の下限を使う）', error)
    return memo
  }
  if (raw === null) return memo
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = v as { gal?: unknown; atMs?: unknown } | null
        if (e !== null && typeof e === 'object' && isUsable(e.gal) && typeof e.atMs === 'number' && Number.isFinite(e.atMs)) {
          memo.set(id, { gal: e.gal as number, atMs: e.atMs })
        }
      }
    }
  } catch (error) {
    // 壊れた控えは使わない（決め打ちへ倒れるだけ）。次の書き出しで上書きされる。
    log.warn('[seismo] 静かさの控えを読めなかった（決め打ちの縦の下限を使う）', error)
  }
  return memo
}

function isUsable(gal: unknown): boolean {
  return typeof gal === 'number' && Number.isFinite(gal) && gal >= QUIET_LEVEL_MIN_GAL
}

function flush(): void {
  flushTimer = null
  const s = storage()
  if (s === null || memo === null) return
  try {
    s.setItem(SEISMO_QUIET_STORAGE_KEY, JSON.stringify(Object.fromEntries(memo)))
  } catch (error) {
    log.warn('[seismo] 静かさの控えを書けなかった', error)
  }
}

/** その観測点で最後に測れた静かさ（gal）。**一度も測れていなければ `null`。** */
export function rememberedQuietLevel(stationId: string): number | null {
  return load().get(stationId)?.gal ?? null
}

/**
 * 測れた静かさを控える。**物差しの下限未満・非有限の値は控えない**（張り付いた窓が 0 を返すため。
 * `QuietLevelMemory` と同じ扱い）。データ時刻が控えより古ければ書き換えない。
 */
export function rememberQuietLevel(stationId: string, atMs: number, gal: number | null): void {
  if (gal === null || !isUsable(gal) || !Number.isFinite(atMs)) return
  // **先の時刻は控えない。** ホストの時計が進んだ値で一度でも書くと、「新しいデータ時刻でしか書き換えない」規則のせいで、
  // 時計が戻ったあとの測り値を書けなくなる。合わせた時計（`serverNow()`）より {@link FUTURE_TOLERANCE_MS} 以上先なら捨てる。
  // **端末の時計（`Date.now()`）と比べない** —— 端末の時計が 10 分遅れていると、いまのデータ時刻が全部「先の時刻」になり、
  // 静かさを二度と控えられない。再生中は再生時刻と比べることになるが、再生で読むのは再生時刻までのデータなので通る。
  if (atMs > serverNow() + FUTURE_TOLERANCE_MS) return
  const m = load()
  const cur = m.get(stationId)
  if (cur !== undefined && cur.atMs >= atMs) return
  m.set(stationId, { gal, atMs })
  if (m.size > MAX_STATIONS) {
    const oldest = [...m.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0]
    m.delete(oldest[0])
  }
  hookPagehide()
  flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS)
}

/** テスト用: 端末の控えを読み直す前の状態へ戻す。 */
export function resetSeismoQuietMemoForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  memo = null
}

/** テスト用: 待っている書き出しをすぐ済ませる。 */
export function flushSeismoQuietMemoForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flush()
}
