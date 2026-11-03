import type { JMAEarthquakeCount, JMAKohatsu, JMALpgm, JMANankai, JMANankaiCommentary } from '../types/earthquake'
import { isObservedLpgmClass } from './lpgm'

/**
 * 帯に出すお知らせ系の電文（南海トラフ地震臨時情報・後発地震注意情報・南海トラフ地震関連解説情報・地震回数に関する情報）を
 * **帯へ当てるか**と、**音・読み上げ・通知へ流すか**の判定。アプリ（`useEarthquakes`）と中継のプッシュ通知が同じ答えを出すために
 * ここへ置く（2026-11-03 ユーザー選択「判定をすべて共用する (Recommended)」。docs/relay-server-design.md §6.7）。
 *
 * どちらも「いま帯に出している情報単位」を覚えておき、それを渡して判定する。覚え方は呼ぶ側が持つ —— アプリは ref と
 * 期限のタイマー、中継は SQLite（期限は判定の前に `expired` で外す）。
 */

/** 帯の判定の結果。当てないときは理由を返す（記録に使う） */
export type BandDecision =
  | { apply: true }
  | { apply: false; reason: 'notShown' | 'otherUnit' | 'expired' | 'badExpire' | 'empty' }

/** 期限（ISO 8601）を過ぎたか。読めない日時は `null`（壊れた値と正当な期限切れを同じに潰さない） */
export function expired(expireAt: string, nowMs: number): boolean | null {
  const at = new Date(expireAt).getTime()
  if (!Number.isFinite(at)) return null
  return at - nowMs <= 0
}

/**
 * 臨時情報・後発地震注意情報の取消が、**いま出ている別の情報単位の帯の下で届いた古い取消か**。帯へ当てる前に見る
 * （当てた後では、消したのか元から別だったのかが分からない）
 */
export function cancelOverOtherUnit(
  shownEventId: string | null,
  telegram: { eventId: string; cancelled: boolean; retracted?: boolean },
): boolean {
  return telegram.cancelled && telegram.retracted === true && shownEventId !== null && shownEventId !== telegram.eventId
}

/**
 * 南海トラフ地震臨時情報。**照合するのは取消（`retracted`）だけ** —— 「調査終了」は発表ごとに別の識別情報を持つ別の報なので、
 * 照合すると正常な調査終了で帯が消えなくなる。取消は対象と同じ識別情報を持つ（電文解説資料 Ⅰ.別紙ウ）。
 */
export function nankaiBandDecision(shownEventId: string | null, nankai: Pick<JMANankai, 'eventId' | 'cancelled' | 'retracted'>): BandDecision {
  if (!nankai.cancelled) return { apply: true }
  if (nankai.retracted && shownEventId !== nankai.eventId) return { apply: false, reason: shownEventId === null ? 'notShown' : 'otherUnit' }
  return { apply: true }
}

/** 後発地震注意情報。期限切れの報は出さない。取消の照合は臨時情報と同じ */
export function kohatsuBandDecision(
  shownEventId: string | null,
  kohatsu: Pick<JMAKohatsu, 'eventId' | 'cancelled' | 'retracted' | 'expireAt'>,
  nowMs: number,
): BandDecision {
  if (!kohatsu.cancelled) {
    const e = expired(kohatsu.expireAt, nowMs)
    if (e === null) return { apply: false, reason: 'badExpire' }
    return e ? { apply: false, reason: 'expired' } : { apply: true }
  }
  if (kohatsu.retracted && shownEventId !== kohatsu.eventId) return { apply: false, reason: shownEventId === null ? 'notShown' : 'otherUnit' }
  return { apply: true }
}

/**
 * 南海トラフ地震関連解説情報。取消は帯に出している号（`id`。識別情報と号数の組）にだけ当てる —— 臨時解説は一連の期間で
 * `eventId` が固定なので、`eventId` だけでは連日届く別の号を同じものとして扱う。期限切れの報は出さない。
 */
export function nankaiCommentaryBandDecision(
  shownId: string | null,
  commentary: Pick<JMANankaiCommentary, 'id' | 'cancelled' | 'expireAt'>,
  nowMs: number,
): BandDecision {
  if (commentary.cancelled) return shownId === commentary.id ? { apply: true } : { apply: false, reason: shownId === null ? 'notShown' : 'otherUnit' }
  const e = expired(commentary.expireAt, nowMs)
  if (e === null) return { apply: false, reason: 'badExpire' }
  return e ? { apply: false, reason: 'expired' } : { apply: true }
}

/**
 * 地震回数に関する情報。取消は `eventId`（群発の識別子）で照合する（同じ群発について報を重ねるので、取消が指すのは
 * いま出している報）。回数も本文も無い報と、期限切れの報は出さない。
 */
