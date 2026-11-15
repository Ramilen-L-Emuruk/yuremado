/**
 * 気象庁の多言語辞書に無い名前（震度観測点・津波観測点）の中国語・韓国語の訳を作る（`build-place-names.ts`）。
 *
 * - 中国語: 漢字の字形だけを変える。字ごとの対応は、まず辞書の訳（震央地名・都道府県・市町村・津波予報区）から学んだもの、
 *   無ければ OpenCC（繁体は 日本の字体→繁体、簡体はさらに 繁体→簡体）。繋ぎの仮名は辞書と同じ扱い（ヶ・ケは落とし、の・ノは「之」）
 *   で、それ以外の仮名を含む名前は作らない（日本語のまま出る）
 * - 韓国語: 読み仮名から音でハングルにする
 *
 * 辞書の訳との一致の度合いは `docs/spec/data-sources-spec.md` §6「地名の訳の表」。
 *
 * （2026-11-15 ユーザー選択「案A 字形変換＋ハングル (Recommended)」）
 */
import * as OpenCC from 'opencc-js'

type ZhLocale = 'zh-Hans' | 'zh-Hant'
const jp2t = OpenCC.Converter({ from: 'jp', to: 't' })
const t2cn = OpenCC.Converter({ from: 't', to: 'cn' })
const HAN = /[㐀-鿿豈-﫿]/
const KANA = /[ぁ-ゖァ-ヺー]/

/** 辞書と同じ繋ぎの仮名の扱い（龍ケ崎→龙崎・一ノ関→一之关）と、踊り字を前の字に戻す（佐々→佐佐） */
const normalizeJapanese = (s: string) => s.replace(/[ヶケ]/g, '').replace(/[のノ]/g, '之').replace(/(.)々/g, '$1$1')

/** 全角の数字と英字を半角にする（「沖１００ｋｍＡ」の距離と記号） */
const toHalfWidth = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

/**
 * 辞書の訳（日本語の名前と訳の組）から、漢字ごとに辞書が使う字を学ぶ。同じ長さの組の同じ位置の字を数え、
 * 2 回以上出て 8 割以上がその字のものだけを使う（辞書が字ごとに決まった形で書く「戸→户」「郷→乡」「内→內」を拾う）
 */
export function learnCharMap(pairs: Iterable<readonly [string, string]>): Map<string, string> {
  const seen = new Map<string, Map<string, number>>()
  for (const [ja, zh] of pairs) {
    // 「付近→附近」は地名ではない語の訳なので学ばない（学ぶと「見付」「付知」まで「附」になる）
    const a = [...normalizeJapanese(ja.replace(/付近/g, ''))], b = [...zh.replace(/[附付]近/g, '')]
    if (a.length !== b.length) continue
    a.forEach((c, i) => {
      if (!HAN.test(c)) return
      const m = seen.get(c) ?? new Map<string, number>()
      m.set(b[i], (m.get(b[i]) ?? 0) + 1)
      seen.set(c, m)
    })
  }
  const out = new Map<string, string>()
  for (const [c, counts] of seen) {
    const [top, n] = [...counts].sort((x, y) => y[1] - x[1])[0]
    const total = [...counts.values()].reduce((s, v) => s + v, 0)
    if (n >= 2 && n / total >= 0.8) out.set(c, top)
  }
  return out
}

/**
 * OpenCC が変えない日本の字体 → 繁体字（簡体はこの後 OpenCC で 繁体→簡体 に変える。「梼」は辞書の「檮原町」に合わせる）。
 * OpenCC のどの変換でも見つからないので、観測点名に出る字をこの表に持つ。表に無い字は見落とす
 */
export const JP_ONLY_TO_HANT: Readonly<Record<string, string>> = {
  舎: '舍', 冨: '富', 篭: '籠', 渕: '淵', 薮: '藪', 梼: '檮',
  // 簡体字と同じ形で、繁体（台湾の字）では別の形の字（繁体でも使う岩・台・栖・峰などは入れない）
  内: '內', 厩: '廄', 悦: '悅', 潴: '瀦', 猫: '貓',
}

/**
 * OpenCC の 日本→繁体 が返す古い形のうち、今の繁体字でも簡体字でも使わない形 → 今の形（表に残れば、作る段の確かめ〈`placeNameFixes.ts`〉が止める）。
 * 繁体→簡体 の変換もこれらの古い形を変えないので、ここでそろえる
 */
