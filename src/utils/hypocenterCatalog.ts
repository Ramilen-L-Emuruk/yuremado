// 長期震源カタログ（public/data/hypocenter/）を読む。
//
// 気象庁の震源データを加工した静的データで、統計解析（b 値・静穏化・余震域・同一地点履歴・
// 深さ断面）の土台。生成は `scripts/build-hypocenter-catalog.ts`。
//
// 【年別に分かれている】1 ファイルにまとめると 30MB 前後になるため年ごとに分けてある。
// 用途に応じて必要な年だけ読む（時計盤なら 1 年、b 値なら 10 年、というように）。
//
// 【2 つの限界を必ず見ること】カタログは自分の限界を持っている。無視すると静かに嘘をつく。
//
//   1. `coveredThroughMs` —— データの終端。気象庁の「震源リスト」は 2 日前までしか載らない
//      ため、最近の数日は**必ず**欠ける。「まだ取っていない」と「地震が無かった」は、
//      格子の濃淡では区別できない。終端より先は「未取得」として描くこと。
//   2. `completeness` —— 期間ごとの完全性。収録は M2.0 以上だが、**M2.0 の取りこぼしが
//      無いのは 1997 年以降だけ。** 1919〜1950 年は年 505 件しか記録がない（現代は 2 万件超）。
//      統計に使うなら `completeMinMagnitude()` で閾値を上げること。
//
// 【電文の地震とは母集団が違う】このカタログは M2.0 以上の全地震。DMDATA / P2PQuake の地震情報は
// **震度を観測した地震だけ**で、1 日あたり 6〜7 件（カタログは 88 件）。10 倍以上違うので、
// 繋いで日別回数や統計に使わない。ヒートマップ（`useQuakeHeatmap`）だけはカタログを主にし、
// 終端より後の数日だけを電文で埋めて繋ぐ（2026-10-22 ユーザー承認「カタログ＋末尾の空きだけ API」）。
// 密度の見た目に使うだけで、回数は数えない。
//
// 【列で持つ】1 件 1 オブジェクトに展開すると数十万件でメモリを大きく食う。列ごとの
// TypedArray で保持し、利用側は添字で読む。

import { fetchJsonWithTimeout } from './fetchJson'

const BASE_URL = `${import.meta.env.BASE_URL}data/hypocenter`

/** 確定値（地震月報カタログ編）か速報値（震源リスト）か。 */
export type HypocenterQuality = 'final' | 'preliminary'

/** 「この年以降なら M いくつ以上が完全か」。`from` の昇順。 */
export interface HypocenterCompleteness {
  from: number
  minMagnitude: number
}

/** 索引。どの年が使えるかと、出典・件数・限界を持つ。 */
export interface HypocenterIndex {
  source: string
  sourceUrl: string
  license: string
  /**
   * 収録した M の下限。これより小さい地震は入っていない。
   * **M が決まっていない地震は下限に関わらず入っている**（`HypocenterYear.magnitude` が `NaN`）。
   */
  minMagnitude: number
  /**
   * データの終端（UTC epoch ミリ秒）。これより後は**未取得**であって、地震が無かったのではない。
   */
  coveredThroughMs: number
  /** 期間ごとの完全性。統計に使うときは `completeMinMagnitude()` を通すこと。 */
  completeness: HypocenterCompleteness[]
  /** 収録されている年（昇順）。 */
  years: number[]
  /** 年ごとの件数。M が決まっていない地震も含む。 */
  counts: Record<string, number>
  /**
   * 年ごとの、M が決まっていない地震の件数（`counts` の内数）。
   *
   * **画面はこの値を使わない**（件数欄の内訳は年ファイルの列から数える）。統計や調べもの向けに
   * 索引へ載せているだけなので、欠けた索引でも読めるよう任意にしてある。
   */
  unknownMagnitudeCounts?: Record<string, number>
  /** 年ごとの確からしさ。 */
  quality: Record<string, HypocenterQuality>
}

