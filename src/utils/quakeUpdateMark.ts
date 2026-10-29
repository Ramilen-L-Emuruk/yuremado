import type { JMAQuake, JMAQuakeCity, JMALpgm, EarthquakePoint, IssueType } from '../types/earthquake'
import { cityKey, higherIntensityEntry, isAreaPoint, type AreaPrefIndex, type IntensityEntry } from './quakePoints'
import { log } from './logger'
import { UPDATE_MARK_TTL_MS, statusOf, type SnapshotValue, type UpdateStatus } from './updateMark'

/**
 * 地震カードで「この報で動いた」と示せる欄。
 *
 * **どれも実配信では稀にしか動かない**（控え 60 日・続報 534 通での実測。震央地名 0.0% /
 * 津波区分 1.0% / 規模 4.0% / 深さ 4.5% / 座標 4.7% / 最大震度 9.6%）。稀だからこそ印が
 * 「そこが動いた」を本当に意味する。
 *
 * **震央地名は 1 度も動かなかったが、入れておく。** 気象庁は訂正報と震源要素更新
 * （VXSE61）で震源名を書き換えうるので、動かないのは標本の性質であって規約ではない。
 */
export type QuakeUpdateField =
  | 'hypocenterName'
  | 'coordinate'
  | 'nameFromMark'
  | 'magnitude'
  | 'depth'
  | 'domesticTsunami'
  | 'maxScale'

/** 震源要素・最大震度のスナップショット。 */
export type QuakeFactSnapshot = ReadonlyMap<QuakeUpdateField, SnapshotValue>

/** 震度一覧・長周期一覧の行のスナップショット。鍵は {@link rowMarkKey}。 */
export type RowSnapshot = ReadonlyMap<string, SnapshotValue>

/**
 * 津波区分の重さ。**「調査中」「不明」はここに載せない** —— あれは値ではなく
 * 「まだ決まっていない」なので、そこから確定しても上がった／下がったとは言えない。
 *
 * **載っていない値は「値が無い」として扱う**（{@link quakeFactSnapshot} が番兵へ倒す）。
 * 調査中から確定した報は、震源が未確定から確定した報と同じく「値が付いた」扱いになり、
 * 直前の電文と種別が同じときだけ初出の緑が付く（→ {@link changedQuakeFacts}）。
 */
const DOMESTIC_TSUNAMI_RANK: Record<string, number> = {
  'なし': 0,
  '若干の海面変動': 1,
  '海面変動の可能性': 2,
  '注意報': 3,
  '警報等': 4,
}

/**
 * 行を指す鍵。**段の種別を前置きする** —— 区域名と県名は一致しうる（実データの「奈良県」）。
 * カードの開閉キー（`expandKey`）が同じ理由で同じ形を採っている。
 *
 * **名前だけで鍵にする段がある**（県・区域・観測点）。市町村だけは名前が全国で一意にならない
 * ので（府中市＝東京都・広島県）区域との組にする —— 既存の {@link cityKey} をそのまま使い、
 * 区切り文字を書き写さない。
 *
 * 観測点名も全国で一意とは限らないが、**取り違えても起きるのは「隣の行に印が付く」ことだけ**で、
 * 座標や震度が入れ替わるわけではない。津波カードの観測点も名前で引いており、そちらと揃える。
 */
export const rowMarkKey = {
  pref: (name: string) => `pref:${name}`,
  area: (name: string) => `area:${name}`,
  city: (area: string, name: string) => `city:${cityKey(area, name)}`,
  station: (name: string) => `st:${name}`,
} as const

/** {@link rowMarkKey} が作る鍵の種別。`diffQuakeRows` が「その段が初めて現れた報」を見分けるのに使う。 */
const ROW_KINDS = ['pref:', 'area:', 'city:', 'st:'] as const
/** 行の段（{@link rowMarkKey} の前置き）。 */
export type RowKind = typeof ROW_KINDS[number]
const kindOf = (key: string): string => ROW_KINDS.find(k => key.startsWith(k)) ?? ''

/** 値が無い欄を表す番兵。**空文字を「比べない」の意味に使わない** —— 下記の理由を参照。 */
const UNKNOWN = ''

/**
 * 震源要素・最大震度の、いま画面に出ている値を写し取る。
 *
 * **渡すのは併合後のカードで、届いた電文そのものではない。** 続報の持ち越し規則
 * （`docs/spec/quake-spec.md` §6.4 —— 震度速報は震源を持たないので前報から補う、
 * 種別に付く定型文の津波区分は採らない、等）は併合が既に適用している。電文の側で差分を
 * 取ると、その規則をもう 1 か所に書き写すことになり、必ず食い違う。
 *
 * **値が無い欄も番兵で写す。捨てない。** 捨てると「値が消えた」が差分に現れなくなる。
 * 気象庁が取り下げた値は画面からも消えるので（§6.4「値が消えた・下がったのはそのまま従う」）、
 * そこは印が要る変化。
 */
export function quakeFactSnapshot(q: JMAQuake): Map<QuakeUpdateField, SnapshotValue> {
  const h = q.earthquake.hypocenter
  const snap = new Map<QuakeUpdateField, SnapshotValue>()
  setHypocenterFacts(snap, h)
  // 位置不明のセンチネルは -200（パーサーが埋める）。`Number.isFinite` だけでは素通りする。
  const hasPos = Number.isFinite(h.latitude) && Number.isFinite(h.longitude) && h.latitude !== -200 && h.longitude !== -200
  snap.set('coordinate', { key: hasPos ? `${h.latitude},${h.longitude}` : UNKNOWN })
  // 震央補助表現（「輪島の東北東３０ｋｍ付近」）も大小が無い。**電文の原文で比べる**（表示は半角へ直すが、
  // 持つ値は原文 —— `formatNameFromMark`）。全期間の控え（2020-11〜、続報 1,586 組）では、座標が動いても
  // 文はそのままで、文が別の文へ変わった組は 0 だった。震央地名と同じく、動かないのは標本の性質として入れておく
  // （2026-10-19 ユーザー承認「1 で」＝文が別の文へ変わったときだけ印を付ける）。文が無かった欄に文が現れたときは、
  // 同じ種別の続報に限って初出の印を付ける（2026-10-21 に改めた。→ `changedQuakeFacts`）。
  snap.set('nameFromMark', { key: h.nameFromMark || UNKNOWN })
  // 「調査中」「不明」は値ではなく「まだ決まっていない」ので、値が無いのと同じに扱う
  // （→ `DOMESTIC_TSUNAMI_RANK`）。**逆向き（確定していた区分が調査中へ戻る）は印を付ける** ——
  // 気象庁が取り下げた事実なので、こちらは伝える。
  const tsunami = q.earthquake.domesticTsunami
  const tsunamiRank = tsunami ? DOMESTIC_TSUNAMI_RANK[tsunami] : undefined
  // **鍵には区分を決めたコードも入れる。** 札はコードで語を選ぶ（→ `formatDomesticTsunami`）ので、
  // 区分が同じでもコードが変われば表示は動く（0212「若干の海面変動」→ 0213「海面変動に注意」）。
  const tsunamiCode = q.earthquake.domesticTsunamiCode
  snap.set('domesticTsunami', tsunamiRank === undefined
    ? { key: UNKNOWN }
    : { key: tsunamiCode ? `${tsunami}:${tsunamiCode}` : tsunami, rank: tsunamiRank })
  setMaxScaleFact(snap, q.earthquake.maxScale)
  return snap
}

