import { useEffect, useRef } from 'react'

import { pushPrefsOf, pushSupported, subscribePush, unsubscribePush } from '../services/pushSubscription'
import { log } from '../utils/logger'
import { refreshNotificationPermission, useNotificationPermission } from './useNotificationPermission'
import type { AppSettings } from './useSettings'

/** 設定を続けて変えたときに、中継へまとめて 1 回送るまでの待ち */
const PUSH_SYNC_DELAY_MS = 1500
/**
 * 登録に失敗したときにやり直すまでの待ち（回を追って伸ばし、最後の値を繰り返す）。画面に文言は出さない
 * （2026-11-03 ユーザー選択「文言は足さずやり直すだけ」）
 */
export const PUSH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const

/**
 * 通知を許可した端末の購読を作り・消し、通知の設定を変えたら中継の写しを送り直す（docs/relay-server-design.md §6.7）。
 * 起動のたびにも送り直す（中継の写しを端末の設定に揃え、ブラウザが購読を作り直していても拾う）。
 *
 * - 購読するのは「通知を表示」が入っていて、通知が許可されていて、このブラウザが購読を扱えるときだけ。
 *   プッシュ通知だけを入り切りする設定は置かない（2026-11-12 ユーザー発言「プッシュ通知オンオフを別途設定できるようにする必要は無いと思います。」）。
 *   許可を求めるのはここではなく、設定の窓の許可のボタン（`requestNotificationPermission`）
 * - 登録に失敗したら `PUSH_RETRY_DELAYS_MS` の間を空けてやり直す。画面が見えるようになったときにもやり直す
 * - 登録の途中で条件が外れたら、作り終えた購読を外す（解除が先に終わって何も外せなかった分を残さない）
 */
export function usePushSubscription(settings: AppSettings): void {
  const permission = useNotificationPermission()
  const wanted = settings.notifyEnabled && permission === 'granted' && pushSupported()
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const prefsKey = JSON.stringify(pushPrefsOf(settings))
  // 初めは「入っていた」として始める。起動した時点で条件が外れていれば一度外す（前の版の「プッシュ通知」だけで作った購読や、
  // 閉じている間に許可を取り消した端末の購読を残さない。購読が無ければ外す処理は何もしない）
  const wasEnabled = useRef(true)
  // 登録の世代。設定を続けて変えたとき、前の世代の登録が後から中継へ届いて新しい写しを上書きしないよう、送る直前に見る
  const generation = useRef(0)
  const latest = useRef(settings)
  latest.current = settings

  useEffect(() => {
    if (!wanted) {
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
      void subscribePush(latest.current, () => generation.current === myGeneration && wantedRef.current).then(result => {
        running = false
        if (!wantedRef.current) {
          // 待っている間に条件が外れた（設定が切られた・許可が取り消された）。解除がブラウザの購読の作成より先に終わっていることがあるので、結果によらずここでも外す
          void unsubscribePush()
          return
        }
        if (cancelled) return
        if (result === 'denied' || result === 'unsupported') {
          // 許可を読み直して条件を外す（許可の変化を見張れないブラウザでも、ここで追いつく）。ここではやり直さない
          log.warn(`[push] プッシュ通知を使えないので登録しない（${result === 'denied' ? '通知が許可されていない' : 'このブラウザは扱えない'}）`)
          refreshNotificationPermission()
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
  }, [wanted, prefsKey])
}
