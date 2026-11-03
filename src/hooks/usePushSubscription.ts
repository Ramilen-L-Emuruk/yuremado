import { useEffect, useRef } from 'react'

import { pushPrefsOf, subscribePush, unsubscribePush } from '../services/pushSubscription'
import { log } from '../utils/logger'
import type { AppSettings } from './useSettings'

/** 設定を続けて変えたときに、中継へまとめて 1 回送るまでの待ち */
const PUSH_SYNC_DELAY_MS = 1500
/**
 * 登録に失敗したときにやり直すまでの待ち（回を追って伸ばし、最後の値を繰り返す）。画面に文言は出さない
 * （2026-11-03 ユーザー選択「文言は足さずやり直すだけ」）
 */
export const PUSH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const

/**
 * 設定「プッシュ通知」に合わせて購読を作り・消し、通知の設定を変えたら中継の写しを送り直す（docs/relay-server-design.md §6.7）。
 * 起動のたびにも送り直す（中継の写しを端末の設定に揃え、ブラウザが購読を作り直していても拾う）。
 *
 * - 通知が許可されていない・このブラウザが購読を扱えないときは、設定を切って戻す（入ったままだと届くと読める）。
 *   許可を求めるのはここではなく、設定を入れた操作の中（`requestPushPermission`）
 * - 登録に失敗したら `PUSH_RETRY_DELAYS_MS` の間を空けてやり直す。画面が見えるようになったときにもやり直す
 * - 登録の途中で設定が切られたら、作り終えた購読を外す（解除が先に終わって何も外せなかった分を残さない）
 */
export function usePushSubscription(
  settings: AppSettings,
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void,
): void {
  const prefsKey = JSON.stringify(pushPrefsOf(settings))
  const wasEnabled = useRef(false)
  // 登録の世代。設定を続けて変えたとき、前の世代の登録が後から中継へ届いて新しい写しを上書きしないよう、送る直前に見る
  const generation = useRef(0)
  const latest = useRef(settings)
  latest.current = settings

  useEffect(() => {
    if (!settings.pushNotifyEnabled) {
      if (wasEnabled.current) {
        wasEnabled.current = false
        void unsubscribePush()
      }
      return
    }
    wasEnabled.current = true
    const myGeneration = ++generation.current
    let cancelled = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let running = false
    let succeeded = false

    const attempt = (): void => {
      timer = null
      if (cancelled || running) return
      running = true
      void subscribePush(latest.current, () => generation.current === myGeneration && latest.current.pushNotifyEnabled).then(result => {
        running = false
        if (!latest.current.pushNotifyEnabled) {
          // 待っている間に設定が切られた。解除がブラウザの購読の作成より先に終わっていることがあるので、結果によらずここでも外す
          void unsubscribePush()
          return
        }
        if (cancelled) return
        if (result === 'denied' || result === 'unsupported') {
          log.info(`[push] プッシュ通知を使えないので設定を切る（${result === 'denied' ? '通知が許可されていない' : 'このブラウザは扱えない'}）`)
          updateSetting('pushNotifyEnabled', false)
          return
        }
        if (result === 'ok') {
          succeeded = true
          failures = 0
          return
        }
        const wait = PUSH_RETRY_DELAYS_MS[Math.min(failures, PUSH_RETRY_DELAYS_MS.length - 1)]
        failures++
        log.info(`[push] 登録できなかったので ${Math.round(wait / 60_000)} 分後にやり直す（${failures} 回目）`)
        timer = setTimeout(attempt, wait)
      })
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || succeeded || running) return
      if (timer !== null) clearTimeout(timer)
      attempt()
    }

    timer = setTimeout(attempt, PUSH_SYNC_DELAY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // prefsKey は通知の設定の写しが変わったときだけ送り直すための鍵
  }, [settings.pushNotifyEnabled, prefsKey, updateSetting])
}
