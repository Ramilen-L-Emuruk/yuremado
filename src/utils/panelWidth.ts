/**
 * 左右分割（`side`）でのパネルの幅。境界のつまみで変えた幅を、画面に見せる幅と、ドラッグの可動範囲へ直す。
 *
 * **見せる幅の計算は CSS と JS の 2 か所にある。** CSS（`panelWidthCss`）が画面に効く値で、JS
 * （`shownPanelWidthPx`）はドラッグを始めた位置を求めるために同じ式をなぞる。どちらもここの定数から作る。
 *
 * 範囲は 2026-11-05 ユーザー選択「20rem〜地図を 360px 残すまで (Recommended)」。下限は
 * `PANEL_WIDTH_MIN_REM`、上限は「画面の幅 − アイコンナビ − 地図 360px」。画面が狭くて上限が下限を割るときは下限に揃える。
 * 上限で詰めるのは見せる幅だけで、保存した幅は書き換えない（画面を広げれば元の幅に戻る）。
 */
import { PANEL_WIDTH_MIN_REM } from '../hooks/useSettings'

/** 動かしていないときの幅（rem）。PC（`side`）とスマホ横（`sideNarrow`）で別 */
export const PANEL_WIDTH_DEFAULT_SIDE_REM = 35
export const PANEL_WIDTH_DEFAULT_NARROW_REM = 22
/** アイコンナビに取っておく幅（rem）。`src/index.css` の `w-panel` と同じ値 */
export const PANEL_NAV_RESERVE_REM = 4
/** つまみで広げても地図に残す幅（CSS px） */
export const PANEL_MAP_KEEP_PX = 360

/** 画面の寸法。`remPx` はルートの `font-size`（UI 倍率で変わる） */
export interface PanelWidthEnv {
  readonly viewportWidth: number
  readonly remPx: number
}

/** つまみで動かせる幅の範囲（px） */
export function panelWidthRangePx(env: PanelWidthEnv): { min: number; max: number } {
  const min = PANEL_WIDTH_MIN_REM * env.remPx
  const beforeNav = env.viewportWidth - PANEL_NAV_RESERVE_REM * env.remPx
  // 地図を残す上限が下限を割る狭い画面では下限に揃える。ただしアイコンナビを押し出す幅にはしない
  const max = Math.min(Math.max(min, beforeNav - PANEL_MAP_KEEP_PX), beforeNav)
  return { min: Math.min(min, max), max }
}

/**
 * 画面に出ている幅（px）。`storedRem` が `null` なら既定の幅を、アイコンナビを押し出さない範囲で使う
 * （つまみを入れる前と同じ。地図を残す上限は掛けない）。
 */
export function shownPanelWidthPx(storedRem: number | null, defaultRem: number, env: PanelWidthEnv): number {
  const beforeNav = env.viewportWidth - PANEL_NAV_RESERVE_REM * env.remPx
  if (storedRem === null) return Math.min(defaultRem * env.remPx, beforeNav)
  const { min, max } = panelWidthRangePx(env)
  return Math.min(Math.max(storedRem * env.remPx, min), max)
}

/** ドラッグで求めた幅（px）を保存する rem へ直す。範囲に収め、小数 2 桁で丸める */
export function panelWidthRemFromPx(px: number, env: PanelWidthEnv): number {
  const { min, max } = panelWidthRangePx(env)
  const clamped = Math.min(Math.max(px, min), max)
  return Math.round((clamped / env.remPx) * 100) / 100
}

/**
 * CSS 変数（`--panel-w-side` / `--panel-w-narrow`）へ入れる値。`null` なら変数を置かない（`w-panel` の既定に任せる）。
 * 下限・地図を残す上限を CSS の側で掛けるので、画面の幅が変わってもその場で詰まる。
 */
export function panelWidthCss(storedRem: number | null): string | undefined {
  if (storedRem === null) return undefined
  return `max(${PANEL_WIDTH_MIN_REM}rem, min(${storedRem}rem, calc(100dvw - ${PANEL_NAV_RESERVE_REM}rem - ${PANEL_MAP_KEEP_PX}px)))`
}

/**
 * 左右分割のうち狭い画面（`sideNarrow`）の条件。どちらの幅を使い・保存するかをこれで決める。
 * **`src/index.css` の `@custom-variant sideNarrow` と同じ式にする**（`panelWidth.test.ts` が突き合わせる）。
 */
export const SIDE_NARROW_QUERY = '(orientation: landscape) and (max-height: 600px) and (max-width: 1023px)'
