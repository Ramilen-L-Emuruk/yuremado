import { describe, it, expect, vi, beforeEach } from 'vitest'

// `log` だけ差し替える部分モック（`createFirstSeenLogGate` は本物を使う —— 間引きの挙動ごと
// 確かめたいため）。丸ごと置き換えると logger の export が増えた日にファイルごと落ちる。
const warnMock = vi.hoisted(() => vi.fn())
vi.mock('./logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: warnMock, error: vi.fn() },
}))

import { formatCoordinate, formatDepth, formatDomesticTsunami, formatMagnitude, formatMagnitudeCondition, formatMagnitudeValue, formatMagnitudeWithCondition, magnitudePrefix, magnitudeTypeLabel, formatNameFromMark, formatFileStamp, formatDateTime, formatDateTimeLocal, formatDateTimeMin, formatQuakeDateTime, formatQuakeTime, formatQuakeTimeLabeled, formatTime, formatTimeMin, hasHypocenterFacts, withNonJmaMark, NON_JMA_MARK } from './formatters'
import type { Hypocenter } from '../types/earthquake'
import { withTz } from '../test-utils/withTz'
import { getMagnitudeColor, getDepthColor } from './intensity'

// 規模・深さの色は文字表示（formatMagnitude / formatDepth）と同じ判定で「不明」を弾く必要がある。
// NaN は比較演算がすべて false になるため、ガードが無いと最終行（M7 以上＝紫）に落ちて
// 「不明」の文字の隣に最も深刻な色が付く、という文字と色の矛盾が起きる。
describe('色付けの不明ガード', () => {
  const UNKNOWN = '#666666'

  it('規模 NaN・負値は不明色（M7 以上の紫に落ちない）', () => {
    expect(getMagnitudeColor(Number.NaN)).toBe(UNKNOWN)
    expect(getMagnitudeColor(-1)).toBe(UNKNOWN)
    expect(getMagnitudeColor(7.4)).not.toBe(UNKNOWN)
  })

  it('深さ NaN・負値は不明色、0 は「ごく浅い」の色', () => {
    expect(getDepthColor(Number.NaN)).toBe(UNKNOWN)
    expect(getDepthColor(-1)).toBe(UNKNOWN)
    expect(getDepthColor(0)).not.toBe(UNKNOWN)
  })
})

describe('formatDepth', () => {
  it('depth=0 は "ごく浅い"', () => {
    expect(formatDepth(0, false)).toBe('ごく浅い')
  })
  it('負値は "不明"', () => {
    expect(formatDepth(-1, false)).toBe('不明')
  })
  it('通常値は "Nkm"', () => {
    expect(formatDepth(50, false)).toBe('50km')
  })
  it('NaN は "不明"', () => {
    expect(formatDepth(Number.NaN, false)).toBe('不明')
  })
  it('undefined 相当（Number 変換 NaN）は "不明"', () => {
    expect(formatDepth(Number(undefined), false)).toBe('不明')
  })
  // 「700km以上」（2026-10-19 ユーザー承認）。正・対照・安全弁を対にする
  it('下限だけの深さ（700km以上）は "700km以上"', () => {
    expect(formatDepth(700, true)).toBe('700km以上')
  })
  it('対照: 印が無ければ同じ 700 でも "700km"', () => {
    expect(formatDepth(700, false)).toBe('700km')
  })
  it('安全弁: 印があっても深さ不明は "不明"・ごく浅いは "ごく浅い" のまま', () => {
    expect(formatDepth(-1, true)).toBe('不明')
    expect(formatDepth(0, true)).toBe('ごく浅い')
  })
  it('Infinity は "不明"', () => {
    expect(formatDepth(Number.POSITIVE_INFINITY, false)).toBe('不明')
  })
})

