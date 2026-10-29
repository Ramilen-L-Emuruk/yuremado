/**
 * 強震モニタの観測点と値の扱いで、検知器・床の係・表示・診断が共有する小さな部品。
 *
 * - 計測震度インデックス → 計測震度の変換（`indexToValue`）
 * - 観測点の座標 → キー（`siteKey`・`computeSiteKeys`）
 * - 時間の空いたフレームでも時定数を保つ EWMA の係数（`ewmaAlpha`）
 *
 * **キーの作り方を 1 か所に保つこと。** 検知器（`kyoshinEnsembleTracker`）・床の係（`kyoshinNoiseFloor`）・
 * 表示（`kyoshinDetectionView` の `buildSiteIndex`）・診断はどれも同じキーで観測点を引き合う。どれか 1 つが
 * 別の作り方をすると、例外も出ずに別の点の値で判定するようになる。
 */

/** 計測震度インデックス(0〜20) → 計測震度 value(-3.0〜7.0)。 */
export function indexToValue(index: number): number {
  return -3.0 + index * 0.5
}

/**
 * 座標 → 状態管理キー。小数第 3 位（約 100m）で丸めて安定化する。
 * sitelist 更新時の丸め誤差レベルの座標揺れで別キー扱いになるのを防ぐ。
 */
export function siteKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`
}

/**
 * フレーム配列（座標順）→ 一意キー配列。Yahoo 強震モニタの公開座標は観測点によっては小数第1位までしか
 * 精度が無く、複数の実観測点が同一座標として配信されることがある（2026-08-08 天草・芦北地方の地震の
 * 誤報調査で発覚。全1725点中207グループ・431点が生座標レベルで完全一致）。siteKey(lat,lng) だけを
 * キーにすると後から処理した点が先勝ちの点を黙って上書きし、床の学習・立ち上がりの判定が別センサーの
 * データで汚染される（どちらも「同一物理点の連続観測」が前提）。同一座標が複数回現れた場合は
 * 出現順に #2, #3... を付与し、別実体として扱う。Yahoo 公式サイト自身も座標の重複を一切マージせず
 * 観測点ごとに別の描画要素（circle）を出し、震度が大きい方が上に重なるよう描画順をソートしているだけ。
 */
// 観測点リストごとのキー配列。**同じ配列に対しては作り直さない。**
//
// 表示側（`kyoshinDetectionView` の `buildSiteIndex`）は強震モニタが 1 秒ごとに値を配るたびに
// これを呼ぶが、渡ってくる観測点リストは同じ配列（`fetchSiteList` がキャッシュしたもの）で、
// 座標が変わらない以上キーも変わらない。それでも全 1725 点ぶんの文字列を毎秒組み直すと、
// 非力な端末では自動移動 1 回のあいだに 30〜50ms をここで使う。
//
// **配列そのものを鍵にする**（中身の比較はしない）。観測点リストが差し替わるときは必ず別の配列に
// なるため、これで十分に見分けられる。WeakMap なので、リストが捨てられればキャッシュも一緒に消える。
//
// **返す配列は `readonly`。** 同じ配列を全員（検知器・表示用の索引・診断ログ）が共有するため、
// 1 箇所の書き換えが全部を同時に狂わせる。例外は出ず、座標とキーの対応だけが静かにずれるので、型で止める。
const siteKeysCache = new WeakMap<readonly [number, number][], readonly string[]>()

export function computeSiteKeys(sites: [number, number][]): readonly string[] {
  const cached = siteKeysCache.get(sites)
  if (cached) return cached
  const seen = new Map<string, number>()
  const keys = sites.map(([lat, lng]) => {
    const base = siteKey(lat, lng)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
  siteKeysCache.set(sites, keys)
  return keys
}

/**
 * Δt を考慮した EWMA 係数を返す。α = 1 − exp(−Δt/τ)。
 * フレーム欠損で Δt が伸びても時定数を保つ。
 */
export function ewmaAlpha(dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return 0
  return 1 - Math.exp(-dtMs / tauMs)
}
