import { useCallback, useMemo, useState } from 'react'
import type { JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount } from '../../types/earthquake'
import type { InternationalTsunamiBandItem } from '../../utils/internationalTsunami'
import type { SpecialInfoCancelBand } from '../../utils/specialInfoCancelBand'
import { log } from '../../utils/logger'
import { isQuakeNoticeDismissed, normalizeDmdataTelegramId } from '../../utils/dmdataId'

/**
 * 地図に重ねる特別情報の帯 6 種の元データと、取消の表示。
 *
 * **南海トラフ地震臨時情報だけは 1 通**（届いていなければ null）で、新しい報が前の報を置き換える。ほかの 5 種は
 * 種類ごとに**新しい順の一覧**で、1 本の帯に積む（2026-11-04 ユーザー選択「1 本に積む (Recommended)」「臨時情報は最新で
 * 置き換える (Recommended)」。一覧の作り方は `utils/specialInfoBandList.ts`）。
 */
export interface SpecialInfoItems {
  nankai: JMANankai | null
  nankaiCommentary: readonly JMANankaiCommentary[]
  kohatsu: readonly JMAKohatsu[]
  quakeNotice: readonly JMAQuakeNotice[]
  earthquakeCount: readonly JMAEarthquakeCount[]
  /** 地震カードに付かない国際津波関連情報（通信試験・発生時刻を読めない報。→ `internationalTsunamiBandItem`） */
  internationalTsunami: readonly InternationalTsunamiBandItem[]
  /** 取消の表示（10 秒。→ `utils/specialInfoCancelBand.ts`）。その種類の帯のすぐ上に出す */
  cancels: readonly SpecialInfoCancelBand[]
}

/** 帯を出さない種類へ渡す空の一覧（設定で隠したお知らせなど）。毎回 `[]` を作ると、帯の束の計算が描くたびにやり直しになる */
export const NO_BAND_ITEMS: readonly never[] = []

/**
 * 利用者が閉じられる帯（6 種すべて）。南海トラフ臨時情報と後発地震注意情報もかつては閉じられなかった（取消・失効でだけ
 * 消えた）が、2026-10-22 ユーザー選択「閉じられるようにする」で閉じられるようにした。
 */
export type DismissibleSpecialInfo = 'nankai' | 'nankaiCommentary' | 'kohatsu' | 'quakeNotice' | 'earthquakeCount' | 'internationalTsunami'

/** 一覧で積む 5 種 */
export type StackedSpecialInfo = Exclude<DismissibleSpecialInfo, 'nankai'>

export interface SpecialInfoBanners {
  /** **いま画面に出す帯**（閉じた電文を除いたもの）。帯の描画もこれを見る。 */
  readonly visible: SpecialInfoItems
  /** 帯が 1 枚でも出ているか（`visible` のどれかが空でない）。 */
  readonly shown: boolean
  /** その種類の帯を閉じる。**積まれている全件を閉じる**（帯の右端の ×。2026-11-04 ユーザー選択「帯は全件・行は 1 件 (Recommended)」）。 */
  readonly dismiss: (kind: DismissibleSpecialInfo) => void
  /** 積んだ一覧から 1 件だけを閉じる（開いた一覧の各行の ×）。残りがあれば帯は残る。 */
  readonly dismissOne: (kind: StackedSpecialInfo, id: string) => void
  /** 取消の表示を閉じる（10 秒を待たずに）。覚えるのはこの画面を開いている間だけ（取消の表示は 10 秒で消えるので） */
  readonly dismissCancel: (id: string) => void
}

// 閉じた電文の id を覚えておく localStorage のキー。中身は**閉じた id の一覧**（JSON の配列）。
// かつては種類ごとに 1 つの id の文字列だった（帯に出すのが最新の 1 通だけだったため）。その形の記録も読む（→ `parseDismissed`）。
// **覚えるのは報の id** —— 続報が届けば id が違うので帯は出直す。
// - 解説情報: 解除電文が無く、定例解説は平常時にも毎月届く
// - お知らせ（VZSE40）: 取消は届くが、「入電停止は明日の 8 時から」のような予告は取り消されないまま期間が過ぎる
// - 南海トラフ臨時情報・後発地震注意情報: 段階が変われば新しい報（id が違う）なので、閉じても出直す
// - 地震回数（VXSE60）: 群発は日をまたいで続き報が重なる。続報は回数が増えた新しい事実なので、閉じても出直すのはそのつもり
//   （群発ごとに閉じたままにすると、1704 回が 3000 回になっても黙ることになる）
const DISMISSED_KEYS: Record<DismissibleSpecialInfo, string> = {
  nankai: 'nankai-dismissed',
  kohatsu: 'kohatsu-dismissed',
  nankaiCommentary: 'nankai-commentary-dismissed',
  quakeNotice: 'quake-notice-dismissed',
  earthquakeCount: 'earthquake-count-dismissed',
  internationalTsunami: 'international-tsunami-band-dismissed',
}