export const OPENCC_ARCHAIC: Readonly<Record<string, string>> = { 鄕: '鄉', 澁: '澀', 硏: '研', 緖: '緒', 晄: '晃', 甁: '瓶', 竝: '並', 郞: '郎' }
/**
 * OpenCC の 日本→繁体 の結果を、辞書の訳の書き方にそろえる対応（{@link OPENCC_ARCHAIC} を含む）。
 * 「臺・眞・豫・萠・膽・絲・亙」は、辞書が日本の字のまま書き、2026-11-15 に直さないと決めた字（台・真・予・萌・胆・糸・亘）に戻す
 */
export const OPENCC_OLD_FORMS: Readonly<Record<string, string>> = {
  ...OPENCC_ARCHAIC, 鑛: '礦',
  臺: '台', 眞: '真', 豫: '予', 萠: '萌', 膽: '胆', 絲: '糸', 亙: '亘',
}

/** 名前に繋ぎ（ヶ・ケ・の・ノ）以外の仮名を含むか（含めば中国語の名前は作らない） */
export const hasNonConnectiveKana = (name: string) => KANA.test(normalizeJapanese(name))

/**
 * 簡体では変えない字。OpenCC の 繁体→簡体 が、字形ではなく別の字に置き換える（「摺→折」「麹→曲」「碕→埼」「於→于」、
 * 「樫」はまれな字「㭴」）。地名の字なので、字形だけを変える決まりに合わせて日本の字のまま残す（「足摺岬」が「足折岬」にならないように）
 */
export const KEEP_IN_HANS = '摺麹碕樫於'

/** 日本語の名前の字形を中国語（簡体・繁体）にする。繋ぎ以外の仮名を含めば作れない（null） */
export function zhFromJapanese(locale: ZhLocale, name: string, learned: ReadonlyMap<string, string>): string | null {
  const s = normalizeJapanese(name)
  if (KANA.test(s)) return null
  const one = (c: string) => {
    const hit = learned.get(c)
    if (hit !== undefined) return hit
    if (locale === 'zh-Hans' && KEEP_IN_HANS.includes(c)) return c
    const opencc = jp2t(c)
    const t = JP_ONLY_TO_HANT[c] ?? OPENCC_OLD_FORMS[opencc] ?? opencc
    return locale === 'zh-Hant' ? t : t2cn(t)
  }
  return toHalfWidth([...s].map(one).join(''))
}

// ── 読み仮名からハングル ──

const INITIAL = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const MEDIAL = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
const FINAL = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
const syllable = (l: string, v: string) => String.fromCharCode(0xac00 + (INITIAL.indexOf(l) * 21 + MEDIAL.indexOf(v)) * 28)
const withFinal = (s: string, t: string) => String.fromCharCode(s.charCodeAt(0) - ((s.charCodeAt(0) - 0xac00) % 28) + FINAL.indexOf(t))

type Vowel = 'a' | 'i' | 'u' | 'uu' | 'e' | 'o' | 'ya' | 'yu' | 'yo' | 'wa'
const VOWEL: Record<Vowel, string> = { a: 'ㅏ', i: 'ㅣ', u: 'ㅜ', uu: 'ㅡ', e: 'ㅔ', o: 'ㅗ', ya: 'ㅑ', yu: 'ㅠ', yo: 'ㅛ', wa: 'ㅘ' }
/**
 * 仮名 → [語頭の子音, 語中の子音, 母音]。カ・タ行は語頭で平音（ㄱ・ㄷ）、語中で激音（ㅋ・ㅌ）。
 * ス・ツ・ズ・ヅの母音は ㅡ（uu）、ほかのウ段は ㅜ（韓国語の外来語の書き方）
 */
