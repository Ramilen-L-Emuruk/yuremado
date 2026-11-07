// 国際津波関連情報（WEPA60・英文）の日本語訳。地震カードの英文の欄で、初めから日本語訳を出し「原文」と切り替える
// （2026-11-08 ユーザー発言「切り替えだけどせっかくなんだからデフォ翻訳でいいんじゃない」）。
//
// **機械翻訳はしない。** 電文の書式は気象庁の仕様書（No.40401 別紙）で決まっているので、決まった文と項目だけを
// 決まった訳に置き換える。訳せない行（備考など書式の外の文・表に無い地名を含む行）は英語のまま残し、
// `untranslated` の印を付ける（推して訳さない。原文は「原文」でいつでも見られる）。
//
// 訳の文面は 2026-11-08 にユーザーへ諮って決めた（文の訳「この形で決める (Recommended)」・沿岸ブロックと地震区
// 「この案でよい (Recommended)」・地点名「漢字圏は漢字・他はカタカナ (Recommended)」・HOMEL は「和美（推測で当てる）」・
// IRIAN JAYA は「インドネシア、パプア北岸 (Recommended)」。名詞句に「の」を挟まない形はユーザーが直した）。
import { evaluationFromSentence } from '../services/wepa60Parser'
import type { InternationalTsunamiEvaluation } from '../types/earthquake'

/**
 * 評価の文の画面の訳。読み上げの文（`internationalTsunamiSpeech.ts`）とは別に、原文の語を足し引きせずに訳す
 * （2026-11-08 ユーザー選択「原文に沿う訳を別に持つ (Recommended)」）
 */
const EVALUATION_TEXT: Readonly<Record<InternationalTsunamiEvaluation, string>> = {
  oceanWide: '大洋全域に被害をもたらす津波の可能性がある',
  regional: '広い地域に被害をもたらす津波の可能性がある',
  localNearEpicenter: '震源付近に被害をもたらす局地的な津波の可能性がある',
  verySmall: '被害をもたらす局地的な津波の可能性は非常に小さい',
  none: '津波の可能性はない',
}

/** 座標から引いた気象庁の津波観測点 */
export interface Wepa60StationMatch {
  readonly name: string
  /** 10 km 以内に候補が 2 つ以上あった（電文の座標は 0.1 度刻みなので取り違えうる） */
  readonly ambiguous: boolean
}

export interface Wepa60TranslatedLine {
  readonly text: string
  /** 訳せず英語のまま残した行 */
  readonly untranslated: boolean
}

export interface Wepa60TranslateContext {
  /** 震央の 1 行目（Flinn-Engdahl の地域名）→ 気象庁の詳細震央地名。`public/data/wepa60-region-names.json` */
  readonly regionNames: Readonly<Record<string, string>>
  /**
   * 英文が付いた地震カードの気象庁の震央地名。震央の 1 行目が地名の表に無いときだけ使う
   * （電文の地名を先にする。2026-11-08 ユーザー選択「電文の地名を先に (Recommended)」）
   */
  readonly quakeName?: string
  /** 座標から気象庁の津波観測点を引く（日本の観測点の行に使う）。無ければ undefined */
  readonly tsunamiStationNameAt?: (lat: number, lon: number) => Wepa60StationMatch | undefined
}

/** 沿岸ブロック（北西太平洋津波情報センターの名簿の 15） */
const COASTAL_BLOCKS: Readonly<Record<string, string>> = {
  'EAST COASTS OF KAMCHATKA PENINSULA': 'カムチャツカ半島東岸',
  'KURIL ISLANDS': '千島列島',
  'SOUTH COASTS OF KOREAN PENINSULA': '朝鮮半島南岸',
  'COASTS OF EAST CHINA SEA': '東シナ海沿岸',
  TAIWAN: '台湾',
  'EAST COASTS OF PHILIPPINES': 'フィリピン東岸',
  'NORTH COASTS OF IRIAN JAYA': 'インドネシア、パプア北岸',
  'NORTH COASTS OF PAPUA NEW GUINEA': 'パプアニューギニア北岸',
  'MARIANA ISLANDS': 'マリアナ諸島',
  PALAU: 'パラオ',
  MICRONESIA: 'ミクロネシア',
  'MARSHALL ISLANDS': 'マーシャル諸島',
  'NORTH COASTS OF SOLOMON ISLANDS': 'ソロモン諸島北岸',
  'SOLOMON SEA': 'ソロモン海',
  'CORAL SEA': 'サンゴ海',
}

