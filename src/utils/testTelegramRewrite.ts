// テストボタンの台本で、実電文の一部を書き換えるための部品（→ `testTelegrams.ts` の `rewrite`）。
//
// **文字列の置換ではなく DOM で書き換える。** 観測点を抜く・震度を上げるといった書き換えは
// 要素の入れ子（都道府県 → 区域 → 市町村 → 観測点）をまたぐので、正規表現では壊れやすい。
// パーサー（`dmdataParser.ts`）と同じ `DOMParser` で読み、`XMLSerializer` で書き戻す。
//
// **見つからなければ例外にする。** 書き換え先が無いまま黙って元の電文を流すと、確かめたい形が
// 一度も出ないのに気づけない。

/** 電文を読んで書き換え、文字列へ戻す。 */
export function editXml(xml: string, edit: (doc: Document) => void): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('テスト用の電文を XML として読めませんでした')
  }
  edit(doc)
  return new XMLSerializer().serializeToString(doc)
}

/** 名前空間を問わず、要素名で子孫を集める。 */
export function descendants(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName))
}

/** 直下の子のうち、その名前のもの。 */
export function childOf(el: Element, localName: string): Element | undefined {
  return Array.from(el.children).find(c => c.localName === localName)
}

/** 直下の子の文字列（無ければ undefined）。 */
export function childText(el: Element, localName: string): string | undefined {
  return childOf(el, localName)?.textContent ?? undefined
}

/** ただ 1 つの要素を取る（0 個・2 個以上なら例外）。 */
export function only(root: Document | Element, localName: string): Element {
  const found = descendants(root, localName)
  if (found.length !== 1) throw new Error(`テスト用の電文の <${localName}> が ${found.length} 個ありました（1 個であるべき）`)
  return found[0]
}

/** `Control` か `Head` の直下の欄を書き換える（例: `Control` の `DateTime`、`Head` の `Serial`）。 */
export function setSectionText(doc: Document, section: 'Control' | 'Head', localName: string, value: string): void {
  const parent = only(doc, section)
  const el = childOf(parent, localName)
  if (!el) throw new Error(`テスト用の電文の <${section}> に <${localName}> がありません`)
  el.textContent = value
}

/**
 * 同じ実電文を 2 回流すときの、発表時刻の付け替え。
 *
 * **電文の一意鍵（`Control/Title` と `Control/DateTime` の組）が重ならないようにする。** 重なると
 * 2 通目が「同じ電文の再送」として数えられない（→ `utils/telegramKey.ts`）。報の発表時刻
 * （`Head/ReportDateTime`）も同じだけ進める —— 片方だけ進めると、報の新旧の比べ方
 * （作成時刻）と画面の発表時刻が食い違う。
 */
export function shiftIssueTime(doc: Document, seconds: number): void {
  const control = only(doc, 'Control')
  const dateTime = childOf(control, 'DateTime')
  const head = only(doc, 'Head')
  const report = childOf(head, 'ReportDateTime')
  if (!dateTime || !report) throw new Error('テスト用の電文に発表時刻（Control/DateTime・Head/ReportDateTime）がありません')
  dateTime.textContent = shiftIso(dateTime.textContent ?? '', seconds)
  report.textContent = shiftIsoKeepingZone(report.textContent ?? '', seconds)
}

/**
 * 別の事象の電文（サンプルの取消など）を、元にした報の事象へ付け替える。
 *
 * **取消は事象の識別子（`EventID`）で対象を探す**ので、ここが食い違うと何も取り消さない。発表時刻も
 * 元にした報の少し後へ置き直す —— 別の年の時刻のまま流すと、時刻のずらし（1 つの差分）で
 * 何年も先の報になる。
 *
 * @param controlIso 電文の作成時刻（`Control/DateTime`。UTC の `Z` 付き）
 */
export function moveToEvent(doc: Document, eventId: string, controlIso: string): void {
  setSectionText(doc, 'Head', 'EventID', eventId)
  setSectionText(doc, 'Control', 'DateTime', controlIso)
  const jst = new Date(new Date(controlIso).getTime() + 9 * 3600_000).toISOString().slice(0, 16)
  const head = only(doc, 'Head')
  for (const tag of ['ReportDateTime', 'TargetDateTime']) {
    const el = childOf(head, tag)
    if (el) el.textContent = `${jst}:00+09:00`
  }
}

