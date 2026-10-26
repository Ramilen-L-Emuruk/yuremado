import { log } from './logger'

/** 通知に渡す指定。`renotify` は型定義（lib.dom）に無いが、ブラウザは受け付ける。 */
export type BrowserNotificationOptions = NotificationOptions & { renotify?: boolean }

/** 通知を出す許可があるか。API の無い環境（Node・古いブラウザ）では偽。 */
export function canShowBrowserNotification(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

/**
 * 通知を出す。出せなければ reject する（許可があることは呼び出し側が確かめておく）。
 *
 * **Service Worker が動いていればそちらから出す**（`registration.showNotification()`）。Android の Chrome 系は
 * `new Notification()` を受け付けず TypeError を投げ、iPhone のホーム画面に置いたアプリも Service Worker
 * 経由でしか出せないため。動いている登録が無いとき（dev サーバー・初回訪問でまだ入っていない・
 * Service Worker に非対応）と、Service Worker が出せなかったときは `new Notification()` で出す。
 *
 * **`navigator.serviceWorker.ready` は待たない。** 登録が無い環境（dev サーバーは Service Worker を登録しない）
 * では永遠に解決せず、通知が黙って出なくなる。`getRegistration()` は登録が無ければ undefined で返る。
 *
 * Service Worker に非対応の環境では、最初の await より前に `new Notification()` を呼ぶ（同期のまま出す）。
 *
 * `renotify`（同じ tag の通知を置き換えるときも知らせ直す）を受け付けなかったときは、外して出し直す ——
 * 前の通知が残っていれば知らせ直さずに差し替わるだけになるが、中身の置き換え自体は伝わる。
 */
export async function deliverBrowserNotification(title: string, options: BrowserNotificationOptions): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    showWithConstructor(title, options)
    return
  }
  const tag = options.tag ?? ''
  const registration = await findOwnRegistration(tag)
  if (registration?.active) {
    // **返事を待つ上限を置く。** 地震の通知は同じ地震ごとに列へ並ぶので、ここが返らないと、その地震の
    // 以後の通知が黙って止まる
    let late: Promise<void> | undefined
    try {
      const showing = showWithRegistration(registration, title, options)
      if (await withTimeout(showing, SW_SHOW_TIMEOUT_MS)) return
      log.warn(`[notify] Service Worker から ${SW_SHOW_TIMEOUT_MS}ms 返事が無いので、ページから出し直す（${tag}）`)
      late = showing
    } catch (err) {
      log.warn(`[notify] Service Worker から通知を出せなかったので、ページから出し直す（${tag}）`, err)
    }
    // ページから出せなければ投げる（Android の Chrome 系）。そのとき遅れて出た Service Worker の通知は残す
    showWithConstructor(title, options)
    if (late) closeLateNotification(registration, late, title, options)
    return
  } else if (registration) {
    // 初回訪問・更新の直後で、まだ動いていない。Android の Chrome 系では続くページからの通知が投げるので、
    // 出せなかったときにこの理由を辿れるよう残す
    log.debug(`[notify] Service Worker がまだ動いていないので、ページから出す（${tag}・installing ${!!registration.installing}・waiting ${!!registration.waiting}）`)
  }
  showWithConstructor(title, options)
}

/**
 * 上限で諦めた Service Worker の通知が遅れて出たら閉じる（ページから出し直した通知が既にあるので）。
 * Service Worker の通知とページの通知は、同じ tag でも置き換わらない別の通知として扱われうる。
 * 閉じるのは、題と本文が同じものだけ（その間に同じ tag で出た新しい通知は閉じない）。
 */
function closeLateNotification(
  registration: ServiceWorkerRegistration,
  late: Promise<void>,
  title: string,
  options: BrowserNotificationOptions,
): void {
  const tag = options.tag ?? ''
  late
    .then(async () => {
      const shown = await registration.getNotifications(options.tag ? { tag: options.tag } : undefined)
      const same = shown.filter(n => n.title === title && n.body === (options.body ?? ''))
      for (const n of same) n.close()
      log.debug(same.length > 0
        ? `[notify] Service Worker から遅れて出た通知 ${same.length} 件を閉じた（ページから出し直したため・${tag}）`
        : `[notify] 諦めた Service Worker の通知は遅れて済んだが、表示中に同じ通知は無かった（${tag}）`)
    })
    .catch((err: unknown) => log.debug(`[notify] 諦めた Service Worker の通知は、遅れて失敗した（${tag}）`, err))
}