/**
 * 長周期地震動の欄に出している値（震源名・規模・深さ・全国の最大震度）を写し取る。
 *
 * **写し方は地震カードと同じ関数を通す**（→ {@link setHypocenterFacts}）。同じ名前の欄を 2 つの
 * カード部品が出すので、片方だけ鍵の作りが変わると、同じ変化に一方だけ印が付く。
 *
 * **地震発現時刻は写さない。** 地震カードも時刻の欄に印を持たない（→ {@link QuakeUpdateField}）。
 *
 * **取消の報では呼ばない**（一覧ごと消えるので、印を付ける先が無い。→ `applyLiveLpgmWithMarks`）。
 */
export function lpgmFactSnapshot(lpgm: JMALpgm): Map<QuakeUpdateField, SnapshotValue> {
  const snap = new Map<QuakeUpdateField, SnapshotValue>()
  const h = lpgm.hypocenter
  setHypocenterFacts(snap, {
    name: h?.name ?? '',
    magnitude: lpgm.magnitude ?? Number.NaN,
    magnitudeCondition: lpgm.magnitudeCondition,
    magnitudeType: lpgm.magnitudeType,
    // 長周期の型は深さを任意で持つ（読めなければ持たない）。地震カードの番兵 -1 へ揃える。
    depth: h?.depth ?? -1,
    depthAtLeast: h?.depthAtLeast,
  })
  setMaxScaleFact(snap, lpgm.maxInt ?? -1)
  return snap
}

/**
 * 前の写しで値があったのに、新しい写しで値が無くなった欄。
 *
 * 長周期の欄は値の無い項目を行から省くので、続報で値が消えても印を付ける先が無い。
 * **画面には出さず、記録にだけ残す**（2026-10-29 ユーザー承認「記録にだけ残す (Recommended)」）ために使う。
 */
export function vanishedFacts(
  prev: ReadonlyMap<QuakeUpdateField, SnapshotValue> | undefined,
  next: ReadonlyMap<QuakeUpdateField, SnapshotValue>,
): QuakeUpdateField[] {
  if (!prev) return []
  const out: QuakeUpdateField[] = []
  for (const [field, value] of next) {
    const before = prev.get(field)
    if (before && before.key !== UNKNOWN && value.key === UNKNOWN) out.push(field)
  }
  return out
}

/** 震源名・規模・深さを写す。地震カード（{@link quakeFactSnapshot}）と長周期（{@link lpgmFactSnapshot}）で共有する。 */
function setHypocenterFacts(
  snap: Map<QuakeUpdateField, SnapshotValue>,
  h: Pick<JMAQuake['earthquake']['hypocenter'], 'name' | 'magnitude' | 'magnitudeCondition' | 'magnitudeType' | 'depth' | 'depthAtLeast'>,
): void {
  // 震央地名には大小が無いので `rank` を付けない（動いたことしか言えない）。
  snap.set('hypocenterName', { key: h.name || UNKNOWN })
  // 規模は**数値と説明の両方**を鍵に含める。「Ｍ８を超える巨大地震」は本文が NaN で
  // `description` だけが値を持つので、数値だけで比べるとその変化が消える
  // （→ `docs/spec/quake-spec.md` §8）。**大小を比べられるのは数値があるときだけ。**
  // **種別（`Mj` / `M`）も鍵に入れる。** 画面はこれを前置きの記号に出すので、数値が同じまま
  // 種別だけ変わった続報でも表示は動く（`M6.8` → `Mj6.8`）。鍵から外すと印が付かない。
  //
  // **「値が無い」は鍵の文字列ではなく、材料そのもので見る。** 鍵の組み立てに項目を 1 つ足すと
  // 区切りの数が変わるので、`magKey === '|'` のような文字列の突き合わせは黙って外れる
  // （実際に種別を足したとき外れ、規模が無い報に `UNKNOWN` ではない鍵が付いた）。
  const hasMag = Number.isFinite(h.magnitude) && h.magnitude >= 0
  const hasMagFacts = hasMag || !!h.magnitudeCondition
  const magKey = `${hasMag ? h.magnitude.toFixed(1) : ''}|${h.magnitudeCondition ?? ''}|${h.magnitudeType ?? ''}`
  snap.set('magnitude', hasMagFacts
    ? { key: magKey, ...(hasMag ? { rank: h.magnitude } : {}) }
    : { key: UNKNOWN })
  // 深さの 0 は「ごく浅い」という有効値で、-1 が「読めなかった」の目印。
  // **浅いほど危険なので、順序は深さの符号を反転させる** —— 「上がった（赤）」が
  // 「より深刻になった」を指す約束を、どの欄でも守る。
  // 「700km以上」（`depthAtLeast`）は同じ 700 でも別の値なので鍵に含める（印が付いた・外れたも更新）。
  snap.set('depth', h.depth >= 0 ? { key: `${h.depth}${h.depthAtLeast ? '+' : ''}`, rank: -h.depth } : { key: UNKNOWN })
}

/** 最大震度を写す。地震カードの `maxScale` と長周期の全国の最大震度（`JMALpgm.maxInt`）で共有する。 */
function setMaxScaleFact(snap: Map<QuakeUpdateField, SnapshotValue>, maxScale: number): void {
  snap.set('maxScale', maxScale >= 0 ? { key: String(maxScale), rank: maxScale } : { key: UNKNOWN })
}

/**
 * 前の報から動いた欄を、欄ごとの印にする。
 *
 * **前が無ければ何も返さない。** そのカードで最初に見た報は全欄が「初出」になり、
 * 印が画面を埋めるだけで何も指さない。
 *
 * **値が無い状態から値が付いた欄は、直前の電文と種別が同じときだけ初出（緑）にする**
 * （2026-10-21 ユーザー承認。選択「自明でない組だけ緑 (Recommended)」。2026-10-19 の
 * 「震央補助表現が現れただけでは付けない」はこれで改めた）。種別が変われば載せる欄の顔ぶれも
 * 変わるので、値が付いたのは「報の粒度が変わった」ことでしかない —— 震度速報のあとに震源情報が
 * 届く形がこれで、付けると**震源が確定した報で欄が一斉に光る**。同じ種別のまま値が付くのは
 * 気象庁が続報で新たに伝えた事実で、全期間の控えでは震央補助表現が出た 3 件・遠地地震の津波区分が
 * 調査中から確定した 22 件がこれにあたる。
 *
 * **一覧の行はこれと違う**（→ {@link diffQuakeRows}）。数百行のなかに 1 行増えても、それ自体では
 * 気づけないので初出の印が要る。
 *
 * 値どうしが入れ替わったら、大小を比べられるなら向き（上がった／下がった）、比べられないなら
 * 「向きの無い変化」。**値が消えたのは「向きの無い変化」** —— 小さくなったのではなく気象庁が
 * 取り下げたので、大小の話にしない。
 */
