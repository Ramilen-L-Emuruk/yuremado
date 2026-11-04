// 「電文の読み上げが控えているか」の問い合わせ口。`useLiveEventHandler` が登録し、時報（`hooks/useTimeSignal.ts`）が引く。
//
// 控えているとは、予約済みでまだ読み始めていない読み上げがあること。`voicevox.ts` の `isSpeaking()` は
// 読み上げを呼んだ瞬間からしか数えないので、通知音との間・緊急地震速報の連鎖の待ち・予想値の確定待ちの
// あいだは偽になる。時報はそこへ声を割り込ませないよう、こちらも見る。

import { log } from './logger'

/** 控えているかを決める状態。`useLiveEventHandler` の参照から写す */
export interface PendingSpeechState {
  /** 通知音との間を置いている予約（`scheduleSpeech`）の数 */
  scheduledSpeeches: number
  /** 緊急地震速報の読み上げの連鎖に積まれた本数 */
  eewChainPending: number
  /** 緊急地震速報の予想値が付くのを待つタイマーの数 */
  eewPhase2Timers: number
  /** 緊急地震速報の予想震度・長周期階級の確定待ち（安定待ち）の数 */
  eewStabilityWaits: number
  /** 誤報取消の読み上げを予約した地震の数 */
  eewCancelPending: number
  /** 優先度ごとの読み上げの予約（鳴り始めるか取り下げるまで残る）の数 */
  scheduledPriorities: number
}

/** どれか 1 つでも残っていれば控えている */
export function isSpeechPending(s: PendingSpeechState): boolean {
  return s.scheduledSpeeches > 0
    || s.eewChainPending > 0
    || s.eewPhase2Timers > 0
    || s.eewStabilityWaits > 0
    || s.eewCancelPending > 0
    || s.scheduledPriorities > 0
}

/**
 * 控えている状態が、読み上げが 1 本も始まらないまま続いてよい上限（ms）。
 * 超えたら、予約の後始末が漏れて残ったとみなして数えない（数え続けると時報の声が二度と出ない）。
 * `voicevox.ts` の `SPEECH_STALE_MS` と同じ考え方で、同じ 5 分を取る。
 */
export const PENDING_SPEECH_STALE_MS = 5 * 60_000

/**
 * 問い合わせの間がこれより空いたら、控えが続いていたとは見なさず数え直す（ms）。
 * 問い合わせるのは時報の都合（境の数秒前〜声の時点）だけなので、境と境の間は見ていない。
 * 前の境で見た控えと次の境で見た控えは別物かもしれず、続けて数えると 5 分を超えたと誤って判定する。
 */
const PENDING_OBSERVATION_GAP_MS = 10_000

let probe: (() => PendingSpeechState) | null = null
let pendingSince: number | null = null
let lastObservedAt: number | null = null
let staleWarned = false

/** 状態を写す関数を登録する。戻り値を呼ぶと外す（登録したものと同じときだけ） */
export function registerPendingSpeechProbe(next: () => PendingSpeechState): () => void {
  probe = next
  pendingSince = null
  lastObservedAt = null
  staleWarned = false
  return () => { if (probe === next) probe = null }
}

/**
 * 電文の読み上げが控えているか。登録が無ければ偽。
 *
 * @param speaking いま読み上げの最中か（`isSpeaking()`）。最中なら控えが長く続いても正常なので、続いた長さを数え直す
 * @param nowMs 経過を測る時刻（`performance.now()`）。テストから渡せるように引数にしてある
 */
export function hasPendingSpeech(speaking: boolean, nowMs: number): boolean {
  let pending: boolean
  try {
    pending = probe !== null && isSpeechPending(probe())
  } catch (err) {
    log.warn(`[tts] 読み上げの予定を確かめられなかった: ${String(err)}`)
    return false
  }
  const gap = lastObservedAt === null ? Infinity : nowMs - lastObservedAt
  lastObservedAt = nowMs
  if (!pending || speaking) {
    pendingSince = pending ? nowMs : null
    if (!pending) staleWarned = false
    return pending
  }
  // 間が空いていたら、前に見た控えとは別物かもしれないので数え直す
  if (pendingSince === null || gap > PENDING_OBSERVATION_GAP_MS) pendingSince = nowMs
  if (nowMs - pendingSince <= PENDING_SPEECH_STALE_MS) return true
  if (!staleWarned) {
    staleWarned = true
    log.warn(`[tts] 読み上げの予約が ${Math.round(PENDING_SPEECH_STALE_MS / 1000)} 秒を超えて残っているため、時報では数えない（予約の後始末が漏れた疑い）`)
  }
  return false
}
