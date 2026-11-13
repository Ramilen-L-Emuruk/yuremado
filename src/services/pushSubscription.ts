import type { AppSettings } from '../hooks/useSettings'
import { deviceLanguageTags, resolveLocale, type Locale } from '../i18n/messages'
import { log } from '../utils/logger'
import { setPushQuietBinding } from './notifyQuietWhileOpen'
import { RELAY_ORIGIN, relayTokenStore } from './relayEndpoint'

/**
 * プッシュ通知の購読（docs/relay-server-design.md §6.7）。設定「プッシュ通知」を入れた端末だけが、ブラウザで購読を作って
 * 中継へ送り先と通知の設定の写しを登録する（2026-11-03 ユーザー選択「設定で入れたときだけ (Recommended)」）。
 *
 * 中継へ渡す設定の写しは、画面内の通知と同じ判定に使う値だけ（`notificationAllowed`・`notificationRegionAllowed` が見るもの）。
 * まとめて止める設定（`notifyEnabled`）が切れていれば、種類ごとの値を全部切ったものとして渡す。
 */

/** 中継へ渡す通知の設定の写し（中継の src/push/subscription.ts の PushPrefs と同じ形） */
export interface PushPrefsCopy {
  quake: boolean
  minScale: number
  eew: boolean
  tsunami: boolean
  nankai: boolean
  nankaiCommentary: boolean
  /** 定例解説の通知（`notifyNankaiRoutine`）。この欄を知らない古い中継には無視される */
  nankaiRoutine: boolean
  /** 地震・津波に関するお知らせの通知（`notifyQuakeNotice`）。同上 */
  quakeNotice: boolean
  /**
   * 試験報を受け取るか（`dmdataTestDelivery`）。入でなければ、国際津波関連情報の通信試験を送らない（2026-11-09 ユーザー選択
   * 「試験報の設定で止める (Recommended)」）。この欄を知らない古い購読は、中継が切として扱う
   */
  testDelivery: boolean
  prefectures: string[]
  /**
   * 通知の文の言語（設定の言語。端末に合わせるときは、いま端末から決まる言語）。この欄を知らない古い中継には無視され、
   * 日本語で送られる（2026-11-11 ユーザー選択「言語の設定の段で合わせる (Recommended)」・2026-11-12 同「11-11 の決定どおりこの段で (Recommended)」）
   */
  locale: Locale
}

type PushSettings = Pick<AppSettings,
  'notifyEnabled' | 'notifyQuake' | 'notifyMinScale' | 'notifyEEW' | 'notifyTsunami' | 'notifyNankai' | 'nankaiCommentaryAlerts'
  | 'notifyNankaiRoutine' | 'notifyQuakeNotice' | 'notifyPrefectures' | 'dmdataTestDelivery' | 'locale'>

export function pushPrefsOf(s: PushSettings, deviceTags: readonly string[] = deviceLanguageTags()): PushPrefsCopy {
  const on = s.notifyEnabled
  return {
    locale: resolveLocale(s.locale, deviceTags),
    quake: on && s.notifyQuake,
    minScale: s.notifyMinScale,
    eew: on && s.notifyEEW,
    tsunami: on && s.notifyTsunami,
    nankai: on && s.notifyNankai,
    nankaiCommentary: s.nankaiCommentaryAlerts,
    nankaiRoutine: on && s.notifyNankaiRoutine,
    quakeNotice: on && s.notifyQuakeNotice,
    testDelivery: s.dmdataTestDelivery,
    prefectures: [...s.notifyPrefectures],
  }
}

/** このブラウザでプッシュ通知を購読できるか（Service Worker と Push API があり、安全な接続で開いている） */
export function pushSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4 !== 0) t += '='
  const bin = atob(t)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 中継への要求と Service Worker の用意を待つ上限。届かないまま待ち続けると、成功も失敗も記録に出ない */
const PUSH_REQUEST_TIMEOUT_MS = 15_000

