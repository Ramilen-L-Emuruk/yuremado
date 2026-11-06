// 通知を押したときの開き先の受け渡し（→ `notificationOpen.ts`）。出す部品（`notifications.ts`）と受ける側
// （`hooks/useNotificationOpen.ts`）の間に置く。受ける側が出す部品を import すると、通知を出すファイルに数えられる
// （`notificationGate.test.ts` の網）ので分けてある。
import { log } from './logger'
import { notificationOpenQuery, parseNotificationOpen, type NotificationOpen } from './notificationOpen'

const openHandlers = new Set<(open: NotificationOpen) => void>()
/**
 * 受け手がまだ居ない間に届いた開き先（最後の 1 件だけ）。起動の途中（画面がまだ受け手を付けていない）に
 * 押された通知を捨てないため。受け手が付いたときに渡す。
 */
let waiting: NotificationOpen | null = null

export function emitNotificationOpen(open: NotificationOpen, via: string): void {
  log.info(`[notify] 通知を押したので開く（${via}・${notificationOpenQuery(open)}）`)
  if (openHandlers.size === 0) {
    if (waiting !== null) log.warn(`[notify] 預かっていた開き先を、後から押された通知の開き先で置き換える（捨てる方: ${notificationOpenQuery(waiting)}）`)
    else log.info('[notify] 開き先を受け取る先がまだ無いので、付くまで預かる')
    waiting = open
    return
  }
  deliver(open)
}

function deliver(open: NotificationOpen): void {
  for (const handler of openHandlers) {
    // 投げても残りの受け手と、呼び出し元（Service Worker の文・通知の onclick）を止めない
    try {
      handler(open)
    } catch (err) {
      log.error(`[notify] 通知を押した開き先の処理に失敗した（${notificationOpenQuery(open)}）`, err)
    }
  }
}

/** Service Worker が「この通知が押された」と知らせる文の種類（`public/sw-notification-click.js` と揃える。`scripts/swImportScripts.test.ts` が見る） */
export const NOTIFICATION_OPEN_MESSAGE = 'notification-open'

/**
 * Service Worker からの文の受け口。**このモジュールを読み込んだ時点で付ける**（画面の描画を待たない）。
 * 受け口の無いうちに届いた文は、ブラウザが黙って捨てる（文の列は文書の読み込みが済むと流れ始める）。
 */
function onServiceWorkerMessage(event: MessageEvent): void {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== NOTIFICATION_OPEN_MESSAGE) return
  const query = (data as { open?: unknown }).open
  const open = typeof query === 'string' ? parseNotificationOpen(query) : null
  if (open) emitNotificationOpen(open, 'Service Worker')
  else log.warn('[notify] 通知を押したと知らされたが、開き先を読めなかった', data)
}
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage)
}

/**
 * 通知が押されたときの開き先を受け取る。Service Worker から出した通知（プッシュ通知を含む）は
 * `public/sw-notification-click.js` が開いている画面へ文で知らせ、ページから出した通知はここで直に受ける。
 * 受け手が付く前に届いていた開き先は、付いたときに渡す。戻り値で受け取りをやめる。
 * アプリが閉じていたときは、開き先が URL に付いて開く（→ `useNotificationOpen`）。
 */
export function subscribeNotificationOpen(handler: (open: NotificationOpen) => void): () => void {
  openHandlers.add(handler)
  if (waiting !== null) {
    const open = waiting
    waiting = null
    deliver(open)
  }
  return () => { openHandlers.delete(handler) }
}
