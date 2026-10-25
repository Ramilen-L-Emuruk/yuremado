import type { AppSettings } from '../hooks/useSettings'

/** ブラウザ通知の種類。設定タブの種類ごとのトグルと 1 対 1 で対応する。 */
export type NotificationKind = 'quake' | 'detection' | 'eew' | 'tsunami' | 'nankai'

type NotificationSettings = Pick<
  AppSettings,
  'notifyEnabled' | 'notifyQuake' | 'notifyMinScale' | 'notifyDetection' | 'notifyEEW' | 'notifyTsunami' | 'notifyNankai'
>

/**
 * その種類のブラウザ通知を出してよいか。
 *
 * **ブラウザ通知を出す場所はすべてここを通す。** まとめて止める設定（`notifyEnabled`）を場所ごとに
 * 書き足すと、どこかで書き忘れた種類だけが止まらずに出続ける。
 *
 * 地震情報（`quake`）の最低震度の判定は含まない。判定は報ごとに `decideQuakeNotification` が行う
 * （渡す閾値は `effectiveNotifyMinScale`）。
 */
export function notificationAllowed(settings: NotificationSettings, kind: NotificationKind): boolean {
  if (!settings.notifyEnabled) return false
  switch (kind) {
    case 'quake': return settings.notifyQuake
    case 'detection': return settings.notifyDetection
    case 'eew': return settings.notifyEEW
    case 'tsunami': return settings.notifyTsunami
    case 'nankai': return settings.notifyNankai
  }
}

/** 地震情報の通知を判定する閾値。通知しないときは -1（`decideQuakeNotification` の取り決め）。 */
export function effectiveNotifyMinScale(settings: NotificationSettings): number {
  return notificationAllowed(settings, 'quake') ? settings.notifyMinScale : -1
}
