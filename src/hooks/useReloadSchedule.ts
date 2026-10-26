import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { currentAppUpdater, type AppUpdateSnapshot } from '../services/appUpdate'
import {
  RELOAD_COUNTDOWN_SEC,
  RELOAD_POSTPONE_MS,
  decideReloadGate,
  isTextEntryElement,
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

  const gate = decideReloadGate({
    // 前の起動で適用が効かなかったら、静かなときにも自分では適用しない（札の［今すぐ更新］だけにする）
    updateWaiting: update.waiting && update.autoApply,
    periodicDue,
    alertActive: input.alertActive,
    replaying: input.replaying,
    typing,
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
  reading: '変更内容を開いている',
  postponed: '［後で］を押した',
}

/** 入力中のまま、フォーカスの知らせが来なくても読み直す間隔。 */
const TEXT_ENTRY_RECHECK_MS = 5_000

/** 文字を入力する欄にフォーカスがあるか。 */
function useTextEntryFocus(): boolean {
  const [typing, setTyping] = useState(() => isTextEntryElement(document.activeElement))
  useEffect(() => {
    // focusout の時点ではまだ次の要素へ移っていないので、移り終えてから読む
    const sync = () => { queueMicrotask(() => setTyping(isTextEntryElement(document.activeElement))) }
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
    const id = setInterval(() => setTyping(isTextEntryElement(document.activeElement)), TEXT_ENTRY_RECHECK_MS)
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