export function changedQuakeFacts(
  cur: QuakeFactSnapshot,
  prev: QuakeFactSnapshot | undefined,
  /** 直前の電文と、いま届いた電文の種別が同じか（→ {@link QuakeMarkMemory.telegramType}） */
  sameTelegramType: boolean,
): Map<QuakeUpdateField, UpdateStatus> {
  const out = new Map<QuakeUpdateField, UpdateStatus>()
  if (!prev) return out
  for (const [field, value] of cur) {
    const before = prev.get(field)
    if (before === undefined) continue
    // 値が無いところへ値が付いたら、種別が同じときだけ初出（上の注記）。
    if (before.key === UNKNOWN) {
      if (sameTelegramType && value.key !== UNKNOWN) out.set(field, 'new')
      continue
    }
    const status = statusOf(before, value)
    if (status) out.set(field, status)
  }
  return out
}

/**
 * 震度一覧の行の、いま画面に出ている階級を写し取る。
 *
 * **併合後のカードの点を渡すこと**（理由は {@link quakeFactSnapshot} と同じ）。
 *
 * **ここで写すのは値だけで、電文の `Revise` は見ない。** `Revise` で付ける印は
 * {@link quakeTelegramRevise} が届いた電文から作り、{@link advanceQuakeMarks} がこの写しの差分と
 * 差し替える。写しは次の報が比べる相手でもあるので、`Revise` の有無で中身を変えない。
 */
export function quakeRowSnapshot(
  points: readonly EarthquakePoint[],
  cities: readonly JMAQuakeCity[],
  /** 区域の点と都道府県ロールアップ点を見分ける索引（`buildIntensityRows` へ渡すものと同じ） */
  areaPrefIndex: AreaPrefIndex,
): Map<string, SnapshotValue> {
  const snap = new Map<string, SnapshotValue>()
  const prefEntries = new Map<string, IntensityEntry>()
  for (const p of points) {
    // 未入電は下限の 45 が入っているので、階級だけで比べると観測値が届いた瞬間を
    // 取りこぼす（45 のまま）。**鍵には含め、順序には含めない** —— 階級が同じまま
    // 未入電が解けたのは「上がった」でも「下がった」でもないため。
    const value: SnapshotValue = { key: `${p.scale}${p.unreceived ? '!' : ''}`, rank: p.scale }
    // **振り分けは `buildIntensityRows` と同じ規則にする。** 行を組む側と写す側で違えると、
    // 画面に無い行を記憶したり、ある行を記憶し損ねたりする。
    //
    // とくに**都道府県ロールアップ点**（`Pref/MaxInt` 由来。`isArea` が真で `addr === pref`）は
    // **どの行にもならず、県の最大にしか効かない**。`isAreaPoint` が偽でも観測点の側へ落とさない
    // こと（`!p.isArea` で分ける）—— 落とすと震度速報の段階で `st:` の記憶ができてしまい、
    // **「観測点の段が初めて現れた報では印を付けない」歯止めが効かなくなる** —— 各地の震度で
    // 観測点が数千行いっぺんに光る。
    //
    // 区域の点は `pref` の有無で見分けない。**P2PQuake は区域の点にも県名を積む**ので、
    // `pref` で見ると標準版の震度速報で区域の記憶が 1 つもできない。
    if (p.pref) {
      // 県の行は配下の最大。**点を上書きせず、行と同じ規則で大きい方を残す**（震度が同じなら
      // 観測値を採る。→ `higherIntensityEntry`）。鍵には区域・観測点と同じく未入電の印を含める ——
      // 含めないと、県の値が「5弱以上・未入電」から観測値の 5弱へ変わった報で県の行だけ印が付かない。
      const key = rowMarkKey.pref(p.pref)
      const cur = prefEntries.get(key)
      const next = higherIntensityEntry(cur, { scale: p.scale, unreceived: !!p.unreceived })
      prefEntries.set(key, next)
      snap.set(key, { key: `${next.scale}${next.unreceived ? '!' : ''}`, rank: next.scale })
    }
    if (isAreaPoint(p, areaPrefIndex)) snap.set(rowMarkKey.area(p.addr), value)
    if (!p.isArea) snap.set(rowMarkKey.station(p.addr), value)
  }
  for (const c of cities) {
    if (!c.area || !c.name) continue
    snap.set(rowMarkKey.city(c.area, c.name), { key: `${c.scale}${c.unreceived ? '!' : ''}`, rank: c.scale })
  }
  return snap
}

/**
 * 行のスナップショットどうしを突き合わせて、行ごとの印を出す。
 *
 * **「値が動いたか」と「行が初めて出たか」で、比べる相手を分ける。**
 *
 * 値が動いたかは**直前の報**と比べる。気象庁が震度を引き上げた事実は、報の種別が変わっても
 * 伝える価値があるため。
 *
 * 行が初めて出たかは**同じ情報種別で前に見た報**と比べる。気象庁は同じ地震について載せる範囲の
 * 違う電文を発表する —— 震度速報は震度3以上の区域しか載せず、震源・震度情報は震度1以上の全区域を
 * 載せる。種別をまたいで比べると区域と県が一斉に増え、それが「初出」として光る（能登本震の実電文で
 * 33 県 75 区域 → 44 県 118 区域。11 県・43 区域が該当）。**それは新しく揺れが観測されたのでは
 * なく、報の粒度が変わっただけ。**
 *
 * **初出の判定に「直前の報の種別」を使ってはいけない。** 気象庁は種別を前後させる ——
 * 2024-01-01 16:06 の前震では震度速報（16:07）→ 震源情報 → 震度速報（16:08）の順で届く。
 * 「直前と種別が違えば初出を出さない」という形にすると、**震度速報どうしの続報が種別の変わり目と
 * して扱われ**、その報で本当に増えた区域（新潟県佐渡）の印まで消える。種別ごとに写しを持つのは
 * このため（→ {@link QuakeMarkMemory}）。
 *
 * **その種別を初めて見た報では初出を出さない**（`prevSameType` が無い）。比べる相手が無いので、
 * 増えた行はすべて初出に見える。
 *
 * **段が初めて現れた報でも印を付けない。** 「震度速報 → 各地の震度」では観測点の行がいっぺんに
 * 全部現れる（控え 60 日の実測で中央値 26 行・最大 2,825 行）。種別ごとに比べるようになって
 * 重なる場面が増えたが、**同じ種別のまま段が増える経路も残る**ので置いたままにする —— 市町村に
 * 紐づかない観測点しか持たない報のあとに市町村付きの報が来る形（`points` の振り分けは電文の
 * 入れ子で決まる）がそれにあたる。
 *
 * 2 通目以降は素直に差分を出す。実測では観測点の行のうち印が付くのは中央値 3.2% だった。
 */
export function diffQuakeRows(
  cur: RowSnapshot,
  /** 直前の報の写し（種別を問わない）。**値が動いたか**はこれと比べる。 */
  prev: RowSnapshot | undefined,
  /** 同じ情報種別で前に見た写し。**行が初めて出たか**はこれと比べる。 */
  prevSameType: RowSnapshot | undefined,
): Map<string, UpdateStatus> {
  const out = new Map<string, UpdateStatus>()
  // 段の既出は**同じ種別の写し**で見る。種別をまたぐと段の顔ぶれが変わるため。
  const seenKinds = new Set<string>()
  for (const key of prevSameType?.keys() ?? []) seenKinds.add(kindOf(key))
  for (const [key, value] of cur) {
    const before = prev?.get(key)
    if (before !== undefined) {
      const status = statusOf(before, value)
      if (status) out.set(key, status)
      continue
    }
    // 直前の報に無い行。**初出と言えるのは、同じ種別の写しにも無いときだけ。**
    if (!prevSameType) continue
    if (prevSameType.has(key)) continue
    if (!seenKinds.has(kindOf(key))) continue
    out.set(key, 'new')
  }
  return out
}

