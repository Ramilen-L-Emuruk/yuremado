// 地震情報の「報をカードが採るか」の判定と、そのための記憶（震度速報の震度の控え）の扱い（純関数）。アプリの入口
// （`hooks/useEarthquakes.ts` の `handleEvent`）が使い、中継のプッシュ通知も同じものを写して使う（docs/relay-server-design.md §6.7。
// 2026-11-03 ユーザー選択「判定をすべて共用する (Recommended)」、2026-11-04 ユーザー選択「アプリと同じに出す (Recommended)」）。
//
// 記憶（震度の控え・取消の台帳・既存のカード）は呼び出し側が持ち、ここは引数で受けて決定を返す。アプリは React の ref に、
// 中継は SQL に持つ。通知を出すかの判定（`decideQuakeNotification`）と文面は `quakeNotification.ts` にある。

import type { EarthquakePoint, IntensityScale, JMAQuake } from '../types/earthquake'
import type { AreaPrefIndex } from './quakePoints'
import {
  type QuakeRetraction, type ReportAge,
  applyQuakeCancelToCard, compareReportAge, isQuakeCancelTarget, mergeQuakeInto, quakeEventKey, quakeHoldBack,
} from './quakeMerge'
import { log } from './logger'

/** 震度速報の震度の控え（後に届く震度を持たない報を補う）。`report` は控えた震度速報の発表時刻・作成時刻 */
export interface QuakeIntensityCacheEntry {
  readonly maxScale: IntensityScale
  readonly points: EarthquakePoint[]
  readonly report: ReportAge
}

/** 鍵は地震の安定キー（`quakeEventKey`） */
export type QuakeIntensityCache = Map<string, QuakeIntensityCacheEntry>

/**
 * 震度を持たない電文（VXSE52/53）を、震度速報の震度で補う。
 *
 * **統合側と据え置き判定側で同じ述語を通す。** 補完の有無で `hasIntensity(incoming)` が変わり、`quakeHoldBack` はそこで
 * 判定軸を切り替える（実震度を持つなら発表時刻・持たないなら種別優先度）。片方だけ補完すると、**同じ電文について統合は
 * 受け入れ・判定は据え置きと答える**形でずれる。
 *
 * **補ったことに印を付ける**（`intensityFromCache`）。補った電文はそのままカードの控え（`sourceTelegrams`）へ積まれるので、
 * 元の震度速報が取り消されたとき、当て直しがこの印を見て補った震度を外す（→ `quakeMerge.ts` の `applyQuakeCancelToCard`）。
 */
export function fillQuakeIntensity(quake: JMAQuake, cache: ReadonlyMap<string, QuakeIntensityCacheEntry>): JMAQuake {
  if (quake.earthquake.maxScale >= 0 || quake.points.length > 0) return quake
  const cached = cache.get(quakeEventKey(quake))
  if (!cached) return quake
  return {
    ...quake,
    earthquake: { ...quake.earthquake, maxScale: cached.maxScale },
    points: cached.points,
    intensityFromCache: true,
  }
}

/**
 * そのカードが、取消電文の効く相手か。照合の中身は `quakeMerge.ts` の `isQuakeCancelTarget`（情報名称の単位で、カードが
 * 取消より前にその種別の報を受けていたか）。ライブは**取消表示中のカードを対象から外す**ところだけを足す（二重に取消表示を
 * 張って 10 秒の purge を延ばさないため）。
 *
 * 台帳への記録（入口）と実際の取消の適用（状態の更新）で**同じ述語を使う**ために切り出している。書き写すと片方だけが変わり、
 * 記録と適用の範囲が静かにずれる。
 */
export function isLiveQuakeCancelTarget(card: JMAQuake, cancel: JMAQuake, areaPrefIndex: AreaPrefIndex): boolean {
  return !card.cancelledAt && isQuakeCancelTarget(card, cancel, areaPrefIndex)
}

/** 取消電文が効くカードを探す。判定は {@link isLiveQuakeCancelTarget} */
export function findQuakeCancelTarget(
  cards: readonly JMAQuake[],
  cancel: JMAQuake,
  areaPrefIndex: AreaPrefIndex,
): JMAQuake | undefined {
  return cards.find(card => isLiveQuakeCancelTarget(card, cancel, areaPrefIndex))
}

/**
 * その地震情報を**地震カードが採らないか**（据え置くか）。真なら音・読み上げ・ウィンドウタイトル・自動タブ切替・通知を
 * 起こさない（何を止めるかは受け取る側が決める）。取消は内容の更新ではなくカードを消す操作なので、呼び出し側が渡さない。
 *
 * **統合側がその報を採らない門は 2 つある。** 片方だけを見ると、もう片方で捨てられた電文が音・読み上げ・タイトル・タブ移動
 * だけを動かす（→ docs/spec/quake-spec.md §6.3「カードが採らない門は 2 つ」）。
 *
 * ① 取消より前に発表された報（§6.2。`retracted`）。**`existing` を見ても分からない** —— 対象カードは取消済みなので
 *    既存のカードを探す処理が候補から外し、`existing` は `undefined` になる。そのまま「据え置かない」へ倒すと、
 *    **画面には何も出ないのに声だけが鳴る**。判断は入口で 1 回だけ行い（`isRetractedQuakeReport`）、その値を受け取る。
 * ② 据え置き（`quakeHoldBack`）。実例: 2024-11-26 22:47 の大阪府北部（完全版・最大震度1）の 55 秒後に、1 分後に起きた
 *    石川県西方沖の揺れが紛れ込んだ震度速報（福井県嶺南・滋賀県北部の震度3）が同じ EventID で届く。カードは据え置いて
 *    いたのに、読み上げだけが「新たに最大震度3を…観測しました」と言っていた。
 */
