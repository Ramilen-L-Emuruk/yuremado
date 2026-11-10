import type { TelegramLogEntry, TelegramLogKind, TelegramOrigin } from '../../types/earthquake'
import { log } from '../../utils/logger'
import { TELEGRAM_KIND_OF_HEAD_TYPE } from '../../services/dmdataTelegramPayload'
import { ja } from '../../i18n/messages/ja'
import type { Messages } from '../../i18n/messages'

/**
 * 電文種別コードから引く種別名。名前は気象庁の情報名に揃える。
 *
 * **扱うコードはすべてここに載せる。** 鍵がコードの文字列なので、書き漏らしても型検査には
 * 掛からず、行にはコードだけが出る。漏れは `labels.test.ts` が、アプリが扱う種別の集合
 * （`dmdataTelegramPayload.ts`）と突き合わせて落とす。
 *
 * **扱わないコードの行にコードだけが出るのは正しい。** DMDATA は試験報を捨てるとき
 * （`includeTest` が無効）に種別を問わず記録する。
 * これらに名前を付ける必要はない。引くときは `headTypeLabel` を通す。
 *
 * VYSE51・VYSE52 の括弧書きは、気象庁の情報番号コード（`InfoSerial` の 210・219 が「臨時解説」、
 * 200 が「定例解説」）の名前から取っている。データ種類コードの表ではどちらも括弧の無い
 * 「南海トラフ地震関連解説情報」（2026-10-15 ユーザー承認）。
 *
 * VXSE43 は、予報が無く警報だけを受けている人には緊急地震速報そのもの。予報を受けている人には
 * 購読外だが、配信分類が変わって届いた場合に `filtered` として記録する（services/dmdata.ts）。
 *
 * 緊急地震速報の行は種別で引くので、特別警報の条件を満たした報も特別警報とは出ない
 * （2026-10-21 ユーザー承認「今のまま記録する (Recommended)」）。
 */
export const HEAD_TYPE_LABEL: Readonly<Record<string, string>> = ja.telegramLog.headType

/** 種別名。載っていないコードはコードそのものを返す（継承したキーは引かない）。 */
export function headTypeLabel(headType: string): string {
  return Object.prototype.hasOwnProperty.call(HEAD_TYPE_LABEL, headType) ? HEAD_TYPE_LABEL[headType] : headType
}

/**
 * 電文の Control/Title。`Control` の中だけを見る（Head にも同名の Title がある）。開始タグの属性と接頭辞は、
 * 訓練・試験の読み取り（`utils/telegramOperationStatus.ts`）と同じく許す。
 */
const CONTROL_BLOCK = /<(?:[\w.-]+:)?Control\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Control>/
const TITLE = /<(?:[\w.-]+:)?Title\b[^>]*>\s*([^<]*?)\s*<\/(?:[\w.-]+:)?Title>/

/** 一度読んだ行の題名（読めなければ null。行は作られた後に書き換えない）。2,022 行を描くたびに本文をなめ直さない。 */
const titleCache = new WeakMap<object, string | null>()

/** 本文の Control/Title。XML でない・読めない・空なら null。 */
function controlTitleOf(entry: Pick<TelegramLogEntry, 'rawBody'>): string | null {
  const cached = titleCache.get(entry)
  if (cached !== undefined) return cached
  const body = entry.rawBody
  const control = typeof body === 'string' && body.trimStart().startsWith('<') ? CONTROL_BLOCK.exec(body)?.[1] : undefined
  const title = (control === undefined ? undefined : TITLE.exec(control)?.[1]) || null
  titleCache.set(entry, title)
  return title
}

/**
 * 行に出す名前（日本語）。XML の電文は本文の Control/Title をそのまま出す（2026-11-04 ユーザー選択「電文の Title を
 * そのまま (Recommended)」）。Title が読めない行（二進の推計震度分布図・復号に失敗した base64・捨てた試験報）は
 * 種別名（{@link headTypeLabel}）を出す。画面はいま出している言語で引く {@link localizedTelegramTitle} を使う。
 */
export function telegramTitleOf(entry: Pick<TelegramLogEntry, 'headType' | 'rawBody'>): string {
  return controlTitleOf(entry) || headTypeLabel(entry.headType)
}

/** 電文ログの辞書（`Messages['telegramLog']`）。 */
export type TelegramLogMessages = Messages['telegramLog']

/** 表に鍵があればその値。継承したキーは引かない。 */
function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

/**
 * 行に出す名前を、いま出している言語で。電文の題名は `controlTitle` で引き、表に無い題名は電文の文字のまま。
 * 題名の読めない行は電文種別コードで `headType` を引き、表に無いコードはコードのまま。
 */
export function localizedTelegramTitle(entry: Pick<TelegramLogEntry, 'headType' | 'rawBody'>, tm: TelegramLogMessages): string {
  const title = controlTitleOf(entry)
  if (title) return lookup(tm.controlTitle, title) ?? title
  return lookup(tm.headType, entry.headType) ?? entry.headType
}

/** 行の赤字の欄。受信の側が入れた印を `errorMessage` で引き、表に無い印はそのまま出す。 */
export function localizedErrorMessage(message: string, tm: TelegramLogMessages): string {
  return lookup(tm.errorMessage, message) ?? message
}

/**
 * 行の前段に出す短い名前。**書いた順が、種別の絞り込みの選択肢の並びになる**
 * （`KIND_OPTIONS`）。`Record<TelegramLogKind, string>` なので、種別を足して書き忘れると
 * 型エラーになり、選択肢にも自動で並ぶ。
 */
export const KIND_LABEL: Readonly<Record<TelegramLogKind, string>> = ja.telegramLog.kind