describe('formatMagnitude', () => {
  it('負値は "不明"', () => {
    expect(formatMagnitude(-1, undefined)).toBe('不明')
  })
  it('通常値は "M X.Y"', () => {
    expect(formatMagnitude(5.3, undefined)).toBe('M5.3')
  })
  it('NaN は "不明"', () => {
    expect(formatMagnitude(Number.NaN, undefined)).toBe('不明')
  })
  it('undefined 相当（Number 変換 NaN）は "不明"', () => {
    expect(formatMagnitude(Number(undefined), undefined)).toBe('不明')
  })
  it('Infinity は "不明"', () => {
    expect(formatMagnitude(Number.POSITIVE_INFINITY, undefined)).toBe('不明')
  })
})

// 規模の前に置く記号は電文の種別（`jmx_eb:Magnitude@type`）をそのまま出す
// （2026-10-22 ユーザー承認「1-A 電文のまま」）。種別を持たない経路は従来どおり `M`。
describe('規模の種別（Mj／M）', () => {
  // 正: 電文の種別がそのまま前置きになる。
  it('電文の種別を前置きにする', () => {
    expect(formatMagnitude(3.5, 'Mj')).toBe('Mj3.5')
    expect(formatMagnitude(6.8, 'M')).toBe('M6.8')
    expect(formatMagnitudeWithCondition(3.5, undefined, 'Mj')).toBe('Mj3.5')
  })

  // 対照: 種別を持たない経路（P2PQuake・長期震源カタログ）は従来どおり `M`。
  it('種別が無ければ M', () => {
    expect(formatMagnitude(3.5, undefined)).toBe('M3.5')
    expect(magnitudePrefix(undefined)).toBe('M')
    expect(magnitudePrefix('')).toBe('M')
  })

  // 安全弁: **知らない値も丸めずにそのまま出す。** `M` へ寄せると、気象庁が種別を増やしたときに
  // 発表と違う記号を出すことになる。
  it('知らない種別もそのまま出す', () => {
    expect(formatMagnitude(7.0, 'Mw')).toBe('Mw7.0')
    expect(magnitudePrefix('mb')).toBe('mb')
  })

  // 正: 見出しが「マグニチュード」で記号を置けない欄は、語で添える。
  it('語を当てるのは Mj だけ', () => {
    expect(magnitudeTypeLabel('Mj')).toBe('気象庁マグニチュード')
  })

  // 対照: **`M` には語を添えない**（2026-10-23 ユーザー承認「資料の裏付けがある分だけ」）。
  // 気象庁の資料が定めているのは `Mj` だけで、`M` が何かはどこにも書かれていない。控えでは
  // `M` なのに震源決定機関が無い電文が 12 通あり、「気象庁以外の値」とは言い切れない。
  it('M には語を添えない', () => {
    expect(magnitudeTypeLabel('M')).toBeNull()
  })

  // 安全弁: **知らない値にも何も添えない。** 意味を推し量って言い換えない（記号なら電文のまま
  // 出せるが、語は当てはめた瞬間に嘘になりうる）。
  it('知らない種別には語を添えない', () => {
    expect(magnitudeTypeLabel('Mw')).toBeNull()
    expect(magnitudeTypeLabel(undefined)).toBeNull()
  })

  // 安全弁: 規模が数値にならないときは、種別があっても説明を優先する（前置きの出番が無い）。
  it('数値が無ければ種別より説明', () => {
    expect(formatMagnitudeWithCondition(NaN, 'Ｍ８を超える巨大地震', 'Mj')).toBe('M8を超える巨大地震')
  })
})

