// テストボタンの台本（どの電文を・いつ・どう書き換えて流すか）。
//
// 電文の出どころは `public/data/test-telegrams/README.md`。**実電文で流せるものは実電文のまま流し、
// 標本が無い形だけを書き換えで作る。** 書き換えたものは、その理由を台本の隣に書く。
import type { TestTelegramScript, TestTelegramStep } from './testTelegrams'
import { replaceOnce } from './testTelegrams'
import {
  editXml, descendants, childOf, childText, setSectionText, shiftIssueTime, only, moveToEvent,
  toCancelForm, toAllLifted, toFinalEew, stripRevise, stationsWithInt, raiseInt, lowerInt, recomputeMaxInts, INT_ORDER,
  setIssueTime, setHeadlineText,
} from './testTelegramRewrite'

const nii = (id: string) => `nii/${id}.xml`
const sample = (name: string) => `jma-sample/${name}.xml`

/**
 * 長周期地震動の観測情報の**先頭 1 点だけ**に、気象庁以外が運用する観測点の印（`＊`）を付ける。
 *
 * **その観測点が実際に気象庁以外なのではない。** 元にした能登本震の電文は 198 点すべて気象庁で、
 * 印の付く観測点が 1 件も無い（→ docs/spec/quake-spec.md §8「気象庁以外が運用する観測点（`＊`）」）。
 * **そこに無い形は実機で一度も画面に出ない**ので、表示の経路を通せるように 1 点へ付ける。
 * 読み取り後の形としては正しい —— パーサーが名前の `＊` を外し、代わりに印を立てる。
 */
const markFirstLgStation = (xml: string) => editXml(xml, doc => {
  const name = childOf(descendants(doc, 'IntensityStation')[0]!, 'Name')!
  name.textContent = `${name.textContent}＊`
})

/** 令和6年能登半島地震（2024-01-01）の本震（EventID 20240101161010）。 */
const NOTO = {
  /** 16:11 震度速報（最大震度6強・一部の区域）。 */
  prompt1: nii('20240101071142_0_VXSE51_010000'),
  /** 16:12 津波警報（原因地震 M7.4）。地震情報より先に震源を伝えた電文。 */
  tsunami1: nii('20240101071254_0_VTSE41_010000'),
  /** 16:13 震度速報（区域が出そろった続報）。 */
  prompt2: nii('20240101071328_0_VXSE51_010000'),
  /** 16:16 震源・震度に関する情報（報番号 1・M7.4）。 */
  detail1: nii('20240101071649_0_VXSE53_010000'),
  /** 16:22 津波警報（石川県能登を大津波警報へ引き上げ・M7.6）。 */
  tsunami2: nii('20240101072233_0_VTSE41_010000'),
  /** 16:23 長周期地震動に関する観測情報。 */
  lpgm: nii('20240101072337_0_VXSE62_010000'),
  /** 16:24 震源・震度に関する情報（報番号 2・M7.6・未入電 3 地点）。 */
  detail2: nii('20240101072429_0_VXSE53_010000'),
}

/** 同じ日 16:06 の前震（EventID 20240101160608）。種別が前後して届く順の実例。 */
const NOTO_FORESHOCK = {
  /** 16:07 震度速報。 */
  prompt1: nii('20240101070741_0_VXSE51_010000'),
  /** 16:08 震源に関する情報。 */
  destination: nii('20240101070831_0_VXSE52_010000'),
  /** 16:08 震度速報（2 通目）。 */
  prompt2: nii('20240101070841_0_VXSE51_010000'),
  /** 16:10 震源・震度に関する情報（報番号 1）。 */
  detail: nii('20240101071005_0_VXSE53_010000'),
}

/**
 * 同じ日 23:04 の佐渡付近の地震（EventID 20240101230402）。**23:05 の震度速報は本震の震度を誤って
 * 流したもの**で、23:13 に取り消され、23:14 に正しい震源・震度に関する情報が出た。
 */
/** 佐渡付近の地震の EventID（→ `SADO`）。 */
const SADO_EVENT_ID = '20240101230402'

const SADO = {
  prompt: nii('20240101140549_0_VXSE51_010000'),
  cancel: nii('20240101141346_0_VXSE51_010000'),
  detail: nii('20240101141410_0_VXSE53_010000'),
}

// ───────────────────────── 地震情報 ─────────────────────────

/**
 * 地震テスト（能登本震の震源・震度に関する情報 16:24・報番号 2）。
 *
 * 長周期地震動の観測情報（16:23）も一緒に流す。**DMDATA 経路でしか届かない**ので DMDSS 版だけ
 * （→ `TestTelegramStep.onlyIn`）。地震カードに長周期の欄を付けるため、地震情報より後に積む。
 */
export const EARTHQUAKE: TestTelegramScript = {
  anchor: 0,
  steps: [
    { file: NOTO.detail2, headType: 'VXSE53', atMs: 0 },
    { file: NOTO.lpgm, headType: 'VXSE62', atMs: 0, onlyIn: 'dmdss', rewrite: markFirstLgStation },
  ],
}

/**
 * 訓練報テスト。地震テストの電文の運用種別（`Control/Status`）だけを「訓練」にする。
 *
 * **気象庁は訓練の電文をヘッダでだけ区別し、中身は本物と同じ形で流す**（→ docs/spec/quake-spec.md §5
 * 「電文の運用種別」）。実配信の訓練報は事前に予告されて流れるもので、こちらの都合では受け取れない。
 */
export const TRAINING_QUAKE: TestTelegramScript = {
  anchor: 0,
  steps: [{
    file: NOTO.detail2, headType: 'VXSE53', atMs: 0,
    rewrite: xml => replaceOnce(xml, '<Status>通常</Status>', '<Status>訓練</Status>'),
  }],
}

/**
 * 未入電テスト（2022-01-22 日向灘 M6.4・報番号 2）。市町村の未入電が 2 通り（配下に未入電がある・
 * 市町村の値そのものが未入電）とも入り、観測点の未入電も 60 地点ある（→ docs/spec/quake-spec.md §5
 * 「市町村の震度」）。
 */
export const UNRECEIVED_QUAKE: TestTelegramScript = {
  anchor: 0,
  steps: [{ file: nii('20220121164041_0_VXSE53_270000'), headType: 'VXSE53', atMs: 0 }],
}

/**
 * 5弱以上テスト（2024-11-26 石川県西方沖 M6.4）。未入電を下限の5弱へ寄せると電文全体の最大震度と
 * 階級が一致し、カードの最大震度が「5弱以上」になる（→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。
 */
export const MAX_SCALE_OR_ABOVE_QUAKE: TestTelegramScript = {
  anchor: 0,
  steps: [{ file: nii('20241126135154_0_VXSE53_010000'), headType: 'VXSE53', atMs: 0 }],
}

/** 区域まるごと未入電にする区域（日向灘の報で、市町村 7・観測点 12）。 */
export const AREA_UNRECEIVED_AREA = '宮崎県北部山沿い'

const UNRECEIVED_TEXT = '震度５弱以上未入電'

/**
 * 区域まるごと「震度5弱以上未入電」のテスト。**気象庁の資料が定める形で、実電文の標本は無い。**
 *
 * 日向灘の報の 1 区域について、配下の市町村と観測点をすべて未入電に書き換える。区域の `MaxInt` は
 * 配下に値が無くなるので外れる —— 気象庁は配下がすべて未入電のとき上の段の `MaxInt` を載せない
 * （電文解説資料 Ⅱ.33 2-1-3-3-1）。見出し（`Head/Headline`）の区域・市町村の行も外す。
 */
export const AREA_UNRECEIVED_QUAKE: TestTelegramScript = {
  anchor: 0,
  steps: [{
    file: nii('20220121164041_0_VXSE53_270000'), headType: 'VXSE53', atMs: 0,
    rewrite: xml => editXml(xml, (doc) => {
      const area = descendants(doc, 'Area').find(a => childText(a, 'Name') === AREA_UNRECEIVED_AREA && childOf(a, 'City'))
      if (!area) throw new Error(`テスト用の電文に区域「${AREA_UNRECEIVED_AREA}」がありません`)
      const cityNames = new Set<string>()
      for (const city of Array.from(area.children).filter(c => c.localName === 'City')) {
        cityNames.add(childText(city, 'Name') ?? '')
        childOf(city, 'MaxInt')?.remove()
        if (!childOf(city, 'Condition')) {
          const condition = doc.createElementNS(city.namespaceURI, 'Condition')
          condition.textContent = UNRECEIVED_TEXT
          const code = childOf(city, 'Code')
          if (!code) throw new Error('テスト用の電文の市町村に <Code> がありません')
          code.after(condition)
        } else {
          childOf(city, 'Condition')!.textContent = UNRECEIVED_TEXT
        }
        for (const station of Array.from(city.children).filter(c => c.localName === 'IntensityStation')) {
          const int = childOf(station, 'Int')
          if (!int) throw new Error('テスト用の電文の観測点に <Int> がありません')
          int.textContent = UNRECEIVED_TEXT
        }
      }
      recomputeMaxInts(doc)
      // 見出しの「震度ごとの区域・市町村」から、この区域とその市町村を外す（空になった項目ごと）
      const head = descendants(doc, 'Head')[0]
      for (const listed of descendants(head, 'Area')) {
        const name = childText(listed, 'Name') ?? ''
        if (name === AREA_UNRECEIVED_AREA || cityNames.has(name)) listed.remove()
      }
      for (const item of descendants(head, 'Item')) {
        if (descendants(item, 'Area').length === 0) item.remove()
      }
    }),
  }],
}

/** 遠地地震テスト（2026-07-17 23:49 メキシコ、チアパス州沿岸 M7.4・深さ不明・付加文 0226 0230）。 */
export const FOREIGN_QUAKE: TestTelegramScript = {
  anchor: 0,
  steps: [{ file: nii('20260717151629_0_VXSE53_010000'), headType: 'VXSE53', atMs: 0 }],
}

/**
 * 巨大地震テスト（遠地地震で規模が「Ｍ８を超える巨大地震」の報）。
 *
 * 元は気象庁のサンプル電文（2010-02-27 チリ中部沿岸・遠地地震に関する情報・付加文 0221 0228 0229）。
 * サンプルは規模を M8.5 と数値で載せているので、**規模の要素だけ**を、同じサンプル集の三陸沖の報
 * （32-39_11_05）と同じ「Ｍ８を超える巨大地震」の書き方に替える。M8 を超えると推定された第一報は
 * この形で届き、規模不明（「Ｍ不明」）とは `@description` だけで区別される。
 */
export const FOREIGN_QUAKE_HUGE: TestTelegramScript = {
  anchor: 0,
  steps: [{
    file: sample('32-39_05_01_100831_VXSE53'), headType: 'VXSE53', atMs: 0,
    rewrite: xml => replaceOnce(
      xml,
      '<jmx_eb:Magnitude type="M" description="Ｍ８．５">8.5</jmx_eb:Magnitude>',
      '<jmx_eb:Magnitude type="M" condition="不明" description="Ｍ８を超える巨大地震">NaN</jmx_eb:Magnitude>',
    ),
  }],
}

/** 訂正報テストで、初報から訂正報までの間（ミリ秒）。 */
export const AMENDMENT_DELAY_MS = 3000

/**
 * 訂正報テスト（能登本震の報番号 1 → その訂正報）。
 *
 * **訂正報は実配信の標本を持たない。** DMDATA アーカイブの全期間にも気象庁のサンプル電文にも、
 * `InfoType` が「訂正」の地震情報は 1 通も無い。気象庁が実際に震源要素の訂正を伝えるときは、
 * 報番号 2 の発表報＋固定付加文 0256（「震源要素を訂正します。」）で伝える。そこで**実電文の
 * 報番号 2（16:24）の `InfoType` だけを「訂正」に替えて**、訂正報の形を作る。規模の変化
 * （M7.4 → M7.6）は実電文のまま。
 */
export const QUAKE_AMENDMENT: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: NOTO.detail1, headType: 'VXSE53', atMs: 0 },
    {
      file: NOTO.detail2, headType: 'VXSE53', atMs: AMENDMENT_DELAY_MS,
      rewrite: xml => replaceOnce(xml, '<InfoType>発表</InfoType>', '<InfoType>訂正</InfoType>'),
    },
  ],
}

/** 種別遷移テストで、報と報のあいだ（ミリ秒）。 */
export const REPORT_SEQUENCE_DELAY_MS = 3000

/**
 * 4 通目と 5 通目のあいだ（ミリ秒）。**4 通目を読み切る前に 5 通目が届くと、既読が「声になった分」
 * までしか進まず、5 通目が差分ではなく全文読みへ倒れる**（→ docs/spec/audio-tts-spec.md §4
 * 「既読になるのは「声になった分」だけ」）。それでは確かめたい形（観測点だけが増えた続報）が出ない。
 */
export const REPORT_SEQUENCE_FOLLOWUP_DELAY_MS = 30000

/** 4 通目の時点でまだ入電していないことにする観測点・市町村の数（5 通目で出そろう）。 */
const LATE_STATION_COUNT = 6
const LATE_CITY_COUNT = 3

/** 7 通目で震度を 1 段上げる・下げる観測点の数（実配信の規模に合わせて少なくする）。 */
const RAISED_STATION_COUNT = 5
const LOWERED_STATION_COUNT = 2

const intRank = (v: string | undefined) => (v === undefined ? -1 : INT_ORDER.indexOf(v as typeof INT_ORDER[number]))

/**
 * 4 通目: 観測点と市町村の一部がまだ入電していない形。
 *
 * **区域の最大震度を動かさない選び方にする**（5 通目で区域の差分が出ると、確かめたい
 * 「区域は据え置きのまま観測点だけが増える続報」にならない）。抜く観測点は、同じ市町村に
 * それ以上の震度の観測点が残るものから弱い順に、抜く市町村は、同じ区域にそれ以上の震度の
 * 市町村が残るものから弱い順に選ぶ。
 */
/**
 * 4 通目で抜く市町村・観測点を選ぶ。
 *
 * **5 通目の「増えた」印と選び方を共有する。** 別々に選ぶと、抜いた点と印の付く点がずれて、
 * 画面では「動いていない行が光り、動いた行が光らない」ことになる。
 */