/**
 * 電文種別コードが属する種別。**独自の表は持たず、受信の振り分けが引く表**
 * （`dmdataTelegramPayload.ts` の `TELEGRAM_KIND_OF_HEAD_TYPE`）**を引く**。
 * 読めた行と読めなかった行が同じ絞り込みに入るのはこのため。
 */
const KIND_OF_HEAD_TYPE: ReadonlyMap<string, TelegramLogKind> = new Map<string, TelegramLogKind>([
  ...TELEGRAM_KIND_OF_HEAD_TYPE,
])

/**
 * 行の種別。読めた行は読んだ結果の `kind` を使い、持たない行（結合待ちの断片・読み取りに
 * 失敗した行・捨てた試験報）は電文種別コードから引く。どちらも無ければ `undefined`
 * （扱わないコード）。種別での絞り込みに断片や失敗した行も含めるため（2026-10-15 ユーザー承認）。
 */
export function telegramLogKindOf(entry: Pick<TelegramLogEntry, 'kind' | 'headType'>): TelegramLogKind | undefined {
  return entry.kind ?? KIND_OF_HEAD_TYPE.get(entry.headType)
}

/** 種別の絞り込みに並べる種別。`KIND_LABEL` から作るので、漏れが起きない。 */
export const KIND_OPTIONS = Object.keys(KIND_LABEL) as readonly TelegramLogKind[]

/** 種別の絞り込み。種別のほかに、読み取りの結果（スキップ・エラー）でも絞れる。 */
export type KindFilter = 'all' | TelegramLogKind | 'filtered' | 'error'

/**
 * `<select>` の値を絞り込みとして読む。知らない値は「全種別」へ倒し、記録を残す
 * （選択肢の値と読む側がずれたとき、絞り込みが黙って効かなくなるのを見分けるため）。
 */
export function readKindFilter(value: string): KindFilter {
  if (value === 'all' || value === 'filtered' || value === 'error') return value
  if ((KIND_OPTIONS as readonly string[]).includes(value)) return value as TelegramLogKind
  log.warn(`[TelegramTab] 種別の絞り込みに知らない値が来たので全種別にした: ${value}`)
  return 'all'
}

/** 経路の絞り込み（ライブで届いたのか、こちらが流したのか）。 */
export type OriginFilter = 'all' | TelegramOrigin

/** 経路の絞り込みの選択肢（並び順）。名前は {@link originFilterLabel}。 */
export const ORIGIN_OPTIONS: readonly OriginFilter[] = ['all', 'live', 'test', 'replay']

/** 経路の絞り込みの名前（いま出している言語で）。 */
export function originFilterLabel(origin: OriginFilter, tm: TelegramLogMessages): string {
  return origin === 'all' ? tm.allOrigins : tm.origin[origin]
}

/**
 * `<select>` の値を経路の絞り込みとして読む。知らない値は「すべての経路」へ倒し、記録を残す
 * （理由は `readKindFilter` と同じ）。
 */
export function readOriginFilter(value: string): OriginFilter {
  if ((ORIGIN_OPTIONS as readonly string[]).includes(value)) return value as OriginFilter
  log.warn(`[TelegramTab] 経路の絞り込みに知らない値が来たのですべての経路にした: ${value}`)
  return 'all'
}

/**
 * 行に出す経路の印（経路の鍵。名前は辞書の `origin` で引く）。ライブは印を出さない（既定の経路なので、
 * 付けると全行が賑やかになる）。
 */
export function originBadgeOf(origin: TelegramOrigin): Exclude<TelegramOrigin, 'live'> | null {
  return origin === 'live' ? null : origin
}

/**
 * 訓練・試験の印。**訓練と試験を同じ印にしない** —— 毎正時の配信テスト（VXSE42 の「試験」）まで
 * 「訓練」と出ていて、年に数回の訓練の電文が埋もれていた（2026-10-23 ユーザー選択「種別名を出し、
 * 訓練と試験を分ける (Recommended)」）。
 *
 * 本文の名乗り（`operationStatus`）を先に見る。名乗りが読めず配信元が試験報の印（`isTest`）だけを
 * 立てているときは、どちらか言えないので「訓練・試験」と出す。
 *
 * `key` は辞書の `operation` の鍵（画面はこれで引く）。`label` は日本語の名前。
 */
export function operationBadgeOf(
  entry: Pick<TelegramLogEntry, 'operationStatus' | 'isTest'>,
): { key: keyof TelegramLogMessages['operation']; label: string; className: string } | null {
  const op = ja.telegramLog.operation
  if (entry.operationStatus === '訓練') return { key: 'drill', label: op.drill, className: 'bg-sky-400/20 text-sky-200' }
  if (entry.operationStatus === '試験') return { key: 'test', label: op.test, className: 'bg-violet-400/20 text-violet-200' }
  if (entry.isTest) return { key: 'drillOrTest', label: op.drillOrTest, className: 'bg-white/10 text-secondary' }
  return null
}

/** その行が絞り込みに当たるか。 */
export function matchesTelegramFilter(
  entry: Pick<TelegramLogEntry, 'origin' | 'status' | 'kind' | 'headType'>,
  kind: KindFilter,
  // **任意（`?`）にしない。** 既定値を置くと、呼び出し側が渡し忘れても型検査が通り、
  // その画面だけ経路の絞り込みが黙って効かなくなる。
  origin: OriginFilter,
): boolean {
  if (origin !== 'all' && entry.origin !== origin) return false
  if (kind === 'all') return true
  if (kind === 'filtered') return entry.status === 'filtered'
  if (kind === 'error') return entry.status === 'error'
  return telegramLogKindOf(entry) === kind
}