/** 震央の 2 行目（Flinn-Engdahl の地震区）。北西太平洋の分だけ。ほかは原文のまま */
const SEISMIC_REGIONS: Readonly<Record<string, string>> = {
  'THE PHILIPPINES': 'フィリピン諸島周辺',
  'BORNEO - SULAWESI': 'ボルネオ島・スラウェシ島周辺',
  'JAPAN - KURIL ISLANDS - KAMCHATKA PENINSULA': '日本・千島列島・カムチャツカ半島周辺',
  'BISMARCK AND SOLOMON ISLANDS': 'ビスマルク諸島・ソロモン諸島周辺',
  'SOUTHWESTERN JAPAN AND RYUKYU ISLANDS': '西日本・南西諸島周辺',
  'GUAM TO JAPAN': 'グアムから日本にかけて',
  'NEW GUINEA AREA': 'ニューギニア周辺',
  TAIWAN: '台湾周辺',
}

/** 予報地点（北西太平洋津波情報センターの名簿の 61） */
const FORECAST_POINTS: Readonly<Record<string, string>> = {
  OSTROV_KARAGINSKIY: 'カラギンスキー島', UST_KAMCHATSK: 'ウスチ・カムチャツク', PETROPAVLOVSK_K: 'ペトロパブロフスク・カムチャツキー',
  NIKOLSKOYA: 'ニコリスコエ', SEVERO_KURILSK: 'セベロクリリスク', 'URUP_IS.': 'ウルップ島（得撫島）',
  BUSAN: '釜山', TONGYEONG: '統営', NOHWA: '蘆花', HEUKSANDO: '黒山島', CHEJU_ISLAND: '済州島', SEOGWIPO: '西帰浦',
  SHANGHAI: '上海', ZHOUSHAN: '舟山', WENZHOU: '温州',
  CHILUNG: '基隆', HUALIEN: '花蓮', TAITUNG: '台東', HOMEL: '和美',
  BASCO: 'バスコ', PALANAN: 'パラナン', LEGASPI: 'レガスピ', LAOANG: 'ラオアン', MADRID: 'マドリード', DAVAO: 'ダバオ',
  GEME: 'ゲメ', BEREBERE: 'ベレベレ', PATANI: 'パタニ', SORONG: 'ソロン', MANOKWARI: 'マノクワリ', WARSA: 'ワルサ', JAYAPURA: 'ジャヤプラ',
  VANIMO: 'バニモ', WEWAK: 'ウェワク', MADANG: 'マダン', 'MANUS_IS.': 'マヌス島', KAVIENG: 'カビエン', RABAUL: 'ラバウル',
  ULAMONA: 'ウラモナ', KIMBE: 'キンベ', KIETA: 'キエタ',
  SAIPAN: 'サイパン', GUAM: 'グアム', MALAKAL: 'マラカル',
  'YAP_IS.': 'ヤップ島', 'CHUUK_IS.': 'チューク島', 'POHNPEI_IS.': 'ポンペイ島', 'KOSRAE_IS.': 'コスラエ島', ENIWETOK: 'エニウェトク',
  PANGGOE: 'パンゴエ', GHATERE: 'ガテレ', AUKI: 'アウキ', KIRAKIRA: 'キラキラ',
  AMUN: 'アムン', FALAMAE: 'ファラマエ', MUNDA: 'ムンダ', HONIARA: 'ホニアラ', MISIMA: 'ミシマ', ALOTAU: 'アロタウ', LAE: 'ラエ',
  PORT_MORESBY: 'ポートモレスビー',
}

const STATUS: Readonly<Record<string, string>> = { ADDITION: '（追加）', REVISION: '（更新）', CANCELLATION: '（取消）' }