/**
 * 発表時刻を**絶対の時刻で置く**（`Control/DateTime`・`Head/ReportDateTime`・`Head/TargetDateTime`）。
 *
 * **元の時刻がばらばらな電文を 1 本の時間軸へ並べるときに使う。** `shiftIssueTime` は元の時刻
 * からの差で動かすので、別々の報（観測情報と満潮時刻の情報など）を混ぜると並びが崩れる ——
 * 崩れると、後の報が前の報より古い作成時刻になり、受け手が**作成時刻の順に並べ直して重ね直す**
 * （→ `utils/tsunami.ts` の `arrivesOutOfOrder`）。台本が狙った「1 つずつ動かす」形が画面に出ない。
 *
 * **`TargetDateTime` も同じ差で動かす。** 置き去りにすると、発表時刻より後の「観測状況を
 * 確定した時刻」になり、**まだ来ていない波を観測した**ことになる（→ docs/spec/tsunami-spec.md §4）。
 * 報の中の時間差は保つので、観測点の実測との前後も崩れない。
 *
 * @param iso 置く時刻（UTC の `Z` 付き）
 */
export function setIssueTime(doc: Document, iso: string): void {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) throw new Error(`テスト用の電文へ置く時刻を読めませんでした: ${iso}`)
  const control = only(doc, 'Control')
  const before = Date.parse(childText(control, 'DateTime') ?? '')
  if (!Number.isFinite(before)) throw new Error('テスト用の電文に作成時刻（Control/DateTime）がありません')
  setSectionText(doc, 'Control', 'DateTime', iso)
  const head = only(doc, 'Head')
  const report = childOf(head, 'ReportDateTime')
  if (!report) throw new Error('テスト用の電文に発表時刻（Head/ReportDateTime）がありません')
  report.textContent = `${new Date(ms + 9 * 3600_000).toISOString().slice(0, 19)}+09:00`
  const target = childOf(head, 'TargetDateTime')
  if (target) target.textContent = shiftIsoKeepingZone(target.textContent ?? '', (ms - before) / 1000)
}

function shiftIso(iso: string, seconds: number): string {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) throw new Error(`テスト用の電文の時刻を読めませんでした: ${iso}`)
  return new Date(ms + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** `+09:00` 付きの時刻を、同じ時間帯の表記のまま進める（電文の `ReportDateTime` の形を崩さない）。 */
function shiftIsoKeepingZone(iso: string, seconds: number): string {
  const m = iso.match(/^(.*)([+-]\d{2}):(\d{2})$/)
  if (!m) return shiftIso(iso, seconds)
  const offsetMin = (m[2].startsWith('-') ? -1 : 1) * (Math.abs(Number(m[2])) * 60 + Number(m[3]))
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) throw new Error(`テスト用の電文の時刻を読めませんでした: ${iso}`)
  const local = new Date(ms + seconds * 1000 + offsetMin * 60_000).toISOString().slice(0, 19)
  return `${local}${m[2]}:${m[3]}`
}

/**
 * 追加・更新の印（`Revise`）をすべて外す。
 *
 * **「前の報と何が違うか」を台本が決めるために使う。** 気象庁は続報のたびに、前の報から動いた
 * 項目へ `Revise`（追加・更新）を付けるが、サンプル電文はその時点の印を持っている。別の報として
 * 流し直すときは、いったん外して、動かす項目にだけ付け直す。
 */
export function stripRevise(doc: Document): void {
  for (const r of descendants(doc, 'Revise')) r.remove()
}

/**
 * 緊急地震速報の最終報の文言（`Body/NextAdvisory`）。**実電文の原文**（2024-06-02 能登の
 * 控えで確認。同じ文が 2 通にあった）。パーサーは「最終報」を含むかで `isFinal` を立てる。
 */
export const EEW_FINAL_ADVISORY = 'この情報をもって、緊急地震速報：最終報とします。'

/** 緊急地震速報を最終報にする（`Body/NextAdvisory` を足す）。 */
export function toFinalEew(doc: Document): void {
  const body = only(doc, 'Body')
  if (childOf(body, 'NextAdvisory')) throw new Error('テスト用の電文は既に最終報です')
  const next = doc.createElementNS(body.namespaceURI, 'NextAdvisory')
  next.textContent = EEW_FINAL_ADVISORY
  body.appendChild(next)
}