const KANA_SOUND: Record<string, readonly [string, string, Vowel]> = {
  ア: ['ㅇ', 'ㅇ', 'a'], イ: ['ㅇ', 'ㅇ', 'i'], ウ: ['ㅇ', 'ㅇ', 'u'], エ: ['ㅇ', 'ㅇ', 'e'], オ: ['ㅇ', 'ㅇ', 'o'],
  カ: ['ㄱ', 'ㅋ', 'a'], キ: ['ㄱ', 'ㅋ', 'i'], ク: ['ㄱ', 'ㅋ', 'u'], ケ: ['ㄱ', 'ㅋ', 'e'], コ: ['ㄱ', 'ㅋ', 'o'],
  サ: ['ㅅ', 'ㅅ', 'a'], シ: ['ㅅ', 'ㅅ', 'i'], ス: ['ㅅ', 'ㅅ', 'uu'], セ: ['ㅅ', 'ㅅ', 'e'], ソ: ['ㅅ', 'ㅅ', 'o'],
  タ: ['ㄷ', 'ㅌ', 'a'], チ: ['ㅈ', 'ㅊ', 'i'], ツ: ['ㅆ', 'ㅆ', 'uu'], テ: ['ㄷ', 'ㅌ', 'e'], ト: ['ㄷ', 'ㅌ', 'o'],
  ナ: ['ㄴ', 'ㄴ', 'a'], ニ: ['ㄴ', 'ㄴ', 'i'], ヌ: ['ㄴ', 'ㄴ', 'u'], ネ: ['ㄴ', 'ㄴ', 'e'], ノ: ['ㄴ', 'ㄴ', 'o'],
  ハ: ['ㅎ', 'ㅎ', 'a'], ヒ: ['ㅎ', 'ㅎ', 'i'], フ: ['ㅎ', 'ㅎ', 'u'], ヘ: ['ㅎ', 'ㅎ', 'e'], ホ: ['ㅎ', 'ㅎ', 'o'],
  マ: ['ㅁ', 'ㅁ', 'a'], ミ: ['ㅁ', 'ㅁ', 'i'], ム: ['ㅁ', 'ㅁ', 'u'], メ: ['ㅁ', 'ㅁ', 'e'], モ: ['ㅁ', 'ㅁ', 'o'],
  ヤ: ['ㅇ', 'ㅇ', 'ya'], ユ: ['ㅇ', 'ㅇ', 'yu'], ヨ: ['ㅇ', 'ㅇ', 'yo'],
  ラ: ['ㄹ', 'ㄹ', 'a'], リ: ['ㄹ', 'ㄹ', 'i'], ル: ['ㄹ', 'ㄹ', 'u'], レ: ['ㄹ', 'ㄹ', 'e'], ロ: ['ㄹ', 'ㄹ', 'o'],
  ワ: ['ㅇ', 'ㅇ', 'wa'], ヲ: ['ㅇ', 'ㅇ', 'o'],
  ガ: ['ㄱ', 'ㄱ', 'a'], ギ: ['ㄱ', 'ㄱ', 'i'], グ: ['ㄱ', 'ㄱ', 'u'], ゲ: ['ㄱ', 'ㄱ', 'e'], ゴ: ['ㄱ', 'ㄱ', 'o'],
  ザ: ['ㅈ', 'ㅈ', 'a'], ジ: ['ㅈ', 'ㅈ', 'i'], ズ: ['ㅈ', 'ㅈ', 'uu'], ゼ: ['ㅈ', 'ㅈ', 'e'], ゾ: ['ㅈ', 'ㅈ', 'o'],
  ダ: ['ㄷ', 'ㄷ', 'a'], ヂ: ['ㅈ', 'ㅈ', 'i'], ヅ: ['ㅈ', 'ㅈ', 'uu'], デ: ['ㄷ', 'ㄷ', 'e'], ド: ['ㄷ', 'ㄷ', 'o'],
  バ: ['ㅂ', 'ㅂ', 'a'], ビ: ['ㅂ', 'ㅂ', 'i'], ブ: ['ㅂ', 'ㅂ', 'u'], ベ: ['ㅂ', 'ㅂ', 'e'], ボ: ['ㅂ', 'ㅂ', 'o'],
  パ: ['ㅍ', 'ㅍ', 'a'], ピ: ['ㅍ', 'ㅍ', 'i'], プ: ['ㅍ', 'ㅍ', 'u'], ペ: ['ㅍ', 'ㅍ', 'e'], ポ: ['ㅍ', 'ㅍ', 'o'],
  ヴ: ['ㅂ', 'ㅂ', 'u'],
}
const SMALL_Y: Record<string, 'ya' | 'yu' | 'yo'> = { ャ: 'ya', ュ: 'yu', ョ: 'yo' }
/** 小さいァ行（「ディ」「ファ」「ウィ」）。前の仮名の子音に、この母音を付ける。ファ行の子音は ㅍ、ウの後は w の二重母音 */
const SMALL_V: Record<string, 'a' | 'i' | 'u' | 'e' | 'o'> = { ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' }
const W_VOWEL: Record<'a' | 'i' | 'u' | 'e' | 'o', string> = { a: 'ㅘ', i: 'ㅟ', u: 'ㅜ', e: 'ㅞ', o: 'ㅝ' }
/** チャ・ジャ行（チ・ジ・ヂ＋ャュョ）の母音は ㅑㅠㅛ ではなく ㅏㅜㅗ（「チョウ」→「초」）。シャ行は ㅑㅠㅛ のまま（「ショ」→「쇼」） */
const PALATAL_PLAIN: Record<'ya' | 'yu' | 'yo', string> = { ya: 'ㅏ', yu: 'ㅜ', yo: 'ㅗ' }

/**
 * 「ウ」で始まる読みを持つ漢字と、その読み。名前にこの漢字があり、読み仮名にその読みが出ていれば、そこの「ウ」は語の頭なので
 * 長音として落とさない（堀之内 ホリノウチ → 호리노우치。落とすと 호리노치）。「ウ」1 音の読み（宇・鵜など）は、
 * 東京（トウキョウ）のような本当の長音の「ウ」と見分けられないので、続く音まで含めた地名の読み（宇陀 ウダ・鵜方 ウガタ）で持つ
 */
const U_HEAD_READINGS: Readonly<Record<string, readonly string[]>> = {
  内: ['ウチ'], 打: ['ウチ'], 浦: ['ウラ'], 臼: ['ウス'], 牛: ['ウシ'], 魚: ['ウオ'], 梅: ['ウメ'], 馬: ['ウマ'],
  海: ['ウミ'], 歌: ['ウタ'], 浮: ['ウキ'], 兎: ['ウサギ'], 鶯: ['ウグイス'], 潤: ['ウルウ'],
  宇: ['ウダ'], 鵜: ['ウガタ'],
}

/**
 * 漢字は {@link U_HEAD_READINGS} にあっても、「ウ」が前の音の長音である読み（青梅 オウメ・青海 オウミ・河内 コウチ／ゴウチ）
 */
const LONG_U_READINGS = ['オウメ', 'オウミ', 'コウチ', 'ゴウチ']

/** 読み仮名のうち、名前の漢字から語の頭と分かる「ウ」の位置 */
function wordHeadU(kana: string, name: string): Set<number> {
  const out = new Set<number>()
  for (const c of name) {
    for (const r of U_HEAD_READINGS[c] ?? []) {
      for (let i = kana.indexOf(r, 1); i >= 0; i = kana.indexOf(r, i + 1)) {
        if (!LONG_U_READINGS.some((l) => kana.startsWith(l, i - 1))) out.add(i)
      }
    }
  }
  return out
}

/**
 * 読み仮名（カタカナ 1 語）を音でハングルにする。長音（ー・オウ・ウウ・オオ）は落とし、ン・ッは前の音節の終声にする。
 * `name`（その読みの漢字の名前）を渡すと、語の頭の「ウ」を長音と取り違えない（{@link U_HEAD_READINGS}）。
 * 表に無い仮名を含めば作れない（null）
 */
export function hangulFromKana(kana: string, name = ''): string | null {
  const keepU = wordHeadU(kana, name)
  const ks = [...kana.replace(/-/g, 'ー')]
  const out: string[] = []
  let prev: Vowel | '' = ''
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]
    if (k === 'ー') continue
    if (k === 'ン' || k === 'ッ') {
      if (!out.length) return null
      out[out.length - 1] = withFinal(out[out.length - 1], k === 'ン' ? 'ㄴ' : 'ㅅ')
      prev = ''
      continue
    }
    const sound = KANA_SOUND[k]
    if (!sound) return null
    const sv = SMALL_V[ks[i + 1]]
    if (sv) {
      i++
      const consonant = k === 'フ' ? 'ㅍ' : out.length === 0 ? sound[0] : sound[1]
      out.push(syllable(consonant, k === 'ウ' ? W_VOWEL[sv] : VOWEL[sv]))
      prev = sv
      continue
    }
    const y = SMALL_Y[ks[i + 1]]
    // 長音（オウ・ウウ・オオ・ヨウ・ユウ）の後ろの母音は書かない
    if (!y && k === 'ウ' && !keepU.has(i) && (prev === 'o' || prev === 'u' || prev === 'uu' || prev === 'yo' || prev === 'yu')) continue
    if (!y && k === 'オ' && (prev === 'o' || prev === 'yo')) continue
    const consonant = out.length === 0 ? sound[0] : sound[1]
    let vowel: Vowel = sound[2]
    let medial: string
    if (y) {
      i++
      vowel = y
      medial = k === 'チ' || k === 'ジ' || k === 'ヂ' ? PALATAL_PLAIN[y] : VOWEL[y]
    } else medial = VOWEL[vowel]
    out.push(syllable(consonant, medial))
    prev = vowel
  }
  return out.length ? out.join('') : null
}