/**
 * 種類ごとに覚えておく閉じた id の上限。超えたら古いものから捨てる。帯は届いて 7 日で消えるので、それより前に閉じた id は
 * もう要らない。お知らせは 7 日以内に最大 16 通が重なった（全期間の控えの数え。docs/common-ui-redesign.md）ので、十分に上回る数にする。
 */
export const DISMISSED_IDS_MAX = 100

const LOG_TAGS: Record<DismissibleSpecialInfo, string> = {
  nankai: '[nankai] 臨時情報',
  kohatsu: '[kohatsu] 後発地震注意情報',
  nankaiCommentary: '[nankai] 解説情報',
  quakeNotice: '[quakeNotice] お知らせ',
  earthquakeCount: '[earthquakeCount] 地震回数',
  internationalTsunami: '[internationalTsunami] 国際津波関連情報',
}

const KINDS: readonly DismissibleSpecialInfo[] = ['nankai', 'nankaiCommentary', 'kohatsu', 'quakeNotice', 'earthquakeCount', 'internationalTsunami']

/**
 * 保存された記録を閉じた id の一覧へ読む。**古い形（1 つの id の文字列そのもの）も読む** —— JSON の文字列の配列でなければ、
 * 記録全体を 1 つの id とみなす（id は `dmdata-…` の形で、JSON としては読めない）。
 */
export function parseDismissed(raw: string | null): readonly string[] {
  if (raw == null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    // 古い形（素の id）。下で 1 件として返す
  }
  return [raw]
}

function readDismissed(kind: DismissibleSpecialInfo): readonly string[] {
  try {
    return parseDismissed(localStorage.getItem(DISMISSED_KEYS[kind]))
  } catch (e) {
    log.debug(`${LOG_TAGS[kind]}の既読状態を読めません`, e)
    return []
  }
}

/** 閉じた id の一覧へ足す。同じ id は末尾へ寄せ直し、上限を超えたら古い（先頭の）ものから捨てる */
function addDismissed(list: readonly string[], ids: readonly string[]): readonly string[] {
  const added = new Set(ids)
  const next = [...list.filter(id => !added.has(id)), ...ids]
  return next.length > DISMISSED_IDS_MAX ? next.slice(next.length - DISMISSED_IDS_MAX) : next
}

/**
 * 突き合わせる前に書式を揃える。保存されている id は閉じた当時のもので、電文 id の書式を変えた版へ
 * 更新すると素の比較では外れる（＝閉じた帯が復活する）。
 */
function isDismissed(dismissed: readonly string[], id: string): boolean {
  const target = normalizeDmdataTelegramId(id)
  return dismissed.some(d => normalizeDmdataTelegramId(d) === target)
}

/** 一覧から閉じたものを除く。何も除かなければ元の一覧をそのまま返す（参照が変わらないように） */
function withoutDismissed<T extends { id: string }>(list: readonly T[], dismissedFn: (item: T) => boolean): readonly T[] {
  const kept = list.filter(item => !dismissedFn(item))
  return kept.length === list.length ? list : kept
}

/**
 * 特別情報の帯の束の状態。**閉じた帯を除いた「いま出す帯」を、帯の描画と呼び出し側（App の共有ボタンの
 * 置き場所）が同じ値で見るためにここへ集める。** 閉じた状態を帯の中だけに持つと、外からは「帯が出ている」と
 * 「全部閉じた」の見分けが付かない。
 *
 * @param items 帯へ出す元データ。**設定で隠した種類は空（`null`・`NO_BAND_ITEMS`）にして渡す**（お知らせの帯の設定など）
 */