/** 1 年ぶんの震源。各配列は同じ長さで、同じ添字が同じ地震を指す。時刻の昇順。 */
export interface HypocenterYear {
  year: number
  count: number
  /** この年のデータが覆っている終端（UTC epoch ミリ秒）。通年なら翌年の頭。 */
  coveredThroughMs: number
  quality: HypocenterQuality
  /**
   * 発生時刻（UTC epoch ミリ秒）。
   *
   * **日ごとに数えるなら日本時間の暦日へ寄せること。** `new Date(timeMs).getDate()` は実行環境の
   * タイムゾーンで答えが変わる（CI は UTC で回る）。カタログの時刻はもともと日本時間なので、
   * 日付境界は `timeMs + 9 * 3600 * 1000` を UTC として読むのが正しい。
   */
  timeMs: Float64Array
  /** 緯度（度）。 */
  lat: Float64Array
  /** 経度（度）。 */
  lng: Float64Array
  /**
   * 深さ (km)。**決まっていない地震は `NaN`**（深さ欄が 2 通りに取れる形。1961〜1966 年に 24 件）。
   * 比較はどれも偽になるので、絞り込み・色分けでは呼び出し側が `Number.isNaN` で分けること。
   */
  depth: Float32Array
  /**
   * 震央地名の表（`nameIdx` が指す）。年 ZIP の年はいまの震央地名の区域に座標を当てた名前、
   * 区域の外は気象庁の英字の名前。日別の速報値の年は震源リストの名前そのまま。
   */
  names: readonly string[]
  /** 地震ごとの `names` の添字。名前が無い地震は `-1`。 */
  nameIdx: Int32Array
  /** 気象庁以外の機関（米国地質調査所・その他の国際機関）が決めた震源なら 1。 */
  external: Uint8Array
  /**
   * 最大震度の生コード（添字 → コード）。**有感の地震だけが載る。** 震度ではないコード
   * （`F` 有感地震・`X` 付近有感・`L`〜`R` 最大有感距離による顕著度）も入る。
   * 表示の語は `hypocenterIntensityLabel`。速報値の年は取得元に震度が無いので空。
   */
  intensityCode: ReadonlyMap<number, string>
  /**
   * マグニチュード。**決まっていない地震は `NaN`**（取得元の M 欄が空・`-`）。
   *
   * 比較はどれも偽になるので、`m >= 下限` のような絞り込みでは黙って落ちる。残すかどうかは
   * 呼び出し側が `Number.isNaN` で決めること（カタログタブの扱いは `hypocenterCatalogView.ts`）。
   */
  magnitude: Float32Array
}

/** 生成スクリプトが書き出す形。読み込み直後だけ使う。 */
interface RawYear {
  year: number
  startMs: number
  coveredThroughMs: number
  quality: HypocenterQuality
  coordScale: number
  depthScale: number
  magScale: number
  timeScale: number
  count: number
  t: number[]
  lat: number[]
  lng: number[]
  /** 深さが決まっていない地震は `null`。 */
  dep: (number | null)[]
  /** `dep` の `null` の数。 */
  unknownDepthCount: number
  /** M が決まっていない地震は `null`。 */
  mag: (number | null)[]
  /** `mag` の `null` の数（生成側が書く。列と食い違えば壊れた年として弾く）。 */
  unknownMagnitudeCount?: number
  // 最大震度の疎な 2 列は、点の吹き出しに最大震度を出すために読む（2026-10-25 ユーザー承認
  // 「C の案でよい (Recommended)」）。列の意味は生成スクリプト（scripts/build-hypocenter-catalog.ts）にある。
  intIdx: number[]
  intCode: string[]
  names: string[]
  nameIdx: number[]
  extIdx: number[]
  /** `extIdx` の件数（生成側が書く。食い違えば壊れた年として弾く）。 */
  externalCount: number
}

let indexCache: HypocenterIndex | null = null
let indexInflight: Promise<HypocenterIndex> | null = null
const yearCache = new Map<number, HypocenterYear>()
const yearInflight = new Map<number, Promise<HypocenterYear>>()