/** 見出しの文（`Head/Headline/Text`）を書き換える。 */
export function setHeadlineText(doc: Document, text: string): void {
  const head = only(doc, 'Head')
  const headline = childOf(head, 'Headline')
  const el = headline && childOf(headline, 'Text')
  if (!el) throw new Error('テスト用の電文に見出しの文（Head/Headline/Text）がありません')
  el.textContent = text
}

/**
 * 発表報を、同じ報を取り消す電文の形へ書き換える。
 *
 * **気象庁の取消電文はどの種別も同じ形をしている**（サンプル電文の取消 7 通で確かめた。
 * 地震回数・お知らせ・南海トラフ臨時情報・津波の 3 種別）—— `InfoType` が「取消」、見出しは
 * 「〜を取り消します。」の 1 文だけ（構造化した `Information` は持たない）、本文は `Body/Text` の
 * 「先ほどの、〜を取り消します。」1 文だけ。サンプルに取消の無い種別（後発地震注意情報・
 * 長周期地震動に関する観測情報）はこの形にならって作る。
 *
 * @param name 取り消す情報の名前（「長周期地震動に関する観測情報」など）
 */
export function toCancelForm(doc: Document, name: string): void {
  setSectionText(doc, 'Head', 'InfoType', '取消')
  const head = only(doc, 'Head')
  const headline = childOf(head, 'Headline')
  if (!headline) throw new Error('テスト用の電文に見出し（Head/Headline）がありません')
  for (const c of Array.from(headline.children)) c.remove()
  const headlineText = doc.createElementNS(headline.namespaceURI, 'Text')
  headlineText.textContent = `${name}を取り消します。`
  headline.appendChild(headlineText)
  const body = only(doc, 'Body')
  for (const c of Array.from(body.childNodes)) c.remove()
  const bodyText = doc.createElementNS(body.namespaceURI, 'Text')
  bodyText.textContent = `先ほどの、${name}を取り消します。`
  body.appendChild(bodyText)
}

/** 津波の等級コード（`Kind/Code`）を、その等級の解除コードへ。予報（71〜73）は解除の報に載らない。 */
const TSUNAMI_LIFT_CODE: Readonly<Record<string, { code: string; name: string }>> = {
  '52': { code: '50', name: '大津波警報解除' },
  '53': { code: '50', name: '大津波警報解除' },
  '51': { code: '50', name: '津波警報解除' },
  '62': { code: '60', name: '津波注意報解除' },
}

/**
 * 津波警報・注意報・予報（VTSE41）の発表報を、**全区域を解除する報**の形へ書き換える。
 *
 * 形は気象庁のサンプル電文（2015-11-14 薩摩半島西方沖の 38-39_02_04）に倣う —— `InfoType` は
 * 「発表」のまま、警報・注意報の区域の等級を解除のコード（50・60）にし、前回の等級（`LastKind`）に
 * 元の等級を残す。**予報だけの区域は載せない。** 固定付加文は 0107「現在、大津波警報・津波警報・
 * 津波注意報を発表している沿岸はありません。」だけにする。見出しの構造化した `Information` は外す。
 *
 * **段階を飛ばした解除は実配信では起きにくい**（大津波警報はふつう津波警報・注意報を経て解除される）。
 * テストボタンが表示を片付けるための報なので、そこは割り切る。
 *
 * @param options.includeForecast 予報の区域も「津波なし（00）」として載せる。**予報だけの津波を
 *   標準版で片付けるときだけ使う** —— 気象庁は予報の終わりに電文を出さず（DMDSS 版は失効時刻で消える）、
 *   この形は実配信に無い。標準版は失効の予約を持たないので、片付けの報が要る
 */
