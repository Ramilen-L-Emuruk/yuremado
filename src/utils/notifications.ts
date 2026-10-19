import { log } from './logger'

/**
 * ブラウザ通知を表示する。Notification API 未対応・未許可の環境では何もしない。
 * tag が同じ通知は上書きされる（同一イベントの続報で通知が積み重ならないようにする）。
 *
 * **例外を外へ投げない。** Android の Chrome 系は `new Notification()` を受け付けず TypeError を投げる
 * （Service Worker 経由でしか出せない）。呼び出し側はこの後に音・読み上げ・記憶の後始末を続けるので、
 * ここで投げると通知 1 つのためにそれらが丸ごと飛ぶ。出せなかったことは記録に残す。
 */
export function showBrowserNotification(
  title: string,
  body: string,
  tag: string,
  requireInteraction = false,
) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(title, {
      body,
      icon: `${import.meta.env.BASE_URL}icons/icon.svg`,
      tag,
      requireInteraction,
    })
  } catch (e) {
    log.warn(`[notify] ブラウザ通知を出せませんでした（${tag}）`, e)
  }
}