/**
 * その年以降を描くときに使うべき M の下限を返す。
 *
 * 収録は M2.0 以上だが、**M2.0 の取りこぼしが無いのは 1997 年以降だけ。** 観測網が疎だった
 * 時代を同じ濃淡で描くと「昔は地震が少なかった」という嘘になる。日別回数・b 値・静穏化の
 * ように件数を数える機能は、描く期間の**最も古い年**をここに渡して閾値を上げること。
 *
 * **使わなくてよいのは「その期間の完全性下限より上の M だけを扱う」場合。** M5 以上なら 1919 年から
 * 横ばいで取りこぼしが無いので、たとえば「この地点で起きた M5 以上」を並べるだけなら不要。
 * 逆に**同じ一覧に M2.0 以上を丸ごと入れるなら、古い期間は必ず薄くなる** —— 件数を数えていなくても、
 * 「近い順に 5 件」のような選び方は新しい期間へ偏る。期間を跨いで多寡を読ませる見せ方は避けること。
 */
export function completeMinMagnitude(index: HypocenterIndex, fromYear: number): number {
  // **黙って誤った閾値を返さない。** この関数の戻り値は統計の母集団を決めるので、
  // 呼び出し側の取り違えを例外にしないと、歪んだグラフが出るまで誰も気づけない。
  if (!Number.isFinite(fromYear)) {
    throw new Error(`completeMinMagnitude: fromYear が数値ではありません（${String(fromYear)}）`)
  }
  // **並び順に依存しない。** `from` が渡された年以前で最大のものを選ぶ。
  // 昇順を前提に「最後に一致したものが勝つ」書き方にすると、生成側の定数が並べ替えられた日に
  // 逆の閾値を返す —— 例外にならないので、観測網の歴史が地震活動の急減として表示される。
  let threshold = index.minMagnitude
  let bestFrom = -Infinity
  for (const entry of index.completeness) {
    if (entry.from <= fromYear && entry.from > bestFrom) {
      bestFrom = entry.from
      threshold = entry.minMagnitude
    }
  }
  // **収録の下限より下は返さない。** 入っていない地震を数えようとしても意味がない。
  return Math.max(threshold, index.minMagnitude)
}

/** 震度の階級を表す記号（`5`・`6` は弱強の区分が無かった 1996 年 9 月までの震度 5・6）。 */
const INTENSITY_SCALE_LABEL: Readonly<Record<string, string>> = {
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  A: '5弱',
  B: '5強',
  C: '6弱',
  D: '6強',
}

/**
 * 震度ではない記号の語。L〜R は気象庁のフォーマット仕様の語そのまま。F は「有感」と出す
 * （2026-10-25 ユーザー承認「C の案でよい (Recommended)」。仕様の語は「有感地震」）。
 */
const INTENSITY_OTHER_LABEL: Readonly<Record<string, string>> = {
  F: '有感',
  X: '付近有感',
  L: '局発地震',
  S: '小局発地震',
  M: 'やや顕著地震',
  R: '顕著地震',
}

/**
 * 最大震度の記号を吹き出しの 1 行にする。階級なら「最大震度 5弱」、震度ではない記号は語だけ。
 * 表に無い記号は `null`（行を出さない）。
 */
export function hypocenterIntensityLabel(code: string): string | null {
  const scale = INTENSITY_SCALE_LABEL[code]
  if (scale !== undefined) return `最大震度 ${scale}`
  return INTENSITY_OTHER_LABEL[code] ?? null
}

/**
 * 震央地名・気象庁以外の印・最大震度の列を確かめる。**添字が範囲の外なら年ごと弾く** ——
 * ずれた添字は別の地震の名前や印を黙って付ける。
 */