export function toAllLifted(doc: Document, options: { includeForecast?: boolean } = {}): void {
  const head = only(doc, 'Head')
  const title = childOf(head, 'Title')
  if (title) title.textContent = '津波予報'
  const headline = childOf(head, 'Headline')
  if (headline) {
    for (const c of Array.from(headline.children)) if (c.localName !== 'Text') c.remove()
    const text = childOf(headline, 'Text')
    if (text) text.textContent = '津波警報等を解除しました。'
  }
  const forecast = only(doc, 'Forecast')
  for (const item of Array.from(forecast.children).filter(c => c.localName === 'Item')) {
    const category = childOf(item, 'Category')
    const kind = category && childOf(category, 'Kind')
    const code = kind ? childText(kind, 'Code') : undefined
    const lift = code
      ? TSUNAMI_LIFT_CODE[code] ?? (options.includeForecast && /^7[123]$/.test(code) ? { code: '00', name: '津波なし' } : undefined)
      : undefined
    if (!kind || !category || !lift) { item.remove(); continue }
    const kindName = childText(kind, 'Name') ?? ''
    // 前回の等級を元の等級にする（無ければ作る）
    let last = childOf(category, 'LastKind')
    if (!last) {
      last = doc.createElementNS(category.namespaceURI, 'LastKind')
      for (const tag of ['Name', 'Code']) last.appendChild(doc.createElementNS(category.namespaceURI, tag))
      category.appendChild(last)
    }
    childOf(last, 'Name')!.textContent = kindName
    childOf(last, 'Code')!.textContent = code!
    childOf(kind, 'Name')!.textContent = lift.name
    childOf(kind, 'Code')!.textContent = lift.code
    // 解除の報は到達予想・予想波高を持たない
    for (const c of Array.from(item.children)) if (c.localName === 'FirstHeight' || c.localName === 'MaxHeight') c.remove()
  }
  const body = only(doc, 'Body')
  const comments = childOf(body, 'Comments')
  if (comments) {
    for (const c of Array.from(comments.children)) c.remove()
    const warning = doc.createElementNS(comments.namespaceURI, 'WarningComment')
    warning.setAttribute('codeType', '固定付加文')
    const text = doc.createElementNS(comments.namespaceURI, 'Text')
    text.textContent = '現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。'
    const code = doc.createElementNS(comments.namespaceURI, 'Code')
    code.textContent = '0107'
    warning.append(text, code)
    comments.appendChild(warning)
  }
}

/** 震度の並び（弱い順）。電文の `Int` / `MaxInt` の値。 */
export const INT_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'] as const
type IntValue = typeof INT_ORDER[number]

function rankOf(value: string | undefined): number {
  return value === undefined ? -1 : INT_ORDER.indexOf(value as IntValue)
}

/** 1 段上げた値（7 はそのまま）。 */
export function raiseInt(value: string): string {
  const i = rankOf(value)
  if (i < 0) throw new Error(`震度として読めません: ${value}`)
  return INT_ORDER[Math.min(i + 1, INT_ORDER.length - 1)]
}

/** 1 段下げた値（1 はそのまま）。 */
export function lowerInt(value: string): string {
  const i = rankOf(value)
  if (i < 0) throw new Error(`震度として読めません: ${value}`)
  return INT_ORDER[Math.max(i - 1, 0)]
}

/** 震度の値を持つ観測点（未入電は除く）。 */
export function stationsWithInt(doc: Document): Element[] {
  return descendants(doc, 'IntensityStation').filter(s => rankOf(childText(s, 'Int')) >= 0)
}

/**
 * 観測点を書き換えたあと、市町村・区域・都道府県・全体の最大震度を配下から取り直す。
 *
 * **実電文と同じく、上の段の値は配下の最大になる。** 観測点だけを動かすと、区域の行と食い違う。
 * 配下に震度の値が 1 つも無い段（すべて未入電）は `MaxInt` を外す —— 気象庁は配下がすべて
 * 未入電のとき上の段の `MaxInt` を載せない（電文解説資料 Ⅱ.33 2-1-3-3-1）。
 */
export function recomputeMaxInts(doc: Document): void {
  const levels: [string, string][] = [['City', 'IntensityStation'], ['Area', 'City'], ['Pref', 'Area'], ['Observation', 'Pref']]
  for (const [parentName, childName] of levels) {
    for (const parent of descendants(doc, parentName)) {
      const kids = Array.from(parent.children).filter(c => c.localName === childName)
      // 配下を持たない段（震度速報の区域など）は触らない
      if (kids.length === 0) continue
      const valueTag = childName === 'IntensityStation' ? 'Int' : 'MaxInt'
      const best = kids.map(k => childText(k, valueTag)).reduce<string | undefined>(
        (max, v) => (rankOf(v) > rankOf(max) ? v : max), undefined,
      )
      const maxInt = childOf(parent, 'MaxInt')
      if (best === undefined) {
        maxInt?.remove()
      } else if (maxInt) {
        maxInt.textContent = best
      } else {
        throw new Error(`テスト用の電文の <${parentName}> に <MaxInt> がありません（取り直す先が無い）`)
      }
    }
  }
}
