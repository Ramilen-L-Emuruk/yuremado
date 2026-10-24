import { useCallback, useMemo, useState } from 'react'
import type { JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount } from '../../types/earthquake'
import { log } from '../../utils/logger'
import { isQuakeNoticeDismissed, normalizeDmdataTelegramId } from '../../utils/dmdataId'

/** 地図に重ねる特別情報の帯 5 種の元データ（届いていなければ null）。 */
export interface SpecialInfoItems {
  nankai: JMANankai | null
  nankaiCommentary: JMANankaiCommentary | null
  kohatsu: JMAKohatsu | null
  quakeNotice: JMAQuakeNotice | null
  earthquakeCount: JMAEarthquakeCount | null
}

/**
 * 利用者が閉じられる帯（5 種すべて）。南海トラフ臨時情報と後発地震注意情報もかつては閉じられなかった（取消・失効でだけ
 * 消えた）が、2026-10-22 ユーザー選択「閉じられるようにする」で閉じられるようにした。
 */
export type DismissibleSpecialInfo = 'nankai' | 'nankaiCommentary' | 'kohatsu' | 'quakeNotice' | 'earthquakeCount'

export interface SpecialInfoBanners {
  /** **いま画面に出す帯**（閉じた電文を除いたもの）。帯の描画もこれを見る。 */
  readonly visible: SpecialInfoItems
  /** 帯が 1 枚でも出ているか（`visible` のどれかが null でない）。 */
  readonly shown: boolean
  /** その種類の帯を閉じる（いま出ている電文の id を覚える）。 */
  readonly dismiss: (kind: DismissibleSpecialInfo) => void
}

// 閉じた電文の id を覚えておく localStorage のキー。保持するのは種類ごとに 1 件だけでよい
// （表示するのは常に最新の 1 通のみ）。**覚えるのは報の id** —— 続報が届けば id が違うので帯は出直す。
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
}

const LOG_TAGS: Record<DismissibleSpecialInfo, string> = {
  nankai: '[nankai] 臨時情報',
  kohatsu: '[kohatsu] 後発地震注意情報',
  nankaiCommentary: '[nankai] 解説情報',
  quakeNotice: '[quakeNotice] お知らせ',
  earthquakeCount: '[earthquakeCount] 地震回数',
}

function readDismissed(kind: DismissibleSpecialInfo): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEYS[kind])
  } catch (e) {
    log.debug(`${LOG_TAGS[kind]}の既読状態を読めません`, e)
    return null
  }
}

/**
 * 突き合わせる前に書式を揃える。保存されている id は閉じた当時のもので、電文 id の書式を変えた版へ
 * 更新すると素の比較では外れる（＝閉じた帯が復活する）。
 */
function isDismissed(dismissedId: string | null, id: string): boolean {
  return dismissedId != null && normalizeDmdataTelegramId(dismissedId) === normalizeDmdataTelegramId(id)
}

/**
 * 特別情報の帯の束の状態。**閉じた帯を除いた「いま出す帯」を、帯の描画と呼び出し側（App の共有ボタンの
 * 置き場所）が同じ値で見るためにここへ集める。** 閉じた状態を帯の中だけに持つと、外からは「帯が出ている」と
 * 「全部閉じた」の見分けが付かない。
 *
 * @param items 帯へ出す元データ。**設定で隠した種類は null にして渡す**（お知らせの帯の設定など）
 */
export function useSpecialInfoBanners(items: SpecialInfoItems): SpecialInfoBanners {
  // マウント時に一度だけ読む。別の電文に入れ替われば id が違うので、新しい電文はきちんと表示される。
  const [dismissed, setDismissed] = useState<Record<DismissibleSpecialInfo, string | null>>(() => ({
    nankai: readDismissed('nankai'),
    nankaiCommentary: readDismissed('nankaiCommentary'),
    kohatsu: readDismissed('kohatsu'),
    quakeNotice: readDismissed('quakeNotice'),
    earthquakeCount: readDismissed('earthquakeCount'),
  }))

  const { nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount } = items
  const visible = useMemo<SpecialInfoItems>(() => ({
    nankai: nankai && !isDismissed(dismissed.nankai, nankai.id) ? nankai : null,
    nankaiCommentary: nankaiCommentary && !isDismissed(dismissed.nankaiCommentary, nankaiCommentary.id) ? nankaiCommentary : null,
    kohatsu: kohatsu && !isDismissed(dismissed.kohatsu, kohatsu.id) ? kohatsu : null,
    // お知らせだけは id の書式を変えたので、旧い書式の記録も効かせる（→ `isQuakeNoticeDismissed`）
    quakeNotice: quakeNotice && !isQuakeNoticeDismissed(dismissed.quakeNotice, quakeNotice) ? quakeNotice : null,
    earthquakeCount: earthquakeCount && !isDismissed(dismissed.earthquakeCount, earthquakeCount.id) ? earthquakeCount : null,
  }), [nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount, dismissed])

  const dismiss = useCallback((kind: DismissibleSpecialInfo) => {
    const item = visible[kind]
    if (item == null) return
    // 永続化できない環境（プライベートモード等・容量超過）でも、この場で閉じる動作は止めない。
    // ただし黙って諦めると「閉じてもリロードで復活する」問い合わせを追跡できないため記録する。
    try {
      localStorage.setItem(DISMISSED_KEYS[kind], item.id)
    } catch (e) {
      log.debug(`${LOG_TAGS[kind]}の既読状態を保存できません`, e)
    }
    setDismissed((d) => ({ ...d, [kind]: item.id }))
  }, [visible])

  const shown = !!(visible.nankai || visible.nankaiCommentary || visible.kohatsu || visible.quakeNotice || visible.earthquakeCount)
  return useMemo(() => ({ visible, shown, dismiss }), [visible, shown, dismiss])
}