/**
 * 長周期地震動の一覧の行を写し取る（県 → 区域 → 観測点の 3 段）。
 *
 * **震度一覧と同じ鍵・同じ差分関数を通す。** 段の数が違うだけで、行の意味は同じ。
 *
 * **控えの 60 日では長周期の続報が 1 通も無かった**（24 件すべて単発）。ただしこれは
 * 「見つからなかった」であって「来ない」ではない —— 電文の仕様は訂正・続報を禁じておらず、
 * アプリ自身も初報と続報を見分けている（`seenLpgmEventIdsRef`）。震度一覧に印を付ける以上、
 * 同じ構造のこちらだけ印が出ない形にはしない。
 *
 * 階級と震度の両方を鍵に含める。カードは 2 つを並べて出しているので、震度だけが動いた報で
 * 印が出ないと画面と食い違う。
 */
export function lpgmRowSnapshot(
  regions: readonly { name: string; maxLgInt: number; maxInt?: number }[],
  points: readonly { name: string; lgInt: number; int?: number }[],
  prefs: readonly { name: string; maxLgInt: number; maxInt?: number }[],
): Map<string, SnapshotValue> {
  const snap = new Map<string, SnapshotValue>()
  // 順序は**階級を主、震度を従**にする（カードもその並びで出している）。震度は階級表の
  // 最大が 70 なので、階級 1 段の差が震度のどの差よりも大きくなる桁を取る。
  const value = (lgInt: number, int?: number): SnapshotValue =>
    ({ key: `${lgInt}/${int ?? ''}`, rank: lgInt * 1000 + (int ?? 0) })
  for (const p of prefs) snap.set(rowMarkKey.pref(p.name), value(p.maxLgInt, p.maxInt))
  for (const r of regions) snap.set(rowMarkKey.area(r.name), value(r.maxLgInt, r.maxInt))
  for (const s of points) snap.set(rowMarkKey.station(s.name), value(s.lgInt, s.int))
  return snap
}

/**
 * 届いた電文の `Revise` から作った行の印（→ {@link quakeTelegramRevise}・{@link lpgmTelegramRevise}）。
 *
 * **`kinds` に入っている段は、差分ではなくこの印だけで付ける**（ただし `unreadable` の行は差分を残す）。
 * `Revise` の無い行は「直前の同じ種別の報から動いていない」（→ `JMAQuake.reportsRevise`）。`kinds` に無い段
 * （長周期の観測点）は電文が `Revise` を持たないので、今までどおり差分で付ける。
 */
export interface TelegramRowRevise {
  kinds: readonly RowKind[]
  marks: ReadonlyMap<string, UpdateStatus>
  /**
   * `Revise` に知らない語が載っていた行の鍵。**この行は差分の印を残す**（電文が何かを言っているのに
   * 読めないので、「動いていない」とは扱えない）。
   */
  unreadable: ReadonlySet<string>
  /** 記録に添える電文の識別子。 */
  source: string
  /** 記録の頭に付ける種別の印（地震情報は `[quake]`、長周期地震動観測情報は `[lpgm]`）。 */
  logTag: '[quake]' | '[lpgm]'
}

/**
 * `Revise` の値を印へ直す。気象庁の語は 3 つ（解説資料 Ⅱ.33 2-1-3-2 ほか）。
 *
 * **緑と黄の使い分けは今の印と同じ**（→ `UPDATE_MARK_COLOR`）。「追加」は初出の緑、
 * 「上方修正」「下方修正」は動いた黄（向きは添える言葉が言う）。
 */
const REVISE_STATUS: Record<string, UpdateStatus> = {
  '追加': 'new',
  '上方修正': 'raised',
  '下方修正': 'lowered',
}

/** `Revise` の語を印の表へ積む。知らない語は、語を `unknown` へ・行の鍵を `unreadable` へ分ける（→ {@link quakeTelegramRevise}）。 */
function collectRevise(
  marks: Map<string, UpdateStatus>,
  unknown: Set<string>,
  unreadable: Set<string>,
  key: string,
  revise: string | undefined,
): void {
  if (!revise) return
  const status = REVISE_STATUS[revise]
  if (status) marks.set(key, status)
  else { unknown.add(revise); unreadable.add(key) }
}

/**
 * 届いた地震情報の電文の `Revise` から、行の印を作る。電文が `Revise` で変化を伝える種別で
 * なければ `null`（→ `JMAQuake.reportsRevise`。DMDATA の震源・震度情報だけが真）。
 *
 * **併合後のカードではなく、届いた電文そのものを渡すこと。** `Revise` は電文が自分の行に
 * 付けた印で、併合後のカードには前の報や震度の控え（`fillIntensityFromCache`）から写った点が
 * 混ざる。
 *
 * **使うのは、直前に届いた電文が同じ種別のときだけ**（{@link advanceQuakeMarks} が決める）。
 * 全期間の控えでは、種別が変わった直後の震源・震度情報（1,456 通）は `Revise` を 1 件も
 * 持たなかった —— 電文が何も言っていないその報では、今の差分を続ける（2026-10-21 ユーザー承認
 * 「おすすめで」。推したのは「今のアプリの比較を続ける」案）。
 *
 * **知らない語は電文の印にせず、その行は差分の印を残して記録にも出す。** 気象庁が語を足したとき、
 * 黙って捨てると「動いていない」と区別が付かない。
 */
export function quakeTelegramRevise(q: JMAQuake): TelegramRowRevise | null {
  if (!q.reportsRevise) return null
  const marks = new Map<string, UpdateStatus>()
  const unknown = new Set<string>()
  const unreadable = new Set<string>()
  for (const p of q.points) {
    // 振り分けはパーサーが作る形に従う（DMDATA の電文は県の点だけが `pref` を持つ）。
    if (p.pref) collectRevise(marks, unknown, unreadable, rowMarkKey.pref(p.pref), p.revise)
    else if (p.isArea) collectRevise(marks, unknown, unreadable, rowMarkKey.area(p.addr), p.revise)
    else collectRevise(marks, unknown, unreadable, rowMarkKey.station(p.addr), p.revise)
  }
  for (const c of q.cities ?? []) {
    if (c.area && c.name) collectRevise(marks, unknown, unreadable, rowMarkKey.city(c.area, c.name), c.revise)
  }
  if (unknown.size > 0) {
    log.warn('[quake] 震度の行の Revise に知らない語があり、その行は電文の印でなく差分で付けた', {
      id: q.id, values: [...unknown], rows: [...unreadable],
    })
  }
  return { kinds: ROW_KINDS, marks, unreadable, source: q.id, logTag: '[quake]' }
}