// 書き出しファイル名の時刻印。UTC で作ると JST の端末では 9 時間ずれた名前が並び、
// 「この時刻に鳴った」という手元のメモと突き合わせられなくなる（診断ログの用途そのもの）。
describe('formatFileStamp', () => {

  // 2026-01-15T00:00:00Z。時間帯ごとの規則が現行のものになる年を選ぶ
  // （epoch 直後を使うと、当時と今で刻みが違う地域＝ネパールの +0530→+0545 等を踏む）
  const BASE = Date.UTC(2026, 0, 15, 0, 0, 0)

  it('端末のローカル時刻で作る（UTC ではない）', () => {
    expect(withTz('Asia/Tokyo', () => formatFileStamp(BASE))).toBe('20260115_090000+0900')
  })

  it('UTC より west の時間帯は負符号になり、日付も繰り下がる', () => {
    expect(withTz('America/New_York', () => formatFileStamp(BASE))).toBe('20260114_190000-0500')
  })

  it('30 分・45 分刻みの時間帯でも分が落ちない', () => {
    expect(withTz('Asia/Kolkata', () => formatFileStamp(BASE))).toBe('20260115_053000+0530')
    expect(withTz('Asia/Kathmandu', () => formatFileStamp(BASE))).toBe('20260115_054500+0545')
  })

  it('UTC の端末では +0000', () => {
    expect(withTz('UTC', () => formatFileStamp(BASE))).toBe('20260115_000000+0000')
  })

  it('夏時間を持つ地域では、記録した時刻に効いていたオフセットで作る', () => {
    // 現在時刻のオフセットで全件を作ると、季節をまたいだ記録が 1 時間ずれて並ぶ
    expect(withTz('America/New_York', () => formatFileStamp(Date.UTC(2026, 6, 1, 12, 0, 0)))).toBe('20260701_080000-0400')
    expect(withTz('America/New_York', () => formatFileStamp(Date.UTC(2026, 0, 1, 12, 0, 0)))).toBe('20260101_070000-0500')
  })

  it('桁を必ず埋める（ファイル名が時刻順に並ぶため）', () => {
    expect(withTz('Asia/Tokyo', () => formatFileStamp(Date.UTC(2026, 0, 1, 18, 4, 5)))).toBe('20260102_030405+0900')
  })

  // `withTz` が復元することの契約テスト。**同じファイルの後続のテストを守るために置く**
  // （テストファイルどうしは別プロセスで走るので互いには漏れない）。formatFileStamp 自体は
  // 時間帯を読むだけなので、漏れうるのはこのヘルパーだけ
  it('時間帯を元へ戻す（同じファイルの後続を巻き込まない）', () => {
    const before = process.env.TZ
    withTz('Asia/Kathmandu', () => formatFileStamp(BASE))
    expect(process.env.TZ).toBe(before)
  })
})

// 規模が数値にならないときの説明（`jmx_eb:Magnitude@description`）。
// 「Ｍ不明」と「Ｍ８を超える巨大地震」はどちらも数値なしで届くが、後者は M8 を超えて
// 速報できないという別の事実で、最も伝えるべき場面に出る。
describe('規模の説明の表示', () => {
  // 正: 全角の記号・数字を半角へ揃える（同じ欄に並ぶ数値表示に合わせる）。
  it('全角の記号・数字を半角にする', () => {
    expect(formatMagnitudeCondition('Ｍ８を超える巨大地震')).toBe('M8を超える巨大地震')
  })

  // 安全弁: 数字を含まない語はそのまま残す。
  it('数字を含まない説明はそのまま残す', () => {
    expect(formatMagnitudeCondition('Ｍ不明')).toBe('M不明')
  })

  // 正: 「マグニチュード」の見出しを別に出す欄では、重ならないよう先頭の記号を落とす。
  it('見出しがある欄では先頭の記号を落とす', () => {
    expect(formatMagnitudeValue(NaN, 'Ｍ８を超える巨大地震')).toBe('8を超える巨大地震')
    expect(formatMagnitudeValue(NaN, 'Ｍ不明')).toBe('不明')
  })

  // 対照: 数値が読めるなら説明があっても数値を出す。
  it('数値が読めれば数値を出す', () => {
    expect(formatMagnitudeValue(7.6, 'Ｍ８を超える巨大地震')).toBe('7.6')
  })

  // 安全弁: 説明が無い規模不明は従来どおり「不明」。
  it('説明が無ければ不明のまま', () => {
    expect(formatMagnitudeValue(NaN)).toBe('不明')
    expect(formatMagnitudeValue(-1)).toBe('不明')
  })
})

