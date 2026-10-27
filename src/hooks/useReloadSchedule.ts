import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { currentAppUpdater, type AppUpdateSnapshot } from '../services/appUpdate'
import {
  RELOAD_COUNTDOWN_SEC,
  RELOAD_POSTPONE_MS,
  SETTINGS_IDLE_HOLD_LIMIT_MS,
  decideReloadGate,
  isInsideSettingsDialog,
  isTypingOutsideSettings,
  type ReloadGate,
  type ReloadHoldCause,
  type ReloadReason,
} from '../utils/appUpdateGate'
import { log } from '../utils/logger'
import { isReleaseNotesOpen, subscribeReleaseNotesOpen } from '../utils/releaseNotesOpen'

export interface ReloadScheduleInput {
  /** 警報・情報の発表中か。 */
  alertActive: boolean
  /** リプレイの再生中か。 */
  replaying: boolean
  /** 毎朝 5 時の定期の読み直しを行うか（設定）。 */
  periodicReloadEnabled: boolean
  /** 設定の窓を開いているか（→ `utils/appUpdateGate.ts` の `settingsOpen`）。 */
  settingsOpen: boolean
}

export interface ReloadSchedule {
  /** 待っている新しい版。 */
  update: AppUpdateSnapshot
  gate: ReloadGate
  /** 秒読みの残り秒数。秒読みしていなければ `null`。 */
  countdown: number | null
  /** 秒読みしている理由。秒読みしていなければ `null`。 */
  countdownReason: ReloadReason | null
  /** 「今すぐ更新」。待っている版があれば適用し、無ければ（定期の読み直しなら）読み直す。 */
  applyNow: () => void
  /** 「後で」。1 時間は秒読みしない。 */
  postpone: () => void
}

/**
 * 読み直しの段取り（新しい版の適用・毎朝 5 時の定期の読み直し）。
 *
 * 待つかどうかは `decideReloadGate` が決め、ここは秒読みと実行だけを受け持つ。**待つ理由が現れたら
 * 秒読みは捨て、消えたら 10 秒から数え直す** —— 発表が終わった瞬間に残り 2 秒から再開すると、
 * 何が起きるのか読む前に画面が変わる。
 */
export function useReloadSchedule(input: ReloadScheduleInput): ReloadSchedule {
  const updater = currentAppUpdater()
  const update = useSyncExternalStore(updater.subscribe, updater.getSnapshot)
  const typing = useTextEntryFocus()
  const periodicDue = usePeriodicReloadDue(input.periodicReloadEnabled)
  const [postponedUntilMs, setPostponedUntilMs] = useState<number | null>(null)
  // 変更内容の窓を開いている間は秒読みしない（窓に札が隠れて［後で］を押せないため）
  const reading = useSyncExternalStore(subscribeReleaseNotesOpen, isReleaseNotesOpen)
  const settingsLastActivityMs = useSettingsLastActivity(input.settingsOpen)

  const gate = decideReloadGate({
    // 前の起動で適用が効かなかったら、静かなときにも自分では適用しない（札の［今すぐ更新］だけにする）
    updateWaiting: update.waiting && update.autoApply,
    periodicDue,
    alertActive: input.alertActive,
    replaying: input.replaying,
    typing,
    settingsLastActivityMs,
    reading,
    postponedUntilMs,
    nowMs: Date.now(),
  })
  const countdownReason = gate.kind === 'countdown' ? gate.reason : null
  const holdCause = gate.kind === 'held' ? gate.cause : null
  const holdReason = gate.kind === 'held' ? gate.reason : null

  // 待っている理由が変わったら残す。画面には札の文言しか出ないので、なぜ読み直さないのかを後から追えるように
  useEffect(() => {
    if (holdCause === null || holdReason === null) return
    log.info(`[reload] ${holdReason === 'update' ? '新しい版の適用' : '毎朝の定期の読み直し'}を待っている（${HOLD_CAUSE_LABEL[holdCause]}）`)
  }, [holdCause, holdReason])

  const [countdown, setCountdown] = useState<number | null>(null)
  // 秒読みを始める・捨てる。理由が変わったとき（定期の読み直しを数えている最中に新しい版が届いた等）も数え直す
  useEffect(() => {
    setCountdown(countdownReason === null ? null : RELOAD_COUNTDOWN_SEC)
  }, [countdownReason])

  const execute = useCallback((reason: ReloadReason) => {
    if (reason === 'update') {
      updater.apply()
    } else {
      log.info('[reload] 毎朝の定期の読み直しを行う')
      window.location.reload()
    }
  }, [updater])

  useEffect(() => {
    if (countdown === null || countdownReason === null) return
    if (countdown <= 0) {
      execute(countdownReason)
      return
    }
    const id = setTimeout(() => setCountdown((n) => (n !== null ? n - 1 : null)), 1000)
    return () => clearTimeout(id)
  }, [countdown, countdownReason, execute])

  useEffect(() => {
    if (postponedUntilMs === null) return
    // 期限は端末の時計（Date.now）で持ち、1 分ごとに過ぎたかを見る。残りを 1 本のタイマーで待つと、
    // 端末が眠っている間タイマーも止まり、起きてからまた残りを待つ
    const id = setInterval(() => {
      if (Date.now() >= postponedUntilMs) setPostponedUntilMs(null)
    }, 60_000)
    return () => clearInterval(id)
  }, [postponedUntilMs])

  const applyNow = useCallback(() => {
    execute(update.waiting ? 'update' : 'periodic')
  }, [execute, update.waiting])

  const postpone = useCallback(() => {
    setPostponedUntilMs(Date.now() + RELOAD_POSTPONE_MS)
  }, [])

  return { update, gate, countdown, countdownReason, applyNow, postpone }
}

