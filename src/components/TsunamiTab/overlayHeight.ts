/**
 * バナーから開く付加文の面（→ docs/spec/tsunami-spec.md §9）の高さを決める。
 *
 * **寸法の判断をコンポーネントの外へ出してある。** 描画の中に置くと、`ResizeObserver` を
 * 差し替えないと動かせず、テストで押さえられない（実際に押さえられないまま 3 巡続けて
 * 指摘が出た）。ここなら数値を渡すだけで確かめられる。
 */

/**
 * バナーを大きいまま貼り付けてよい高さの上限（見える高さに対する割合）。超えるならバナーは流し、巻いて上へ抜けたら
 * 1 行の帯を上に出す（2026-11-04 ユーザー選択「地震タブと同じ規則 (Recommended)」。地震タブの「貼りつく高さが一覧の
 * 見える高さの 4 割までなら大きな枠を貼りつけ、超えたら帯」と同じ規則 → docs/quake-tab-redesign.md）。
 * 2026-10-12 承認の「残りの高さ 100px で測る」を置き換える —— 帯があれば、貼り付けを外しても上に何が出ているかは残る。
 *
 * 貼り付けたバナーは、その高さぶん区域の行の居場所を恒久的に削る。幅 390×844 では前の形のバナーがパネル 380px の
 * 約 45% を塞ぎ、区域が 1 つしか見えなかった（2026-11-04 に測った）。
 */
export const BANNER_STICK_MAX_RATIO = 0.4

/**
 * バナーの扱い。`'stick'` は大きいまま貼り付ける、`'band'` はバナーを流して巻いたら 1 行の帯を出す。
 *
 * **並び方（左右・上下）では決めず、その場で測る**（上下分割で境のつまみを動かしたときも同じ規則）。
 * まだ測れていなければ（どちらかが 0 以下）大きいまま貼り付ける側へ倒す —— 表示された直後の
 * 数フレームだけ帯へ切り替わって見えるのを避けるため。バナーの高さは貼り付けの有無で変わらないので、
 * 行き来して揺れることは無い。
 */
export function bannerStickMode(panelHeight: number, bannerHeight: number): 'stick' | 'band' {
  if (panelHeight <= 0 || bannerHeight <= 0) return 'stick'
  return bannerHeight <= panelHeight * BANNER_STICK_MAX_RATIO ? 'stick' : 'band'
}

/** 面の下端とパネルの下端のあいだに残す隙間（px）。 */
export const COMMENTS_OVERLAY_GAP = 8

/**
 * 面を出すのに要る最低の高さ（px）。本文は 11px・行間 1.6 なので、これで 2 行ぶんにあたる。
 *
 * これを割るなら**開かせない**（→ {@link canShowCommentsOverlay}）。中身が 1 行も見えない
 * 面を開くと、矢印だけ ▶→▼ に変わって何も起きず、理由も出ない。
 */
export const COMMENTS_MIN_HEIGHT = 48

/**
 * 面の高さの上限を返す。まだ測れていなければ `undefined`。
 *
 * **パネルの実寸から引く。** 画面の高さ（`vh`）で切ると、上下分割でパネルが画面の一部しか
 * 占めていないときに下へはみ出す。
 *
 * **下限を置かない。** 「狭くても最低これだけは出す」という床を置くと、パネルを縮めたときに
 * 床の方が残りより大きくなり、はみ出させない目的そのものを裏切る。狭ければ狭いまま返す。
 */
export function commentsOverlayMaxHeight(panelHeight: number, bannerHeight: number): number | undefined {
  if (panelHeight <= 0) return undefined
  return Math.max(0, panelHeight - bannerHeight - COMMENTS_OVERLAY_GAP)
}

/**
 * 面を開かせてよいか。
 *
 * `undefined`（まだ測れていない）は**開かせる側へ倒す**。測る前に閉じると、表示された直後の
 * 数フレームだけ押せない入口になり、利用者からは「押しても反応しないことがある」に見える。
 */
export function canShowCommentsOverlay(maxHeight: number | undefined): boolean {
  return maxHeight === undefined || maxHeight >= COMMENTS_MIN_HEIGHT
}