// 震源の緯度・経度。遠地地震は世界中で起きるため負の値が来る。
describe('震源の座標の表記', () => {
  // 正: 南半球・西半球は向きを語で書く（気象庁の電文と同じ）。
  it('南半球・西半球を語で書く', () => {
    expect(formatCoordinate(-35.8, -72.7)).toBe('南緯 35.8° 西経 72.7°')
  })

  // 対照: 北半球・東半球は従来どおり。
  it('北半球・東半球は従来どおり', () => {
    expect(formatCoordinate(37.5, 138.6)).toBe('北緯 37.5° 東経 138.6°')
  })

  // 安全弁: 赤道・本初子午線は北緯・東経の側へ倒す（「南緯 0.0°」と書かない）。
  it('0 は北緯・東経として書く', () => {
    expect(formatCoordinate(0, 0)).toBe('北緯 0.0° 東経 0.0°')
  })

  // 桁数は呼び出し側が決める（震源要素は 0.1 度刻み、長期震源カタログはより細かい）。
  it('桁数を指定できる', () => {
    expect(formatCoordinate(-17.234, 178.567, 3)).toBe('南緯 17.234° 東経 178.567°')
  })

  // 安全弁: 読めない値はこの関数の中で弾く。呼び出し側のガードだけに任せると、ガードを持たない
  // 経路が足された日に「NaN°」が出る（`Infinity < 0` は偽なので向きの語まで誤る）。
  it('読めない値は不明にする', () => {
    expect(formatCoordinate(NaN, 138.6)).toBe('不明')
    expect(formatCoordinate(37.5, NaN)).toBe('不明')
    expect(formatCoordinate(Infinity, -Infinity)).toBe('不明')
  })
})

// 規模を出す欄はすべて 1 本の述語を通す。呼び出し側ごとに分岐を書くと経路を足すたびに漏れる。
describe('見出しに M を持たない欄の規模', () => {
  // 正: 数値があれば従来どおり。
  it('数値があれば M 付きで出す', () => {
    expect(formatMagnitudeWithCondition(7.6, undefined, undefined)).toBe('M7.6')
  })

  // 正: 数値が無くても説明があれば落とさない。
  it('説明があれば落とさない', () => {
    expect(formatMagnitudeWithCondition(NaN, 'Ｍ８を超える巨大地震', undefined)).toBe('M8を超える巨大地震')
  })

  // 対照: 説明が無ければ従来どおり「不明」（説明を持たない P2PQuake・EEW・カタログの経路）。
  it('説明が無ければ不明', () => {
    expect(formatMagnitudeWithCondition(NaN, undefined, undefined)).toBe('不明')
    expect(formatMagnitudeWithCondition(-1, undefined, undefined)).toBe('不明')
  })

  // 安全弁: 数値が読めるなら説明より数値を優先する。
  it('数値が読めれば数値を優先する', () => {
    expect(formatMagnitudeWithCondition(7.6, 'Ｍ８を超える巨大地震', undefined)).toBe('M7.6')
  })
})

