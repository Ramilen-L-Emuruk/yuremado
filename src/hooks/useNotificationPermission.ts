import { useSyncExternalStore } from 'react'

import { log } from '../utils/logger'

/**
 * ブラウザの通知の許可（`Notification.permission`）を画面と購読の両方で同じ値として読む。
 *
 * 設定の窓は許可が出るまで通知の設定を隠し（許可のボタンだけを置く）、プッシュ通知の購読は許可が出たら作る
 * （docs/spec/settings-pwa-spec.md §4.10）。許可はアプリの外（ブラウザのサイトの設定）でも変わるので、
 * 押したときのほかに、Permissions API の変化と、画面へ戻ったときにも読み直す。
 */
export type NotificationPermissionState = NotificationPermission | 'unsupported'

function read(): NotificationPermissionState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

const listeners = new Set<() => void>()
let current: NotificationPermissionState = read()
let watching = false

/** 許可を読み直し、変わっていれば全員に知らせる（購読が許可を断られたときにも呼ぶ） */
export function refreshNotificationPermission(): void {
  const next = read()
  if (next === current) return
  current = next
  for (const l of listeners) l()
}

function startWatching(): void {
  if (watching || typeof document === 'undefined') return
  watching = true
  document.addEventListener('visibilitychange', refreshNotificationPermission)
  // Permissions API は通知の名前を扱わないブラウザがある（古い Safari）。扱えなければ画面へ戻ったときの読み直しだけで追う
  // （やり直さない。押したとき・画面へ戻ったとき・購読が断られたときに読み直すので、追いつく）
  void navigator.permissions?.query({ name: 'notifications' as PermissionName })
    .then(status => { status.addEventListener('change', refreshNotificationPermission) })
    .catch(err => { log.debug('[notify] 通知の許可の変化を見張れないので、画面へ戻ったときに読み直す', err) })
}

function subscribe(listener: () => void): () => void {
  startWatching()
  listeners.add(listener)
  refreshNotificationPermission()
  return () => { listeners.delete(listener) }
}

/** 今の許可。押した操作の中で尋ねるときは `requestNotificationPermission` を使う */
export function useNotificationPermission(): NotificationPermissionState {
  return useSyncExternalStore(subscribe, () => current, () => current)
}

/**
 * 通知の許可を尋ね、結果を全員に知らせる。**押した操作の中で、ほかの待ちより先に呼ぶ** —— Safari（iOS のホーム画面から
 * 開いたものを含む）と Firefox は、操作から離れたところで求めた許可を尋ねない
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    if (Notification.permission === 'default') await Notification.requestPermission()
  } catch (err) {
    log.warn('[notify] 通知の許可を尋ねられませんでした', err)
  }
  refreshNotificationPermission()
  return current
}