export function useSpecialInfoBanners(items: SpecialInfoItems): SpecialInfoBanners {
  // マウント時に一度だけ読む。別の電文が届けば id が違うので、新しい電文はきちんと表示される。
  const [dismissed, setDismissed] = useState<Record<DismissibleSpecialInfo, readonly string[]>>(() => ({
    nankai: readDismissed('nankai'),
    nankaiCommentary: readDismissed('nankaiCommentary'),
    kohatsu: readDismissed('kohatsu'),
    quakeNotice: readDismissed('quakeNotice'),
    earthquakeCount: readDismissed('earthquakeCount'),
    internationalTsunami: readDismissed('internationalTsunami'),
  }))
  // 閉じた取消の表示。10 秒で消えるものなので保存しない。鍵ではなく表示 1 件ごと（一覧に足された物）で覚えるので、
  // 消えた後に同じ取消が流し直されれば（リプレイの再生し直しなど）新しい 1 件としてまた出る
  const [dismissedCancels, setDismissedCancels] = useState<ReadonlySet<SpecialInfoCancelBand>>(() => new Set())

  const { nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount, internationalTsunami, cancels } = items
  const visible = useMemo<SpecialInfoItems>(() => ({
    nankai: nankai && !isDismissed(dismissed.nankai, nankai.id) ? nankai : null,
    nankaiCommentary: withoutDismissed(nankaiCommentary, c => isDismissed(dismissed.nankaiCommentary, c.id)),
    kohatsu: withoutDismissed(kohatsu, k => isDismissed(dismissed.kohatsu, k.id)),
    // お知らせだけは id の書式を変えたので、旧い書式の記録も効かせる（→ `isQuakeNoticeDismissed`）
    quakeNotice: withoutDismissed(quakeNotice, n => dismissed.quakeNotice.some(d => isQuakeNoticeDismissed(d, n))),
    earthquakeCount: withoutDismissed(earthquakeCount, c => isDismissed(dismissed.earthquakeCount, c.id)),
    internationalTsunami: withoutDismissed(internationalTsunami, x => isDismissed(dismissed.internationalTsunami, x.id)),
    // 取り消した報をどれも × で閉じていたなら、取消の表示も出さない（帯に出していない報への取消と同じ扱い）。
    // 閉じた記録はお知らせだけ書式が違うので、id だけで照合できない分は出す側へ倒す
    cancels: withoutDismissed(cancels, c => dismissedCancels.has(c)
      || (c.targetIds.length > 0 && c.targetIds.every(id => isDismissed(dismissed[c.kind], id)))),
  }), [nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount, internationalTsunami, cancels, dismissed, dismissedCancels])

  // 閉じた id を覚える。永続化できない環境（プライベートモード等・容量超過）でも、この場で閉じる動作は止めない。
  // ただし黙って諦めると「閉じてもリロードで復活する」問い合わせを追跡できないため記録する。
  const remember = useCallback((kind: DismissibleSpecialInfo, ids: readonly string[]) => {
    if (ids.length === 0) return
    setDismissed((d) => {
      // 書く直前に保存済みの分を読み直して合わせる。別のタブで閉じた記録を、こちらの古い一覧で上書きしないため
      const next = addDismissed(addDismissed(d[kind], readDismissed(kind)), ids)
      try {
        localStorage.setItem(DISMISSED_KEYS[kind], JSON.stringify(next))
      } catch (e) {
        log.debug(`${LOG_TAGS[kind]}の既読状態を保存できません`, e)
      }
      return { ...d, [kind]: next }
    })
  }, [])

  const dismiss = useCallback((kind: DismissibleSpecialInfo) => {
    if (kind === 'nankai') {
      if (visible.nankai) remember(kind, [visible.nankai.id])
      return
    }
    remember(kind, visible[kind].map(item => item.id))
  }, [visible, remember])

  const dismissOne = useCallback((kind: StackedSpecialInfo, id: string) => {
    remember(kind, [id])
  }, [remember])

  const dismissCancel = useCallback((id: string) => {
    const target = cancels.find(c => c.id === id)
    if (!target) return
    // いま一覧に残っている分だけを持ち直す（消えた表示の記憶を溜めない）
    setDismissedCancels(prev => new Set([...[...prev].filter(c => cancels.includes(c)), target]))
  }, [cancels])

  const shown = visible.cancels.length > 0 || KINDS.some(kind => kind === 'nankai' ? visible.nankai !== null : visible[kind].length > 0)
  return useMemo(() => ({ visible, shown, dismiss, dismissOne, dismissCancel }), [visible, shown, dismiss, dismissOne, dismissCancel])
}