// 震源の位置が判らなくても、規模や深さだけは判っていることがある（震源要素不明の電文。
// → quake-spec.md §5）。位置と一緒くたに伏せると、震源を決められないほど異常な地震で
// 最も重要な数値がカードから消える。
describe('hasHypocenterFacts', () => {
  const hypo = (over: Partial<Hypocenter> = {}): Hypocenter =>
    ({ name: '岩手県沖', latitude: 39.9, longitude: 142.2, depth: 50, magnitude: 5.1, ...over })

  // 正: 位置が「不明」でも、規模が判っていれば出す。これがこの述語を分けた理由。
  it('位置が不明でも規模が判っていれば真', () => {
    expect(hasHypocenterFacts(hypo({ latitude: -200, longitude: -200, depth: -1 }))).toBe(true)
  })

  // 正: 規模の説明だけ（「Ｍ８を超える巨大地震」）でも出す。
  it('規模の説明だけでも真', () => {
    expect(hasHypocenterFacts(hypo({
      latitude: -200, longitude: -200, depth: -1, magnitude: NaN,
      magnitudeCondition: 'Ｍ８を超える巨大地震',
    }))).toBe(true)
  })

  // 正: 深さだけでも出す。
  it('深さだけでも真', () => {
    expect(hasHypocenterFacts(hypo({ magnitude: NaN, depth: 0 }))).toBe(true)
  })

  // 対照: 震源要素をまったく持たない電文（震度速報）では欄ごと出ない。
  // **ここが偽にならないと、震度速報のカードに「不明／不明」の欄が並ぶ。**
  it('震度速報（震源要素なし）では偽', () => {
    expect(hasHypocenterFacts(hypo({
      name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN,
    }))).toBe(false)
  })

  // 安全弁: 3 つの条件は OR。1 つでも AND に書き換わったら落ちる。
  it('規模だけ・深さだけのどちらでも真になる（AND ではない）', () => {
    expect(hasHypocenterFacts(hypo({ magnitude: 5.1, depth: -1 }))).toBe(true)
    expect(hasHypocenterFacts(hypo({ magnitude: NaN, depth: 50 }))).toBe(true)
  })
})

// 国内への津波の影響区分を出す語。
//
// **「警報等」は等級をひとまとめにした値**で、大津波警報・津波警報・津波注意報のどれかが
// 出ていることしか言っていない（DMDATA は固定付加文 0211、P2PQuake は `MajorWarning` と
// `Warning` の両方をここへ寄せる）。「津波警報」と書くと、**大津波警報の地震で事実より
// 一段軽く見える**。短くしたくなる欄だが、ここは縮めてはいけない。
describe('国内津波情報の語', () => {
  // 正: 気象庁の語（固定付加文と同じ「津波警報等」）を使う。読み上げとも揃う。
  it('警報等はまとめた語で出す', () => {
    expect(formatDomesticTsunami('警報等', undefined).text).toBe('津波警報等')
  })

  // 対照: 注意報だけの区分は等級が確定しているので、まとめた語にしない。
  it('注意報はまとめた語にしない', () => {
    expect(formatDomesticTsunami('注意報', undefined).text).toBe('津波注意報')
  })

  // 安全弁: **まとめた語を他の区分へ広げていない。** 「等」を付けてよいのは等級が確定して
  // いない「警報等」だけで、確定している区分に付けると今度は**実際より重く**見える
  // （「津波の心配なし等」では何を言っているのか分からない）。
  it('等級が確定している区分に「等」を足していない', () => {
    for (const t of ['なし', '注意報', '若干の海面変動', '調査中', '不明'] as const) {
      expect(formatDomesticTsunami(t, undefined).text, t).not.toContain('等')
    }
  })

  // 区分は複数のコードを 1 つへ丸めているので、コードが分かれば気象庁の文に合う語を出す
  // （コード表の文は docs/jma-wording-audit.md E1〜E3）。
  // 正: 震度速報の 0217 は「今後の情報に注意してください。」で、「調査中」とは書いていない。
  it('コードが分かれば気象庁の文に合う語を出す', () => {
    expect(formatDomesticTsunami('調査中', '0217').text).toBe('今後の情報に注意')
    expect(formatDomesticTsunami('若干の海面変動', '0213').text).toBe('海面変動に注意')
    expect(formatDomesticTsunami('若干の海面変動', '0214').text).toBe('海面変動に注意')
    expect(formatDomesticTsunami('海面変動の可能性', '0216').text).toBe('津波のおそれ（震源が海底の場合）')
    expect(formatDomesticTsunami('なし', '0230').text).toBe('日本への影響なし')
  })

  // 対照: 区分の語が気象庁の文と合うコードと、コードを持たない経路（P2PQuake・借りた区分）は区分の語のまま。
  it('区分の語で足りるコードとコードの無い経路は区分の語のまま', () => {
    expect(formatDomesticTsunami('調査中', '0229').text).toBe('調査中')
    expect(formatDomesticTsunami('なし', '0215').text).toBe('津波の心配なし')
    expect(formatDomesticTsunami('警報等', '0211').text).toBe('津波警報等')
    expect(formatDomesticTsunami('調査中', undefined).text).toBe('調査中')
  })

  // 安全弁: 色は区分で決める（コードで語を替えても深刻さは区分と同じ）。
  it('語をコードで替えても色は区分のまま', () => {
    expect(formatDomesticTsunami('調査中', '0217').color).toBe(formatDomesticTsunami('調査中', undefined).color)
    expect(formatDomesticTsunami('なし', '0230').color).toBe(formatDomesticTsunami('なし', undefined).color)
  })
})