/** 予想の高さの区分（仕様の 5 区分と、巨大地震のときの定性的な表現） */
const AMPLITUDES: Readonly<Record<string, string>> = {
  '0.3-1M': '0.3〜1m', '1-3M': '1〜3m', '3-5M': '3〜5m', '5-10M': '5〜10m', OVER10M: '10m超', HUGE: '巨大', HIGH: '高い', '----': '----',
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

/** 段落まるごとで決まる文。空白を 1 つに詰めた段落と照らす */
const PARAGRAPHS: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
  [/^AMPL - MAXIMUM AMPLITUDE IN METERS FROM THE UNDISTURBED SEA LEVEL TO THE CREST\.?$/,
    () => '高さは、平常の海面から波の山までの最大値（m）。'],
  [/^ESTIMATION AT FORECAST POINTS - NO TSUNAMI WAVES WITH AN AMPLITUDE OF (\d+(?:\.\d+)?) METERS OR MORE ARE EXPECTED AT ANY FORECAST POINT\.*$/,
    m => `予報地点予測: どの予報地点でも、高さ ${m[1]}m 以上の津波は予想されていない。`],
  [/^IN SOME COASTAL AREAS \(PARTICULARLY NEAR THE EPICENTER\), TSUNAMI WAVES MAY BE HIGHER AND\/OR ARRIVE EARLIER THAN ESTIMATED FOR NEARBY FORECAST POINTS\. AUTHORITIES SHOULD BE AWARE OF THIS POSSIBILITY\.$/,
    () => '一部の沿岸（特に震源の近く）では、近くの予報地点の予想より津波が高くなったり、早く到達したりすることがある。防災機関はこの可能性に注意すること。'],
  [/^HOWEVER, IN SOME COASTAL AREAS \(PARTICULARLY NEAR THE EPICENTER\), HIGHER TSUNAMI WAVES THAN ESTIMATED MAY ARRIVE\. AUTHORITIES SHOULD BE AWARE OF THIS POSSIBILITY\.$/,
    () => 'ただし、一部の沿岸（特に震源の近く）では、予想より高い津波が到達することがある。防災機関はこの可能性に注意すること。'],
  [/^THE EVALUATION OF TSUNAMIGENIC POTENTIAL AND ESTIMATED ARRIVAL TIMES FOR TSUNAMI WAVES MAY ALSO DIFFER FROM THOSE OF PTWC DUE TO DIFFERENCES IN ESTIMATED EARTHQUAKE PARAMETERS AND THE TSUNAMI FORECAST MODEL\. AUTHORITIES SHOULD REFER TO EARLIER ARRIVAL TIMES FOR GREATEST SAFETY\.$/,
    () => '津波発生の可能性の評価と到達予想時刻は、推定した震源要素や津波予測の手法の違いから、太平洋津波警報センター（PTWC）の情報と異なることがある。防災機関は、安全のため早いほうの到達時刻を参照すること。'],
  [/^MAXIMUM TSUNAMI WAVE -{1,2} HALF THE AMPLITUDE FROM THE TROUGH TO THE CREST\.?$/,
    () => '最大波の高さは、波の谷から山までの高さの半分。'],
  [/^THIS WILL BE THE FINAL BULLETIN UNLESS CHANGES IN THE POTENTIAL FOR TSUNAMI GENERATION ARE DEEMED POSSIBLE BASED ON EARTHQUAKE RE-EVALUATION OR REPORTS INDICATING TSUNAMI OBSERVATION ARE RECEIVED\.$/,
    () => '地震の再評価で津波発生の可能性が変わる場合や、津波を観測したという報告を受けた場合を除き、これを最終報とする。'],
  [/^THIS INFORMATION IS BASED ON THE PREDEFINED MAGNITUDE\.?$/,
    () => 'この情報は、あらかじめ想定したマグニチュードに基づく。'],
  [/^PART (\d+) OF (\d+) PARTS$/, m => `分割 ${m[1]}/${m[2]}`],
]

const pad2 = (n: number) => String(n).padStart(2, '0')
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 表を電文の文字列で引く。表が自分で持つ鍵だけを見る（`constructor` などの継いだ名前で引けてしまわないように） */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

/** `hhmm` と日が時刻として正しいか（`2561`・`0` 日のような値を、Date が繰り上げて別の時刻にしないように） */
function validTime(hhmm: string, day: string): boolean {
  const h = Number(hhmm.slice(0, 2))
  const mi = Number(hhmm.slice(2, 4))
  const d = Number(day)
  return h <= 23 && mi <= 59 && d >= 1 && d <= 31
}