const HOLD_CAUSE_LABEL: Record<ReloadHoldCause, string> = {
  alert: '発表中',
  replay: '再生中',
  typing: '入力中',
  settings: '設定の窓を開いている',
  reading: '変更内容を開いている',
  postponed: '［後で］を押した',
}

/** 設定の窓の待ちが明けたかを見直す間隔。明けるのが最大この分だけ遅れる。 */
const SETTINGS_IDLE_RECHECK_MS = 30_000

/**
 * 設定の窓を開いている間に最後に操作した時刻。閉じていれば `null`（→ `utils/appUpdateGate.ts` の
 * `settingsLastActivityMs`）。開くたびに数え直し、窓の中の操作（押す・キー・ホイール・スクロール）で更新する。
 *
 * 操作のたびに描き直さないよう、時刻そのものは ref に持つ。描き直すのは、待ちが明けたとき（一定間隔で見る）と、
 * **明けていた状態で触ったとき**（窓の後ろで進んでいた秒読みを捨てるため）。明けていたかは合図の有無ではなく
 * 触る直前の時刻で見る —— 別の理由の描き直しで先に明けた判定になっていても、触れば必ず描き直す。
 */
function useSettingsLastActivity(open: boolean): number | null {
  const lastRef = useRef<number | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  if (!open) lastRef.current = null
  else if (lastRef.current === null) lastRef.current = Date.now()
  useEffect(() => {
    if (!open) return
    const expired = (): boolean =>
      lastRef.current !== null && Date.now() - lastRef.current >= SETTINGS_IDLE_HOLD_LIMIT_MS
    let expiryDrawn = false
    const touch = (e: Event) => {
      // スクロールは窓の中のものだけ数える。窓の後ろのページも読み上げの追従などで自分からスクロールするので、
      // それまで数えると開けたまま離れた端末でも待ちが明けない。押す・キー・ホイールは窓の外が `inert` なので窓に届く
      if (e.type === 'scroll' && !(e.target instanceof Element && isInsideSettingsDialog(e.target))) return
      const wasExpired = expired()
      lastRef.current = Date.now()
      expiryDrawn = false
      if (wasExpired) redraw()
    }
    // 端末が眠っている間はタイマーも止まるので、残りを 1 本で待たず、一定間隔で過ぎたかを見る
    const id = setInterval(() => {
      if (expiryDrawn || !expired()) return
      expiryDrawn = true
      redraw()
    }, SETTINGS_IDLE_RECHECK_MS)
    const opts = { passive: true, capture: true } as const
    const events = ['pointerdown', 'keydown', 'wheel', 'touchmove', 'scroll'] as const
    for (const e of events) window.addEventListener(e, touch, opts)
    return () => {
      clearInterval(id)
      for (const e of events) window.removeEventListener(e, touch, true)
    }
  }, [open])
  return lastRef.current
}

/** 入力中のまま、フォーカスの知らせが来なくても読み直す間隔。 */
const TEXT_ENTRY_RECHECK_MS = 5_000

/** 設定の窓の外で、文字を入力する欄にフォーカスがあるか（窓の中は窓の待ちが受け持つ → `isTypingOutsideSettings`）。 */
function useTextEntryFocus(): boolean {
  const [typing, setTyping] = useState(() => isTypingOutsideSettings(document.activeElement))
  useEffect(() => {
    // focusout の時点ではまだ次の要素へ移っていないので、移り終えてから読む
    const sync = () => { queueMicrotask(() => setTyping(isTypingOutsideSettings(document.activeElement))) }
    document.addEventListener('focusin', sync)
    document.addEventListener('focusout', sync)
    return () => {
      document.removeEventListener('focusin', sync)
      document.removeEventListener('focusout', sync)
    }
  }, [])
  useEffect(() => {
    if (!typing) return
    // フォーカスのある欄が消されると focusout が届かず、入力中のまま秒読みが止まり続ける。入力中の間だけ読み直す
    const id = setInterval(() => setTyping(isTypingOutsideSettings(document.activeElement)), TEXT_ENTRY_RECHECK_MS)
    return () => clearInterval(id)
  }, [typing])
  return typing
}

/** 5 時を過ぎたかを確かめる間隔。 */
const PERIODIC_RELOAD_CHECK_MS = 60_000

/**
 * 毎朝 5 時を過ぎたか。過ぎたら真のまま（読み直せばページごと初めからになるので、戻す必要が無い）。
 * 時刻は端末の時計で見る（日付が変わったことを知るだけなので、ずれていても実害は 5 時の前後だけ）。
 *
 * **5 時までの残りを 1 本のタイマーで待たない。** 端末がスリープしている間はタイマーの時計も止まるので、
 * 夜中に眠った端末では、起きてから残りの時間をまた待つことになる。狙いの時刻を先に決め、1 分ごとに
 * 過ぎたかを見る。
 */
function usePeriodicReloadDue(enabled: boolean): boolean {
  const [due, setDue] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setDue(false)
      return
    }
    const target = new Date()
    target.setHours(5, 0, 0, 0)
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1)
    const targetMs = target.getTime()
    const id = setInterval(() => {
      if (Date.now() >= targetMs) setDue(true)
    }, PERIODIC_RELOAD_CHECK_MS)
    return () => clearInterval(id)
  }, [enabled])
  return due
}