// 気象庁以外が運用する観測点の印（※ ではなく全角アスタリスク ＊）。
//
// **電文の読み取りでは外し、表示するときに戻す。** 座標表をはじめ、印の無い名前を鍵にして
// いる先がいくつもあるため（一覧は `docs/spec/quake-spec.md` §8「気象庁以外が運用する観測点」）。
describe('気象庁以外が運用する観測点の印', () => {
  // 正: 印の付く観測点には末尾へ ＊ を足す。
  it('気象庁以外の観測点には印を付ける', () => {
    expect(withNonJmaMark('普代村銅屋', true)).toBe('普代村銅屋＊')
  })

  // 対照: 気象庁の観測点には何も足さない。
  it('気象庁の観測点には印を付けない', () => {
    expect(withNonJmaMark('輪島市門前町', false)).toBe('輪島市門前町')
  })

  // 安全弁: 印の有無を持たない点（P2PQuake 経路は配信しない）でも名前を壊さない。
  it('印の有無が未定義なら名前をそのまま返す', () => {
    expect(withNonJmaMark('輪島市門前町', undefined)).toBe('輪島市門前町')
  })

  // 安全弁: **電文が使う文字と同じものを足している。** 見た目の似た ※（U+203B）や
  // 半角の * に取り違えると、電文の付加文が説明している記号と画面の記号が食い違う。
  it('電文と同じ全角アスタリスク（U+FF0A）を使う', () => {
    expect(NON_JMA_MARK).toBe(String.fromCharCode(0xFF0A))
  })
})

