/**
 * 津波の電文に書いてある「取りうる値が決まっている語」を、日本語以外の言語へ訳す組み立て。
 * 訳すのは等級の名前・予想の高さの語（巨大・高い・10ｍ超・以上・未満）・第 1 波の押し引き・運用の種別（訓練・試験）
 * （2026-11-10 ユーザー選択「決まった語は訳す (Recommended)」）。**表に無い値は電文の語のまま返す**
 * （気象庁が語を足しても、訳せないだけで消えない）。高さの数字（「１ｍ」）は電文のまま残す。
 *
 * 言語ごとの語は各辞書が {@link TsunamiTermWords} として渡す。日本語の辞書はこれを使わない（電文の語をそのまま出す）。
 */
export interface TsunamiTermWords {
  grade: { MajorWarning: string; Warning: string; Watch: string; Forecast: string }
  /** 電文の「津波なし」 */
  noTsunami: string
  /** 「大津波警報：発表」の形 */
  issued: (grade: string) => string
  /** 「津波注意報解除」の形 */
  lifted: (grade: string) => string
  huge: string
  high: string
  over10m: string
  /** 「１ｍ以上」の形 */
  orMore: (height: string) => string
  /** 「０．２ｍ未満」の形 */
  under: (height: string) => string
  initialRise: string
  initialDrop: string
  drill: string
  test: string
}

const GRADE_OF_NAME: Record<string, keyof TsunamiTermWords['grade']> = {
  大津波警報: 'MajorWarning',
  津波警報: 'Warning',
  津波注意報: 'Watch',
  '津波予報（若干の海面変動）': 'Forecast',
}

/** 電文の等級の名前（`Kind/Name`・`LastKind/Name`）を訳す。 */
export function translateKindName(name: string, w: TsunamiTermWords): string {
  const base = GRADE_OF_NAME[name]
  if (base) return w.grade[base]
  if (name === '津波なし') return w.noTsunami
  const issued = /^(.+)：発表$/.exec(name)
  if (issued && GRADE_OF_NAME[issued[1]]) return w.issued(w.grade[GRADE_OF_NAME[issued[1]]])
  const lifted = /^(.+)解除$/.exec(name)
  if (lifted && GRADE_OF_NAME[lifted[1]]) return w.lifted(w.grade[GRADE_OF_NAME[lifted[1]]])
  return name
}

/** 予想・観測の高さの語を訳す。`over` は電文が上限を定めない値と名乗っているか（日本語の「以上」に当たる）。 */
export function translateHeight(description: string, over: boolean, w: TsunamiTermWords): string {
  if (description === '巨大') return w.huge
  if (description === '高い') return w.high
  if (description === '１０ｍ超' || description === '10m超') return w.over10m
  if (description.endsWith('未満')) return w.under(description.slice(0, -2))
  if (description.endsWith('以上')) return w.orMore(description.slice(0, -2))
  if (over && /[\d０-９]/.test(description)) return w.orMore(description)
  return description
}

/** 第 1 波の押し引き（電文の `Initial`）を訳す。 */
export function translateInitialWave(initial: string, w: TsunamiTermWords): string {
  if (initial === '押し') return w.initialRise
  if (initial === '引き') return w.initialDrop
  return initial
}

/** 運用の種別（電文の `Control/Status`。訓練・試験のときだけ札を出す）を訳す。 */
export function translateOperationStatus(status: string, w: TsunamiTermWords): string {
  if (status === '訓練') return w.drill
  if (status === '試験') return w.test
  return status
}