async function relayFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await relayTokenStore.ensure()
  const res = await fetch(`${RELAY_ORIGIN}${path}`, {
    ...init,
    signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
    headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  if (res.status === 401) relayTokenStore.invalidate()
  return res
}

/** 終わらない待ち（Service Worker の用意・ブラウザの購読の作成）を打ち切る */
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}が終わらない`)), PUSH_REQUEST_TIMEOUT_MS)),
  ])
}

function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
  return withTimeout(navigator.serviceWorker.ready, 'Service Worker の用意')
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (a === null || a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

/**
 * 通知の許可を求める。**設定の切り替えを押した操作の中で、ほかの待ちより先に呼ぶ** —— Safari（iOS のホーム画面から
 * 開いたものを含む）と Firefox は、操作から離れたところで求めた許可を尋ねない。許可されたかを返す
 */
export async function requestPushPermission(): Promise<boolean> {
  if (!pushSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

/**
 * 購読を作るか、既にあるものを使い、中継へ送り先と設定の写しを登録する。通知の許可は尋ねない（`requestPushPermission` が
 * 設定の切り替えの中で尋ねる）。返すのは登録できたか。出来なかった理由は記録に残す（設定を戻す・やり直すのは呼び出し側）
 */
export async function subscribePush(
  settings: PushSettings,
  /** まだこの登録を送ってよいか。偽なら中継へ送らずに 'failed' を返す（後から始めた登録の写しを、古い写しで上書きしない） */
  stillCurrent: () => boolean,
): Promise<'ok' | 'denied' | 'unsupported' | 'failed'> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission !== 'granted') return 'denied'
  try {
    const keyRes = await fetch(`${RELAY_ORIGIN}/push/key`, { signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS) })
    if (!keyRes.ok) { log.warn(`[push] 中継から VAPID の公開鍵を受け取れませんでした（${keyRes.status}）`); return 'failed' }
    const { key } = await withTimeout(keyRes.json() as Promise<{ key: string }>, '公開鍵の読み取り')
    const serverKey = b64urlToBytes(key)
    const registration = await serviceWorkerReady()
    let subscription = await registration.pushManager.getSubscription()
    // 中継の鍵を作り直すと、古い鍵で作った購読へは送れない（送り口が署名を拒む）。鍵が違えば作り直す
    if (subscription && !sameBytes(subscription.options.applicationServerKey, serverKey)) {
      log.info('[push] 中継の鍵が変わったので購読を作り直す')
      await subscription.unsubscribe()
      subscription = null
    }
    subscription ??= await withTimeout(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey }), 'ブラウザの購読の作成')
    if (!stillCurrent()) return 'failed'
    const res = await relayFetch('/push/subscription', {
      method: 'PUT',
      body: JSON.stringify({ subscription: subscription.toJSON(), prefs: pushPrefsOf(settings) }),
    })
    if (!res.ok) { log.warn(`[push] 中継へ購読を登録できませんでした（${res.status}）`); return 'failed' }
    // 中継に登録できた購読だけを名乗りに使う（中継は登録済みの購読と突き合わせてから受ける。→ notifyQuietWhileOpen.ts）
    const auth = subscription.toJSON().keys?.auth
    setPushQuietBinding(typeof auth === 'string' && auth !== '' ? { endpoint: subscription.endpoint, auth } : null)
    return 'ok'
  } catch (err) {
    log.warn('[push] プッシュ通知を購読できませんでした', err)
    return 'failed'
  }
}

/**
 * ブラウザの購読を外し、中継からも消す。購読が無ければ何もしない。
 * **ブラウザの購読を先に外す** —— 中継へ届かなくても、外した購読へは送り口が 410 を返すので、中継の登録は次の配りで消える。
 * 先に中継へ送る形だと、届かなかったときにブラウザの購読が残り、設定を切っても通知が届き続ける
 */
export async function unsubscribePush(): Promise<void> {
  // 外すと決めた時点で名乗りも取り下げる（購読が残っていても、もう尋ねられる理由が無い）
  setPushQuietBinding(null)
  if (!pushSupported()) return
  let endpoint: string
  try {
    const registration = await serviceWorkerReady()
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return
    endpoint = subscription.endpoint
    // ブラウザの購読を外せなくても、中継の登録は消しに行く（消せば中継からは送らない）
    try { await subscription.unsubscribe() } catch (err) { log.warn('[push] ブラウザの購読を外せませんでした。中継の登録は消す', err) }
  } catch (err) {
    log.warn('[push] プッシュ通知の購読を外せませんでした', err)
    return
  }
  try {
    const res = await relayFetch('/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint }) })
    if (!res.ok && res.status !== 404) log.warn(`[push] 中継から購読を消せませんでした（${res.status}）。外した購読なら、送り口に断られた後で中継から消える`)
  } catch (err) {
    log.warn('[push] 中継から購読を消せませんでした。外した購読なら、送り口に断られた後で中継から消える', err)
  }
}