// 日時として読めない値のガード。
//
// `new Date('壊れた値')` は例外を投げず `Invalid Date` になり、`getHours()` 以下がそろって
// `NaN` を返す。素通しにすると `"NaN:NaN:NaN"` が画面へ出るうえ、例外も記録も残らなかった。
//
// **テストごとに違う値を使うこと。** 記録の間引きはモジュール変数の `Set` で、テスト間で
// 状態を共有する。同じ値を使い回すと 2 件目以降で `warn` が鳴らず、鳴らない理由が
// 「ガードが効いていない」のか「既に記録済み」なのか判別できない。
describe('日時として読めない値のガード', () => {
  beforeEach(() => { warnMock.mockClear() })

  // 正: 表示用の整形はすべて null を返す。呼び出し側はこれを見て欄・句ごと落とす。
  it('読めない値では null を返す（表示用の 6 関数）', () => {
    expect(formatTime('壊れた値-time')).toBeNull()
    expect(formatTimeMin('壊れた値-timeMin')).toBeNull()
    expect(formatDateTime('壊れた値-dateTime')).toBeNull()
    expect(formatDateTimeMin('壊れた値-dateTimeMin')).toBeNull()
    expect(formatQuakeTime('壊れた値-quakeTime')).toBeNull()
    expect(formatQuakeDateTime('壊れた値-quakeDateTime')).toBeNull()
    expect(formatDateTimeLocal(new Date('壊れた値-local'))).toBeNull()
  })

  // 対照: 読める値では従来どおりの文字列を返す（ガードが正常な値まで止めていないこと）。
  it('読める値では従来どおりの文字列を返す', () => {
    withTz('Asia/Tokyo', () => {
      expect(formatTime('2026-01-02T03:04:05+09:00')).toBe('03:04:05')
      expect(formatTimeMin('2026-01-02T03:04:05+09:00')).toBe('03:04')
      expect(formatDateTime('2026-01-02T03:04:05+09:00')).toBe('2026/01/02 03:04:05')
      expect(formatDateTimeMin('2026-01-02T03:04:05+09:00')).toBe('2026/01/02 03:04')
      expect(formatQuakeTime('2026-01-02T03:04:05+09:00')).toBe('1月2日 3:04')
      // 共有カードの画像。**秒を出さない**（電文に秒が無い）。画像は日をまたいで共有されるので年月日まで入れる
      // （2026-10-22 ユーザー承認「5-A 秒と発生を落とす」）。「ごろ」は付けない（2026-10-23 ユーザー選択「公式名を付ける (Recommended)」）。
      expect(formatQuakeDateTime('2026-01-02T03:04:05+09:00')).toBe('2026/01/02 03:04')
      // 対照: 秒まで出す `formatDateTime` は別の用途（電文の作成時刻など）に残る。
      expect(formatDateTime('2026-01-02T03:04:05+09:00')).toBe('2026/01/02 03:04:05')
      expect(formatDateTimeLocal(new Date('2026-01-02T03:04:05+09:00'))).toBe('2026-01-02T03:04')
    })
  })

  // 地震の時刻（地震発現時刻）の名前つきの形。「発生」は地震発生時刻の名前なので使わない。
  it('地震の時刻には「地震発現時刻」の名前を付け、読めなければ「地震発現時刻不明」', () => {
    withTz('Asia/Tokyo', () => {
      // 正: 名前つきで、「ごろ」も「発生」も付かない。
      expect(formatQuakeTimeLabeled('2026-01-02T03:04:05+09:00')).toBe('地震発現時刻 1月2日 3:04')
      // 対照: 緊急地震速報のカードの見出しと同じ正式名で出す（「時刻」を落とした「地震発現 」にしない）。
      expect(formatQuakeTimeLabeled('2026-01-02T03:04:05+09:00')).not.toMatch(/地震発現 /)
      // 安全弁: 読めない値・空文字は名前だけを残さず、決まった語にする。
      expect(formatQuakeTimeLabeled('壊れた値-labeled')).toBe('地震発現時刻不明')
      expect(formatQuakeTimeLabeled('')).toBe('地震発現時刻不明')
    })
  })

  // 正: 読めなかったことが記録に残る。**例外も記録も無い**のが元の問題だった。
  it('読めない値は記録に残り、値そのものが載る', () => {
    formatTime('記録される壊れた値')
    expect(warnMock).toHaveBeenCalledTimes(1)
    const message = String(warnMock.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('[format]')
    expect(message).toContain('formatTime')
    expect(message).toContain('記録される壊れた値')
  })

  // 対照: 同じ値の 2 回目は鳴らない。時刻の整形は再描画のたびに走るので、
  // 素朴に `log.warn` を置くと壊れた値 1 つでコンソールが埋まる。
  it('同じ値で何度も鳴らさない', () => {
    formatTime('繰り返される壊れた値')
    formatTime('繰り返される壊れた値')
    formatTime('繰り返される壊れた値')
    expect(warnMock).toHaveBeenCalledTimes(1)
  })

  // 対照: 関数が違えば別の経路なので、それぞれ記録する（追う先が違う）。
  it('同じ値でも整形関数が違えば別に記録する', () => {
    formatTime('経路ごとに記録される値')
    formatDateTime('経路ごとに記録される値')
    expect(warnMock).toHaveBeenCalledTimes(2)
  })

  // 安全弁: **時間帯を明示していない値はここでは弾かない。** `Date` はローカル時刻として
  // 解釈して有効な値を返すため、この層では捕まえられない。弾くのは電文を読む側
  // （`dmdataParser.ts` の `readTelegramDateTime`）の担当で、ここで中途半端に弾くと
  // 「両方で見ているつもり」になって入口の検証が薄くなる。
  it('時間帯を明示していない値はここでは弾かない（入口の担当）', () => {
    withTz('Asia/Tokyo', () => {
      expect(formatTime('2026-01-02T03:04:05')).toBe('03:04:05')
    })
    expect(warnMock).not.toHaveBeenCalled()
  })

  // **安全弁: `Date`・数値の入力は値で間引かない。** 壊れていると `String()` が元の値に
  // よらず `"Invalid Date"` / `"NaN"` へ丸めるため、値を鍵にすると別々の壊れた値が 1 つに
  // 潰れ、最初の 1 回だけ出て以後は永久に黙る（痕跡も残らない）。時間で間引くことで、
  // 別の壊れた値でも間隔が明ければ必ず記録される。
  it('Date の入力は値で間引かない（別の壊れた値が永久に黙らない）', () => {
    vi.useFakeTimers()
    try {
      // 前のテストが張った間引きを明けさせてから測る（記録器はモジュール変数で持ち越される）。
      vi.advanceTimersByTime(120_000)
      warnMock.mockClear()

      formatDateTimeLocal(new Date('壊れた日付A'))
      expect(warnMock).toHaveBeenCalledTimes(1)

      // 別の壊れた値。値を鍵にする作りなら「同じ値」と見なされて永久に黙る。
      formatDateTimeLocal(new Date('壊れた日付B'))
      expect(warnMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(60_001)
      formatDateTimeLocal(new Date('壊れた日付C'))
      expect(warnMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // 安全弁: 記録器は整形関数ごとに分かれている。ある関数で壊れた値が連発しても、
  // 別の関数の記録が間引きに巻き込まれない。
  it('ある関数で枠を使い切っても、別の関数の記録は止まらない', () => {
    for (let i = 0; i < 40; i++) formatTime(`枠を埋める値${i}`)
    warnMock.mockClear()
    formatDateTimeMin('別の関数の壊れた値')
    expect(warnMock).toHaveBeenCalledTimes(1)
  })

  // 安全弁: ファイル名の時刻印だけは null を返さない。名前が付かなければ書き出し自体が
  // 成り立たず、対象の時刻が判らないことと利用者の操作を止めることは別。
  it('ファイル名の時刻印は読めない値でも現在時刻で作る', () => {
    const stamp = formatFileStamp(Number.NaN)
    expect(stamp).not.toContain('NaN')
    expect(stamp).toMatch(/^\d{8}_\d{6}[+-]\d{4}$/)
    expect(warnMock).toHaveBeenCalledTimes(1)
  })
})

describe('震央補助表現の表示', () => {
  // 正: 数字と距離の単位を半角へ直す。
  it('全角の数字と ｋｍ を半角にする', () => {
    expect(formatNameFromMark('輪島の東北東３０ｋｍ付近')).toBe('輪島の東北東30km付近')
    expect(formatNameFromMark('新潟の南西１２０ｋｍ付近')).toBe('新潟の南西120km付近')
  })

  // 対照: 地名・方位の語はそのまま残す。
  it('地名と方位の語は変えない', () => {
    expect(formatNameFromMark('御前崎の北東４０ｋｍ付近')).toBe('御前崎の北東40km付近')
    expect(formatNameFromMark('宮古の東６０ｋｍ付近').startsWith('宮古の東')).toBe(true)
  })

  // 安全弁: 既に半角の文や数字を含まない文はそのまま返す。
  it('半角の文は変えない', () => {
    expect(formatNameFromMark('輪島の東北東30km付近')).toBe('輪島の東北東30km付近')
    expect(formatNameFromMark('　輪島付近')).toBe('輪島付近')
  })
})