function lateTargets(doc: Document): { cities: Element[]; stations: Element[] } {
  const cities = descendants(doc, 'City')
    .filter((city) => {
      const area = city.parentElement
      if (!area) return false
      const mine = intRank(childText(city, 'MaxInt'))
      return Array.from(area.children).some(o => o !== city && o.localName === 'City' && intRank(childText(o, 'MaxInt')) >= mine)
    })
    .sort((a, b) => intRank(childText(a, 'MaxInt')) - intRank(childText(b, 'MaxInt')))
    .slice(0, LATE_CITY_COUNT)
  if (cities.length < LATE_CITY_COUNT) throw new Error('テスト用の電文に、抜いてよい市町村が足りません')
  const stations = stationsWithInt(doc)
    .filter((station) => {
      const city = station.parentElement
      if (!city) return false
      const mine = intRank(childText(station, 'Int'))
      return Array.from(city.children).some(o => o !== station && o.localName === 'IntensityStation' && intRank(childText(o, 'Int')) >= mine)
    })
    .sort((a, b) => intRank(childText(a, 'Int')) - intRank(childText(b, 'Int')))
    .slice(0, LATE_STATION_COUNT)
  if (stations.length < LATE_STATION_COUNT) throw new Error('テスト用の電文に、抜いてよい観測点が足りません')
  return { cities, stations }
}

/**
 * 5 通目: 4 通目で抜いた市町村・観測点が**増えた**形。その行へ電文の印（`Revise` = 追加）を付ける。
 *
 * **印を付けないと、行の更新の印が画面に出ない。** 同じ種別の続報では、アプリは電文の印だけを
 * 採り、差分からは付けない（→ `utils/quakeUpdateMark.ts`。実配信の震源・震度情報は必ず印を持つ）。
 */
function withAddedStations(serial: number, seconds: number): (xml: string) => string {
  return xml => editXml(xml, (doc) => {
    setSectionText(doc, 'Head', 'Serial', String(serial))
    shiftIssueTime(doc, seconds)
    const { cities, stations } = lateTargets(doc)
    for (const node of [...cities, ...stations]) node.appendChild(el(doc, node, 'Revise', '追加'))
  })
}

function withLateStations(xml: string): string {
  return editXml(xml, (doc) => {
    const cities = descendants(doc, 'City')
    const removableCities = cities
      .filter((city) => {
        const area = city.parentElement
        if (!area) return false
        const mine = intRank(childText(city, 'MaxInt'))
        return Array.from(area.children).some(o => o !== city && o.localName === 'City' && intRank(childText(o, 'MaxInt')) >= mine)
      })
      .sort((a, b) => intRank(childText(a, 'MaxInt')) - intRank(childText(b, 'MaxInt')))
      .slice(0, LATE_CITY_COUNT)
    if (removableCities.length < LATE_CITY_COUNT) throw new Error('テスト用の電文に、抜いてよい市町村が足りません')
    for (const city of removableCities) city.remove()
    const removableStations = stationsWithInt(doc)
      .filter((station) => {
        const city = station.parentElement
        if (!city) return false
        const mine = intRank(childText(station, 'Int'))
        return Array.from(city.children).some(o => o !== station && o.localName === 'IntensityStation' && intRank(childText(o, 'Int')) >= mine)
      })
      .sort((a, b) => intRank(childText(a, 'Int')) - intRank(childText(b, 'Int')))
      .slice(0, LATE_STATION_COUNT)
    if (removableStations.length < LATE_STATION_COUNT) throw new Error('テスト用の電文に、抜いてよい観測点が足りません')
    for (const station of removableStations) station.remove()
  })
}

/** 7 通目: 観測点の震度が上下した続報。上の段の最大震度は配下から取り直す。 */
function withRaisedStations(xml: string): string {
  return editXml(xml, (doc) => {
    setSectionText(doc, 'Head', 'Serial', '3')
    shiftIssueTime(doc, 180)
    const sorted = stationsWithInt(doc).sort((a, b) => intRank(childText(a, 'Int')) - intRank(childText(b, 'Int')))
    const raised = sorted.slice(0, RAISED_STATION_COUNT)
    // **下がる観測点も入れる。** 印は向きで色が変わるので、上がる形しか無いと下がった側を実機で確かめられない。
    //
    // **市町村でいちばん強い観測点は下げない。** 下げると市町村・区域・地震全体の最大震度まで下がり、
    // 確かめたい「観測点の行の印」ではなく最大震度の下方修正になる（実機で見出しの震度が下がった）。
    // 同じ市町村に同じかそれ以上の観測点が残るものから、強い順に選ぶ。**残るかどうかは、既に
    // 選んだ観測点を除いて見る** —— 同じ震度の観測点が 2 つある市町村で、互いを「残る相手」と
    // 数えて両方を下げてしまう。
    const lowered: Element[] = []
    for (const s of [...sorted].reverse()) {
      if (lowered.length >= LOWERED_STATION_COUNT) break
      const mine = intRank(childText(s, 'Int'))
      if (raised.includes(s) || mine <= 0) continue
      const city = s.parentElement
      const kept = !!city && Array.from(city.children).some(o =>
        o !== s && o.localName === 'IntensityStation' && !raised.includes(o) && !lowered.includes(o)
        && intRank(childText(o, 'Int')) >= mine)
      if (kept) lowered.push(s)
    }
    if (lowered.length < LOWERED_STATION_COUNT) throw new Error('テスト用の電文に、下げてよい観測点が足りません')
    for (const s of raised) childOf(s, 'Int')!.textContent = raiseInt(childText(s, 'Int')!)
    for (const s of lowered) childOf(s, 'Int')!.textContent = lowerInt(childText(s, 'Int')!)
    // **動いた行へ電文の印を付ける。** 同じ種別の続報では、アプリは電文の印だけを採り、
    // 差分からは付けない（→ `utils/quakeUpdateMark.ts`）。付けないと行が 1 つも光らない。
    for (const s of raised) s.appendChild(el(doc, s, 'Revise', '上方修正'))
    for (const s of lowered) s.appendChild(el(doc, s, 'Revise', '下方修正'))
    recomputeMaxInts(doc)
  })
}

/**
 * 種別が前後して届く報のテスト（**7 通**）。能登の前震（16:06）の実電文の並び。
 *
 * 1〜3 通目と 4 通目の元は**実配信の順そのまま**（震度速報 → 震源に関する情報 → 震度速報 →
 * 震源・震度に関する情報）。3 通目で見出しが「震度速報#2/震源情報」になり、4 通目で速報段階が畳まれる
 * （→ docs/spec/quake-spec.md §8「見出しには受け取った種別を並べる」）。
 *
 * 5〜7 通目はこの地震には無い形なので、実電文を書き換えて作る。
 *
 * - **4 通目は観測点・市町村の一部を抜いたもの**（→ `withLateStations`）、**5 通目が実電文そのもの**
 *   （報番号 2 として流す）。区域は据え置きのまま観測点だけが増え、読み上げは「観測地点が追加
 *   されましたが、地域ごとの最大震度は変わっていません。」と読む
 * - **6 通目は震源・震度に関する情報のあとに届く震度速報**（1 通目を遅らせて流す）。気象庁の発表で
 *   実際に起きる順序で、カードは据え置かれる（→ `utils/quakeMerge.ts` の `isSupersededByExistingCard`）
 * - **7 通目は観測点の震度が上下した続報**（→ `withRaisedStations`）。動いた行に更新の印が付く
 */
export const QUAKE_REPORT_SEQUENCE: TestTelegramScript = {
  anchor: 6,
  steps: [
    // 1 通目は**区域の最大震度を 1 段下げる**（5強 → 5弱）。3 通目で 5強が出そろうので、
    // **ブラウザ通知の「最大震度更新」を実機で確かめられる**のはここだけ（→ 設定の窓の説明文）。
    // 実配信でも、速報の続報で区域の震度が上がる（観測が増えるため）。
    { file: NOTO_FORESHOCK.prompt1, headType: 'VXSE51', atMs: 0, rewrite: lowerAreaInts },
    { file: NOTO_FORESHOCK.destination, headType: 'VXSE52', atMs: REPORT_SEQUENCE_DELAY_MS },
    { file: NOTO_FORESHOCK.prompt2, headType: 'VXSE51', atMs: REPORT_SEQUENCE_DELAY_MS * 2 },
    { file: NOTO_FORESHOCK.detail, headType: 'VXSE53', atMs: REPORT_SEQUENCE_DELAY_MS * 3, rewrite: withLateStations },
    {
      file: NOTO_FORESHOCK.detail, headType: 'VXSE53', atMs: REPORT_SEQUENCE_DELAY_MS * 3 + REPORT_SEQUENCE_FOLLOWUP_DELAY_MS,
      rewrite: withAddedStations(2, 60),
    },
    {
      file: NOTO_FORESHOCK.prompt1, headType: 'VXSE51', atMs: REPORT_SEQUENCE_DELAY_MS * 4 + REPORT_SEQUENCE_FOLLOWUP_DELAY_MS,
      rewrite: xml => editXml(xml, doc => shiftIssueTime(doc, 300)),
    },
    { file: NOTO_FORESHOCK.detail, headType: 'VXSE53', atMs: REPORT_SEQUENCE_DELAY_MS * 5 + REPORT_SEQUENCE_FOLLOWUP_DELAY_MS, rewrite: withRaisedStations },
  ],
}

/** 取消テストで、震度速報から取消までの間（ミリ秒）。 */
export const QUAKE_CANCEL_DELAY_MS = 10_000

/**
 * 取消テスト（2024-01-01 23:05 の震度速報 → 23:13 の取消）。**実配信の誤発表と取消そのもの。**
 * 23:05 の震度速報は、23:04 の佐渡付近の地震に能登本震の震度が誤って載ったもの。
 */
export const QUAKE_CANCEL: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: SADO.prompt, headType: 'VXSE51', atMs: 0 },
    { file: SADO.cancel, headType: 'VXSE51', atMs: QUAKE_CANCEL_DELAY_MS },
  ],
}

/**
 * 一部取消テスト（震度速報 → 震源・震度に関する情報 → 震度速報だけの取消）。
 *
 * 取消は情報名称の単位で効く（電文解説資料 別紙ウ）。**この順の実電文の標本は無い** —— 実配信
 * （上の取消テストと同じ地震）は震度速報 → 取消（23:13）→ 震源・震度に関する情報（23:14）の順だった。
 * 同じ 3 通を並べ替え、**取消の発表時刻だけを震源・震度に関する情報より後へ動かす**（並べ替えただけ
 * では取消のほうが古い報になり、新旧の比べ方が実配信と逆になる）。
 */
export const QUAKE_PARTIAL_CANCEL: TestTelegramScript = {
  anchor: 2,
  steps: [
    { file: SADO.prompt, headType: 'VXSE51', atMs: 0 },
    { file: SADO.detail, headType: 'VXSE53', atMs: REPORT_SEQUENCE_DELAY_MS },
    {
      file: SADO.cancel, headType: 'VXSE51', atMs: REPORT_SEQUENCE_DELAY_MS + QUAKE_CANCEL_DELAY_MS,
      // 取消の元の発表は 23:13。2 分進めて、分単位の発表時刻（`ReportDateTime`）でも 23:14 の
      // 震源・震度に関する情報より後ろにする（1 分だと同じ 23:14 に並ぶ）
      rewrite: xml => editXml(xml, doc => shiftIssueTime(doc, 120)),
    },
  ],
}

/** 震源の借用テストで、電文と電文のあいだ（ミリ秒）。実電文の 1 分前後の間隔を詰めたもの。 */
const HYPOCENTER_BORROW_STEP_MS = 4000

/**
 * 震源の借用テストで、規模が更新される津波警報を流すまで（ミリ秒。1 通目から）。
 * **前の津波の読み上げが終わってから届くように空ける**（実電文では 16:12 → 16:22 の 10 分）。
 */
const HYPOCENTER_BORROW_UPDATE_MS = 30000

/**
 * 震源を津波電文から借りる場面のテスト（能登本震の実電文の並び）。
 *
 * 震度速報が届くあいだ震源はどこにも無く、16:12 の津波警報が最初に「石川県能登地方・Ｍ７．４」を
 * 伝えた。地震情報として震源が届くのは 16:16。
 *
 *   1. 震度速報（16:11）
 *   2. 津波警報（16:12。**ここで震度速報のカードに震源が入る**）
 *   3. 震度速報の続報（16:13。震源はやはり無い＝借りたまま保つことを見る）
 *   4. 津波警報の続報（16:22。石川県能登を大津波警報へ引き上げ、同じ報で M7.6 へ更新）
 */
export const HYPOCENTER_FROM_TSUNAMI: TestTelegramScript = {
  anchor: 3,
  steps: [
    { file: NOTO.prompt1, headType: 'VXSE51', atMs: 0 },
    { file: NOTO.tsunami1, headType: 'VTSE41', atMs: HYPOCENTER_BORROW_STEP_MS },
    { file: NOTO.prompt2, headType: 'VXSE51', atMs: HYPOCENTER_BORROW_STEP_MS * 2 },
    { file: NOTO.tsunami2, headType: 'VTSE41', atMs: HYPOCENTER_BORROW_UPDATE_MS },
  ],
}

// ───────────────────────── 津波 ─────────────────────────

/**
 * テストの津波を片付けるまで（ミリ秒）。発表から解除の報までの間。
 * 津波そのものの失効ではなく、**テストで流した津波を片付けるまでの間**。
 */
export const TSUNAMI_DISMISS_MS = 90_000

/** 能登本震の津波の報（2024-01-01〜02）。 */
const NOTO_TSUNAMI = {
  /** 16:12 津波警報（津波警報 5・注意報 11・予報 10 区域）。 */
  warning: nii('20240101071254_0_VTSE41_010000'),
  /** 16:13 各地の満潮時刻・津波到達予想時刻に関する情報。 */
  tide1: nii('20240101071324_0_VTSE51_010000'),
  /** 16:22 石川県能登を大津波警報へ引き上げ。 */
  upgrade: nii('20240101072233_0_VTSE41_010000'),
  /** 16:23 満潮時刻の情報（等級は前報のまま）。 */
  tide2: nii('20240101072302_0_VTSE51_010000'),
  /** 20:30 大津波警報を津波警報へ引き下げ。 */
  downgrade: nii('20240101113006_0_VTSE41_010000'),
  /** 01/02 07:30 津波注意報。 */
  watch: nii('20240101223019_0_VTSE41_010000'),
  /** 01/02 10:00 津波注意報を解除し、予報だけが残る（失効時刻 17:00）。 */
  forecastWithExpiry: nii('20240102010011_0_VTSE41_010000'),
}

/**
 * 2015-11-14 薩摩半島西方沖の地震（A: 05:51 M7.0、B: 06:17 M5.1）。**06:55 の報で原因地震に B が
 * 加わり、`EventID` が「A B」になる**（電文解説資料 Ⅰ.別02-7 出現例６と同じ形の実例）。
 */