export function isQuakeReportHeldBack(existing: JMAQuake | undefined, quake: JMAQuake, retracted: boolean): boolean {
  if (retracted) {
    log.info('[quake] 取消以前に発表された報なので音・読み上げ・タイトル・タブ移動を起こさない', {
      incomingId: quake.id, incomingType: quake.issue.type, incomingTime: quake.time,
    })
    return true
  }
  if (!existing) return false
  const held = quakeHoldBack(existing, quake)
  if (!held) return false
  // **記録するかも述語が決める**（`notable`）。ここで条件を書き下すと統合側の絞り込みを書き写すことになり、片方だけ
  // 古くなったときにこちらの記録だけが溢れる。
  if (held.notable) {
    log.info('[quake] カードが採らない電文なので音・読み上げ・タイトル・タブ移動を起こさない', {
      reason: held.reason, incomingId: quake.id, incomingType: quake.issue.type,
      existingType: existing.issue.type,
      droppedMaxScale: quake.earthquake.maxScale, droppedPoints: quake.points.length,
    })
  }
  return true
}

/**
 * 報を当てたあとのカード。取消なら取消の当て方（`applyQuakeCancelToCard`）で、全体の取消は取消済みの印（`cancelledAt`）を
 * 付けたカード、一部の取消は当て直したカード、当たらなければ `undefined`。それ以外は統合（`mergeQuakeInto`）。
 *
 * **取消の対象は `existing` を流用せず、統合側と同じ探し方（{@link findQuakeCancelTarget}）で選んで渡す。** `existing` は
 * 据え置き判定のために引いたもので、同じ地震と判定できるカードのうち**発表時刻がいちばん早い 1 枚**を返す（種別は見ない）。
 * 同じ地震のカードが 2 枚並ぶ状態（暫定 ID と確定 ID）では、早い方が取消対象でないと何も当たらない。
 */
export function quakeCardAfterReport(args: {
  existing: JMAQuake | undefined
  quake: JMAQuake
  cancelTarget: JMAQuake | undefined
  retractions: readonly QuakeRetraction[]
  areaPrefIndex: AreaPrefIndex
  cancelledAt: Date
}): JMAQuake | undefined {
  const { existing, quake, cancelTarget, retractions, areaPrefIndex, cancelledAt } = args
  if (!quake.cancelled) return mergeQuakeInto(existing, quake, { quiet: true })
  if (!cancelTarget) return undefined
  const effect = applyQuakeCancelToCard(cancelTarget, quake, retractions, areaPrefIndex)
  return effect.kind === 'partial' ? effect.card
    : effect.kind === 'whole' ? { ...cancelTarget, cancelledAt }
    : undefined
}

/**
 * 報を見た後に震度の控えを進める（入口で 1 回だけ。台帳と同じく、状態の更新関数の中に置くと二重に走る）。
 *
 * - 震度速報なら、その震度を控える。**据え置き（`heldBack`）・取消より前に発表された報（`retracted`）は
 *   書かない。** どちらもカードが内容を採らない・採れない電文で、書くと裏口からカードへ入り込む —— 据え置かれた震度速報 B の
 *   points が控えに残ったまま、後続の震源情報（震度を持たない）が {@link fillQuakeIntensity} で B を取り込むと
 *   `hasIntensity(incoming)` が真になり、統合が既存の震度で補う分岐を通らず、カードは B の points をそのまま採ってしまう
 * - 震度速報の取消なら、**取消より前に発表された震度速報の控え**を捨てる（カードへの当て方と同じ規則）。残すと、取消の後に
 *   届く震度を持たない報が取り消された震度で埋め戻される。鍵は電文と当たったカードの両方で引く（暫定 EventID の付け替えで
 *   カードの鍵が電文と違うことがある）。取消の後に発表し直された震度速報が先に届いて控えられていれば、それは残す
 *
 * 鍵はイベントの安定キー。eventId を持たない電文は報ごとに別キーになるため控えは実質効かず、統合（既存カードの震度で埋める）が
 * 同じ補完を担う。ここを地震の時刻にすると、同じ分に起きた別の地震の震度を引いてしまう。
 */
export function noteQuakeIntensity(
  cache: QuakeIntensityCache,
  quake: JMAQuake,
  seen: { heldBack: boolean; retracted: boolean; cancelTarget: JMAQuake | undefined },
): void {
  if (quake.issue.type !== '震度速報') return
  const key = quakeEventKey(quake)
  // 書く側は取消かを見ない（取消の電文は震度を持たない（maxScale -1）ので、実配信では書かない）
  if (!seen.heldBack && !seen.retracted && quake.earthquake.maxScale >= 0) {
    cache.set(key, {
      maxScale: quake.earthquake.maxScale,
      points: quake.points,
      report: { time: quake.time, ...(quake.createdAtMs !== undefined && { createdAtMs: quake.createdAtMs }) },
    })
  }
  if (!quake.cancelled) return
  const keys = new Set([key, ...(seen.cancelTarget ? [quakeEventKey(seen.cancelTarget)] : [])])
  for (const k of keys) {
    const cached = cache.get(k)
    if (cached && (!quake.time || compareReportAge(cached.report, quake) <= 0)) cache.delete(k)
  }
}