function validateSideColumns(raw: RawYear, year: number): void {
  const n = raw.count
  const isIndex = (v: unknown, limit: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < limit
  if (!Array.isArray(raw.names) || raw.names.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error(`hypocenter ${year}: names が不正です`)
  }
  if (!Array.isArray(raw.nameIdx) || raw.nameIdx.length !== n) {
    throw new Error(`hypocenter ${year}: nameIdx の長さが count と一致しません`)
  }
  for (const v of raw.nameIdx) {
    if (v !== -1 && !isIndex(v, raw.names.length)) throw new Error(`hypocenter ${year}: nameIdx が範囲の外です`)
  }
  if (!Array.isArray(raw.extIdx) || raw.extIdx.some((v) => !isIndex(v, n))) {
    throw new Error(`hypocenter ${year}: extIdx が不正です`)
  }
  // **件数も申告と突き合わせる。** 列が途中で切れても添字は範囲に収まるので、上の検査を通る ——
  // 気象庁以外の機関の震源が黙って気象庁の震源として描かれる。
  if (raw.externalCount !== raw.extIdx.length) {
    throw new Error(`hypocenter ${year}: 気象庁以外の機関の震源の数が年ファイルの申告と一致しません`)
  }
  if (
    !Array.isArray(raw.intIdx) ||
    !Array.isArray(raw.intCode) ||
    raw.intIdx.length !== raw.intCode.length ||
    raw.intIdx.some((v) => !isIndex(v, n)) ||
    raw.intCode.some((c) => typeof c !== 'string' || c.length !== 1)
  ) {
    throw new Error(`hypocenter ${year}: intIdx・intCode が不正です`)
  }
}

/** 索引を取得する。初回のみ fetch し、以降はキャッシュを返す。 */
export function loadHypocenterIndex(): Promise<HypocenterIndex> {
  if (indexCache) return Promise.resolve(indexCache)
  if (!indexInflight) {
    indexInflight = fetchJsonWithTimeout<HypocenterIndex>(`${BASE_URL}/index.json`, 'hypocenter-index', {
      // 地図の表示には関わらないため、地図の「〇〇を取り込めず」には計上しない
      // （TTS 辞書・テストシナリオと同じ扱い）。
      trackStatus: false,
      validate: (data) => {
        const idx = data as HypocenterIndex
        if (!idx || typeof idx !== 'object' || !Array.isArray(idx.years)) {
          throw new Error('震源カタログの目次: 形が不正です')
        }
        if (idx.years.length === 0) {
          throw new Error('震源カタログの目次: 収録年が 0 件です')
        }
        // **年の中身まで見る。** 数値でない年が 1 つでも混ざると、そこから作った時刻が NaN になり、
        // 日付ピッカーへ渡すところで例外になる（`toDateInputValue`）。震源カタログタブは常時
        // マウントされているので、その例外は**アプリ全体を落とす**。下の `coveredThroughMs` と
        // 同じ厳しさで見ておく。
        for (const year of idx.years) {
          if (typeof year !== 'number' || !Number.isInteger(year)) {
            throw new Error(`震源カタログの目次: years に年として読めない値があります（${String(year)}）`)
          }
        }
        // **終端が無ければ失敗させる。** 無いまま通すと、消費側は「未取得」と「地震が無かった」を
        // 区別できないまま格子を描く。欠けていることに気づけるのはここだけ。
        if (typeof idx.coveredThroughMs !== 'number' || !Number.isFinite(idx.coveredThroughMs)) {
          throw new Error('震源カタログの目次: coveredThroughMs がありません')
        }
        // **年ごとの確からしさも全年ぶん見る。** 期間の行に「速報値」を添えるかはこれで決める
        // （`preliminaryNote`）。欠けた年を黙って通すと、速報値の期間に何も添えない —— 年ファイル
        // 側と同じく、既定値（'final'）へ倒さない。
        if (!idx.quality || typeof idx.quality !== 'object') {
          throw new Error('震源カタログの目次: quality がありません')
        }
        for (const year of idx.years) {
          const q = idx.quality[String(year)]
          if (q !== 'final' && q !== 'preliminary') {
            throw new Error(`震源カタログの目次: quality[${year}] が不正です（${String(q)}）`)
          }
        }
        // **完全性の表が無ければ失敗させる。** 無いと `completeMinMagnitude()` が収録の下限を
        // そのまま返し、1919 年からの日別回数を M2.0 で数えてしまう（観測網の歴史が地震活動に化ける）。
        if (!Array.isArray(idx.completeness) || idx.completeness.length === 0) {
          throw new Error('震源カタログの目次: completeness がありません')
        }
        for (const entry of idx.completeness) {
          if (typeof entry?.from !== 'number' || typeof entry?.minMagnitude !== 'number') {
            throw new Error('震源カタログの目次: completeness の形が不正です')
          }
        }
      },
    })
      .then((data) => {
        indexCache = data
        return data
      })
      .catch((err) => {
        indexInflight = null
        throw err
      })
  }
  return indexInflight
}

/**
 * 1 年ぶんを取得する。初回のみ fetch し、以降はキャッシュを返す。
 *
 * 読み込んだ時点で TypedArray へ移し、格納単位（1/6000 度など）を実数へ戻す。
 * **単位は年ファイル自身が持っている値を使う** —— 索引側の値と食い違ったとき、読んだファイルの
 * 側を信じる方が桁がずれない。
 */
export function loadHypocenterYear(year: number): Promise<HypocenterYear> {
  const cached = yearCache.get(year)
  if (cached) return Promise.resolve(cached)
  const running = yearInflight.get(year)
  if (running) return running

  const p = fetchJsonWithTimeout<RawYear>(`${BASE_URL}/${year}.json`, `hypocenter-${year}`, {
    trackStatus: false,
    validate: (data) => {
      const raw = data as RawYear
      if (!raw || typeof raw !== 'object' || typeof raw.count !== 'number') {
        throw new Error(`hypocenter ${year}: 形が不正です`)
      }
      // **列の長さが揃っていることを必ず確かめる。** 1 本でも欠けると添字がずれ、別の地震の
      // 座標と M を組み合わせた値を黙って返すことになる。
      for (const key of ['t', 'lat', 'lng', 'dep', 'mag'] as const) {
        const col = raw[key]
        if (!Array.isArray(col) || col.length !== raw.count) {
          throw new Error(`hypocenter ${year}: ${key} の長さが count と一致しません`)
        }
        // **要素の型まで見る。** `null` が混ざると `null / coordScale` は例外にも NaN にもならず
        // **0 になる** —— 北緯 0 度・東経 0 度という「もっともらしい嘘」が静かに紛れ込み、
        // 地図にアフリカ沖の地震として現れる。NaN なら下流で崩れて気づけるが、0 は気づけない。
        //
        // **`null` を許すのは M と深さの列だけ。** 決まっていない値を表し、下で `NaN` へ
        // 写す（`null / magScale` の 0 にはしない —— M0.0・深さ 0 km という「もっともらしい嘘」になる）。
        const nullable = key === 'mag' || key === 'dep'
        for (let i = 0; i < col.length; i++) {
          const v = col[i]
          if (v === null && nullable) continue
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error(`hypocenter ${year}: ${key}[${i}] が数値ではありません`)
          }
        }
      }
      // **M 未決定の数を生成側の申告と突き合わせる。** `null` を許したぶん、M の列だけが
      // 壊れた年（全件 `null` など）も長さが揃えば通ってしまう —— 描画は失敗せず、灰色の
      // 「M 不明」の点が増えるだけで誰も気づけない。
      const unknown = raw.mag.reduce<number>((n, m) => (m === null ? n + 1 : n), 0)
      if (raw.unknownMagnitudeCount !== undefined && raw.unknownMagnitudeCount !== unknown) {
        throw new Error(`hypocenter ${year}: M 未決定の数が年ファイルの申告と一致しません`)
      }
      // 全件 M 未決定の年は実在しない（最も多い 1966 年でも 82%）。
      if (raw.count > 0 && unknown === raw.count) {
        throw new Error(`hypocenter ${year}: M の列がすべて null です`)
      }
      // **深さ不明の数も申告と突き合わせる**（M と同じ理由。深さの列だけ壊れても長さは揃う）。
      const unknownDepth = raw.dep.reduce<number>((n, d) => (d === null ? n + 1 : n), 0)
      if (raw.unknownDepthCount !== unknownDepth) {
        throw new Error(`hypocenter ${year}: 深さ不明の数が年ファイルの申告と一致しません`)
      }
      validateSideColumns(raw, year)
      if (typeof raw.startMs !== 'number' || !Number.isFinite(raw.startMs)) {
        throw new Error(`hypocenter ${year}: startMs がありません`)
      }
      // 索引と同じ理由で年ファイル側にも要る（索引を読み損ねても桁を取り違えないため）。
      if (typeof raw.coveredThroughMs !== 'number' || !Number.isFinite(raw.coveredThroughMs)) {
        throw new Error(`hypocenter ${year}: coveredThroughMs がありません`)
      }
      // **既定値を置かない。** 欠けたときに 'final' へ倒すと、速報値を確定値として扱う。
      if (raw.quality !== 'final' && raw.quality !== 'preliminary') {
        throw new Error(`hypocenter ${year}: quality が不正です`)
      }
      // **格納単位も必ず確かめる。** 欠けていると `数値 / undefined` が NaN になり、その年の
      // 時刻・座標・深さ・M が**例外を投げずに全件 NaN で埋まる**。検分しなければ「取得成功」として
      // 通り、統計側でグラフが崩れるまで誰も気づけない。
      //
      // **正の整数まで見る。** 0 だけを弾いても穴は残る —— 負の値なら符号が反転した座標を、
      // 小数なら桁がずれた時刻を、どちらも例外も NaN も出さずに「成功」として返す。
      for (const key of ['coordScale', 'depthScale', 'magScale', 'timeScale'] as const) {
        const scale = raw[key]
        if (typeof scale !== 'number' || !Number.isInteger(scale) || scale <= 0) {
          throw new Error(`hypocenter ${year}: ${key} が不正です`)
        }
      }
    },
  })
    .then((raw) => {
      const n = raw.count
      const out: HypocenterYear = {
        year: raw.year,
        count: n,
        coveredThroughMs: raw.coveredThroughMs,
        quality: raw.quality,
        timeMs: new Float64Array(n),
        lat: new Float64Array(n),
        lng: new Float64Array(n),
        depth: new Float32Array(n),
        magnitude: new Float32Array(n),
        names: raw.names,
        nameIdx: Int32Array.from(raw.nameIdx),
        external: new Uint8Array(n),
        intensityCode: new Map(raw.intIdx.map((idx, k) => [idx, raw.intCode[k]] as const)),
      }
      for (const idx of raw.extIdx) out.external[idx] = 1
      for (let i = 0; i < n; i++) {
        // 時刻は「その年の頭からの経過時間 × timeScale」で入っている。起点も刻みも年ファイルが
        // 持っているので、ここで日本時間を意識する必要はない。
        out.timeMs[i] = raw.startMs + (raw.t[i] * 1000) / raw.timeScale
        out.lat[i] = raw.lat[i] / raw.coordScale
        out.lng[i] = raw.lng[i] / raw.coordScale
        const dep = raw.dep[i]
        out.depth[i] = dep === null ? NaN : dep / raw.depthScale
        const mag = raw.mag[i]
        out.magnitude[i] = mag === null ? NaN : mag / raw.magScale
      }
      yearCache.set(year, out)
      yearInflight.delete(year)
      return out
    })
    .catch((err) => {
      yearInflight.delete(year)
      throw err
    })

  yearInflight.set(year, p)
  return p
}

/**
 * 複数年をまとめて取得する。並べ替えはせず、渡した順に返す。
 *
 * **1 年でも失敗したら全体を失敗させる。** 統計は期間が欠けると意味が変わるため、
 * 「取れた年だけで計算する」を既定にすると、欠けたことに気づかないまま誤った値を出す。
 */
export function loadHypocenterYears(years: readonly number[]): Promise<HypocenterYear[]> {
  return Promise.all(years.map(loadHypocenterYear))
}
