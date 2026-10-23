// 縦積みレイアウト（スマホ縦など）で、下部の波形が出ている間に地図を正方形に保つための高さの配り方。
//
// 縦積みでは地図・下部の波形・つまみ・パネルが 1 本の縦の列を分け合う。波形を足すと地図だけが削られ、
// 既定のパネル比率（45%）では地図が横長の帯になって見られなくなる。そこで**配る順番を
// 「地図の正方形 → 波形の 1 段 → パネル」にする**（2026-10-24 ユーザー選択「一旦Aで作ってみて」）。
//
// - 波形が出たら、パネルは足りない分だけ縮めて見せる。**保存してある比率は書き換えない**（ここで返すのは
//   表示に使う比率だけ）。波形が消えれば元の高さへ戻る
// - 利用者がつまみで動かしたら、その比率をそのまま使う。**上限より広げたら、波形の枠を隠す**（地図の正方形は残す。
//   2026-10-24 ユーザー指示「そうではなく波形を隠す方向にすることはできないですか？タブは上限以上に調整できるようにしたいです。」）
// - パネルは下限（`PANEL_RATIO_MIN`）より小さくしない。そこまで縮めても足りない背の低い画面では、
//   波形の 1 段を残して地図のほうが正方形を割る
// - 波形の 2 段目以降は枠の中でずらして見る（地図の下限があるので、枠はそれ以上伸びない）
//
// 左右分割（`side`）では使わない —— パネルの高さも地図の下限も、呼び出し側の CSS が縦積みのときだけ効かせる。

export interface SquareMapLayoutInput {
  /** 地図・つまみ・パネル・下のナビを縦に積む器の幅（px）。縦積みでは地図の幅と同じ。パネルの比率はこの器の高さに掛かる。 */
  readonly containerWidth: number
  /** 同じ器の高さ（px）。 */
  readonly containerHeight: number
  /** 器のうち地図の列とパネル以外が占める高さ（px。境目のつまみと下のナビ）。 */
  readonly otherHeight: number
  /** 下部の波形の先頭の段の高さ（px）。**波形を出していないなら `null`**（何も借りない）。 */
  readonly leadRowHeight: number | null
  /** 利用者が決めたパネルの比率（折りたたみ中は 0）。 */
  readonly panelRatio: number
  /**
   * 波形が出ている間に、利用者がつまみでパネルを動かしたか。**動かしたら縮めずに `panelRatio` をそのまま使う**。
   * 呼び出し側は波形が消えたら偽へ戻す（次に波形が出たら、また縮めて見せる）。
   */
  readonly adjustedWhileWave: boolean
  /** パネルの比率の下限。 */
  readonly minPanelRatio: number
}

export interface SquareMapLayout {
  /** 表示に使うパネルの比率。 */
  readonly panelRatio: number
  /** 地図の高さの下限（px）。0 なら下限を置かない。 */
  readonly mapMinHeight: number
  /** 波形の枠を隠すか（パネルを上限より広げたとき）。 */
  readonly waveHidden: boolean
  /** 地図を正方形に保つために縮めている、または縮めうる状態か（波形が出ていて寸法が読めている）。 */
  readonly borrowing: boolean
}

export function squareMapLayout(input: SquareMapLayoutInput): SquareMapLayout {
  const { containerWidth: w, containerHeight: h, otherHeight, leadRowHeight, panelRatio, adjustedWhileWave, minPanelRatio } = input
  // 波形が出ていない・寸法が読めないときは今までどおり（利用者の比率のまま、地図に下限を置かない）。
  // `otherHeight` が負になるのは左右分割のとき（地図の列とパネルが横に並ぶので、器の高さから両方を引くと負になる）。
  if (
    leadRowHeight === null || !(w > 0) || !(h > 0) || !Number.isFinite(leadRowHeight)
    || !Number.isFinite(otherHeight) || otherHeight < 0
  ) {
    return { panelRatio, mapMinHeight: 0, waveHidden: false, borrowing: false }
  }
  const row = Math.max(0, leadRowHeight)
  // つまみ・ナビ・地図の正方形・波形の 1 段を取ったあと、パネルに残せる高さ。
  const roomForPanel = h - otherHeight - w - row
  // 下限より下へは縮めない。折りたたみ（0）や下限より小さい比率はそのまま（広げはしない）。
  const cap = Math.max(minPanelRatio, roomForPanel / h)
  const effective = adjustedWhileWave ? panelRatio : Math.min(panelRatio, cap)
  // 上限を超えた高さをパネルに取ったら、波形の 1 段は入らない —— 枠ごと隠す（半端に切れた段は出さない）。
  // 誤差で揺れないよう 0.5px の遊びを持たせる。
  const waveHidden = (effective - cap) * h > 0.5
  // 地図の下限は正方形。ただし波形の 1 段を押し出さない高さまでに留める（背の低い画面で正方形を割る側）。
  // 波形を隠したら 1 段ぶんも地図へ回す。
  const mapMinHeight = Math.max(0, Math.min(w, h - otherHeight - effective * h - (waveHidden ? 0 : row)))
  return { panelRatio: effective, mapMinHeight, waveHidden, borrowing: true }
}
