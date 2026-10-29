// 揺れ検知エンジンの助走（ウォームアップ）。
//
// 検知器は点ごとの上がりを「自分が持っている履歴の中での上昇量」で測る（統計は 6〜65 秒前の中央値と
// 直前 10 秒の最小から、波面は 3〜59 秒前の最大から）。供給が始まった時点で既に揺れていると、
// その値が履歴の最初のサンプルになるため、どれだけ強く揺れていても「ずっと高いまま静止している点」に
// 見えて上がらない。リプレイの開始時とアプリの起動時は必ずこの状態から始まるので、
// **開始時刻より前のフレームを先に食わせて**履歴を作っておく。
//
// ここに置くのは「どこまで遡るか」を決める規則だけ。取得は供給元（services/kyoshinSource・
// kyoshinLocalArchiveSource）、消化は utils/kyoshinWarmupConsumer（どのフレームをどの順で
// 食わせるか）と検知フック（hooks/useKyoshinDetectorV2。待つか諦めるかの判断と記録）が受け持つ。
//
// ## どこまで遡るか
//
// **揺れが立ち上がった瞬間を含むまで。** 助走の長さがそのまま「ずっと再生し続けた場合と
// 一致する範囲」になる（実測値の表は
// `docs/spec/kyoshin-detection-spec.md` §7「助走」が単一情報源。測り直しは
// `scripts/measure-kyoshin-warmup.ts`）。
//
// **60 秒のブロック単位で遡り、遡った先が静穏なら打ち切る。ただし静穏でも最低
// `WARMUP_MIN_BLOCKS`（10 分）は遡る**（理由と実測は定数の側）。平常時（大半の起動はこちら）は
// 10 ブロックで止まり、揺れが続いていれば上限まで遡る。固定 600 秒と比べると、平常時の取得は同じ 600 件で、
// 10 分を超えて続く揺れでも立ち上がりまで遡れる。
//
// 上限を置くのは、群発地震のように何分経っても静穏にならない状況で青天井にしないため。
// 上限に当たったぶんは「遡りきれなかった」として受け入れる（そこまでの助走は無駄にならない）。
//
// **「始める時点が静穏なら助走そのものを省く」ようにはしない。** 旧エンジンで、最低の長さを置く前の
// 打ち切り方で測っても、一致率が落ちた（151 → 137）。揺れが続いていても現在のフレームだけは静穏に
// 見える瞬間があり、そこを省くと、いちばん見たい「収まりつつある時間帯」で検知が出なくなる。
// 判定を厳しくしても改善せず、減らせる取得量は平均 289 → 225 フレームにとどまる。
//
// **緩めるとかえって一致率が落ちる（旧エンジンで測った）。** 静穏の判定を `v>=1.5` が 3 件未満（平常時の最大が
// 2 件なので一見ちょうどよく見える）にすると、大地震の余韻が一瞬途切れたところを静穏と
// 誤って打ち切り、本震まで遡れずに 128 まで下がった。戻したいのは**揺れの合間**ではなく
// **揺れが始まる前**なので、平常時の水準そのもので判定する。

import { indexToValue } from './kyoshinSiteKeys'
import { MAX_RESUME_GAP_MS } from './kyoshinNoiseFloor'

/** 助走を遡るときの 1 ブロックの長さ（秒）。 */
export const WARMUP_BLOCK_SEC = 60

/**
 * 遡るブロック数の上限。
 *
 * 上限に当たるのは「この時間ずっと揺れ続けている」場合だけで、静穏に行き当たれば手前で止まる。
 */
export const WARMUP_MAX_BLOCKS = 15