/**
 * 届いた長周期地震動の電文の `Revise` から、県と区域の行の印を作る（→ {@link quakeTelegramRevise}）。
 * **観測点の段は電文が `Revise` を持たないので `kinds` に入れない**（そこは差分のまま）。
 */
export function lpgmTelegramRevise(lpgm: JMALpgm): TelegramRowRevise | null {
  if (!lpgm.reportsRevise) return null
  const marks = new Map<string, UpdateStatus>()
  const unknown = new Set<string>()
  const unreadable = new Set<string>()
  for (const p of lpgm.prefs ?? []) collectRevise(marks, unknown, unreadable, rowMarkKey.pref(p.name), p.revise)
  for (const r of lpgm.regions ?? []) collectRevise(marks, unknown, unreadable, rowMarkKey.area(r.name), r.revise)
  if (unknown.size > 0) {
    log.warn('[lpgm] 長周期の行の Revise に知らない語があり、その行は電文の印でなく差分で付けた', {
      id: lpgm.id, values: [...unknown], rows: [...unreadable],
    })
  }
  return { kinds: ['pref:', 'area:'], marks, unreadable, source: lpgm.id, logTag: '[lpgm]' }
}

/**
 * 差分で出した行の印のうち、`Revise` が受け持つ段を電文の印へ差し替える。
 *
 * **画面に無い行の印は捨てる**（`cur` に無い鍵）。電文が載せていても、カードの一覧に
 * 行が無ければ指す先が無い。捨てた数は記録に残す（鍵の作り方がカード側とずれると、
 * ずれた行だけ印が永久に出なくなるので）。
 *
 * **差分では動いたのに `Revise` の無い行（受け持つ段）があれば記録に残す**（印は電文どおり付けない）。
 * 地震情報では全期間の控えで起きていない形（件数は `docs/spec/quake-spec.md` §8「電文の `Revise` で
 * 行の印を付ける」）。長周期は続報の実電文がまだ無く、この前提を確かめられていない —— 崩れたとき、
 * 画面からは「動いていない」と見分けが付かない。
 */
function withTelegramRevise(
  diff: ReadonlyMap<string, UpdateStatus>,
  cur: RowSnapshot,
  revise: TelegramRowRevise,
): Map<string, UpdateStatus> {
  const covered = new Set<string>(revise.kinds)
  const out = new Map<string, UpdateStatus>()
  let silentRows = 0
  for (const [key, status] of diff) {
    if (!covered.has(kindOf(key))) out.set(key, status)
    else if (revise.unreadable.has(key)) out.set(key, status)
    else if (!revise.marks.has(key)) silentRows++
  }
  let dropped = 0
  for (const [key, status] of revise.marks) {
    if (cur.has(key)) out.set(key, status)
    else dropped++
  }
  if (dropped > 0) {
    log.warn(`${revise.logTag} 電文の Revise が指す行がカードの一覧に無く、その印を捨てた`, {
      id: revise.source, dropped,
    })
  }
  if (silentRows > 0) {
    log.warn(`${revise.logTag} 同じ種別の続報で、差分では動いたのに Revise の無い行がある（電文の印を採った）`, {
      id: revise.source, rows: silentRows,
    })
  }
  return out
}

/**
 * 長周期地震動の印を指す鍵。
 *
 * **地震の印と同じ入れ物に入れるが、鍵の名前空間を分ける。** 長周期の一覧はカードの中で
 * 震度一覧と切り替えて出るので、行の鍵（`area:` / `st:`）が同じ名前で衝突しうる。
 * 入れ物を分けないのは、寿命の掃除を 1 つで済ませるため。
 */
export const lpgmMarkKey = (eventId: string) => `lpgm:${eventId}`

/**
 * 写しを持ち回る**行の総数**の上限（→ {@link advanceQuakeMarks}・{@link trimQuakeMarkMemory}）。
 *
 * **カードの枚数ではなく行の数で切る。** 1 枚あたりの重さが地震の規模で 2 桁変わるため
 * （実測: 2024-01-01 能登の本震は観測点 2993・市町村 1343 で写しが約 4336 行＝約 120 KiB。
 * 種別ごとの写し（{@link QuakeMarkMemory.rowsByType}）を最大 4 種別持つので 1 枚で約 480 KiB。
 * 一方、小さい余震は 1 枚あたり十数行）。枚数で切ると、群発では小さい余震が数十枚並ぶだけで
 * 枠が埋まって本震が落ち、巨大地震が続けば逆に数十 MB を抱える。
 *
 * **この値は「画面に出ているカードの分を持てる」ことを優先して決める。** 刈り込みは
 * まず一覧に無いものを落とすので（{@link trimQuakeMarkMemory}）、ここへ来るのは
 * 一覧に残っているカードだけ。能登の 24 時間（地震 71 件・うち本震級 1 件）で約 2 万行
 * なので、10 万行あれば本震級が 5 件あっても持ちきれる。行 1 つを 28 B として約 2.8 MB。
 *
 * **落ちるのは最大震度のいちばん低い地震**（同じ震度なら発表時刻の古い側。並べ方の理由は
 * {@link capQuakeMarkMemory}）。**発表時刻だけで並べないこと** —— 能登本震は最後の通常報から
 * 5 時間沈黙したあとに震源要素更新が届いたので、時刻で並べるとその 5 時間に届く余震に押されて
 * いちばん残したい記憶から落ちる。**挿入順も代理にしないこと** —— 「もっと見る」は古い地震を
 * 後から積むので、挿入順では取り込んだ古い分が新しい側へ回る。
 *
 * **上限に達したら、一覧に残っているカードの記憶でも落ちる。** 落ちたカードへ続報が来ても
 * 印は出ない（そのカードで最初に見た報と同じ扱いになる）。一覧の枚数に上限が無いので、
 * これを完全に無くすには記憶の上限を捨てることになる —— 落とす順を震度にしているのは、
 * その確率をいちばん下げる並べ方だから。
 */
export const MARK_MEMORY_MAX_ROWS = 100_000

/** カードに出す印。欄ごとと行ごとの 2 系統を持つ。 */
export interface QuakeCardMarks {
  facts: ReadonlyMap<QuakeUpdateField, UpdateStatus>
  rows: ReadonlyMap<string, UpdateStatus>
  /** 印を付けた時刻。{@link UPDATE_MARK_TTL_MS} を過ぎたら消す。 */
  markedAt: number
}