/** 「2021年1月21日 21時47分（日本時間）」。`hhmmZ DD MMM YYYY` を読めなければ null */
function fullTimeJst(hhmm: string, day: string, mon: string, year: string): string | null {
  const month = lookup(MONTHS, mon)
  if (!month || !validTime(hhmm, day)) return null
  const ms = Date.UTC(Number(year), month - 1, Number(day), Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4)))
  if (!Number.isFinite(ms)) return null
  // 2 月 31 日のような無い日付は、Date が翌月へ繰り上げるので月で見分ける
  if (new Date(ms).getUTCMonth() !== month - 1) return null
  const d = new Date(ms + 9 * 3600_000)
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${d.getUTCHours()}時${pad2(d.getUTCMinutes())}分（日本時間）`
}

/**
 * 「7月30日10時30分（日本時間）」。年の無い `hhmmZ DD MMM`（到達時刻・観測時刻）は、発表時刻の年から補う。
 * 発表の月から 6 か月を超えて離れた月は、年をまたいだとみて前後の年にする（12 月の地震を 1 月に報じた形など）。
 * 無い日付（2 月 31 日など）は訳さない。
 */
function dayTimeJst(hhmm: string, day: string, mon: string, issuedMs: number): string | null {
  const month = lookup(MONTHS, mon)
  if (!month || !validTime(hhmm, day) || !Number.isFinite(issuedMs)) return null
  const issued = new Date(issuedMs)
  let year = issued.getUTCFullYear()
  const diff = month - (issued.getUTCMonth() + 1)
  if (diff > 6) year -= 1
  else if (diff < -6) year += 1
  const ms = Date.UTC(year, month - 1, Number(day), Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4)))
  if (new Date(ms).getUTCMonth() !== month - 1) return null
  const d = new Date(ms + 9 * 3600_000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日${d.getUTCHours()}時${pad2(d.getUTCMinutes())}分（日本時間）`
}

/** 「北緯24.0度 東経121.6度」。`24.0N`・`121.6E` を読む */
function coordinates(lat: string, lon: string): string {
  const la = /^(\d+(?:\.\d+)?)([NS])$/.exec(lat)
  const lo = /^(\d+(?:\.\d+)?)([EW])$/.exec(lon)
  if (!la || !lo) return `${lat} ${lon}`
  return `${la[2] === 'N' ? '北緯' : '南緯'}${deg(la[1])}度 ${lo[2] === 'E' ? '東経' : '西経'}${deg(lo[1])}度`
}

/** 電文の度の値。先頭の 0 だけ落とし、小数点以下は電文のまま残す（`07.2` → `7.2`・`23.0` → `23.0`） */
const deg = (v: string) => v.replace(/^0+(?=\d)/, '')

const signedDeg = (value: string, hemi: string) => Number(value) * (hemi === 'S' || hemi === 'W' ? -1 : 1)