const SATSUMA = {
  /** 05:56 津波注意報。 */
  watch: nii('8b582841-8b18-3800-915e-d71e748cbc4d'),
  /** 05:58 各地の満潮時刻・津波到達予想時刻に関する情報。 */
  tide: nii('3a412185-ee4c-31d9-8f8c-0e6da483abcb'),
  /** 05:59 地震 A の震源・震度に関する情報。 */
  quakeA: nii('04690cbb-243d-3bca-b191-cee9833a5a6a'),
  /** 06:22 地震 B の震源・震度に関する情報。 */
  quakeB: nii('316603b4-497a-3d99-af04-ec064b9e24d0'),
  /** 06:55 津波観測に関する情報（原因地震 A B）。 */
  observationAB: nii('08650b71-a0fe-34a3-9d0c-a0cdccfef806'),
  /** 07:20 津波注意報の解除（全区域）。 */
  lift: nii('305cd28b-f713-3961-aefd-2ec53b096a06'),
}
const SATSUMA_EVENT_ID = '20151114055157'
/** 薩摩の津波注意報（05:56:28）の作成時刻。取消をこの少し後へ置く。 */
const SATSUMA_WATCH_CONTROL_MS = Date.parse('2015-11-13T20:56:28Z')

/** 発表報を、その数分後の全区域解除の報へ書き換える（→ `toAllLifted`）。 */
const liftedAfter = (seconds: number, options?: { includeForecast?: boolean }) =>
  (xml: string) => editXml(xml, (doc) => {
    toAllLifted(doc, options)
    shiftIssueTime(doc, seconds)
  })

/** 2011-03-11 東北地方太平洋沖地震を元にした気象庁のサンプル電文（通常の運用種別）。 */
const TOHOKU = {
  /** 14:49 大津波警報・津波警報・津波注意報・津波予報。 */
  warning: sample('32-39_11_02_250206_VTSE41'),
  /** 14:50 各地の満潮時刻・津波到達予想時刻に関する情報。 */
  tide: sample('32-39_11_03_250206_VTSE51'),
  /** 沖合の津波観測に関する情報（沿岸への推定を含む）。発表時刻は 14:50、作成時刻（`Control/DateTime`）は 14:53:50。 */
  offshore: sample('61_11_01_250206_VTSE52'),
  /** 14:53 津波警報の続報（青森県太平洋沿岸を大津波警報へ引き上げ）。 */
  upgrade: sample('32-39_11_06_250206_VTSE41'),
  /** 15:00 津波警報の続報（予想される津波の高さを数値へ更新。区域の等級は 14:53 と同じ）。 */
  update: sample('32-39_11_09_250206_VTSE41'),
  /**
   * 15:01 津波観測に関する情報（観測中・重要・上昇中を含む）。
   *
   * **区域の等級と予想の高さは 15:00 の続報（`update`）の写し**で、14:49 の発表とは違う（青森県太平洋沿岸が
   * 大津波警報・高さは数値）。津波情報は等級も予想も動かさないので、この報を流すなら 15:00 の津波警報を先に流すこと
   * （→ docs/spec/settings-pwa-spec.md §7「実配信に無い形を作らない」）。
   */
  observation: sample('32-39_11_10_250206_VTSE51'),
}

/**
 * 区域の最大震度（`Pref/Area/MaxInt`）を 1 段下げる。
 *
 * **速報の 1 通目を「まだ出そろっていない」形にするのに使う。** 続報で震度が上がる経路
 * （カードの最大震度の更新・ブラウザ通知）を実機で通すには、上がる前の報が要る。
 */
function lowerAreaInts(xml: string): string {
  return editXml(xml, (doc) => {
    const ints = descendants(doc, 'MaxInt')
    if (ints.length === 0) throw new Error('テスト用の電文に区域の最大震度がありません')
    for (const node of ints) {
      const lowered = lowerInt(node.textContent ?? '')
      if (lowered) node.textContent = lowered
    }
  })
}

/** 名前で観測点（`Station`）を探す。 */
function stationNamed(doc: Document, name: string): Element {
  const found = descendants(doc, 'Station').find(s => childText(s, 'Name') === name)
  if (!found) throw new Error(`テスト用の電文に観測点「${name}」がありません`)
  return found
}

/** 子要素を作って中身を入れる（親と同じ名前空間）。 */
function el(doc: Document, parent: Element, localName: string, text: string, ns = parent.namespaceURI): Element {
  const e = doc.createElementNS(ns, localName)
  e.textContent = text
  return e
}

/** `FirstHeight` / `MaxHeight` の中身を作り直す。 */
function replaceChildren(target: Element, children: Element[]): void {
  for (const c of Array.from(target.children)) c.remove()
  target.append(...children)
}

const JMX_EB_NS = 'http://xml.kishou.go.jp/jmaxml1/elementBasis1/'

/**
 * 観測の報へ、**東北のサンプルに無い観測状態**を足す（2026-10-22 ユーザー選択「実電文を書き換えて足す
 * (Recommended)」）。書き方は気象庁の訓練用サンプル（2025-07-02 三陸沖 38_01_01）の実例に倣う。
 *
 * - 宮古: 最大波「微弱」（那智勝浦町浦神の形）
 * - 大船渡: 最大波「重要　欠測」・「３．２ｍ以上」（函館の形）
 * - むつ市関根浜: 第１波「第１波識別不能」（浦河の形）
 * - 石巻市鮎川: 第１波・最大波とも「欠測」（第１波の欠測はサンプルに無く、電文解説資料の定めどおり書く）
 *
 * サンプルが元から持つ「観測中」「重要」「上昇中」（釜石）・沖合の報の「推定中」と合わせて、
 * 観測状態を一通り確かめられる。
 */
function withAllObservationStates(xml: string): string {
  return editXml(xml, (doc) => {
    const miyako = childOf(stationNamed(doc, '宮古'), 'MaxHeight')!
    replaceChildren(miyako, [el(doc, miyako, 'DateTime', '2011-03-11T14:58:00+09:00'), el(doc, miyako, 'Condition', '微弱')])

    const ofunato = childOf(stationNamed(doc, '大船渡'), 'MaxHeight')!
    const height = el(doc, ofunato, 'jmx_eb:TsunamiHeight', '3.2', JMX_EB_NS)
    for (const [k, v] of [['type', 'これまでの最大波の高さ'], ['unit', 'm'], ['description', '３．２ｍ以上']]) height.setAttribute(k, v)
    replaceChildren(ofunato, [el(doc, ofunato, 'DateTime', '2011-03-11T14:55:00+09:00'), el(doc, ofunato, 'Condition', '重要　欠測'), height])

    const mutsu = childOf(stationNamed(doc, 'むつ市関根浜'), 'FirstHeight')!
    replaceChildren(mutsu, [el(doc, mutsu, 'Condition', '第１波識別不能')])

    const ishinomaki = stationNamed(doc, '石巻市鮎川')
    const first = childOf(ishinomaki, 'FirstHeight')!
    replaceChildren(first, [el(doc, first, 'Condition', '欠測')])
    const max = childOf(ishinomaki, 'MaxHeight')!
    replaceChildren(max, [el(doc, max, 'Condition', '欠測')])
  })
}

/**
 * 大津波警報テスト（2011 東北の気象庁サンプル電文の並び）。
 *
 *   1. 14:49 大津波警報（大津波警報 3・津波警報 5・注意報 15・予報 20 区域）
 *   2. 14:50 満潮時刻・到達予想の情報
 *   3. 14:53 津波警報の続報（青森県太平洋沿岸を大津波警報へ引き上げ。大津波警報 4・津波警報 4）
 *   4. 沖合の津波観測（観測中・重要・沿岸への推定。作成は 14:53:50）
 *   5. 15:00 津波警報の続報（予想される津波の高さを「巨大」「高い」から数値へ）
 *   6. 15:01 津波観測（**観測状態を一通り足したもの** → `withAllObservationStates`）
 *   7. 片付けの全区域解除
 *
 * **並びは作成時刻（`Control/DateTime`）の順。** 発表時刻で並べると沖合の報が 3 より先に来て、
 * 受け手が作成時刻の順へ並べ直して重ね直す（→ `utils/tsunami.ts` の `arrivesOutOfOrder`）。
 * 3・5 を抜かない理由は `TOHOKU.observation`。
 *
 * 最後の報（片付け）を「いま」に合わせる。第１波の到達予想（15:00 以降）はまだ先に残る。
 */
export const TSUNAMI_MAJOR_WARNING: TestTelegramScript = {
  anchor: 6,
  steps: [
    { file: TOHOKU.warning, headType: 'VTSE41', atMs: 0 },
    { file: TOHOKU.tide, headType: 'VTSE51', atMs: 3000 },
    { file: TOHOKU.upgrade, headType: 'VTSE41', atMs: 6000 },
    { file: TOHOKU.offshore, headType: 'VTSE52', atMs: 9000 },
    { file: TOHOKU.update, headType: 'VTSE41', atMs: 12_000 },
    { file: TOHOKU.observation, headType: 'VTSE51', atMs: 15_000, rewrite: withAllObservationStates },
    { file: TOHOKU.warning, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS, rewrite: liftedAfter(780) },
  ],
}

/** 変化の小さい続報テストの、電文と電文のあいだ（ミリ秒）。読み上げが終わる程度に空ける。 */
export const TSUNAMI_QUIET_STEP_MS = 10_000
/** 変化の小さい続報テストで、最後の報を流してから全解除までに残す余裕（ミリ秒）。 */
export const TSUNAMI_QUIET_TAIL_MS = 20_000

/** 観測の報（東北サンプル）で、波高を持たせる観測点。 */
const QUIET_HEIGHT_STATION = '釜石'

/**
 * 変化の小さい続報テストの時間軸の基準（**観測情報のサンプルの作成時刻**）。
 *
 * **段ごとに発表時刻を絶対値で置く**（→ `setIssueTime`）。元にしたサンプルは報の種類ごとに
 * 時刻がばらばらで（観測情報 06:01:55・沖合 05:55:00・満潮時刻 05:50:46）、元の時刻からの差で
 * ずらすと**後の段が前の段より古い作成時刻**になる。そうなると受け手が作成時刻の順に並べ直して
 * 重ね直すので（→ `utils/tsunami.ts` の `arrivesOutOfOrder`）、1 段ずつ動かした値が画面に出ない。
 *
 * **いちばん遅い報（観測情報）に合わせる。** 早い報に合わせると、その報が載せている観測の時刻
 * （最大波・第 1 波・観測状況を確定した時刻）が発表時刻より後になり、**まだ来ていない波を
 * 観測した**形になる（→ docs/spec/tsunami-spec.md §4）。
 */
const QUIET_BASE_MS = Date.parse('2011-03-11T06:01:55Z')
/** 段 `i` の発表時刻（届く時刻と同じ刻みで並べる）。 */
const quietIssueAt = (atMs: number) => isoZ(QUIET_BASE_MS + atMs)

/** 観測点（名前で探す）の `MaxHeight` の波高要素。 */
function maxHeightOf(doc: Document, name: string): { max: Element; height: Element } {
  const max = childOf(stationNamed(doc, name), 'MaxHeight')
  const height = max && descendants(max, 'TsunamiHeight')[0]
  if (!max || !height) throw new Error(`テスト用の電文の観測点「${name}」に最大波の高さがありません`)
  return { max, height }
}

/** 釜石の最大波の観測時刻（段 3 で更新した値。以後の段は保つ）。 */
const QUIET_MAX_HEIGHT_TIME = '2011-03-11T14:58:00+09:00'
/** 大船渡の第１波の到達時刻（段 4 で更新した値。以後の段は保つ）。 */
const QUIET_FIRST_WAVE_TIME = '2011-03-11T14:50:00+09:00'

/**
 * 観測の報（東北サンプル 32-39_11_10）を元に、**直前の報から 1 つだけ動かした続報**を作る書き換え。
 *
 * 動かした項目にだけ `Revise` を付ける。**前の段で動かした項目は値を保つ**（保たないと、後の段が
 * 「前の段の変更を元へ戻した」ことになり、確かめたい 1 つの変化に別の変化が混ざる）。
 *
 * @param serial 報番号。**段ごとに 1 つずつ進める** —— 津波情報（VTSE51）の `id` は報番号から作るので、
 *   同じ番号で 2 通流すと 2 通目が同じ報の再送として捨てられる
 * @param level どこまでの変化を保つか（2〜4）。前の段で動かした項目を元へ戻さないために使う
 * @param atMs この段が届くまでの待ち（発表時刻を基準から同じだけ進める）
 * @param mark 動かした項目へ `Revise` を付ける
 */
const quietObservation = (
  serial: number,
  level: number,
  atMs: number,
  mark: (doc: Document) => void = () => {},
) => (xml: string) => editXml(xml, (doc) => {
  stripRevise(doc)
  setSectionText(doc, 'Head', 'Serial', String(serial))
  setIssueTime(doc, quietIssueAt(atMs))
  // **全段で値を落としておく。** 段 9 の「値は無いまま印だけが付く報」の前提（→ `makeValueless`）
  makeValueless(doc, QUIET_VALUELESS_STATION)
  const { max, height } = maxHeightOf(doc, QUIET_HEIGHT_STATION)
  if (level >= 2) height.setAttribute('description', '３．２ｍ以上')
  if (level >= 3) childOf(max, 'DateTime')!.textContent = QUIET_MAX_HEIGHT_TIME
  if (level >= 4) childOf(childOf(stationNamed(doc, '大船渡'), 'FirstHeight')!, 'ArrivalTime')!.textContent = QUIET_FIRST_WAVE_TIME
  mark(doc)
})

/** 満潮時刻の情報（東北サンプル 32-39_11_03）を元に、続報を作る書き換え。 */
const quietTide = (
  serial: number,
  atMs: number,
  edit: (doc: Document) => void = () => {},
) => (xml: string) => editXml(xml, (doc) => {
  setSectionText(doc, 'Head', 'Serial', String(serial))
  setIssueTime(doc, quietIssueAt(atMs))
  alignTideForecastToLatest(doc)
  edit(doc)
})

/**
 * 15:00 の津波警報の続報（`TOHOKU.update`）で大津波警報だった区域と、予想される津波の高さ。
 * 値はその電文の `Forecast/Item` から写した。
 */