/** 1 通ぶんの写し（`advanceQuakeMarks` へ渡す入力）。 */
export interface QuakeMarkSnapshot {
  facts: QuakeFactSnapshot
  rows: RowSnapshot
  /**
   * その報の情報種別。**行の写しをこの単位で持つ**（→ {@link QuakeMarkMemory}）。
   *
   * **`headType` ではなく `issue.type` を見る。** 知りたいのは「載せる範囲が同じか」で、
   * 種別の名前が同じなら範囲も同じ。`resolveIssueType` が未知の `headType` を
   * `'震源・震度情報'` へ落とす点は、ここでは「未知の種別どうしを同じ範囲とみなす」に留まる。
   */
  reportType: MarkReportType
  /**
   * **届いた電文そのものの種別**（`reportType` はカードの種別）。`null` は「電文の報ではない」——
   * 取消を当て直した姿と、畳み込みの吸収を写し直した姿がこれにあたる。
   *
   * **カードの種別と分けて持つ。** 併合は震度速報を震源・震度情報のカードへ当ててもカードの
   * 種別を変えないことがある（`mergeQuakeInto`）。`Revise` も欄の初出も「直前の電文と同じ種別か」
   * で決まるので、カードの種別で見ると、間に別の種別の電文が挟まった報を同じ種別の続報と
   * 取り違える。
   */
  telegramType: MarkReportType | null
  /**
   * 届いた電文の `Revise` から作った行の印。電文が `Revise` で変化を伝えないなら `null`
   * （→ {@link quakeTelegramRevise}）。
   */
  revise: TelegramRowRevise | null
  /**
   * その報の発表時刻（epoch ms）。刈り込みの順序に使う（→ {@link QuakeMarkMemory.issuedAt}）。
   *
   * **呼び出し側が渡す。** ここで電文から読み直すと、渡すカードと時刻の出どころが分かれて
   * 食い違いうる（据え置かれた報ではカードが進まないので、時刻だけが進む形になる）。
   */
  issuedAt: number
}

/**
 * 発表時刻の文字列を、刈り込みが使う数値へ直す（→ {@link QuakeMarkSnapshot.issuedAt}）。
 *
 * **読めない値は `0` へ倒す**（いちばん先に落ちる側）。ここで `Date.now()` へ倒すと、
 * 時刻が壊れた 1 通が「いちばん新しい」ことになって、本物の新しい地震の記憶を追い出す。
 *
 * **「いま届いた報がいちばん先に落ちる」形にはならない** —— 刈り込みはその報の記憶を
 * 守るため（{@link capQuakeMarkMemory} の `keep`）。守りが無ければ、時刻が読めない報は
 * 記憶を作った直後に自分で落とすことになる。
 */
export function markIssuedAt(time: string | undefined | null): number {
  const ms = time ? new Date(time).getTime() : Number.NaN
  return Number.isFinite(ms) ? ms : 0
}

/** 次の報と突き合わせるための、いまカードが見せている値の写し。 */
export interface QuakeMarkMemory {
  /**
   * 震源要素・最大震度。**種別で分けない** —— 欄の顔ぶれはどの種別でも同じで、
   * 震源要素更新（VXSE61）のように必ず種別が変わる報でも値の変化を伝えたいため。
   */
  facts: QuakeFactSnapshot
  /** 直前の報の行。**値が動いたか**はこれと比べる（種別を問わない）。 */
  rows: RowSnapshot
  /**
   * **情報種別ごとの行の写し。行が初めて出たかはこれと比べる。** 種別をまたいで比べると、
   * 報の粒度の違い（震度速報は震度3以上の区域まで・震源・震度情報は震度1以上の観測点まで）が
   * 「初出」として光る。
   *
   * **「直前の報の種別」を覚える形では足りない。** 気象庁は種別を前後させるので
   * （震度速報 → 震源情報 → 震度速報）、直前と比べると**震度速報どうしの続報が種別の
   * 変わり目に見え**、その報で本当に増えた区域の印まで消える（2024-01-01 16:06 の前震で実際に
   * そうなった）。種別ごとに持てば、いつでも「同じ範囲を載せる報どうし」を比べられる。
   *
   * **種別数に上限を置かない。** 鍵の値域は {@link MarkReportType} が定める 8 値で、
   * 型として有限なので溜まりようがない。**上限は「持ち物が膨らむこと」の代理値**で、
   * 実際に効くのはカードの枚数（`liveKeys` に無い地震の記憶は捨てる）。上限を置いていた頃は
   * 「震度速報 → 震源情報 → 震源・震度情報 → 各地の震度情報」というありふれた遷移で
   * 最初の種別が追い出され、**その種別が再び届いたとき初出の印が出なかった**。
   *
   * **どの種別の写しも大きくなりうる。** 写す先は電文ではなく**併合後のカード**なので、
   * その報自体が観測点を運ばない種別（震源情報・顕著な地震の震源要素更新）でも、先行する報が
   * 積んだ点をそのまま引き継いだ状態が写る（→ §6.4 の持ち越し規則）。空になるのは、その種別が
   * そのカードで最初の報だったときだけ。
   *
   * それでも溜まらないのは、**種別の数が型で有限**（高々 8）で、**持ち回る行の総数にも
   * 上限がある**から（{@link MARK_MEMORY_MAX_ROWS}）。能登本震の各地の震度情報で約 4,336 行
   * （観測点 2,993・市町村 1,343）という大きさは、その上限の内側に収まる。
   */
  rowsByType: ReadonlyMap<MarkReportType, RowSnapshot>
  /**
   * この記憶を作った電文の種別（→ {@link QuakeMarkSnapshot.telegramType}）。次の電文が
   * `Revise` を使うか・欄の初出を出すかを、これと同じ種別かで決める。`null` なら使わない・出さない。
   */
  telegramType: MarkReportType | null
  /**
   * この記憶を作った報の発表時刻（epoch ms）。**刈り込みで落とす順の第 2 キーに使う**
   * （第 1 キーは最大震度。→ {@link MARK_MEMORY_MAX_ROWS}・{@link capQuakeMarkMemory}）。
   *
   * **挿入順を代理にしない。** `Map` の挿入順は「入った順」であって発表時刻の順ではない。
   * 「もっと見る」は既存の記憶を土台に**古い地震を後から積む**ので、挿入順で古い側から
   * 落とすと、取り込んだ古い分が新しい側へ回り、**いま画面で見ているカードのぶんが
   * 先に落ちる**（押した直後のライブの続報で印が出なくなる）。
   *
   * 読めない発表時刻は `0` へ倒す（同じ震度のなかでいちばん先に落ちる側）。**印は
   * 「いま動いた」を指すもので、時刻が読めない報のために新しい地震の記憶を犠牲にする理由が
   * 無い。** いま届いた報だけは刈り込みが守る（{@link capQuakeMarkMemory} の `keep`）。
   */
  issuedAt: number
}

/**
 * 写しを作った報の種別。地震カードは情報種別をそのまま使い、長周期地震動は
 * 1 種類しか無いので専用の値を置く。
 *
 * **長周期を `IssueType` のどれかで代用しない。** 地震カードと長周期は同じ入れ物
 * （`quakeMarkMemory`）に鍵を分けて同居するので、代用すると「種別が変わった」の意味が
 * 2 つの一覧で違ってしまう。
 */
export type MarkReportType = IssueType | 'lpgm'

/**
 * 1 通ぶん、記憶を進めて印を出す。**純関数** —— 状態の更新関数の中から呼ぶので、
 * ref への書き込みのような副作用を持たせない（React が更新関数を 2 度走らせても同じ結果になる）。
 *
 * **記憶は受信のたびに進める。読み上げ用の記憶を流用しない。** 上位の読み上げに待たされて
 * 声にならなかった報でも、画面にはその内容が届いている。声にした分だけ進む記憶で画面の差分を
 * 取ると、読まれなかった報の変化が次の報の印に混ざる（津波カードが同じ理由で 2 つに分けている）。
 *
 * **カードが消えた地震の記憶は捨てる。** 一覧の上限で落ちたカードの記憶を持ち続けると、
 * 群発のあいだ観測点の写し（大きいものは数千件）が積み上がる。
 */
