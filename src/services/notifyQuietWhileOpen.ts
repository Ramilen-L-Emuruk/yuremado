import { log } from '../utils/logger'

/**
 * 設定「アプリを開いている間は通知しない」（`notifyQuietWhileOpen`。docs/spec/settings-pwa-spec.md §4.11・
 * docs/relay-server-design.md §6.7「アプリを開いている間は送らない」）。
 *
 * 止めるのは 3 か所で、どれも「いまアプリが画面に出ているか」を {@link quietNow} で見る。
 *
 * 1. 画面内の通知（`utils/notifications.ts` の `deliverBrowserNotification`）は出さない
 * 2. 中継のプッシュ通知は、中継が送る前に尋ねる（`relay-push-probe`）。画面に出ていれば返事（`push-probe-ack`）をし、
 *    返事を受けた中継はこの端末へ送らない。**届いてから捨てる形にしない** —— iPhone（WebKit）は、通知を出さなかった
 *    プッシュを窓が見えていても数え、3 回で購読を打ち切る（2026-11-05 ユーザー選択「受け取りを待って送る (Recommended)」）
 * 3. 尋ねる前に送られていた分（切り替わりの瞬間・中継との接続が切れていた間）は、Service Worker が Chromium 系に限って
 *    捨てる（`public/sw-push.js`）。Chromium は、そのサイトのタブが見えていれば通知を出さないプッシュを咎めない
 *
 * 中継へ名乗るのは、プッシュ通知の購読があり、この設定が入っているときだけ（`push-quiet-bind`）。名乗りは購読の送り先と
 * 鍵（`auth`）で、中継は登録済みの購読と突き合わせてから受ける。
 */

/** 中継へ送る口（接続 1 本につき 1 つ） */
export type RelaySend = (text: string) => void

/** 中継へ名乗るプッシュの購読（`PushSubscription.toJSON()` の送り先と鍵） */
export interface PushQuietBinding {
  endpoint: string
  auth: string
}

let enabled = false
let binding: PushQuietBinding | null = null
const sockets = new Set<RelaySend>()

/** いま通知を止めるか（設定が入っていて、ページが画面に出ている） */
export function quietNow(): boolean {
  return enabled && typeof document !== 'undefined' && document.visibilityState === 'visible'
}

/**
 * 名乗りの文。**名乗るのは画面に出ている間だけ**（隠れたら取り下げる。{@link installNotifyQuietVisibilityWatch}）——
 * 裏のタブのように接続が生きたまま返事をしない端末を中継に待たせない（名乗った購読へは返事を待ってから送るため）
 */
function bindText(): string | null {
  return quietNow() && binding !== null ? JSON.stringify({ type: 'push-quiet-bind', endpoint: binding.endpoint, auth: binding.auth }) : null
}

function sendAll(text: string): void {
  for (const send of sockets) {
    try {
      send(text)
    } catch (err) {
      log.warn('[push] 中継へアプリを開いている間の扱いを伝えられませんでした', err)
    }
  }
}

/** 最後に繋いでいる中継へ伝えた名乗り（取り下げていれば null）。設定・購読・画面の出し入れのどれが変わっても、これと比べて名乗り直す */
let announced: string | null = null

/** 名乗りが変わったら、繋いでいる中継すべてへ名乗り直す（外れたら名乗りを取り下げる） */
function announce(): void {
  const next = bindText()
  if (next === announced) return
  announced = next
  sendAll(next ?? JSON.stringify({ type: 'push-quiet-unbind' }))
}

/** 設定の値を移す（`App` が設定の変わるたびに呼ぶ） */
export function setNotifyQuietWhileOpen(on: boolean): void {
  enabled = on
  announce()
}

/** 中継に登録できたプッシュの購読（外したら null）。`services/pushSubscription.ts` が呼ぶ */
export function setPushQuietBinding(next: PushQuietBinding | null): void {
  binding = next
  announce()
}

/**
 * 中継の接続が「尋ねる口がある」と名乗ったら（`relay-status` の `pushQuiet: true`）、その接続を登録する。
 * 既に名乗る条件が揃っていれば、ここで名乗る。返す関数で外す（接続が閉じたとき）
 */
export function attachRelaySocket(send: RelaySend): () => void {
  if (sockets.has(send)) return () => sockets.delete(send)
  sockets.add(send)
  const text = bindText()
  if (text !== null) {
    try {
      send(text)
    } catch (err) {
      log.warn('[push] 中継へアプリを開いている間の扱いを伝えられませんでした', err)
    }
  }
  return () => sockets.delete(send)
}

/**
 * 画面の出し入れで名乗り直す口を張る（画面に出たら名乗り、隠れたら取り下げる）。返す関数で外す。
 * 隠れた瞬間に止まる端末（iPhone）は取り下げを送れないことがあるが、そのときは問いに返事をしないので、中継は待ったあとで送る
 */
export function installNotifyQuietVisibilityWatch(): () => void {
  if (typeof document === 'undefined') return () => {}
  const onChange = (): void => announce()
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/**
 * 中継の問い（`relay-push-probe`）に答える。画面に出ていて設定が入っていれば「送らないで」（`push-probe-ack`）、
 * そうでなければ「送って」（`push-probe-nack`）と返す。返事が無いときも中継は待ったあとで送る（裏へ回って止まっている端末にも届く）
 */
export function answerPushProbe(msg: Record<string, unknown>, send: RelaySend): void {
  const probe = msg.probe
  if (typeof probe !== 'string' || probe.length === 0 || probe.length > 64) return
  const quiet = quietNow()
  try {
    send(JSON.stringify({ type: quiet ? 'push-probe-ack' : 'push-probe-nack', probe }))
    if (quiet) log.info(`[push] アプリが画面に出ているので、中継にプッシュ通知を送らないよう答えた（${probe}）`)
  } catch (err) {
    log.warn('[push] 中継の問いに答えられませんでした（プッシュ通知が届きます）', err)
  }
}

/**
 * Service Worker の問い（`push-quiet-query`）に答える口を張る（`public/sw-push.js`）。問いは `MessageChannel` の
 * 片端を添えて届くので、そこへ止めるかを返す。返す関数で外す
 */
export function installServiceWorkerQuietAnswer(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as { type?: unknown } | null
    if (data === null || typeof data !== 'object' || data.type !== 'push-quiet-query') return
    const port = ev.ports[0]
    if (port === undefined) return
    port.postMessage({ quiet: quietNow() })
  }
  navigator.serviceWorker.addEventListener('message', onMessage)
  return () => navigator.serviceWorker.removeEventListener('message', onMessage)
}

/** テスト用: 持っている状態を初めに戻す */
export function resetNotifyQuietWhileOpenForTest(): void {
  enabled = false
  binding = null
  announced = null
  sockets.clear()
}