const TOHOKU_UPDATE_MAJOR_HEIGHTS: Readonly<Record<string, number>> = { 201: 5, 210: 5, 220: 10, 250: 5 }
/** 同じ報で、大津波警報以外の区域の予想される津波の高さ（等級の種別コードごと。どの区域も同じ値）。 */
const TOHOKU_UPDATE_HEIGHTS: Readonly<Record<string, { value: number; description: string }>> = {
  51: { value: 3, description: '３ｍ' },
  62: { value: 1, description: '１ｍ' },
  71: { value: 0.2, description: '０．２ｍ未満' },
}
const FULL_WIDTH_DIGITS = '０１２３４５６７８９'
const toFullWidthMeters = (value: number) => `${String(value).replace(/\d/g, d => FULL_WIDTH_DIGITS[Number(d)])}ｍ`

/** 15:01 の観測の報（`TOHOKU.observation`）で、第１波の到達を確認していた区域。 */
const TOHOKU_OBSERVED_ARRIVAL_AREAS: ReadonlySet<string> = new Set(['201', '210', '220'])

/** 区域の `FirstHeight` を「第１波の到達を確認」にする（到達予想時刻・推測の印は外す）。 */
function markAreaArrived(doc: Document, item: Element): void {
  const first = childOf(item, 'FirstHeight')
  if (!first) throw new Error('テスト用の電文の区域に第１波（FirstHeight）がありません')
  replaceChildren(first, [el(doc, first, 'Condition', '第１波の到達を確認')])
}

/**
 * 満潮時刻の報（14:50 のサンプル）の区域を、**その時点でいちばん新しい報に揃える**。
 * 等級と予想の高さは 15:00 の津波警報の続報、到達状況は 15:01 の観測の報（→ `TOHOKU.observation`）。
 *
 * 15:00 より後の満潮時刻の報はサンプルに無い。14:50 の報をそのまま流すと、等級・高さ・到達状況が
 * 14:50 の値へ戻った形になる（実配信に無い。→ docs/spec/settings-pwa-spec.md §7「実配信に無い形を作らない」）。
 */
function alignTideForecastToLatest(doc: Document): void {
  const forecast = descendants(doc, 'Forecast')[0]
  if (!forecast) throw new Error('テスト用の電文に津波予報（Forecast）がありません')
  let aligned = 0
  for (const item of descendants(forecast, 'Item')) {
    const area = childOf(item, 'Area')
    const category = childOf(item, 'Category')
    const kind = category && childOf(category, 'Kind')
    const height = descendants(item, 'TsunamiHeight')[0]
    if (!area || !kind || !height) continue
    const code = childText(area, 'Code') ?? ''
    const major = TOHOKU_UPDATE_MAJOR_HEIGHTS[code]
    if (major !== undefined) {
      childOf(kind, 'Name')!.textContent = '大津波警報'
      childOf(kind, 'Code')!.textContent = '52'
    }
    const kindName = childText(kind, 'Name') ?? ''
    const kindCode = childText(kind, 'Code') ?? ''
    const next = major !== undefined ? { value: major, description: toFullWidthMeters(major) } : TOHOKU_UPDATE_HEIGHTS[kindCode]
    if (!next) throw new Error(`テスト用の電文の区域（${code}）の等級（${kindCode}）に、揃える高さがありません`)
    // 前回の等級は今回と同じにする（この報は等級を動かしていない）
    const last = childOf(category, 'LastKind')
    if (last) {
      childOf(last, 'Name')!.textContent = kindName
      childOf(last, 'Code')!.textContent = kindCode
    }
    height.removeAttribute('condition')
    height.setAttribute('description', next.description)
    height.textContent = String(next.value)
    if (TOHOKU_OBSERVED_ARRIVAL_AREAS.has(code)) markAreaArrived(doc, item)
    aligned++
  }
  if (aligned === 0) throw new Error('テスト用の電文に、揃える区域がありません')
}

