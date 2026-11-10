import type { AppSettings } from '../hooks/useSettings'

/** ブラウザ通知の種類。設定の窓の種類ごとのトグルと 1 対 1 で対応する。 */
export type NotificationKind = 'quake' | 'detection' | 'eew' | 'tsunami' | 'nankai' | 'nankaiRoutine' | 'quakeNotice'

type NotificationSettings = Pick<
  AppSettings,
  'notifyEnabled' | 'notifyQuake' | 'notifyMinScale' | 'notifyDetection' | 'notifyEEW' | 'notifyTsunami' | 'notifyNankai'
  | 'notifyNankaiRoutine' | 'notifyQuakeNotice'
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
    case 'nankaiRoutine': return settings.notifyNankaiRoutine
    case 'quakeNotice': return settings.notifyQuakeNotice
  }
}

/** 地震情報の通知を判定する閾値。通知しないときは -1（`decideQuakeNotification` の取り決め）。 */
export function effectiveNotifyMinScale(settings: NotificationSettings): number {
  return notificationAllowed(settings, 'quake') ? settings.notifyMinScale : -1
}

/**
 * 通知が関わる都道府県（2 桁のコード）が、設定「通知する地域」に入っているか。地域を選んでいなければ全国。
 * `null` は地域で絞らない通知（南海トラフなど）。中継のプッシュ通知も同じ判定をする（docs/relay-server-design.md §6.7）。
 */
export function notificationRegionAllowed(settings: Pick<AppSettings, 'notifyPrefectures'>, prefectures: readonly string[] | null): boolean {
  if (prefectures === null || settings.notifyPrefectures.length === 0) return true
  return prefectures.some(p => settings.notifyPrefectures.includes(p))
}

/**
 * 震度を持たない国内の地震の報を、地域で絞っているので出さないか。震度の無い報は県を読めない（`notificationRegionAllowed` では
 * 絞らない扱いになる）が、地域を選んでいれば、どの県でも震度を観測していないので出さない。後から選んだ県で震度を観測した報が来れば、
 * そのとき通知する（2026-11-09 ユーザー選択「地域を選んでいれば出さない (Recommended)」）。遠地地震は震度に関係なく出す。
 */
export function noIntensityQuakeHiddenByRegion(
  settings: Pick<AppSettings, 'notifyPrefectures'>,
  quake: { readonly earthquake: { readonly maxScale: number }; readonly issue: { readonly type: string } },
): boolean {
  return settings.notifyPrefectures.length > 0 && quake.earthquake.maxScale < 0 && quake.issue.type !== '遠地地震'
}