export function earthquakeCountBandDecision(
  shownEventId: string | null,
  count: Pick<JMAEarthquakeCount, 'eventId' | 'cancelled' | 'items' | 'body' | 'expireAt'>,
  nowMs: number,
): BandDecision {
  if (count.cancelled) return shownEventId === count.eventId ? { apply: true } : { apply: false, reason: shownEventId === null ? 'notShown' : 'otherUnit' }
  if (count.items.length === 0 && !count.body) return { apply: false, reason: 'empty' }
  const e = expired(count.expireAt, nowMs)
  if (e === null) return { apply: false, reason: 'badExpire' }
  return e ? { apply: false, reason: 'expired' } : { apply: true }
}

/** 伝えた取消の記憶の上限（取消は年に数通しか無いが、長く開いたままの端末で増え続けないように） */
export const CONVEYED_CANCELS_MAX = 500

/** 伝えた取消の記憶の鍵。**発表時刻を含める** —— 取消の id は対象と同じ形で、号数が欠けると `1` に倒れるので、id だけだと別の取消を取り違える */
export function conveyedCancelKey(kind: string, telegram: { id: string; time: string }): string {
  return `${kind}:${telegram.id}|${telegram.time}`
}

/** 取消を「伝えた」に数える。初めてなら真（もう数えてあれば偽＝二重配信） */
export function noteConveyedCancel(conveyed: Set<string>, kind: string, telegram: { id: string; time: string }): boolean {
  const key = conveyedCancelKey(kind, telegram)
  if (conveyed.has(key)) return false
  if (conveyed.size >= CONVEYED_CANCELS_MAX) conveyed.clear()
  conveyed.add(key)
  return true
}

/** 流すかの判定の結果。流さないときの理由はリプレイの記録（`ReplayTelegramSkip`）と同じ語 */
export type DispatchDecision = 'dispatch' | 'notApplied' | 'notDispatched' | 'silentReplayInit'

/**
 * 帯の電文（と長周期）を音・読み上げ・通知へ流すか。
 *
 * - **取消でない報**は帯へ当てたか（`applied`）で決める
 * - **取消**は帯へ当てたかによらず流し、同じ電文の 2 通目だけ止める（`'notDispatched'`）
 * - **サイレント注入**（リプレイの初期状態）は流さない。取消なら「伝えた」に数える
 * - **別の情報単位の帯が出ているときの古い単位への取消**（`otherUnitShown`）は流さない。「〇〇は取り消されました」と言うと、
 *   いま出ている帯の情報が取り消されたように聞こえる（2026-10-24 ユーザー選択「別単位の帯が出ていれば黙る (Recommended)」）
 */
export function decideDispatch(
  conveyed: Set<string>,
  kind: string,
  telegram: { id: string; time: string; cancelled: boolean },
  applied: boolean,
  silent: boolean | undefined,
  otherUnitShown: boolean,
): DispatchDecision {
  if (!telegram.cancelled) return !applied ? 'notApplied' : silent ? 'silentReplayInit' : 'dispatch'
  const duplicate = !noteConveyedCancel(conveyed, kind, telegram)
  if (silent) return 'silentReplayInit'
  if (otherUnitShown) return 'notApplied'
  if (duplicate) return 'notDispatched'
  return 'dispatch'
}

/**
 * lpgm が `onLiveEvent`（音・読み上げ・タブ移動）の対象になるか。
 *
 * - **発表**は最大階級 0 の報も含めてすべて（2026-10-30 ユーザー選択「階級 1 以上と同じ型
 *   (Recommended)」・#1201。それまでは階級 1 以上だけで、最大階級 0 の報は音・読み上げ・通知・
 *   タイトル・自動で開くのどれも出さなかった）。パーサーは 0〜4 以外を捨てるので、ここでの値域の確かめは
 *   型の効かない経路（シナリオの手書き JSON など）から壊れた値が来たときのための保険
 * - **取消**は常に（画面に出していない地震への取消でも伝える。2026-10-22 ユーザー選択「地震情報に揃えて伝える
 *   (Recommended)」で 2026-10-15 の「表示中を消した時だけ（推奨）」を覆した）。同じ取消の 2 通目は
 *   `decideDispatch` が止める
 *
 * **他の 5 種別（nankai 等）と違い、これは「反映されたか」と一致しない。** あちらは
 * `applyXxx` が期限切れ等で棄却すると `lpgmByEventId` 相当の state 自体を書き換えないが、
 * lpgm は取消なら削除・それ以外なら必ず追加する形で **`lpgmByEventId` を常に書き換える**
 * （`useEarthquakes` の `setState` を参照）。ここが偽でも画面（長周期一覧・バッジ）は更新されうる
 * ので、記録の理由はどちらも `notApplied`（＝反映されなかった）ではなく
 * `notDispatched`（＝音読み上げの対象外と決めている）にする。
 */
export function lpgmNotifiable(lpgm: Pick<JMALpgm, 'cancelled' | 'maxClass'>): boolean {
  return lpgm.cancelled || isObservedLpgmClass(lpgm.maxClass)
}