/** 段落（空行で区切った行のまとまり）ごとに訳す */
export function translateWepa60(text: string, issuedAtIso: string, ctx: Wepa60TranslateContext): Wepa60TranslatedLine[] {
  const issuedMs = Date.parse(issuedAtIso)
  const out: Wepa60TranslatedLine[] = []
  const ok = (t: string) => out.push({ text: t, untranslated: false })
  const keep = (t: string) => out.push({ text: t, untranslated: true })

  /** 地点の行（予想の表・観測の表で共通）: 名前と座標を訳し、残りは呼び出し側が訳す */
  const pointRow = (line: string): { head: string, rest: string, known: boolean } | null => {
    const m = /^\s*(\S+)\s+(\d+(?:\.\d+)?[NS])\s+(\d+(?:\.\d+)?[EW])\s*(.*)$/.exec(line)
    if (!m) return null
    const lat = signedDeg(m[2].slice(0, -1), m[2].slice(-1))
    const lon = signedDeg(m[3].slice(0, -1), m[3].slice(-1))
    // 名簿の予報地点でなければ、座標から日本の津波観測点を引く。候補が 2 つ以上あった地点は、取り違えても
    // 原文の名前が残るよう英語名を添える（2026-11-08 ユーザー選択「候補が 2 つなら英語名を添える (Recommended)」）
    const forecastPoint = lookup(FORECAST_POINTS, m[1])
    const station = forecastPoint === undefined ? ctx.tsunamiStationNameAt?.(lat, lon) : undefined
    const ja = forecastPoint ?? (station && (station.ambiguous ? `${station.name}（${m[1]}）` : station.name))
    return { head: `${ja ?? m[1]}　${coordinates(m[2], m[3])}`, rest: m[4].trim(), known: ja !== undefined }
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  let blockIndex = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') { ok(''); i++; continue }
    const block: string[] = []
    while (i < lines.length && lines[i].trim() !== '') block.push(lines[i++])
    translateBlock(block, blockIndex++ === 0)
  }
  return out

  function translateBlock(block: readonly string[], isHead: boolean): void {
    const first = squash(block[0])
    if (isHead) { block.forEach(headLine); return }
    if (/^HYPOCENTRAL PARAMETERS/.test(first)) { hypocenter(block); return }
    if (first === 'EVALUATION') {
      ok('評価')
      const e = evaluationFromSentence(block.slice(1).join(' '))
      if (e) ok(EVALUATION_TEXT[e])
      else block.slice(1).forEach(l => keep(l.trim()))
      return
    }
    if (first === 'THIS BULLETIN IS FOR') {
      ok('対象地域')
      for (const l of block.slice(1)) {
        const m = /^(.*?)\s*(?:\((ADDITION|REVISION|CANCELLATION)\))?$/.exec(squash(l))!
        const ja = lookup(COASTAL_BLOCKS, m[1])
        if (ja) ok(`${ja}${m[2] ? STATUS[m[2]] : ''}`)
        else keep(l.trim())
      }
      return
    }
    if (/^(ESTIMATED TSUNAMI ARRIVAL TIMES AND WAVE AMPLITUDES|MEASUREMENTS OR REPORTS OF TSUNAMI)\b/.test(first)
      || block.some(l => /^\s*LOCATION\s+COORDINATES/.test(l))) { table(block); return }
    if (block.length === 1 && first === '=') { ok('='); return }
    const joined = squash(block.join(' '))
    for (const [re, make] of PARAGRAPHS) {
      const m = re.exec(joined)
      if (m) { ok(make(m)); return }
    }
    block.forEach(l => keep(l.trim()))
  }

  function headLine(line: string): void {
    const s = squash(line)
    let m: RegExpExecArray | null
    if (/^WEPA60 \w+ \d{6}$/.test(s)) { ok(s); return }
    if ((m = /^TSUNAMI BULLETIN NUMBER (\d+)$/.exec(s))) { ok(`北西太平洋津波情報 第${Number(m[1])}報`); return }
    if (s === 'ISSUED BY NWPTAC(JMA)') { ok('発表元: 北西太平洋津波情報センター（気象庁）'); return }
    if ((m = /^ISSUED AT (\d{4})Z (\d{1,2}) ([A-Z]{3}) (\d{4})$/.exec(s))) {
      const t = fullTimeJst(m[1], m[2], m[3], m[4])
      if (t) { ok(`発表時刻: ${t}`); return }
    }
    keep(line.trim())
  }

  function hypocenter(block: readonly string[]): void {
    // 見出しは全体で照らす。書式の外の語が付いていたら推して訳さず、見出しの行を英語のまま残す
    const head = /^HYPOCENTRAL PARAMETERS(?: \((ADDITION|REVISION|CANCELLATION)\))?$/.exec(squash(block[0]))
    if (head) ok(`震源要素${head[1] ? STATUS[head[1]] : ''}`)
    else keep(block[0].trim())
    let regionLine = 0
    for (const line of block.slice(1)) {
      const s = squash(line)
      let m: RegExpExecArray | null
      if ((m = /^ORIGIN TIME:\s*(\d{4})Z (\d{1,2}) ([A-Z]{3}) (\d{4})$/.exec(s))) {
        const t = fullTimeJst(m[1], m[2], m[3], m[4])
        if (t) { ok(`地震発生時刻: ${t}`); continue }
      }
      if ((m = /^PRELIMINARY EPICENTER:\s*LAT\s*(\d+(?:\.\d+)?)\s*(NORTH|SOUTH)\s+LON\s*(\d+(?:\.\d+)?)\s*(EAST|WEST)$/.exec(s))) {
        ok(`暫定震央: ${m[2] === 'NORTH' ? '北緯' : '南緯'}${deg(m[1])}度 ${m[4] === 'EAST' ? '東経' : '西経'}${deg(m[3])}度`)
        regionLine = 1
        continue
      }
      // 震央の次の行は地域名（字下げ・コロン無し）。1 行目は地域、2 行目は地震区
      if (regionLine > 0 && /^\s+\S/.test(line) && !line.includes(':')) {
        // 2 行目の地震区は決めた 8 つ。それ以外でも、同じ名前が気象庁の地名の表にあれば（VANUATU ISLANDS など）その日本語を使う
        const key = s.toUpperCase()
        // 1 行目が表に無ければカードの震央地名で補い、補ったと分かるよう電文の英語名を添える
        // （2026-11-08 ユーザー選択「英語名を添える (Recommended)」）
        const quakeName = ctx.quakeName?.trim()
        const ja = regionLine === 1
          ? (lookup(ctx.regionNames, key) ?? (quakeName ? `${quakeName}（${s}）` : undefined))
          : (lookup(SEISMIC_REGIONS, key) ?? lookup(ctx.regionNames, key))
        if (ja) ok(ja)
        else keep(line.trim())
        regionLine++
        continue
      }
      regionLine = 0
      const parts: string[] = []
      let rest = s
      const depth = /FOCAL DEPTH:\s*(\d+)\s*KM/.exec(rest)
      if (depth) { parts.push(`深さ ${Number(depth[1])}km`); rest = rest.replace(depth[0], '') }
      const mag = /MAG:\s*(OVER 8|\d+(?:\.\d+)?)(?:\s*\((MJMA|MW)\))?/.exec(rest)
      if (mag) {
        const value = mag[1] === 'OVER 8' ? '8 超' : mag[1]
        const kind = mag[2] === 'MJMA' ? '（気象庁マグニチュード）' : mag[2] === 'MW' ? '（モーメントマグニチュード）' : ''
        parts.push(`マグニチュード ${value}${kind}`)
        rest = rest.replace(mag[0], '')
      }
      if (parts.length > 0 && rest.trim() === '') { ok(parts.join('　')); continue }
      const sentence = PARAGRAPHS.find(([re]) => re.test(s))
      if (sentence) { ok(sentence[1](sentence[0].exec(s)!)); continue }
      keep(line.trim())
    }
  }

  function table(block: readonly string[]): void {
    for (const line of block) {
      const s = squash(line)
      const head = /^(ESTIMATED TSUNAMI ARRIVAL TIMES AND WAVE AMPLITUDES|MEASUREMENTS OR REPORTS OF TSUNAMI)(?: \((ADDITION|REVISION|CANCELLATION)\))?$/.exec(s)
      if (head) {
        ok(`${head[1].startsWith('ESTIMATED') ? '予想到達時刻・予想高さ' : '津波観測値'}${head[2] ? STATUS[head[2]] : ''}`)
        continue
      }
      if (/^LOCATION COORDINATES ARRIVAL TIME AMPL$/.test(s)) { ok('地点　座標　到達時刻　高さ'); continue }
      let m: RegExpExecArray | null
      if ((m = /^MAXIMUM TSUNAMI WAVE (\d{4})Z (\d{1,2}) ([A-Z]{3})\s+(\d+(?:\.\d+)?)M$/.exec(s))) {
        const t = dayTimeJst(m[1], m[2], m[3], issuedMs)
        // 高さは電文の書き方のまま（`0.0` を「0」に丸めると「波が無かった」と読めてしまう）
        if (t) { ok(`最大波 ${t} ${m[4]}m`); continue }
      }
      const coast = lookup(COASTAL_BLOCKS, s)
      if (coast) { ok(coast); continue }
      const row = pointRow(line)
      if (row) {
        const flag = /\((ADDITION|REVISION|CANCELLATION)\)$/.exec(row.rest)
        const body = flag ? row.rest.slice(0, flag.index).trim() : row.rest
        const status = flag ? STATUS[flag[1]] : ''
        if (body === '') { (row.known ? ok : keep)(`${row.head}${status}`); continue }
        const t = /^(\d{4})Z (\d{1,2}) ([A-Z]{3})\s+(\S+)$/.exec(squash(body))
        const time = t && dayTimeJst(t[1], t[2], t[3], issuedMs)
        const amp = t && lookup(AMPLITUDES, t[4])
        if (time && amp) { (row.known ? ok : keep)(`${row.head}　${time}　${amp}${status}`); continue }
      }
      keep(line.trim())
    }
  }
}