/** 満潮時刻を次の満潮へ進める（実電文でも半日ほど先へ飛ぶ）。 */
function advanceHighTide(doc: Document): void {
  const tides = descendants(doc, 'HighTideDateTime')
  if (tides.length === 0) throw new Error('テスト用の電文に満潮時刻（HighTideDateTime）がありません')
  for (const t of tides) t.textContent = new Date(Date.parse(t.textContent ?? '') + 12 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 段 11 で、欠測のまま進める釜石の最大波の観測時刻。**段 3 の値（14:58）より後で、段 11 の観測状況を確定した時刻より前**
 * にする —— 確定時刻より後の観測は「まだ来ていない波を観測した」形になる（実配信に無い）。段 11 の確定時刻は見本の
 * 15:00:00 に `at(11)`（110 秒）を足した 15:01:50、発表時刻は 15:03:45。
 */
const QUIET_MISSING_MAX_HEIGHT_TIME = '2011-03-11T15:01:00+09:00'

/**
 * 観測点の最大波を「欠測」にする（**値は持ったまま**。これまでの最大波を観測した後に観測が途切れた形）。
 * 電文解説資料 Ⅱ.12 事例 6（「欠測」と数値が並ぶ）と同じ形にする。
 */
function markMissing(doc: Document, name: string): void {
  const { max } = maxHeightOf(doc, name)
  childOf(max, 'Condition')?.remove()
  max.appendChild(el(doc, max, 'Condition', '欠測'))
}

/** 変化の小さい続報テストで、**値を 1 つも持たない形**にしておく観測点。 */
const QUIET_VALUELESS_STATION = '石巻市鮎川'

/**
 * 観測点を「第１波識別不能・観測中」＝**値を 1 つも持たない形**にする（全段に効かせる）。
 *
 * この形があって初めて、段 9 の「値は無いまま印だけが付く報」を作れる。素材では到達時刻を
 * 持っているので、ここで落としておかないと段 9 が「値が消えた報」になってしまう。
 */
function makeValueless(doc: Document, name: string): void {
  const first = childOf(stationNamed(doc, name), 'FirstHeight')
  if (!first) throw new Error(`テスト用の電文の観測点「${name}」に第１波がありません`)
  for (const tag of ['ArrivalTime', 'Initial']) childOf(first, tag)?.remove()
  if (!childOf(first, 'Condition')) first.appendChild(el(doc, first, 'Condition', '第１波識別不能'))
}

/**
 * 値を持たない観測点へ、**電文の印だけ**を付ける。
 *
 * **値が無いまま印が付く報は実配信にある**（実電文 168 件）。カードの「到達時刻不明」「観測中」に
 * 印の色が当たる経路は、この形でしか通らない
 * （→ docs/spec/tsunami-spec.md §9「どの項目が動いたかを文字色で示す」）。
 */
function markValuelessStation(doc: Document, name: string): void {
  const station = stationNamed(doc, name)
  for (const tag of ['FirstHeight', 'MaxHeight']) {
    const el2 = childOf(station, tag)
    if (!el2) throw new Error(`テスト用の電文の観測点「${name}」に ${tag} がありません`)
    el2.appendChild(el(doc, el2, 'Revise', '追加'))
  }
}

/**
 * 観測点の到達予想時刻（満潮時刻の報の `Station/FirstHeight/ArrivalTime`）を早める。
 * **区域の到達予想時刻は動かさない** —— 区域の欄は津波警報等の写しで、津波情報だけでは動かない。
 */
function advanceArrivalForecast(doc: Document, minutes: number): void {
  let moved = 0
  for (const item of descendants(descendants(doc, 'Forecast')[0] ?? doc, 'Item')) {
    // **区域の到達予想時刻より前へは早めない** —— 観測点に区域より早く届く予想は実配信に無い
    const areaFirst = childOf(item, 'FirstHeight')
    const areaMs = Date.parse(childText(areaFirst ?? item, 'ArrivalTime') ?? '')
    for (const s of descendants(item, 'Station')) {
      const first = childOf(s, 'FirstHeight')
      const time = first && childOf(first, 'ArrivalTime')
      const ms = Date.parse(time?.textContent ?? '')
      if (!time || !Number.isFinite(ms)) continue
      const next = Math.max(ms - minutes * 60_000, Number.isFinite(areaMs) ? areaMs : -Infinity)
      if (next === ms) continue
      time.textContent = new Date(next).toISOString().replace(/\.\d{3}Z$/, 'Z')
      moved++
    }
  }
  if (moved === 0) throw new Error('テスト用の電文に、早められる観測点の到達予想時刻（ArrivalTime）がありません')
}

/** 段 14 で第１波の到達を確認する区域（15:01 の観測の報では、まだ到達予想時刻だけを持つ）。 */
const QUIET_ARRIVING_AREA = '250'

/** 到達状況だけを進める（到達予想時刻だけだった区域が「第１波の到達を確認」になる）。 */
function confirmArrival(doc: Document): void {
  const item = descendants(descendants(doc, 'Forecast')[0] ?? doc, 'Item')
    .find(i => childText(childOf(i, 'Area') ?? i, 'Code') === QUIET_ARRIVING_AREA)
  if (!item || !childOf(childOf(item, 'FirstHeight') ?? item, 'ArrivalTime')) {
    throw new Error(`テスト用の電文に、到達予想時刻だけを持つ区域（${QUIET_ARRIVING_AREA}）がありません`)
  }
  markAreaArrived(doc, item)
}

/**
 * 変化の小さい続報テスト（DMDSS 版のみ）。**通知音だけが鳴って何も声にならなかった報を、実機で
 * 確かめる唯一の入口。** 2024 年能登半島地震の 26 時間では、取消を除く津波電文 56 通のうち 7 通が
 * この形だった（→ docs/spec/tsunami-spec.md §10「変化を伝えない続報」）。
 *
 * 元は 2011 東北の気象庁サンプル電文で、**1 段ごとに 1 つだけ動かした続報**を書き換えで作る
 * （2026-10-22 ユーザー選択「実電文を書き換えて足す (Recommended)」）。
 *
 * | 段 | 報 | 動かすもの |
 * |---|---|---|
 * | 0 | 大津波警報 | 15:00 の続報（次の段の前提。段 1 以降の区域はこの報の写し） |
 * | 1 | 観測情報 | サンプルのまま。波高の文（**ここで波高が既読にならないと、続く段が波高の文に食われる**）。区域の到達状況もサンプルの値で動く |
 * | 2 | 観測情報 | 釜石の波高を「３．２ｍ以上」へ（値は据え置き） |
 * | 3 | 観測情報 | 釜石の最大波の観測時刻だけ更新 |
 * | 4 | 観測情報 | 大船渡の第１波の到達時刻だけ更新 |
 * | 5 | 沖合の観測情報 | 沖合の観測点が初めて載る（**次の段の前提**。前の値が無いと「動いた」にならない） |
 * | 6 | 沖合の観測情報 | 沖合の観測点の最大波の観測時刻が動く（**カードの沖合の行に印が出るのはここだけ**） |
 * | 7 | 観測情報 | 何も動かない（同じ値の再送） |
 * | 8 | 観測情報 | 釜石の波高が下がり「以上」も外れる（**段 7 より後ろに置く** —— 読み上げの記憶は下げない） |
 * | 9 | 観測情報 | 値を持たない観測点（石巻市鮎川）へ、電文の印だけが付く（カードの「観測中」に印の色が当たる） |
 * | 10 | 観測情報 | 釜石が欠測へ転じる（これまでの最大波の値は持ったまま。行に印が付き、欠測の文が読まれる） |
 * | 11 | 観測情報 | 釜石が欠測のまま、最大波の観測時刻だけが更新される（「欠測となっている観測点で、…」の文） |
 * | 12〜16 | 満潮時刻 | 名乗りだけ／満潮時刻の更新／到達状況の更新／到達予想時刻の更新／何も動かない（区域は段 0・段 1 の値に揃える → `alignTideForecastToLatest`。段 14 は到達予想時刻だけだった区域の到達確認） |
 */
export const TSUNAMI_QUIET_REPORTS: TestTelegramScript = (() => {
  const T = TOHOKU.observation
  const at = (i: number) => i * TSUNAMI_QUIET_STEP_MS
  const steps: TestTelegramStep[] = [
    // 段 0: 15:00 の津波警報の続報（14:49 の発表から始めない理由は `TOHOKU.observation`）
    { file: TOHOKU.update, headType: 'VTSE41', atMs: 0 },
    // 段 1: サンプルのまま（発表時刻だけ、この時間軸へ置き直す）
    { file: T, headType: 'VTSE51', atMs: at(1), onlyIn: 'dmdss', rewrite: xml => editXml(xml, doc => setIssueTime(doc, quietIssueAt(at(1)))) },
    // 段 2: 釜石の波高が「３．２ｍ以上」になる（値は据え置き）。印は付けない（`Revise` は無い形）
    { file: T, headType: 'VTSE51', atMs: at(2), onlyIn: 'dmdss', rewrite: quietObservation(4, 2, at(2)) },
    // 段 3: 釜石の最大波の観測時刻だけ更新
    {
      file: T, headType: 'VTSE51', atMs: at(3), onlyIn: 'dmdss',
      rewrite: quietObservation(5, 3, at(3), (doc) => {
        const { max } = maxHeightOf(doc, QUIET_HEIGHT_STATION)
        max.appendChild(el(doc, max, 'Revise', '更新'))
      }),
    },
    // 段 4: 大船渡の第１波の到達時刻だけ更新
    {
      file: T, headType: 'VTSE51', atMs: at(4), onlyIn: 'dmdss',
      rewrite: quietObservation(6, 4, at(4), (doc) => {
        const first = childOf(stationNamed(doc, '大船渡'), 'FirstHeight')!
        first.appendChild(el(doc, first, 'Revise', '更新'))
      }),
    },
    // 段 5: 沖合の観測点が**初めて載る**報。**次の段の前提** —— 前の値が無いまま時刻の違う報が
    // 届いても、カードは「新しく載った行」として描き、更新の印は付かない
    {
      file: sample('61_11_01_250206_VTSE52'), headType: 'VTSE52', atMs: at(5), onlyIn: 'dmdss',
      rewrite: xml => editXml(xml, doc => setIssueTime(doc, quietIssueAt(at(5)))),
    },
    // 段 6: 沖合の観測点の最大波の観測時刻が動く（サンプルの沖合の第 2 報）
    {
      file: sample('61_11_02_250206_VTSE52'), headType: 'VTSE52', atMs: at(6), onlyIn: 'dmdss',
      rewrite: xml => editXml(xml, doc => setIssueTime(doc, quietIssueAt(at(6)))),
    },
    // 段 7: 何も動かない（同じ値の再送）
    { file: T, headType: 'VTSE51', atMs: at(7), onlyIn: 'dmdss', rewrite: quietObservation(7, 4, at(7)) },
    // 段 8: 釜石の波高が下がり、「以上」も外れる（下がる向きの 2 通りを 1 点で同時に通す）
    {
      file: T, headType: 'VTSE51', atMs: at(8), onlyIn: 'dmdss',
      rewrite: quietObservation(8, 4, at(8), (doc) => {
        const { max, height } = maxHeightOf(doc, QUIET_HEIGHT_STATION)
        height.textContent = '2.8'
        height.setAttribute('description', '２．８ｍ')
        max.appendChild(el(doc, max, 'Revise', '更新'))
      }),
    },
    // 段 9: 値を持たない観測点へ、電文の印だけが付く報（カードの「観測中」に印の色が当たる）
    {
      file: T, headType: 'VTSE51', atMs: at(9), onlyIn: 'dmdss',
      rewrite: quietObservation(9, 4, at(9), doc => markValuelessStation(doc, QUIET_VALUELESS_STATION)),
    },
    // 段 10: 釜石が欠測へ転じる（これまでの最大波の値は持ったまま。電文解説資料 Ⅱ.12 事例 6 の形）
    { file: T, headType: 'VTSE51', atMs: at(10), onlyIn: 'dmdss', rewrite: quietObservation(10, 4, at(10), doc => markMissing(doc, QUIET_HEIGHT_STATION)) },
    // 段 11: 釜石が欠測のまま、最大波の観測時刻だけが更新される（断続的な欠測。`Revise`＝更新）
    {
      file: T, headType: 'VTSE51', atMs: at(11), onlyIn: 'dmdss',
      rewrite: quietObservation(11, 4, at(11), (doc) => {
        markMissing(doc, QUIET_HEIGHT_STATION)
        const { max } = maxHeightOf(doc, QUIET_HEIGHT_STATION)
        childOf(max, 'DateTime')!.textContent = QUIET_MISSING_MAX_HEIGHT_TIME
        max.appendChild(el(doc, max, 'Revise', '更新'))
      }),
    },
    { file: TOHOKU.tide, headType: 'VTSE51', atMs: at(12), onlyIn: 'dmdss', rewrite: quietTide(12, at(12)) },
    { file: TOHOKU.tide, headType: 'VTSE51', atMs: at(13), onlyIn: 'dmdss', rewrite: quietTide(13, at(13), advanceHighTide) },
    {
      file: TOHOKU.tide, headType: 'VTSE51', atMs: at(14), onlyIn: 'dmdss',
      rewrite: quietTide(14, at(14), (doc) => { advanceHighTide(doc); confirmArrival(doc) }),
    },
    // 段 15: 到達予想時刻だけを早める（満潮時刻・到達状況は前の段のまま）
    {
      file: TOHOKU.tide, headType: 'VTSE51', atMs: at(15), onlyIn: 'dmdss',
      rewrite: quietTide(15, at(15), (doc) => { advanceHighTide(doc); confirmArrival(doc); advanceArrivalForecast(doc, 10) }),
    },
    {
      file: TOHOKU.tide, headType: 'VTSE51', atMs: at(16), onlyIn: 'dmdss',
      rewrite: quietTide(16, at(16), (doc) => { advanceHighTide(doc); confirmArrival(doc); advanceArrivalForecast(doc, 10) }),
    },
    // 片付けの全区域解除。**時刻もこの時間軸の最後へ置く**（基準＝台本の `anchor`）
    {
      file: TOHOKU.warning, headType: 'VTSE41', atMs: at(16) + TSUNAMI_QUIET_TAIL_MS,
      rewrite: xml => editXml(xml, (doc) => {
        toAllLifted(doc)
        setIssueTime(doc, quietIssueAt(at(16) + TSUNAMI_QUIET_TAIL_MS))
      }),
    },
  ]
  return { anchor: steps.length - 1, steps }
})()

/**
 * 津波警報テスト（能登本震 16:12 の津波警報と、16:13 の満潮時刻の情報）。
 * `TSUNAMI_DISMISS_MS` 後に全区域の解除を流して片付ける（→ `toAllLifted`）。
 */
export const TSUNAMI_WARNING: TestTelegramScript = {
  anchor: 2,
  steps: [
    { file: NOTO_TSUNAMI.warning, headType: 'VTSE41', atMs: 0 },
    { file: NOTO_TSUNAMI.tide1, headType: 'VTSE51', atMs: 3000 },
    { file: NOTO_TSUNAMI.warning, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS, rewrite: liftedAfter(150) },
  ],
}

/**
 * 津波注意報テスト（2015-11-14 薩摩半島西方沖の津波注意報と、満潮時刻の情報）。
 *
 * 片付けは実電文の解除（07:20）ではなく、05:56 の報を書き換えた解除にする —— 実電文の解除を
 * 「いま」に合わせると、発表から 1 時間半前の報になり、到達予想がすべて過ぎた形で出る。
 */
export const TSUNAMI_WATCH: TestTelegramScript = {
  anchor: 2,
  steps: [
    { file: SATSUMA.watch, headType: 'VTSE41', atMs: 0 },
    { file: SATSUMA.tide, headType: 'VTSE51', atMs: 3000 },
    { file: SATSUMA.watch, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS, rewrite: liftedAfter(180) },
  ],
}

/**
 * 津波予報テスト（2024-11-26 石川県西方沖の津波予報・若干の海面変動。失効時刻つき）。
 *
 * **DMDSS 版は失効時刻で消える**（気象庁は予報の終わりに電文を出さない）。標準版は失効の予約を
 * 持たないので、片付けの報を流す（→ `TestTelegramStep.onlyIn`・`toAllLifted` の `includeForecast`）。
 */
export const TSUNAMI_FORECAST: TestTelegramScript = {
  anchor: 0,
  steps: [
    {
      file: nii('20241126135327_0_VTSE41_270000'), headType: 'VTSE41', atMs: 0,
      // **失効時刻は詰める。** 実電文は発表の約 3 時間後で、テストボタンでは待てない
      // （失効時刻テストと同じ扱い。理由はそちらのコメント）。**この報が画面へ出る時刻から数える。**
      rewrite: xml => editXml(xml, (doc) => {
        const valid = only(doc, 'ValidDateTime')
        const report = childText(only(doc, 'Head'), 'ReportDateTime')
        const ms = Date.parse(report ?? '')
        if (!Number.isFinite(ms)) throw new Error('テスト用の電文の発表時刻を読めません')
        valid.textContent = `${new Date(ms + TSUNAMI_DISMISS_MS).toISOString().slice(0, 19)}+00:00`
      }),
    },
    {
      file: nii('20241126135327_0_VTSE41_270000'), headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS, onlyIn: 'standard',
      rewrite: liftedAfter(90, { includeForecast: true }),
    },
  ],
}

/** 失効時刻テストで、降格の報から失効までの長さ（ミリ秒）。期限を延ばした続報でも、その報から同じ長さを置く。 */
export const TSUNAMI_EXPIRY_AFTER_MS = 45_000
/** 失効時刻テストで、降格の報から「期限だけを延ばした続報」までの長さ（ミリ秒）。 */
export const TSUNAMI_EXPIRY_EXTEND_AT_MS = 20_000
/**
 * 失効時刻テストで、続報が期限を延ばす幅（ミリ秒）。**読み上げで違う時刻に聞こえる幅にする**（読み上げは分の単位。
 * 1 分未満だと「同じ時刻へ延長」になり、読み上げは黙る）。
 */
export const TSUNAMI_EXPIRY_EXTEND_BY_MS = 120_000

/**
 * 失効時刻テスト（能登 01/02 07:30 の津波注意報 → 10:00 に解除されて予報だけが残る報）。DMDSS 版のみ。
 *
 * **気象庁が失効時刻を載せる 2 通りのうち、等級の引き下げとして届く形**（予報だけの発表は予報テストが
 * 通す）。1 通だけ流しても降格にならない —— 判定は前報の最上位等級との比較なので、注意報を先に通す。
 * **解除の報は流さない。** 予報だけになった津波は失効時刻が来たときだけ消える。
 */
export const TSUNAMI_EXPIRY: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: NOTO_TSUNAMI.watch, headType: 'VTSE41', atMs: 0 },
    {
      file: NOTO_TSUNAMI.forecastWithExpiry, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS / 2,
      // **失効時刻は詰める。** 実電文は発表の約 7 時間後で、テストボタンでは待てない
      // （ほかの津波テストが解除まで 90 秒へ詰めているのと同じ扱い）。失効で消える経路を
      // 確かめるのが目的で、長さそのものは確かめたいことではない。
      //
      // **この報が画面へ出る時刻から数える。** 発表時刻から数えると、電文の時刻を「いま」へ
      // 寄せる分（`anchor`）とこの報を流すまでの待ち（`atMs`）が重なって、**届いた瞬間に
      // 失効済み**になる（画面に一度も出ない）。
      rewrite: xml => editXml(xml, (doc) => {
        const valid = only(doc, 'ValidDateTime')
        const report = childText(only(doc, 'Head'), 'ReportDateTime')
        const ms = Date.parse(report ?? '')
        if (!Number.isFinite(ms)) throw new Error('テスト用の電文の発表時刻を読めません')
        const expireAt = ms + TSUNAMI_DISMISS_MS / 2 + TSUNAMI_EXPIRY_AFTER_MS
        valid.textContent = `${new Date(expireAt).toISOString().slice(0, 19)}+00:00`
      }),
    },
    // **等級は同じまま、期限だけを延ばした続報**（実電文 2022-01-17 13:59 と同じ形。全期間 436 通のうち 3 通）。
    // 「津波予報の失効時刻が、〜に延長されました。」が声になる経路は、この形でしか通らない
    // （2026-10-24 ユーザー選択「延長と言う (Recommended)」）。前回の等級は今回と同じにする —— 実電文も
    // 予報が続いている間は `LastKind` が予報を指す。期限は延ばした分だけ後ろへずれる（失効で消える確認も兼ねる）。
    {
      file: NOTO_TSUNAMI.forecastWithExpiry, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS / 2 + TSUNAMI_EXPIRY_EXTEND_AT_MS,
      rewrite: xml => editXml(xml, (doc) => {
        for (const category of descendants(doc, 'Category')) {
          const kind = childOf(category, 'Kind')
          const last = childOf(category, 'LastKind')
          if (!kind || !last) continue
          childOf(last, 'Name')!.textContent = childText(kind, 'Name') ?? ''
          childOf(last, 'Code')!.textContent = childText(kind, 'Code') ?? ''
        }
        const created = Date.parse(childText(only(doc, 'Control'), 'DateTime') ?? '')
        const report = Date.parse(childText(only(doc, 'Head'), 'ReportDateTime') ?? '')
        if (!Number.isFinite(created) || !Number.isFinite(report)) throw new Error('テスト用の電文の時刻を読めません')
        setIssueTime(doc, new Date(created + TSUNAMI_EXPIRY_EXTEND_AT_MS).toISOString())
        const expireAt = report + TSUNAMI_DISMISS_MS / 2 + TSUNAMI_EXPIRY_AFTER_MS + TSUNAMI_EXPIRY_EXTEND_BY_MS
        only(doc, 'ValidDateTime').textContent = `${new Date(expireAt).toISOString().slice(0, 19)}+00:00`
      }),
    },
  ],
}


/**
 * 区域の等級変化テスト（能登本震の実電文の並び）。DMDSS 版のみ（前回の等級 `LastKind` は P2PQuake が
 * 配信しない）。
 *
 *   1. 16:12 津波警報
 *   2. 16:22 石川県能登を大津波警報へ引き上げ（ほかの区域も注意報 → 警報へ）
 *   3. 16:23 満潮時刻の情報（**等級について何も言っていない報**。「〇〇から引き上げ」の印がこの報で
 *      消えないことを確かめる）
 *   4. 20:30 大津波警報を津波警報へ引き下げ
 *   5. 片付けの全区域解除
 */
export const TSUNAMI_GRADE_CHANGE: TestTelegramScript = {
  anchor: 4,
  steps: [
    { file: NOTO_TSUNAMI.warning, headType: 'VTSE41', atMs: 0 },
    { file: NOTO_TSUNAMI.upgrade, headType: 'VTSE41', atMs: 15_000 },
    { file: NOTO_TSUNAMI.tide2, headType: 'VTSE51', atMs: 30_000 },
    { file: NOTO_TSUNAMI.downgrade, headType: 'VTSE41', atMs: 60_000 },
    { file: NOTO_TSUNAMI.downgrade, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS, rewrite: liftedAfter(120) },
  ],
}

/**
 * 原因地震の追加テスト（2015-11-14 薩摩半島西方沖の実電文の並び）。DMDSS 版のみ。
 *
 *   1. 05:56 津波注意報（`EventID` = A）
 *   2. 05:59 地震 A の震源・震度に関する情報
 *   3. 06:22 地震 B の震源・震度に関する情報
 *   4. 06:55 津波観測に関する情報（**`EventID` = 「A B」・原因地震 2 件**）
 *   5. 07:20 全区域の解除（実電文）
 *
 * **確かめるもの**: カードが別の津波に入れ替わらないこと／バナーに原因地震が 2 件並び、どちらからも
 * 地震情報へ移れること／読み上げが 2 つ目の震源を伝えること。
 */
export const TSUNAMI_SOURCE_ADDED: TestTelegramScript = {
  anchor: 4,
  steps: [
    { file: SATSUMA.watch, headType: 'VTSE41', atMs: 0 },
    { file: SATSUMA.quakeA, headType: 'VXSE53', atMs: 3000 },
    { file: SATSUMA.quakeB, headType: 'VXSE53', atMs: 30_000 },
    { file: SATSUMA.observationAB, headType: 'VTSE51', atMs: 60_000 },
    { file: SATSUMA.lift, headType: 'VTSE41', atMs: 120_000 },
  ],
}

/**
 * 津波の誤報取消テスト（薩摩半島西方沖の津波注意報 → その取消）。
 *
 * 取消の電文は気象庁のサンプル（2021-08-05 の津波注意報の取消 38-39_03_01）。題名は同じ
 * 「津波注意報・津波予報」なので、**事象の識別子と発表時刻だけを**元にした報へ付け替える
 * （→ `moveToEvent`）。
 */
export const TSUNAMI_RETRACTION: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: SATSUMA.watch, headType: 'VTSE41', atMs: 0 },
    {
      file: sample('38-39_03_01_210805_VTSE41'), headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS,
      rewrite: xml => editXml(xml, doc => moveToEvent(doc, SATSUMA_EVENT_ID, isoZ(SATSUMA_WATCH_CONTROL_MS + 180_000))),
    },
  ],
}

