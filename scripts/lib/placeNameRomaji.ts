/**
 * 地名の読み仮名（カタカナ）から、気象庁サイトの報の英語名（`enName`）と同じ書き方のローマ字を作る。
 *
 * 気象庁の英語名は、読み仮名をヘボン式で書き、長音を落とし（オウ・オオ → o、ウウ → u）、
 * ン の後が b・m・p なら m と書く（Nambu・Semmaya）。区切りは次の形（2026-11-13 に報 182 本の英語名で確かめた）。
 *
 * - 区域: 「県名 Ken 残り」「都名 To 残り」「府名 Fu 残り」「地方名 Chiho 残り」（例 Miyagi Ken Hokubu・Ishikari Chiho Nambu）
 * - 市町村: 「語幹-接尾」（接尾は 市 shi・町 machi または cho・村 mura または son・区 ku。読み仮名どおり）
 * - 観測点: 「市町村の英語名 残り」と、名前の末尾の ＊ を * で写す（例 Otaki-mura Suzugasawa*）
 *
 * 気象庁の英語名は書き方に揺れがある（Oume・Chuou・Sports-center）。ここで作るのは、集めた英語名に無い地名の分だけ
 * （生成スクリプト `build-place-names.ts`）。
 */

const KANA: Record<string, string> = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo', シャ: 'sha', シュ: 'shu', ショ: 'sho', チャ: 'cha', チュ: 'chu', チョ: 'cho',
  ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo', ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo', ミャ: 'mya', ミュ: 'myu', ミョ: 'myo',
  リャ: 'rya', リュ: 'ryu', リョ: 'ryo', ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo', ジャ: 'ja', ジュ: 'ju', ジョ: 'jo',
  ビャ: 'bya', ビュ: 'byu', ビョ: 'byo', ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo', ヂャ: 'ja', ヂュ: 'ju', ヂョ: 'jo',
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so', タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo', ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do', バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', ヴ: 'vu',
}

/** カタカナをローマ字（小文字・区切りなし）にする。知らない文字が混じれば null（作らずに日本語の名前へ倒すため） */
export function romanizeKana(kana: string): string | null {
  let out = ''
  for (let i = 0; i < kana.length; i++) {
    const two = KANA[kana.slice(i, i + 2)]
    if (two) { out += two; i++; continue }
    const c = kana[i]
    if (c === 'ッ') {
      const next = KANA[kana.slice(i + 1, i + 3)] ?? KANA[kana[i + 1]] ?? ''
      if (!next) return null
      out += next.startsWith('ch') ? 't' : next[0]
      continue
    }
    if (c === 'ー') continue
    const one = KANA[c]
    if (one === undefined) return null
    out += one
  }
  return out
    .replace(/n(?=[bmp])/g, 'm')
    .replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u')
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** 市町村の接尾（漢字の最後の 1 字と、その読み仮名の終わり → ローマ字） */
const CITY_SUFFIXES: readonly { kanji: string; kana: string; roman: string }[] = [
  { kanji: '市', kana: 'シ', roman: 'shi' },
  { kanji: '町', kana: 'マチ', roman: 'machi' },
  { kanji: '町', kana: 'チョウ', roman: 'cho' },
  { kanji: '村', kana: 'ムラ', roman: 'mura' },
  { kanji: '村', kana: 'ソン', roman: 'son' },
  { kanji: '区', kana: 'ク', roman: 'ku' },
]

/** 市町村の英語名を読み仮名から作る（「語幹-接尾」）。接尾に当たらなければ語幹だけ。作れなければ null */
export function cityEnFromKana(name: string, kana: string): string | null {
  for (const s of CITY_SUFFIXES) {
    if (!name.endsWith(s.kanji) || !kana.endsWith(s.kana) || kana.length <= s.kana.length) continue
    const stem = romanizeKana(kana.slice(0, -s.kana.length))
    return stem ? `${capitalize(stem)}-${s.roman}` : null
  }
  const whole = romanizeKana(kana)
  return whole ? capitalize(whole) : null
}

/**
 * 区域の頭（県・府・地方・都）と、英語名でのその語。都は最後に見る（京都府の「都」で切らないため）
 */
const AREA_HEADS: readonly { kanji: string; roman: string }[] = [
  { kanji: '県', roman: 'ken' }, { kanji: '府', roman: 'fu' }, { kanji: '地方', roman: 'chiho' }, { kanji: '都', roman: 'to' },
]

/**
 * 区域の英語名を読み仮名から作る（「県名 Ken 残り」など）。頭の語が無い名前（伊豆大島など）は 1 語にする。
 * 区切りはローマ字の並びの中で頭の語を探して決める（県名の読み仮名の長さを持っていないため）。作れなければ null
 */
export function areaEnFromKana(name: string, kana: string): string | null {
  const roman = romanizeKana(kana)
  if (!roman) return null
  for (const h of AREA_HEADS) {
    const at = name.indexOf(h.kanji)
    if (at <= 0 || at + h.kanji.length >= name.length) continue
    // 県名の部分の読みの長さは分からないので、ローマ字の中で頭の語が最初に現れる所で切る。
    // 頭の語がローマ字に見つからない（長音の落とし方で崩れた）ときは 1 語に倒す
    const idx = roman.indexOf(h.roman, 1)
    if (idx < 0 || idx + h.roman.length >= roman.length) break
    const rest = roman.slice(idx + h.roman.length)
    return `${capitalize(roman.slice(0, idx))} ${capitalize(h.roman)} ${capitalize(rest)}`
  }
  return capitalize(roman)
}

/**
 * 観測点の英語名を作る（「市町村の英語名 残り」＋末尾の ＊）。観測点の読み仮名が市町村の読み仮名で始まらないときは
 * 全体を 1 語にした名前に市町村の英語名を付けずに返す。作れなければ null
 */
export function stationEnFromKana(name: string, kana: string, cityEn: string, cityKana: string): string | null {
  const star = /[＊*]$/.test(name) ? '*' : ''
  if (kana.startsWith(cityKana)) {
    const rest = kana.slice(cityKana.length)
    if (!rest) return cityEn + star
    const roman = romanizeKana(rest)
    return roman ? `${cityEn} ${capitalize(roman)}${star}` : null
  }
  const roman = romanizeKana(kana)
  return roman ? `${capitalize(roman)}${star}` : null
}

/** 全角の英数字を半角へ */
const toHalfWidth = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

/**
 * 津波観測点の英語名を読み仮名から作る（1 語）。沖合の観測点（読み仮名が「クシロオキ１００ｋｍＡ」の形）は
 * 「Kushiro-oki 100km A」にする。作れなければ null
 */
export function tsunamiStationEnFromKana(kana: string): string | null {
  const offshore = /^(.+?)オキ([０-９]+ｋｍ)([Ａ-Ｚ]?)$/.exec(kana)
  if (offshore) {
    const place = romanizeKana(offshore[1])
    if (!place) return null
    const letter = offshore[3] ? ` ${toHalfWidth(offshore[3])}` : ''
    return `${capitalize(place)}-oki ${toHalfWidth(offshore[2])}${letter}`
  }
  const roman = romanizeKana(kana)
  return roman ? capitalize(roman) : null
}