export function advanceQuakeMarks(args: {
  prev: { memory: ReadonlyMap<string, QuakeMarkMemory>; marks: ReadonlyMap<string, QuakeCardMarks> }
  /** 印を付ける対象の地震（`quakeEventKey`）。 */
  key: string
  /** 併合後のカードから作った写し。 */
  snapshot: QuakeMarkSnapshot
  /** いま一覧に残っているカードの鍵。これ以外の記憶と印は捨てる。 */
  liveKeys: ReadonlySet<string>
  now: number
}): { memory: Map<string, QuakeMarkMemory>; marks: Map<string, QuakeCardMarks> } {
  const { prev, key, snapshot, liveKeys, now } = args
  const before = prev.memory.get(key)
  // 直前の電文と同じ種別か。**どちらかが電文の報でない（`null`）なら偽** —— 取消を当て直した
  // あとの報では、`Revise` が何に対する変化かを言えない。
  const sameTelegramType = before !== undefined && before.telegramType !== null
    && before.telegramType === snapshot.telegramType
  const facts = changedQuakeFacts(snapshot.facts, before?.facts, sameTelegramType)
  // 欄（`facts`）は種別をまたいでも差分を取る。**震源要素更新（VXSE61）は必ず種別が変わる報**
  // なので、ここまで種別で止めると座標・深さが動いた印が出なくなる。
  //
  // 行は**値の変化を直前の報と、初出を同じ種別で前に見た報と**比べる（→ `diffQuakeRows`）。
  // **電文が `Revise` を持ち、直前の電文と種別が同じなら、`Revise` が受け持つ段はそちらで付ける**
  // （2026-10-21 ユーザー承認。選択「カードは電文の印 (Recommended)」）。気象庁が「初出か」「動いたか」を
  // 直接伝えているので、自前の比較で推し量らない。
  const diff = diffQuakeRows(snapshot.rows, before?.rows, before?.rowsByType.get(snapshot.reportType))
  const rows = snapshot.revise && sameTelegramType
    ? withTelegramRevise(diff, snapshot.rows, snapshot.revise)
    : diff

  // 種別ごとの写しを進める。**捨てない** —— 鍵の値域は有限で、溜まりようがない
  // （→ `QuakeMarkMemory.rowsByType`）。
  const rowsByType = new Map<MarkReportType, RowSnapshot>(before?.rowsByType ?? [])
  rowsByType.set(snapshot.reportType, snapshot.rows)

  const memory = new Map<string, QuakeMarkMemory>()
  for (const [k, v] of prev.memory) if (liveKeys.has(k) && k !== key) memory.set(k, v)
  memory.set(key, {
    facts: snapshot.facts, rows: snapshot.rows, rowsByType, issuedAt: snapshot.issuedAt,
    telegramType: snapshot.telegramType,
  })
  // **持ち回る重さに上限を置く。** `liveKeys` はカード一覧の件数までしか絞らず、その一覧に
  // 件数の上限が無い（→ `MARK_MEMORY_MAX_ROWS`）。
  capQuakeMarkMemory(memory, key)

  const marks = new Map<string, QuakeCardMarks>()
  for (const [k, v] of prev.marks) {
    if (k !== key && liveKeys.has(k) && now - v.markedAt < UPDATE_MARK_TTL_MS) marks.set(k, v)
  }
  // **報が来たら、その報の差分で付け直す。前の印は引き継がない。**
  //
  // 続報が届いた時点でカードの表示は新しくなっているので、そこに前の報の印が残っていると
  // 「いまの報で動いた」と読めてしまう。動いたものが無い報では印が消えるのが正しい。
  // 寿命（`UPDATE_MARK_TTL_MS`）が決めるのは**次の報が来ないまま置かれたとき**の上限だけ。
  if (facts.size > 0 || rows.size > 0) marks.set(key, { facts, rows, markedAt: now })
  return { memory, marks }
}

/**
 * 履歴の畳み込みの 1 段から、記憶を進める。**印は出さない。**
 *
 * **1 通ずつ当てるループの中から呼ぶこと**（→ `utils/quakeMerge.ts` の `mergeQuakeHistory`）。
 * あれは電文を発表時刻順に並べて 1 通ずつカードへ当てるので、その各段階が
 * 「その報の時点でカードが見せていた姿」になる。**畳み終わった最終形だけを写すと、
 * 種別ごとの行（`rowsByType`）が最後に当てた種別の分しか埋まらない。**
 *
 * **印を出さないのは、履歴が「もう起きたこと」をまとめて再現するものだから。** 開始時点の
 * カードに印が付くと「いま動いた」と読める。作るのは**次に届く報が比べる相手**だけ。
 *
 * これが無いと、リプレイ開始の直後に届いた報は比べる相手を持たず印が出ない
 * （能登本震の震源要素更新がそれ。21:30 の報の直前にある同じ地震の報は 16:24 で、
 * 再生開始の前に畳み込まれてしまう）。
 */
export function rememberQuakeCard(
  memory: Map<string, QuakeMarkMemory>,
  key: string,
  snapshot: QuakeMarkSnapshot,
): void {
  const prev = memory.get(key)
  const rowsByType = new Map<MarkReportType, RowSnapshot>(prev?.rowsByType ?? [])
  rowsByType.set(snapshot.reportType, snapshot.rows)
  // **挿入順は触らない。** 落とす順は発表時刻（`issuedAt`）で決めるので、`Map` の並びに
  // 意味を持たせない（「もっと見る」が古い地震を後から積むため。→ `MARK_MEMORY_MAX_ROWS`）。
  memory.set(key, {
    facts: snapshot.facts, rows: snapshot.rows, rowsByType, issuedAt: snapshot.issuedAt,
    telegramType: snapshot.telegramType,
  })
}

/**
 * 記憶 1 件が持つ行の数。重さの代理（→ {@link MARK_MEMORY_MAX_ROWS}）。
 *
 * **数えるのは種別ごとの写し（`rowsByType`）だけ。** `rows` はそこへ入れたのと**同じ Map の
 * 参照**なので（`advanceQuakeMarks`・`rememberQuakeCard` がどちらも `rowsByType.set` した値を
 * そのまま `rows` へ置く）、足すと 1 種別ぶん二重に数える。
 */
function rowCountOf(memory: QuakeMarkMemory): number {
  let rows = 0
  for (const byType of memory.rowsByType.values()) rows += byType.size
  return rows
}

/**
 * 落とす順を決めるための、その記憶が指す地震の最大震度（階級値）。
 *
 * **震度が分からない記憶と、長周期地震動の記憶は最後に落とす**（`Infinity` へ倒す）。長周期の記憶は
 * 全国の最大震度（`JMALpgm.maxInt`）を `maxScale` に写すが（→ {@link lpgmFactSnapshot}）、それで並べない ——
 * 鍵（→ {@link lpgmMarkKey}）で見分ける。
 * **先に落とす側へ倒さないこと** —— 長周期は観測点が少なく行も少ないので、落としても
 * 空く余地が小さい。効きの薄いものを先に落とすと、刈り込みが何度も走るだけになる。
 */