/**
 * 津波情報だけが取り消されるテスト（DMDSS 版のみ）。**取消は情報名称ごとに効く**ので、津波注意報は
 * 残り、津波情報が運んだ内容だけが消える（→ docs/spec/tsunami-spec.md）。
 *
 *   1. 05:56 津波注意報  2. 05:58 満潮時刻の情報  3. その取消（サンプル 38-39_03_02 を付け替え）
 *   4. 片付けの全区域解除
 */
export const TSUNAMI_INFO_RETRACTION: TestTelegramScript = {
  anchor: 3,
  steps: [
    { file: SATSUMA.watch, headType: 'VTSE41', atMs: 0 },
    { file: SATSUMA.tide, headType: 'VTSE51', atMs: 3000 },
    {
      file: sample('38-39_03_02_210805_VTSE51'), headType: 'VTSE51', atMs: 30_000,
      rewrite: xml => editXml(xml, doc => moveToEvent(doc, SATSUMA_EVENT_ID, isoZ(SATSUMA_WATCH_CONTROL_MS + 120_000))),
    },
    { file: SATSUMA.watch, headType: 'VTSE41', atMs: TSUNAMI_DISMISS_MS, rewrite: liftedAfter(180) },
  ],
}

// ───────────────────────── 南海トラフ・後発地震・お知らせ・地震回数・長周期 ─────────────────────────

/** 2024-08-08 の南海トラフ地震臨時情報（実電文）。 */
const NANKAI = {
  /** 17:00 調査中。 */
  checking: nii('20240808080035_0_VYSE50_010000'),
  /** 19:15 巨大地震注意。 */
  watch: nii('20240808101516_0_VYSE50_010000'),
}

/** 南海トラフ地震臨時情報（調査中）テスト（2024-08-08 17:00 の実電文）。 */
export const NANKAI_CHECKING: TestTelegramScript = { anchor: 0, steps: [{ file: NANKAI.checking, headType: 'VYSE50', atMs: 0 }] }

/** 南海トラフ地震臨時情報（巨大地震注意）テスト（2024-08-08 19:15 の実電文）。 */
export const NANKAI_WATCH: TestTelegramScript = { anchor: 0, steps: [{ file: NANKAI.watch, headType: 'VYSE50', atMs: 0 }] }

/** 南海トラフ地震臨時情報（巨大地震警戒）テスト。**発表された例が無い**ので気象庁のサンプル電文（74_01_04）。 */
export const NANKAI_WARNING: TestTelegramScript = {
  anchor: 0, steps: [{ file: sample('74_01_04_200512_VYSE50'), headType: 'VYSE50', atMs: 0 }],
}

/**
 * 南海トラフ地震臨時情報の取消テスト（調査中 → その取消）。
 *
 * 取消は気象庁のサンプル（2022-03-18 の「調査中」の取消 74_03_01）を、2024-08-08 の調査中へ付け替える。
 * **取消は対象と同じ `EventID` で届く**（情報単位を指すため。電文解説資料 Ⅰ.別紙ウ）。文中の
 * 「１８日１９時３６分に発表した」も対象の発表時刻へ直す。
 */
export const NANKAI_RETRACTION: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: NANKAI.checking, headType: 'VYSE50', atMs: 0 },
    {
      file: sample('74_03_01_220318_VYSE50'), headType: 'VYSE50', atMs: TSUNAMI_DISMISS_MS,
      rewrite: xml => editXml(
        xml.split('１８日１９時３６分').join('８日１７時００分'),
        doc => moveToEvent(doc, '20240808170000', isoZ(Date.parse('2024-08-08T08:00:32Z') + 180_000)),
      ),
    },
  ],
}

/** 南海トラフ地震関連解説情報（臨時解説）テスト（2024-08-15 第７号の実電文）。 */
export const NANKAI_COMMENTARY_AD_HOC: TestTelegramScript = {
  anchor: 0, steps: [{ file: nii('20240815080252_0_VYSE51_010000'), headType: 'VYSE51', atMs: 0 }],
}

/**
 * 南海トラフ地震関連解説情報の取消テスト。臨時解説（上と同じ実電文）を出し、90 秒後に同じ号の取消を流す
 * （2026-10-24 ユーザー選択「足す (Recommended)」）。**解説情報の取消は実配信にも公式サンプルにも標本が無い**ので、
 * 取消の形は書き換え部品（`toCancelForm`）で作る。本文が宣言だけになるため、読み上げは「取り消されました」の後に
 * 宣言を二度述べる（2026-10-24 ユーザー選択「規約どおり残す (Recommended)」。→ ttsText.ts の `CANCEL_DECLARATION_SUBJECTS`）。
 */
export const NANKAI_COMMENTARY_RETRACTION: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: nii('20240815080252_0_VYSE51_010000'), headType: 'VYSE51', atMs: 0 },
    {
      file: nii('20240815080252_0_VYSE51_010000'), headType: 'VYSE51', atMs: TSUNAMI_DISMISS_MS,
      rewrite: xml => editXml(xml, (doc) => {
        toCancelForm(doc, '南海トラフ地震関連解説情報')
        shiftIssueTime(doc, 180)
      }),
    },
  ],
}

/** 南海トラフ地震関連解説情報（定例解説）テスト（2026-09-07 第109回の実電文）。 */
export const NANKAI_COMMENTARY_ROUTINE: TestTelegramScript = {
  anchor: 0, steps: [{ file: nii('20260907080008_0_VYSE52_010000'), headType: 'VYSE52', atMs: 0 }],
}

const KOHATSU_SAMPLE = sample('80_01_01_260917_VYSE60')

/** 北海道・三陸沖後発地震注意情報テスト（気象庁のサンプル電文 80_01_01）。 */
export const KOHATSU: TestTelegramScript = { anchor: 0, steps: [{ file: KOHATSU_SAMPLE, headType: 'VYSE60', atMs: 0 }] }

/**
 * 後発地震注意情報の取消テスト。**取消のサンプル電文が無い**ので、ほかの種別の取消と同じ形
 * （→ `toCancelForm`）で作る。
 */
export const KOHATSU_RETRACTION: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: KOHATSU_SAMPLE, headType: 'VYSE60', atMs: 0 },
    {
      file: KOHATSU_SAMPLE, headType: 'VYSE60', atMs: TSUNAMI_DISMISS_MS,
      rewrite: xml => editXml(xml, (doc) => {
        toCancelForm(doc, '北海道・三陸沖後発地震注意情報')
        shiftIssueTime(doc, 180)
      }),
    },
  ],
}

/** お知らせの自由付加文。電文解説資料 Ⅱ.51 の事例の文（サンプル電文は持たない）。 */
const QUAKE_NOTICE_FREE_TEXT = '保守点検の時刻が変更になりました。'

/**
 * 地震・津波に関するお知らせテスト（気象庁のサンプル電文 42_01_01＝沖縄県の震度データ入電停止）。
 *
 * **自由付加文を足す**（電文解説資料 Ⅱ.51 の事例の文）。サンプルは持たないが、本文の後に続けて出る・
 * 続けて読まれる形を確かめる入口がほかに無い。置いたサンプルからは問い合わせ先（氏名と電話番号）の
 * 段落を外してある（→ `public/data/test-telegrams/README.md`）。
 */
export const QUAKE_NOTICE: TestTelegramScript = {
  anchor: 0,
  steps: [{
    file: sample('42_01_01_100514_VZSE40'), headType: 'VZSE40', atMs: 0,
    rewrite: xml => editXml(xml, (doc) => {
      const body = only(doc, 'Body')
      const comments = doc.createElementNS(body.namespaceURI, 'Comments')
      const free = doc.createElementNS(body.namespaceURI, 'FreeFormComment')
      free.textContent = QUAKE_NOTICE_FREE_TEXT
      comments.appendChild(free)
      body.appendChild(comments)
    }),
  }],
}

const QUAKE_COUNT_SAMPLE = sample('32-35_03_01_100514_VXSE60')

/**
 * 地震回数に関する情報テスト（気象庁のサンプル電文 32-35_03_01＝2008 年の伊豆半島東方沖の群発）。
 *
 * **回数（`Number`）を全区間「発表なし」（`-1`）に替える。** 電文解説資料 Ⅱ.35 の事例がこの形で、
 * 実配信で起きうるいちばん崩れやすい形（帯に「-1回」、読み上げで「マイナス1回」と出ていた）を
 * 確かめる入口がほかに無い。有感回数（`FeltNumber`）はサンプルのまま。
 */
export const EARTHQUAKE_COUNT: TestTelegramScript = {
  anchor: 0,
  steps: [{
    file: QUAKE_COUNT_SAMPLE, headType: 'VXSE60', atMs: 0,
    rewrite: xml => editXml(xml, (doc) => {
      const numbers = descendants(doc, 'Number')
      if (numbers.length === 0) throw new Error('テスト用の電文に回数（Number）がありません')
      for (const n of numbers) n.textContent = '-1'
    }),
  }],
}

/** 地震回数に関する情報の取消テスト（取消は気象庁のサンプル 32-35_10_02 を付け替える）。 */
export const EARTHQUAKE_COUNT_RETRACTION: TestTelegramScript = {
  anchor: 1,
  steps: [
    EARTHQUAKE_COUNT.steps[0],
    {
      file: sample('32-35_10_02_220510_VXSE60'), headType: 'VXSE60', atMs: TSUNAMI_DISMISS_MS,
      rewrite: xml => editXml(xml, doc => moveToEvent(doc, '20080824150500', isoZ(Date.parse('2008-08-26T03:00:15Z') + 180_000))),
    },
  ],
}

/**
 * 長周期地震動の取消テスト（地震テストと同じ地震情報・長周期地震動 → その長周期の取消）。DMDSS 版のみ。
 * **取消のサンプル電文が無い**ので、ほかの種別の取消と同じ形（→ `toCancelForm`）で作る。
 */
export const LPGM_RETRACTION: TestTelegramScript = {
  anchor: 2,
  steps: [
    { file: NOTO.detail2, headType: 'VXSE53', atMs: 0 },
    { file: NOTO.lpgm, headType: 'VXSE62', atMs: 0, rewrite: markFirstLgStation },
    {
      file: NOTO.lpgm, headType: 'VXSE62', atMs: TSUNAMI_DISMISS_MS,
      rewrite: xml => editXml(xml, (doc) => {
        toCancelForm(doc, '長周期地震動に関する観測情報')
        shiftIssueTime(doc, 180)
      }),
    },
  ],
}

/**
 * 階級 0 の長周期地震動の観測情報を、佐渡付近の地震（2024-01-01 23:04・M4.6・最大震度3。→ `SADO`）へ付けて流す。DMDSS 版のみ。
 *
 * **階級 0 の報の標本は無い。** 全期間のアーカイブ（2020-11〜2026-10 の 68 通・1,032 地点）に、最大階級 0 の報も
 * 階級 0 の観測点も 1 件も無い。資料の値域は 0〜4 で 0 は来うるので、画面に残すと決めた
 * （2026-10-22 ユーザー選択「画面には残す (Recommended)」・ボタンは 2026-10-24 選択「ボタンを足す (Recommended)」）。
 * **そこに無い形は実機で一度も画面に出ない**ので、能登本震の長周期の電文（→ `NOTO.lpgm`）を書き換えて作る。
 *
 * 書き換えるもの（震度 3 の地震に震度 7 の値が残ると、画面で食い違って見える）:
 * - 階級（全国・県・区域・観測点・周期帯ごと）をすべて 0 にし、観測情報の種類（`LgCategory`）を外す
 *   （種類の定義は最大階級が 1 以上の場合しか無い。→ docs/spec/quake-spec.md §8）
 * - 震度を佐渡付近の地震の最大（3）で頭打ちにする
 * - 地震の要素（時刻・震源・規模）を佐渡付近の地震の値へ替え、`EventID` を移す（地震カードへ付くように）
 * - 見出しの構造化（`Information`。階級ごとの区域の一覧）を外し、文を空にする
 *
 * **応答スペクトル（`Sva`）は能登本震の値のまま。** アプリは値の大きさを階級と突き合わせないので、
 * 画面の経路（地図の吹き出しの周期帯の表）を通すことだけが目的のこのテストでは替えていない。
 */
export const LPGM_CLASS_ZERO: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: SADO.detail, headType: 'VXSE53', atMs: 0 },
    {
      file: NOTO.lpgm, headType: 'VXSE62', atMs: 0,
      rewrite: xml => editXml(xml, (doc) => {
        moveToEvent(doc, SADO_EVENT_ID, isoZ(Date.parse('2024-01-01T14:14:10Z') + 60_000))
        for (const tag of ['MaxLgInt', 'LgInt']) {
          for (const el of descendants(doc, tag)) el.textContent = '0'
        }
        for (const el of descendants(doc, 'LgIntPerPeriod')) el.textContent = '0'
        for (const el of descendants(doc, 'LgCategory')) el.parentNode?.removeChild(el)
        const cap = INT_ORDER.indexOf('3')
        for (const tag of ['MaxInt', 'Int']) {
          for (const el of descendants(doc, tag)) {
            if (INT_ORDER.indexOf((el.textContent ?? '').trim() as typeof INT_ORDER[number]) > cap) el.textContent = '3'
          }
        }
        const quake = only(doc, 'Earthquake')
        childOf(quake, 'OriginTime')!.textContent = '2024-01-01T23:03:00+09:00'
        childOf(quake, 'ArrivalTime')!.textContent = '2024-01-01T23:03:00+09:00'
        const area = only(quake, 'Area')
        childOf(area, 'Name')!.textContent = '佐渡付近'
        childOf(area, 'Code')!.textContent = '498'
        const coord = only(area, 'Coordinate')
        coord.textContent = '+37.7+137.7-10000/'
        coord.setAttribute('description', '北緯３７．７度　東経１３７．７度　深さ　１０ｋｍ')
        for (const tag of ['NameFromMark', 'MarkCode', 'Direction', 'Distance']) {
          const el = childOf(area, tag)
          if (el) area.removeChild(el)
        }
        const magnitude = only(quake, 'Magnitude')
        magnitude.textContent = '4.6'
        magnitude.setAttribute('description', 'Ｍ４．６')
        const headline = childOf(only(doc, 'Head'), 'Headline')!
        for (const el of descendants(headline, 'Information')) headline.removeChild(el)
        // 見出しの文は能登本震の階級を述べているので空にする（気象庁の文面を作らない。画面には出ない要素）
        setHeadlineText(doc, '')
      }),
    },
  ],
}

