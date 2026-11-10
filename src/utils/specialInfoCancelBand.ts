import type { JMAEarthquakeCount, JMAKohatsu, JMANankai, JMANankaiCommentary, JMAQuakeNotice } from '../types/earthquake'
import { COMMENTARY_NAME, COUNT_NAME, KOHATSU_NAME, NANKAI_NAME, QUAKE_NOTICE_NAME } from './specialInfoNotification'

/**
 * 特別な情報の帯の取消の表示（2026-11-09 ユーザー選択「帯を取消に切り替え＋通知に理由 (Recommended)」）。
 *
 * 帯に出していた報が取り消されたら、帯を黙って消さずに灰の取消の表示へ切り替え、10 秒で消す（津波の帯の取消に合わせる）。
 * 見出しは「〇〇 取消」、1 行目は「〇〇は取り消されました」、2 行目は電文の取消しの理由（`Body/Text`）をそのまま。
 * 形は帯の中に 3 行（2026-11-10 ユーザー選択「A 帯の中に 3 行 (Recommended)」）。同じ種類の帯に残りの報があれば、取り消された分だけを
 * その種類の帯のすぐ上に出し、残りの報の帯は触らない（同日の見本 mock-cancel-stacked-360.png に「この形でよい (Recommended)」）。
 *
 * **出すのは、帯に出していた報への取消を、音・読み上げへも流したときだけ**（帯に出していない号への取消では帯を立てない。
 * 履歴の取り込み・再生の初期状態の取消も立てない —— 届いた瞬間の出来事ではない）。
 */

/** 取消の表示を出す帯の種類（南海トラフ臨時情報と、積む 4 種） */
export type SpecialInfoCancelKind = 'nankai' | 'nankaiCommentary' | 'kohatsu' | 'quakeNotice' | 'earthquakeCount'

/** 取消の表示を出しておく時間（津波の帯・地震カードの取消と同じ 10 秒） */
export const SPECIAL_INFO_CANCEL_SHOW_MS = 10_000

export interface SpecialInfoCancelBand {
  /** 表示の鍵（取消電文の id と発表時刻。同じ取消の 2 通目は足さない） */
  readonly id: string
  readonly kind: SpecialInfoCancelKind
  /** 情報名（見出し「〇〇 取消」・1 行目「〇〇は取り消されました」の〇〇） */
  readonly name: string
  /** 電文の取消しの理由（`Body/Text`。前後の空白だけ落とす）。空なら 2 行目を出さない */
  readonly reason: string
  /**
   * 取り消して帯から外した報の id。利用者がその報の帯を × で閉じていたら、取消の表示も出さない
   * （帯に出していない報への取消と同じ扱い）
   */
  readonly targetIds: readonly string[]
}

const NAMES: Record<SpecialInfoCancelKind, string> = {
  nankai: NANKAI_NAME,
  nankaiCommentary: COMMENTARY_NAME,
  kohatsu: KOHATSU_NAME,
  quakeNotice: QUAKE_NOTICE_NAME,
  earthquakeCount: COUNT_NAME,
}

/** 種類ごとの取消電文 */
export type SpecialInfoCancelTelegram =
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'quakeNotice'; data: JMAQuakeNotice }
  | { kind: 'earthquakeCount'; data: JMAEarthquakeCount }

/**
 * 取消電文から取消の表示を組む。理由の欄は種類で違う —— 地震回数だけは本文（`body`）と別に `cancelText` に持つ
 * （→ `JMAEarthquakeCount.cancelText`）。ほかは取消電文の `body` が理由
 */
export function specialInfoCancelBand(t: SpecialInfoCancelTelegram, targetIds: readonly string[]): SpecialInfoCancelBand {
  const reason = t.kind === 'earthquakeCount' ? (t.data.cancelText ?? '') : t.data.body
  return {
    id: `${t.kind}:${t.data.id}|${t.data.time}`,
    kind: t.kind,
    name: NAMES[t.kind],
    reason: reason.trim(),
    targetIds,
  }
}

/** 取消の表示を足す。同じ鍵は足さない（足さなければ元の一覧をそのまま返す） */
export function addSpecialInfoCancelBand(list: readonly SpecialInfoCancelBand[], item: SpecialInfoCancelBand): readonly SpecialInfoCancelBand[] {
  return list.some(c => c.id === item.id) ? list : [...list, item]
}

/** 取消の表示を外す（無ければ元の一覧をそのまま返す） */
export function removeSpecialInfoCancelBand(list: readonly SpecialInfoCancelBand[], id: string): readonly SpecialInfoCancelBand[] {
  return list.some(c => c.id === id) ? list.filter(c => c.id !== id) : list
}