/**
 * 静穏でも必ず遡るブロック数（**10 分**）。
 *
 * 遡った先が静穏でも、そこまでの時間は揺れの立ち上がりや余韻を含みうる。組み合わせの検知器で、
 * 「ずっと再生し続けた場合」と一致する時点は最低 1・3・5・7・10・12・15 ブロックで
 * 144・153・154・156・157・158・159/164 だった（大地震 7 本・164 点。窓の手前に 15 分を足して
 * `scripts/measure-kyoshin-warmup.ts --min-blocks=...` で測った）。10 分を超えると 2〜3 分ごとに 1 点しか増えない。
 * 起動 1 回あたりの取得は平常時で 600 件（2026-10-29 ユーザー選択「最低 10 分にする (Recommended)」、
 * 測り直したうえで 2026-10-29 ユーザー選択「10 分のまま (Recommended)」。
 * それまでの 3 分は旧エンジンでの測定のうえで 2026-10-28「3 分のまま残し、理由を書き直す」）。
 *
 * 組み合わせの検知器の、どの地震にも当てはまらない確かな段を減らす効果は無かった（検知ベンチ 795 窓で、
 * 最低 3 分のとき助走なし 18 件・助走あり 21 件）。窓の始まり近くに偏って見えたのは助走が無いせいではなかった。
 */
export const WARMUP_MIN_BLOCKS = 10

/**
 * 静穏の判定に使う計測震度相当値（`indexToValue`）のしきい値。
 *
 * 平常時の水準は実データ（検知ベンチの平常時窓 22 本・40770 フレーム）で測った。
 * この値以上の観測点は中央 4 件・99 パーセンタイル 14 件・最大 19 件。
 */
export const WARMUP_QUIET_VALUE = 0.5

/**
 * 静穏とみなす「`WARMUP_QUIET_VALUE` 以上の観測点」の上限件数。
 *
 * 平常時の 90 パーセンタイルが 10 件なので、平常時はほぼどのブロックでも静穏と判定できる（打ち切るのは
 * `WARMUP_MIN_BLOCKS` に届いてから）。
 */
export const WARMUP_QUIET_MAX_POINTS = 10

/**
 * そのフレームが静穏か（＝ここまで遡れば助走として十分か）。
 *
 * 欠測（負のインデックス）は数えない。観測できていない点は「揺れていない」証拠にならないが、
 * 「揺れている」証拠にもならないため。
 */
export function isQuietFrame(indices: readonly number[]): boolean {
  let count = 0
  for (const idx of indices) {
    if (idx < 0) continue
    if (indexToValue(idx) >= WARMUP_QUIET_VALUE) {
      count++
      if (count >= WARMUP_QUIET_MAX_POINTS) return false
    }
  }
  return true
}

/**
 * ここで遡りを打ち切ってよいか。開始時刻から `secondsBack` 秒遡った先のフレームが `indices`。
 *
 * **遡った長さが `WARMUP_MIN_BLOCKS` に届くまでは、静穏でも止めない。** 取得元（Yahoo 経由・ローカル履歴
 * アーカイブ）と計測（`scripts/measure-kyoshin-warmup.ts`）は、どれもこの 1 つで判定すること —— 別々に
 * 書くと、計測で確かめた規則と実装の規則がずれる。
 */
export function mayStopWarmup(secondsBack: number, indices: readonly number[]): boolean {
  return secondsBack >= WARMUP_MIN_BLOCKS * WARMUP_BLOCK_SEC && isQuietFrame(indices)
}

/**
 * 時刻順のフレーム列から、**助走として使える連続した後半**の開始位置を返す。
 *
 * 検知器は `MAX_RESUME_GAP_MS` を超える間隔が空くと作り直される（`kyoshinEnsembleShadow.ts`）。
 * 穴より前を食わせても作り直しで捨てられるので、最後の穴より後ろだけを助走にする。それ以内の穴は
 * 作り直さないので、穴より前も助走として効く（慢性ノイズ床は `MAX_DT_GAP_MS` を超える穴で点ごとの履歴だけが
 * 空になり、床は残る。設計書§37）。
 *
 * @param timesMs 各フレームのデータ時刻（ミリ秒・昇順）
 * @returns 助走に使い始めるインデックス。空配列なら 0
 */
export function firstContinuousIndex(timesMs: readonly number[]): number {
  let from = 0
  for (let i = 1; i < timesMs.length; i++) {
    if (timesMs[i] - timesMs[i - 1] > MAX_RESUME_GAP_MS) from = i
  }
  return from
}