/**
 * 長周期地震動の観測情報の種類（`LgCategory`）1・3 の実電文を流す。DMDSS 版のみ。
 *
 * 種類 1・3 にも一文を出すと決めたが（2026-10-22 ユーザー選択「1・3 にも一文を出す (Recommended)」）、収録していた
 * 長周期は能登本震の種類 4 だけで、画面で確かめる入口が無かった（ボタンは 2026-10-24 選択「ボタンを足す (Recommended)」）。
 * どちらも国立情報学研究所の実電文で、書き換えない。
 *
 * - 種類 1: 2024-01-01 16:56 石川県能登地方 M5.7・最大震度5強（最大階級 2）
 * - 種類 3: 2024-08-08 16:42 日向灘 M7.1・最大震度6弱（最大階級 3）
 *
 * **時刻のずらし方は 1 つの差分**（→ `TestTelegramScript.anchor`）なので、基準にした日向灘の地震が「いま」になり、
 * 能登の地震は実電文の差のまま約 7 か月前に置かれる。
 */
export const LPGM_CATEGORIES: TestTelegramScript = {
  anchor: 2,
  steps: [
    { file: nii('20240101080010_0_VXSE53_270000'), headType: 'VXSE53', atMs: 0 },
    { file: nii('20240101080522_0_VXSE62_010000'), headType: 'VXSE62', atMs: 0 },
    { file: nii('20240808075502_0_VXSE53_010000'), headType: 'VXSE53', atMs: 3000 },
    { file: nii('20240808075139_0_VXSE62_010000'), headType: 'VXSE62', atMs: 3000 },
  ],
}

/** 2024-01-01 16:56 石川県能登地方 M5.7 の長周期地震動に関する観測情報（最大階級 2・種類 1。→ `LPGM_CATEGORIES`）。 */
const NOTO_1656_LPGM = nii('20240101080522_0_VXSE62_010000')

/**
 * 階級 0 の区域「富山県東部」を、16:56 の報（最大階級 2）に書き足す。
 *
 * **階級 1 以上の報に階級 0 の区域が混ざる形の標本は無い**（全期間の 68 通で、階級 0 の県・区域・観測点は 0 件）。
 * 読み上げは他の階級と同じ設定で数える（2026-10-29 ユーザー承認「他の階級と同じく読む」）ので、その形をここで作る。
 * 震度 3 は同じ地震の地震情報（`20240101080010_0_VXSE53_270000`）の富山県東部の値。観測点は足さない。
 */
function withClassZeroRegion(doc: Document): void {
  const observation = only(only(doc, 'Intensity'), 'Observation')
  const pref = el(doc, observation, 'Pref', '')
  for (const [name, value] of [['Name', '富山県'], ['Code', '16'], ['MaxInt', '3'], ['MaxLgInt', '0']] as const) {
    pref.appendChild(el(doc, observation, name, value))
  }
  const area = el(doc, observation, 'Area', '')
  for (const [name, value] of [['Name', '富山県東部'], ['Code', '380'], ['MaxInt', '3'], ['MaxLgInt', '0']] as const) {
    area.appendChild(el(doc, observation, name, value))
  }
  pref.appendChild(area)
  observation.appendChild(pref)
}

/**
 * 階級 0 の地域が混ざった長周期地震動の観測情報と、その続報を流す。DMDSS 版のみ。
 *
 * - 1 通目: 16:56 の報に階級 0 の区域を書き足したもの（→ {@link withClassZeroRegion}）。読み上げで階級 0 の地域も声になる
 * - 2 通目（3 秒後）: 1 通目の規模を Mj5.7 → Mj5.8 に書き換え、報番号を進めた続報。長周期の欄の規模に更新の印が付く
 *   （2026-10-29 ユーザー承認「続報も流す (Recommended)」）
 *
 * **長周期の続報の標本は無い**（全期間の控えに 1 通も無い。→ `JMALpgm.reportsRevise`）ので、続報は書き換えで作る。
 * 規模を変えたのは、長周期の欄の値のうち続報で動きうるものを 1 つ動かして印を見せるため（実配信で規模がこう動くと言っているのではない）。
 */
export const LPGM_CLASS_ZERO_REGION: TestTelegramScript = {
  anchor: 1,
  steps: [
    { file: nii('20240101080010_0_VXSE53_270000'), headType: 'VXSE53', atMs: 0 },
    { file: NOTO_1656_LPGM, headType: 'VXSE62', atMs: 0, rewrite: xml => editXml(xml, withClassZeroRegion) },
    {
      file: NOTO_1656_LPGM, headType: 'VXSE62', atMs: 3000,
      rewrite: xml => editXml(xml, (doc) => {
        withClassZeroRegion(doc)
        setSectionText(doc, 'Head', 'Serial', '2')
        // 届く間隔（3 秒）と同じだけ進める。それより進めると、届く前に発表された報になる
        shiftIssueTime(doc, 3)
        const magnitude = only(only(doc, 'Earthquake'), 'Magnitude')
        magnitude.textContent = '5.8'
        magnitude.setAttribute('description', 'Ｍ５．８')
      }),
    },
  ],
}

// ───────────────────────── 緊急地震速報 ─────────────────────────

/**
 * 2024-04-17 23:14 豊後水道 M6.6 の緊急地震速報（気象庁のサンプル電文 77_01_01〜33。**予報 →
 * 警報 → 特別警報相当 → 取消**と 33 通そろっている）。
 *
 * | 報 | 区分 | 予想最大震度 | 区域 |
 * |---|---|---|---|
 * | 1〜2 | 予報 | 3 | 0 |
 * | 3 | 予報 | 4 | 1 |
 * | 4 | 警報 | 5弱 | 9 |
 * | 9 | 警報 | 5強 | 27 |
 * | 12 | 警報（**特別警報相当** = 震度6弱以上） | 6弱 | 41 |
 * | 33 | 取消 | – | – |
 */
const BUNGO = (n: number) => sample(`77_01_${String(n).padStart(2, '0')}_240613_VXSE45`)

/** 緊急地震速報のテストで、押されないまま最終報を流すまで（ミリ秒）。 */
export const EEW_FINAL_SILENCE_MS = 10_000

/** 遅れた誤報取消テストで、自動解除からこの長さだけ置いてから取消を流す（ミリ秒）。 */
export const EEW_LATE_RETRACTION_AFTER_EXPIRY_MS = 10_000

/**
 * 取消の報を、**直前の報のすぐ後ろ**へ置き直す。
 *
 * **サンプルの取消（第 33 通・14:17:00Z）は、第 9 報（14:15:02Z）の 118 秒後**。押すたびに進む
 * テストでは最後の押下から 10 秒で取消が届くので、そのままだと**発表時刻が 2 分先の報**になる
 * （実配信に無い形で、カードの時刻も先の時刻で出る）。
 *
 * @param seconds 元の時刻から戻す秒数（負の値で手前へ寄せる）
 */
const shiftIssue = (seconds: number) => (xml: string) => editXml(xml, doc => shiftIssueTime(doc, seconds))

/** 最後の報を最終報にする書き換え（`Body/NextAdvisory` に実電文の文言を足す）。 */
const asFinal = (serial: number, seconds: number) => (xml: string) => editXml(xml, (doc) => {
  setSectionText(doc, 'Head', 'Serial', String(serial))
  shiftIssueTime(doc, seconds)
  toFinalEew(doc)
})

/**
 * 予報テスト（サンプルの第 1〜3 報。**予報のまま**で、区域なし → 1 区域・震度3 → 4 と動く）。
 * 押すたびに 1 通進み、10 秒黙ると最終報。
 */
export const EEW_FORECAST: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    { file: BUNGO(1), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(2), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0, rewrite: asFinal(4, 2) },
  ],
}

/**
 * 警報テスト（サンプルの第 1〜9 報のうち 4 通。**予報 → 警報の格上げ**を含み、特別警報には
 * ならない範囲（震度5弱 → 5強）で止める）。
 */
export const EEW_WARNING: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(4), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(5), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0, rewrite: asFinal(10, 2) },
  ],
}

/**
 * 特別警報テスト（サンプルの第 3〜12 報のうち 5 通。**震度6弱まで上がる** ので、アプリの線引き
 * （震度6弱以上または長周期階級4以上。→ `utils/eew.ts` の `isSpecialWarningForecast`）で
 * 特別警報相当になる）。
 */
export const EEW_SPECIAL_WARNING: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(4), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(12), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(17), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(17), headType: 'VXSE45', atMs: 0, rewrite: asFinal(18, 2) },
  ],
}

/**
 * 誤報取消テスト（サンプルの第 1〜4 報 → **実電文の取消**（第 33 通））。
 * 取消は押すたびではなく、最後の報から `EEW_FINAL_SILENCE_MS` 後（黙ったとき）に届く。
 */
export const EEW_RETRACTION: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS, cancelIndex: 3 },
  steps: [
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(4), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0 },
    // 直前は第 9 報（14:15:02Z）。取消をその 2 秒後へ寄せる（118 - 2 = 116 秒戻す）
    { file: BUNGO(33), headType: 'VXSE45', atMs: 0, rewrite: shiftIssue(-116) },
  ],
}

/**
 * 遅れた誤報取消テスト（**最終報 → 自動解除で画面から消えた後に取消**）。
 *
 * **押すたびには進まない。** 1 通目で最終報まで飛ばし、アプリが自動解除する時刻を待ってから
 * 取消を流す（待つ長さはアプリ側が `calcEEWCancelTime` で求める。→ `useEarthquakes.ts` の
 * `simulateEEWLateRetraction`）。台本は 2 通を持つだけで、間隔は持たない。
 */
export const EEW_LATE_RETRACTION: TestTelegramScript = {
  anchor: 0,
  pacedByApp: true,
  steps: [
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0, rewrite: asFinal(10, 2) },
    // 取消は、最終報（第 9 報の 2 秒後）のさらに 2 秒後へ寄せる（118 - 4 = 114 秒戻す）
    { file: BUNGO(33), headType: 'VXSE45', atMs: 0, rewrite: shiftIssue(-114) },
  ],
}

/** 仮定震源要素の報が名乗る震源（気象庁は観測点直下・深さ 10km・M1.0 を入れる。→ eew-spec.md §5）。 */
const ASSUMED_HYPOCENTER = {
  lat: '+33.1', lon: '+132.4', depth: '-10000', magnitude: '1.0', description: 'Ｍ１．０',
  // 震央・深さはランク 1（1 点で決めた）、規模はランク 8（仮定震源要素）。→ `setEewAccuracy`
  // `rank2` も 1 に揃える（全期間の控えで、`rank` が 1〜4 の報の `rank2` は必ず同じ値か 9）。
  accuracy: { epicenter: 1, epicenterRank2: 1, depth: 1, magnitude: 8, points: 0 },
}

/**
 * 緊急地震速報の震源要素を書き換える。**仮定震源要素・深発地震の形を作るのに使う** ——
 * サンプルにこの 2 つの形が無いため（2026-10-22 ユーザー選択「実電文を書き換えて足す」）。
 */
function setEewHypocenter(doc: Document, v: { lat: string; lon: string; depth: string; magnitude: string; description: string; condition?: string; name?: string; code?: string; accuracy?: EewAccuracyRewrite }): void {
  const coordinate = descendants(doc, 'Coordinate')[0]
  if (!coordinate) throw new Error('テスト用の電文に震源の座標がありません')
  const depthKm = Math.round(Math.abs(Number(v.depth)) / 1000)
  coordinate.textContent = `${v.lat}${v.lon}${v.depth}/`
  coordinate.setAttribute('description', `北緯${v.lat.slice(1)}度　東経${v.lon.slice(1)}度　深さ　${depthKm}ｋｍ`)
  const magnitude = descendants(doc, 'Magnitude')[0]
  if (!magnitude) throw new Error('テスト用の電文に規模がありません')
  magnitude.textContent = v.magnitude
  magnitude.setAttribute('description', v.description)
  if (v.name) {
    const area = descendants(doc, 'Hypocenter')[0]
    const name = area && descendants(area, 'Name')[0]
    if (!name) throw new Error('テスト用の電文に震央地名がありません')
    name.textContent = v.name
    const code = descendants(area, 'Code')[0]
    if (v.code && code) code.textContent = v.code
    for (const reduce of descendants(area, 'ReduceName')) reduce.textContent = v.name
    // **短縮用震央地名コード（`ReduceCode`）は置き換えない** —— 置き換える先の正しい値の出どころが
    // 無い（気象庁のコード表に当たる必要がある）。アプリは読んで持つだけで画面には出さないので、
    // 元のまま残す。**画面に出す項目を足すときは、ここも埋めること。**
  }
  if (v.condition) {
    // **`Condition` は `Earthquake` の直下に置く。** 要素の位置で意味が変わり、`Hypocenter` の
    // 下へ置くと別の意味（区域の状況）になって震源の状態として読まれない
    // （→ `dmdataParser.ts`「`Condition` は要素の位置で意味が変わる」）。
    const eq = only(doc, 'Earthquake')
    const condition = doc.createElementNS(eq.namespaceURI, 'Condition')
    condition.textContent = v.condition
    eq.appendChild(condition)
  }
  if (v.accuracy) setEewAccuracy(doc, v.accuracy)
}

/** `setEewAccuracy` へ渡す精度の値。 */
interface EewAccuracyRewrite { epicenter: number; epicenterRank2: number; depth: number; magnitude: number; points: number }

/**
 * 震源要素の精度（`Accuracy`）を書き換える。
 *
 * **仮定震源要素は精度もその値になる** —— 震央・深さがランク 1（1 点で決めた）、規模がランク 8
 * （P波／S波レベル超え、または仮定震源要素）、計算に使った観測点は 0（→ docs/spec/eew-spec.md §3
 * 「震源要素の精度」）。元にしたサンプルの値（IPF 法 5 点以上）のまま震源だけ差し替えると、
 * **実配信に無い組み合わせ**になり、精度欄にも「単独点処理」の理由づけにも出ない。
 */
function setEewAccuracy(doc: Document, v: EewAccuracyRewrite): void {
  const accuracy = descendants(doc, 'Accuracy')[0]
  if (!accuracy) throw new Error('テスト用の電文に震源要素の精度がありません')
  const set = (tag: string, attr: string, value: number): void => {
    const el = descendants(accuracy, tag)[0]
    if (!el) throw new Error(`テスト用の電文の精度に ${tag} がありません`)
    el.setAttribute(attr, String(value))
  }
  set('Epicenter', 'rank', v.epicenter)
  set('Epicenter', 'rank2', v.epicenterRank2)
  set('Depth', 'rank', v.depth)
  set('MagnitudeCalculation', 'rank', v.magnitude)
  const points = descendants(accuracy, 'NumberOfMagnitudeCalculation')[0]
  if (points) points.textContent = String(v.points)
}