function dropRankOf(key: string, memory: QuakeMarkMemory): number {
  if (key.startsWith(lpgmMarkKey(''))) return Number.POSITIVE_INFINITY
  return memory.facts.get('maxScale')?.rank ?? Number.POSITIVE_INFINITY
}

/**
 * 行の総数が上限を超えていたら、**最大震度の低い地震から**落とす（同じ震度なら発表時刻の
 * 古い側から）。
 *
 * **発表時刻だけで並べないこと。** 「古い地震」は「もう続報が来ない地震」ではない ——
 * 能登本震は最後の通常報（2024-01-01 16:24）から**5 時間沈黙したあと**に震源要素更新
 * （21:30）が届いた。その 5 時間に余震が 67 件発表されるので、発表時刻で並べると
 * **いちばん残したい本震の記憶が真っ先に落ちる**。震度で並べれば本震は最後まで残り、
 * 落ちるのは続報が来ても印の要らない小さな余震のほうになる。
 *
 * **行数の大きい順にしないこと。** いちばん重いのは本震なので、効率で選ぶと残したいものから
 * 落ちる（発表時刻で並べたときと同じ失敗になる）。
 *
 * **いま届いた報の記憶（`keep`）は落とさない。** それを落とすと、次の続報が比べる相手を
 * 失って印が出なくなる —— 記憶を作った意味がその場で消える。**発表時刻が読めない報では
 * とくに要る** —— {@link markIssuedAt} が `0` へ倒すので、震度が同じ地震が並んだときに
 * いま届いた報が先に落ちる並びになる。
 *
 * **落としたことを記録に出す。** 落ちた地震の続報が来ても印が出なくなるが、画面には
 * 「印が無い」としか現れない（それが正常なのか上限で落ちたのかを区別できない）。
 * **1 件も落とせなかったことも出す** —— 守った 1 件だけで上限を超える地震では、以後の報で
 * 毎回ここへ来る。記録が無いと「上限に張り付いたまま」が外から見えない。
 *
 * > **残る限界**: 上限に達したら、**一覧に残っているカードの記憶でも落ちる**。落ちたカードへ
 * > 続報が来ても印は出ない（そのカードで最初に見た報と同じ扱いになる）。震度の順で落とすのは
 * > その確率を下げるだけで、無くすわけではない —— 本震級だけが上限を埋めるほど並んだ状況では
 * > 震度の低い本震級から落ちる。一覧の枚数に上限が無いので、ここを完全に無くすには記憶の
 * > 上限を捨てることになる（→ {@link MARK_MEMORY_MAX_ROWS}）。
 */
function capQuakeMarkMemory(memory: Map<string, QuakeMarkMemory>, keep?: string): void {
  let rows = 0
  for (const v of memory.values()) rows += rowCountOf(v)
  if (rows <= MARK_MEMORY_MAX_ROWS) return

  // **震度の比較は引き算で書かないこと。** 震度が分からない記憶は `Infinity` なので、
  // それが 2 つ並ぶと `Infinity - Infinity` が `NaN` になり、**並べ方そのものが未定義へ落ちる**
  // （長周期の記憶が 2 件以上あれば起きる。第 2 キーの発表時刻へも進まない）。
  const dropOrder = [...memory].sort((a, b) => {
    const ra = dropRankOf(a[0], a[1])
    const rb = dropRankOf(b[0], b[1])
    if (ra !== rb) return ra < rb ? -1 : 1
    return a[1].issuedAt - b[1].issuedAt
  })
  let dropped = 0
  for (const [key, v] of dropOrder) {
    if (rows <= MARK_MEMORY_MAX_ROWS) break
    if (key === keep) continue
    rows -= rowCountOf(v)
    memory.delete(key)
    dropped++
  }
  log.info(
    dropped === 0
      ? `[quake] 印の記憶が上限 ${MARK_MEMORY_MAX_ROWS} 行を超えていますが、落とせる記憶が`
        + `ありませんでした（いま届いた報のぶんだけで超えています。${memory.size} 件・${rows} 行）`
      : `[quake] 印の記憶を ${dropped} 件落としました（行の総数が上限 ${MARK_MEMORY_MAX_ROWS} を`
        + `超えたため。最大震度の低い側から落とします。残り ${memory.size} 件・${rows} 行）`,
  )
}

/**
 * 記憶を、いま残っているカードのぶんだけに絞る（→ {@link MARK_MEMORY_MAX_ROWS}）。
 *
 * **履歴の取り込みは一度に何十枚ものカードを作る**ので、積んだままにすると観測点の写し
 * （大きい地震で数千行）が積み上がる。`advanceQuakeMarks` が受信のたびに行う刈り込みと
 * 同じことを、バッチの最後に一度だけ行う。
 *
 * **`liveKeys` に無い鍵は捨てる。** 畳み込み（`coalesceByEventId`）で暫定 ID と確定 ID の
 * カードが 1 枚になると、消えた側の鍵に紐づく記憶は宛先を失う。残っていても次の受信で
 * 捨てられるだけだが、ここで落とせば上限の枠を無駄に使わない。
 */
export function trimQuakeMarkMemory(
  memory: Map<string, QuakeMarkMemory>,
  liveKeys: ReadonlySet<string>,
): Map<string, QuakeMarkMemory> {
  for (const k of [...memory.keys()]) if (!liveKeys.has(k)) memory.delete(k)
  capQuakeMarkMemory(memory)
  return memory
}

/** 寿命の切れた印を落とす。残す必要が無ければ同じ参照を返す（無駄な再描画を避ける）。 */
export function pruneQuakeMarks(
  marks: ReadonlyMap<string, QuakeCardMarks>,
  now: number,
): ReadonlyMap<string, QuakeCardMarks> {
  const kept = new Map<string, QuakeCardMarks>()
  for (const [k, v] of marks) if (now - v.markedAt < UPDATE_MARK_TTL_MS) kept.set(k, v)
  return kept.size === marks.size ? marks : kept
}

/**
 * ある行と、その配下の行のうち 1 つでも印を持つものがあるかを見る。
 *
 * **畳んだ行にも印を出すために要る。** 一覧は既定でどの段も畳んであるので、配下だけに印を
 * 付けると「開かないと気づけない」印になる。自分自身に印があればそれを、無ければ配下の
 * 印を持ち上げる。
 */
export function rowMarkOf(
  ownKey: string,
  descendantKeys: readonly string[],
  marks: ReadonlyMap<string, UpdateStatus>,
): UpdateStatus | undefined {
  const own = marks.get(ownKey)
  if (own) return own
  // 配下の向きが混ざったら**いちばん重いものを採る**。畳んだ親が言えるのは 1 つだけなので、
  // 悪化を最優先にする（上がった > 下がった > 初出 > 向きの無い変化）。
  let best: UpdateStatus | undefined
  for (const k of descendantKeys) {
    const s = marks.get(k)
    if (!s) continue
    if (s === 'raised') return 'raised'
    if (best === undefined || DESCENDANT_PRIORITY[s] > DESCENDANT_PRIORITY[best]) best = s
  }
  return best
}

/** 配下の印を 1 つへ畳むときの重さ（→ {@link rowMarkOf}）。 */
const DESCENDANT_PRIORITY: Record<UpdateStatus, number> = {
  raised: 3,
  lowered: 2,
  new: 1,
  changed: 0,
}