/** `getRegistration()` を待つ上限（ms）。返事が来なければページから出す（通知を黙って止めない）。 */
export const SW_REGISTRATION_TIMEOUT_MS = 3000

/** `showNotification()` を待つ上限（ms）。返事が来なければページから出し直す。 */
export const SW_SHOW_TIMEOUT_MS = 5000

/** `promise` が `ms` 以内に済めば true、済まなければ false。reject はそのまま投げる。 */
async function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) })
    return await Promise.race([promise.then(() => true as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * このページのスコープの登録を引く。**別のスコープの登録は使わない。** 同じオリジンに standard 版
 * （`/yuremado/`）と DMDSS 版（`/yuremado/dmdss/`）が同居し、DMDSS 版の登録がまだ無いと、DMDSS 版の
 * ページでも standard 版の登録が返る（URL に一致するスコープのうち最も長いもの）。それで出すと、
 * 後で DMDSS 版の登録ができたとき、同じ tag の通知が登録をまたいで置き換わらない。
 */
async function findOwnRegistration(tag: string): Promise<ServiceWorkerRegistration | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), SW_REGISTRATION_TIMEOUT_MS) })
    const found = await Promise.race([navigator.serviceWorker.getRegistration(), timeout])
    if (found === 'timeout') {
      log.warn(`[notify] Service Worker の登録が ${SW_REGISTRATION_TIMEOUT_MS}ms 返らないので、ページから出す（${tag}）`)
      return undefined
    }
    if (found && new URL(found.scope).pathname !== import.meta.env.BASE_URL) {
      log.warn(`[notify] 別のスコープの登録（${found.scope}）なので使わず、ページから出す（${tag}）`)
      return undefined
    }
    return found
  } catch (err) {
    log.warn(`[notify] Service Worker の登録を引けなかったので、ページから出す（${tag}）`, err)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function showWithRegistration(
  registration: ServiceWorkerRegistration,
  title: string,
  options: BrowserNotificationOptions,
): Promise<void> {
  if (!options.renotify) {
    await registration.showNotification(title, options)
    return
  }
  try {
    await registration.showNotification(title, options)
  } catch (err) {
    log.warn(`[notify] 音を鳴らし直す指定（renotify）付きで出せなかったので、外して出し直す（${options.tag ?? ''}）`, err)
    await registration.showNotification(title, withoutRenotify(options))
  }
}

function showWithConstructor(title: string, options: BrowserNotificationOptions): void {
  if (!options.renotify) {
    new Notification(title, options)
    return
  }
  try {
    new Notification(title, options)
  } catch (err) {
    log.warn(`[notify] 音を鳴らし直す指定（renotify）付きで出せなかったので、外して出し直す（${options.tag ?? ''}）`, err)
    new Notification(title, withoutRenotify(options))
  }
}

function withoutRenotify(options: BrowserNotificationOptions): NotificationOptions {
  const { renotify: _renotify, ...rest } = options
  return rest
}

/** 通知に添えるアイコン。 */
export const NOTIFICATION_ICON = `${import.meta.env.BASE_URL}icons/icon.svg`

/**
 * ブラウザ通知を表示する。Notification API 未対応・未許可の環境では何もしない。
 * tag が同じ通知は上書きされる（同一イベントの続報で通知が積み重ならないようにする）。
 * **置き換えでも知らせ直す**（`renotify`）。付けないと、前の通知が通知センターに残っている間は黙って差し替わり、
 * トーストも音も出ない（Windows で通知テストを続けて押して見つかった。2026-10-26 ユーザー選択
 * 「今の場面で知らせ直す (Recommended)」「今出している報で知らせ直す (Recommended)」）。
 * 呼び出し側は出すと決めた報でだけ呼ぶので、ここで知らせ直しても鳴りすぎない。出し方は {@link deliverBrowserNotification}。
 *
 * **例外を外へ投げない。** 呼び出し側はこの後に音・読み上げ・記憶の後始末を続けるので、ここで投げると
 * 通知 1 つのためにそれらが丸ごと飛ぶ。出せなかったことは記録に残す。
 */
export function showBrowserNotification(
  title: string,
  body: string,
  tag: string,
  requireInteraction = false,
): void {
  if (!canShowBrowserNotification()) return
  deliverBrowserNotification(title, { body, icon: NOTIFICATION_ICON, tag, requireInteraction, renotify: true })
    .catch((e: unknown) => log.error(`[notify] ブラウザ通知を出せませんでした（${tag}）`, e))
}