/** 予想震度の欄（`Intensity/Forecast` 直下の `ForecastInt`）を書き換える。 */
function setForecastInt(doc: Document, from: string, to: string): void {
  const forecast = descendants(doc, 'Forecast')[0]
  const int = forecast && Array.from(forecast.children).find(c => c.localName === 'ForecastInt')
  if (!int) throw new Error('テスト用の電文に予想最大震度がありません')
  childOf(int, 'From')!.textContent = from
  childOf(int, 'To')!.textContent = to
}

/**
 * 単独点処理テスト（**仮定震源要素の初報 → 震源が決まった続報**）。
 *
 * **サンプルに仮定震源要素の報が無い**ので、第 1 報を書き換えて作る（2026-10-22 ユーザー選択）。
 * 気象庁は観測点直下・深さ 10km・M1.0 という固定の仮定値を入れ、震源要素の `Condition` へ
 * 「仮定震源要素」と書く（→ docs/spec/eew-spec.md §5）。カードと地図はこれを見て M・深さ・
 * 予報円を隠す。続報（サンプルの第 4 報）で震源が確定し、警報へ上がる。
 */
export const EEW_ASSUMED: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    {
      file: BUNGO(1), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, doc => setEewHypocenter(doc, { ...ASSUMED_HYPOCENTER, condition: '仮定震源要素' })),
    },
    { file: BUNGO(4), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(9), headType: 'VXSE45', atMs: 0, rewrite: asFinal(10, 2) },
  ],
}

/**
 * 深発地震テスト（**深さ 450km**。サンプルの第 1 報を書き換えて作る）。
 *
 * 気象庁は深さ 150km を超える地震に、PLUM 法による 2 点以上の震度予測がある場合を除いて警報を
 * 発表しない（→ docs/spec/settings-pwa-spec.md §7）。この報は区域を持たないのでその例外に当たらず、
 * **予報のまま**で進む。2015-05-30 小笠原諸島西方沖（深さ 682km）を参考にした値。
 */
export const EEW_DEEP: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    {
      file: BUNGO(1), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, doc => setEewHypocenter(doc, {
        lat: '+27.9', lon: '+140.5', depth: '-450000', magnitude: '6.5', description: 'Ｍ６．５',
        name: '小笠原諸島西方沖', code: '439',
      })),
    },
    {
      file: BUNGO(2), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, doc => setEewHypocenter(doc, {
        lat: '+27.9', lon: '+140.5', depth: '-450000', magnitude: '6.8', description: 'Ｍ６．８',
        name: '小笠原諸島西方沖', code: '439',
      })),
    },
    {
      file: BUNGO(2), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, (doc) => {
        setEewHypocenter(doc, {
          lat: '+27.9', lon: '+140.5', depth: '-450000', magnitude: '6.8', description: 'Ｍ６．８',
          name: '小笠原諸島西方沖', code: '439',
        })
        setSectionText(doc, 'Head', 'Serial', '3')
        shiftIssueTime(doc, 2)
        toFinalEew(doc)
      }),
    },
  ],
}

/** 半角の数字を全角の 2 桁へ（電文の本文は全角で、時刻は 0 埋め。例「０６時３１分４２秒」）。 */
const toFullWidth = (n: number): string => String(n).padStart(2, '0').replace(/[0-9]/g, d => String.fromCharCode(d.charCodeAt(0) + 0xfee0))

/**
 * 「非常に強い揺れを検知」の報で、揺れを検知した観測点の所在地。
 *
 * **元にした地震（2024-04-17 豊後水道 M6.6）で震度6弱を観測した市町村**を置く。この形の電文は
 * 震央ではなく**観測点の所在地**を本文へ書くので、海域の震央地名（豊後水道）をそのまま使うと
 * 実配信に無い形になる。
 */
const STRONG_SHAKING_PLACE = '愛媛県愛南町付近'

/**
 * 「非常に強い揺れを検知」の形へ書き換える。
 *
 * **震源を決めずに予想震度だけを発表する報**で、見分けるのは `Earthquake/OriginTime` が
 * **要素ごと無い**こと（電文解説資料 Ⅱ.21 1-1「この場合、本要素は出現しない」）。あわせて
 * 規模も数値にしない —— パーサーは「発生時刻が無いのに規模が数値」なら**この形と見なさず**、
 * 確定した震源の報として扱う（→ `dmdataParser.ts` の `notThisForm`）。
 *
 * **本文は実電文の形**（日時・場所・最大震度。→ docs/spec/eew-spec.md §5）。この文が検知した
 * 時刻と場所を伝える唯一の口なので、定型の一文へ置き換えると画面に出るものが実物と変わる。
 */
function toStrongShaking(doc: Document, now: Date): void {
  const eq = only(doc, 'Earthquake')
  childOf(eq, 'OriginTime')?.remove()
  const magnitude = descendants(doc, 'Magnitude')[0]
  if (!magnitude) throw new Error('テスト用の電文に規模がありません')
  magnitude.textContent = 'NaN'
  magnitude.setAttribute('condition', '不明')
  magnitude.setAttribute('description', 'Ｍ不明')
  const body = only(doc, 'Body')
  const text = doc.createElementNS(body.namespaceURI, 'Text')
  // 「２３日０３時００分００秒頃\n愛媛県愛南町付近　　　　　最大震度５弱程度以上と推定」（日本時間）。
  // **日時は押した時刻から作る。** 電文の時刻は後で「いま」へ寄せるが、本文はその寄せを受けない
  // —— サンプルの日時のまま残すと、発表時刻だけが今日で本文だけが 2024 年のものになる。
  const jst = new Date(now.getTime() + 9 * 3600_000)
  const stamp = `${toFullWidth(jst.getUTCDate())}日${toFullWidth(jst.getUTCHours())}時${toFullWidth(jst.getUTCMinutes())}分${toFullWidth(jst.getUTCSeconds())}秒頃`
  text.textContent = `${stamp}\n${STRONG_SHAKING_PLACE}　　　　　最大震度５弱程度以上と推定`
  body.appendChild(text)
}

/**
 * 強い揺れ検知テスト（**「非常に強い揺れを検知」の報 → 震源が決まった続報**）。
 *
 * 1 点の観測で強い揺れを検知したとき、気象庁は**震源を決めないまま予想震度だけ**を発表する。
 * カードは震源・規模・発生時刻を隠し、震度だけを出す（→ docs/spec/eew-spec.md §5）。
 * **サンプルに無い形**なので、第 1 報を書き換えて作る（→ `toStrongShaking`）。
 */
export const EEW_STRONG_SHAKING: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    {
      file: BUNGO(1), headType: 'VXSE45', atMs: 0,
      rewrite: (xml, { now }) => editXml(xml, (doc) => {
        toStrongShaking(doc, now)
        // **上限を定めない予想**（`over`）。この形の報は「５弱程度以上」と発表するので、
        // 上限を `5-` で閉じると「程度以上」の表示・読み上げの経路が実機で一度も通らない
        // （→ docs/spec/eew-spec.md §4「上限を定めない予想の扱い」）。
        setForecastInt(doc, '5-', 'over')
      }),
    },
    { file: BUNGO(4), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(4), headType: 'VXSE45', atMs: 0, rewrite: asFinal(5, 2) },
  ],
}

/**
 * 予想震度なしテスト（**予想震度の欄そのものが無い報**）。
 *
 * 震源は決まっているが予想震度が出ない形で、カードは「予想震度なし」と出す。**サンプルに無い**
 * ので、第 1 報から `Intensity` を丸ごと外して作る（気象庁もこの欄ごと落とす）。
 */
export const EEW_NO_FORECAST: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS, cancelIndex: 2 },
  steps: [
    {
      file: BUNGO(1), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, (doc) => { only(doc, 'Intensity').remove() }),
    },
    {
      file: BUNGO(2), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, (doc) => { only(doc, 'Intensity').remove() }),
    },
    // 直前は第 2 報（14:14:58Z）。取消をその 2 秒後へ寄せる（122 - 2 = 120 秒戻す）
    { file: BUNGO(33), headType: 'VXSE45', atMs: 0, rewrite: shiftIssue(-120) },
  ],
}

/**
 * 予想震度0テスト（**予想震度が 0 の報**）。震度1 未満の予想で、カードは「予想最大震度 0」と出す。
 * **サンプルに無い**ので、第 1 報の予想震度を 0 にして作る。
 */
/**
 * 予想震度0テストの最初の 2 報の精度。**`rank` と `rank2` が違う形**（震央が EPOS〔海域〕で、`rank2` が IPF法〔3点／4点〕）を、
 * 実配信でいちばん多い組のまま入れる（全期間の控えで `rank`=7・`rank2`=3 の報 135 通のうち 101 通がこの組。
 * 見本は 2022-07-31 の VXSE44 八丈島東方沖）。カードの精度の欄に `rank2` の行が出ることを確かめる入口。
 */
const FORECAST_ZERO_ACCURACY: EewAccuracyRewrite = { epicenter: 7, epicenterRank2: 3, depth: 7, magnitude: 6, points: 0 }

export const EEW_FORECAST_ZERO: TestTelegramScript = {
  anchor: 0,
  stepByPress: { silenceMs: EEW_FINAL_SILENCE_MS },
  steps: [
    {
      file: BUNGO(1), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, doc => { setForecastInt(doc, '0', '0'); setEewAccuracy(doc, FORECAST_ZERO_ACCURACY) }),
    },
    {
      file: BUNGO(2), headType: 'VXSE45', atMs: 0,
      rewrite: xml => editXml(xml, doc => { setForecastInt(doc, '0', '0'); setEewAccuracy(doc, FORECAST_ZERO_ACCURACY) }),
    },
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0 },
    { file: BUNGO(3), headType: 'VXSE45', atMs: 0, rewrite: asFinal(4, 2) },
  ],
}

// ───────────────────────── 推計震度分布図 ─────────────────────────

/** 推計震度分布図テストで、地震情報から分布を流すまで（ミリ秒）。実運用では数分後に届く。 */
export const ESTIMATED_INTENSITY_DELAY_MS = 5000
/** 分布の初報から続報まで（ミリ秒）。 */
export const ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS = 15_000
/** 続報のあと、同じ地震の地震情報を流すまで（ミリ秒。分布モードが閉じることを見る）。 */
export const ESTIMATED_INTENSITY_QUAKE_FOLLOW_UP_DELAY_MS = 15_000

/**
 * 推計震度分布図テスト。**地震情報 → 分布（初報 → 続報）→ 地震情報の続報**と流す。
 *
 * 実運用では地震から数分後に分布が届き、そのころ地震カードは既に画面にある。同時に流すと、
 * 分布モードを開く側がカードを見つけられない（**引き当ては発現時刻**で、探す先の一覧にまだ
 * 載っていない）。最後の地震情報は、分布モードが閉じて発表値へ戻ることを見るためのもの
 * （→ `utils/quakeOverlay.ts` の `closeDistributionOverlayOnQuakeReport`）。
 *
 * **分布だけは合成の二進電文**（`scripts/build-test-estimated-intensity-bufr.ts` が組む。
 * 2026-10-22 ユーザー選択「合成の二進電文を作る」）。この電文は BUFR で、国立情報学研究所の
 * アーカイブにも気象庁のサンプル電文集にも無い。**大きさは能登本震の実電文に合わせ**（続報は約 52 万
 * セル・最大は震度7）、**実配信と同じく 2 断片で流す**（2026-10-25 ユーザー選択「実物と同じ規模で
 * 作り直す (Recommended)」）。
 */
export const ESTIMATED_INTENSITY: TestTelegramScript = {
  anchor: 3,
  steps: [
    { file: NOTO.detail1, headType: 'VXSE53', atMs: 0 },
    {
      file: 'synthetic/estimated-intensity-1.bufr', headType: 'IXAC41', atMs: ESTIMATED_INTENSITY_DELAY_MS,
      continuations: [{ designation: 'RRA', file: 'synthetic/estimated-intensity-1.rra.bufr' }],
    },
    {
      file: 'synthetic/estimated-intensity-2.bufr', headType: 'IXAC41',
      atMs: ESTIMATED_INTENSITY_DELAY_MS + ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS,
      continuations: [{ designation: 'RRA', file: 'synthetic/estimated-intensity-2.rra.bufr' }],
    },
    {
      file: NOTO.detail2, headType: 'VXSE53',
      atMs: ESTIMATED_INTENSITY_DELAY_MS + ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS + ESTIMATED_INTENSITY_QUAKE_FOLLOW_UP_DELAY_MS,
    },
  ],
}

function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 台本の一覧（テストで全件を流して読めることを確かめる）。 */
export const ALL_TEST_TELEGRAM_SCRIPTS: Readonly<Record<string, TestTelegramScript>> = {
  EARTHQUAKE, TRAINING_QUAKE, UNRECEIVED_QUAKE, MAX_SCALE_OR_ABOVE_QUAKE, AREA_UNRECEIVED_QUAKE,
  FOREIGN_QUAKE, FOREIGN_QUAKE_HUGE, QUAKE_AMENDMENT, QUAKE_REPORT_SEQUENCE, QUAKE_CANCEL,
  QUAKE_PARTIAL_CANCEL, HYPOCENTER_FROM_TSUNAMI,
  TSUNAMI_MAJOR_WARNING, TSUNAMI_QUIET_REPORTS, TSUNAMI_WARNING, TSUNAMI_WATCH, TSUNAMI_FORECAST, TSUNAMI_EXPIRY, TSUNAMI_GRADE_CHANGE,
  TSUNAMI_SOURCE_ADDED, TSUNAMI_RETRACTION, TSUNAMI_INFO_RETRACTION,
  NANKAI_CHECKING, NANKAI_WATCH, NANKAI_WARNING, NANKAI_RETRACTION,
  NANKAI_COMMENTARY_AD_HOC, NANKAI_COMMENTARY_RETRACTION, NANKAI_COMMENTARY_ROUTINE, KOHATSU, KOHATSU_RETRACTION,
  QUAKE_NOTICE, EARTHQUAKE_COUNT, EARTHQUAKE_COUNT_RETRACTION, LPGM_RETRACTION, LPGM_CLASS_ZERO, LPGM_CATEGORIES, LPGM_CLASS_ZERO_REGION,
  EEW_FORECAST, EEW_WARNING, EEW_SPECIAL_WARNING, EEW_RETRACTION, EEW_LATE_RETRACTION, EEW_ASSUMED, EEW_DEEP,
  EEW_STRONG_SHAKING, EEW_NO_FORECAST, EEW_FORECAST_ZERO, ESTIMATED_INTENSITY,
}
