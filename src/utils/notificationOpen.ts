/**
 * 通知を押したときの開き先（docs/relay-server-design.md §6.7「押したときの開き先」）。
 *
 * 通知の中身を作る共用の部品（地震情報・緊急地震速報・津波・長周期・推計）が、題・本文と一緒にこれを返す。
 * **中継のプッシュ通知と画面内の通知が同じ開き方になる**よう、どちらも同じ部品から引く（中継へは写して使う）。
 * 運ぶときは {@link notificationOpenQuery} で URL の問い合わせの形（`open=earthquake&quake=…`）へ直す ——
 * Service Worker（`public/sw-notification-click.js`）はこの文字列を読まずに、開いている画面へ渡すか、
 * アプリの URL に付けて開くだけにする。読むのはアプリの {@link parseNotificationOpen} だけ。
 *
 * 2026-11-05 ユーザー選択「開き先を通知に持たせる (Recommended)」「地震カードに付く情報まで (Recommended)」。
 * 南海トラフ・後発・地震回数・関連解説は、どの画面でも地図の上に帯が出ているので開き先を持たない（`null`）。
 */
export type NotificationOpen =
  | { readonly tab: 'realtime' }
  | { readonly tab: 'tsunami' }
  /** 地震タブで、その地震カード（鍵は `quakeEventKey`）を選ぶ */
  | { readonly tab: 'earthquake'; readonly quake: string }
  /** 地震タブで、その長周期地震動の観測情報（電文の `eventId`）の地震を選び、長周期の表示を開く */
  | { readonly tab: 'earthquake'; readonly lpgm: string }
  /**
   * 地震タブで、その推計震度分布図（地震発現時刻と震源）の地震を選び、分布を開く。震源が読めない報は時刻だけで
   * 当てる（`matchEstimatedIntensityArrival` と同じ）
   */
  | { readonly tab: 'earthquake'; readonly estimated: string; readonly lat?: number; readonly lon?: number }
  /**
   * 地震タブで、その国際津波関連情報（英文の発生時刻 `ORIGIN TIME` と震央）が付く地震カードを選ぶ。付く先は画面の結び付け
   * （`internationalTsunamiIndex`）と同じ規則で引く —— 中継は地震カードを持たないので、カードの鍵では指せない
   */
  | { readonly tab: 'earthquake'; readonly wepa60: string; readonly lat?: number; readonly lon?: number }

export const OPEN_REALTIME: NotificationOpen = { tab: 'realtime' }
export const OPEN_TSUNAMI: NotificationOpen = { tab: 'tsunami' }

/** 問い合わせに使う名前。アプリの URL から開き先を取り除くとき（{@link withoutNotificationOpen}）もこれを見る */
const PARAM_NAMES = ['open', 'quake', 'lpgm', 'estimated', 'wepa60', 'lat', 'lon'] as const

/** 開き先を URL の問い合わせの形へ直す（先頭の `?` は付けない）。開き先が無ければ空文字 */
export function notificationOpenQuery(open: NotificationOpen | null): string {
  if (open === null) return ''
  const q = new URLSearchParams({ open: open.tab })
  const setEpicenter = (lat?: number, lon?: number) => {
    if (lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon)) {
      q.set('lat', String(lat))
      q.set('lon', String(lon))
    }
  }
  if ('quake' in open) q.set('quake', open.quake)
  else if ('lpgm' in open) q.set('lpgm', open.lpgm)
  else if ('estimated' in open) {
    q.set('estimated', open.estimated)
    setEpicenter(open.lat, open.lon)
  } else if ('wepa60' in open) {
    q.set('wepa60', open.wepa60)
    setEpicenter(open.lat, open.lon)
  }
  return q.toString()
}

/**
 * URL の問い合わせ（`?` があってもなくてもよい）から開き先を読む。読めなければ `null`。
 * 外から渡る値なので、形が合わないものは開き先ごと捨てる（タブだけ移す、のように半端に効かせない）。
 */
export function parseNotificationOpen(search: string): NotificationOpen | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const tab = q.get('open')
  if (tab === 'realtime') return OPEN_REALTIME
  if (tab === 'tsunami') return OPEN_TSUNAMI
  if (tab !== 'earthquake') return null
  const quake = q.get('quake')
  if (quake) return { tab, quake }
  const lpgm = q.get('lpgm')
  if (lpgm) return { tab, lpgm }
  // `Number(null)` は 0 なので、値があるかも見る。片方だけ・数でないものは震源ごと捨てて時刻だけで当てる
  const lat = Number(q.get('lat'))
  const lon = Number(q.get('lon'))
  const epicenter = q.get('lat') && q.get('lon') && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}
  const estimated = q.get('estimated')
  if (estimated) return { tab, estimated, ...epicenter }
  const wepa60 = q.get('wepa60')
  if (wepa60) return { tab, wepa60, ...epicenter }
  return null
}

/**
 * 問い合わせから開き先の名前だけを取り除いた形（`?` 付き。残るものが無ければ空文字）。
 * **`open` が無ければ何も取り除かない**（`quake`・`lat` のような名前を、通知と関係の無い問い合わせから消さない）。
 */
export function withoutNotificationOpen(search: string): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (!q.has('open')) return search
  for (const name of PARAM_NAMES) q.delete(name)
  const rest = q.toString()
  return rest ? `?${rest}` : ''
}
