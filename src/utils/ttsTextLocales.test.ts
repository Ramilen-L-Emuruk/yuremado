// 日本語以外の語表で、緊急地震速報・地震情報・震度速報・津波・長周期・特別情報・揺れ検知・国際津波関連情報・時報の読み上げ文が
// 承認した文面どおりに組まれることを固定する。
//
// 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（緊急地震速報・地震情報・津波。6 言語）と、2026-11-18 ユーザー選択
// 「この案で入れる (Recommended)」の表（長周期・特別情報・揺れ検知・国際津波関連情報。時報は同日「時刻を数字で書く (Recommended)」）。
// 長周期以降の期待の文は `ttsTextLocalesRest.fixture.ts`。
//
// 長周期以降の分担:
//   正   ＝ 6 言語とも、長周期（2 組目から短く言う・地名は「; 」）・臨時情報・関連解説（号数は半角）・地震回数（単数・1 時台の冠詞）・
//          お知らせ・後発地震・推計震度分布図・揺れ検知（区域名を地名の表で引く。相模湾は震央地名）・国際津波・時報が表の文になる
//   対照 ＝ 日本語の文は今の文のまま（中継へ写した国際津波の日本語の関数と同じ文。取消の理由の前置きの名前も今の名前）
//   安全弁＝ 日本語以外の文に仮名と気象庁の見出し文が入らない。表に無い区域名は日本語の名前のまま読み、記録を 1 度残す
//
// 正・対照・安全弁の分担:
//   正   ＝ 6 言語とも、名乗り・震央・切り替え・対象地方・予想値・取消が表の文になる。地震情報・震度速報の報（初報・続報・取消・
//          震源名が無い・規模が数値でない・未入電・遠地地震・種類を名指しした取消）が表の文になる。津波の報（発表・引き下げ・
//          区域ごとの等級の動き・予想波高の変化・失効時刻・観測・到達・欠測・満潮時刻・取消・解除）が表の文になる
//   対照 ＝ 日本語の組は今の文のまま（区切りを足しても連結と変わらない・取消の理由は気象庁の文を読む・遠地地震は付加文の原文を読む・
//          津波の避難の文と見出し文は気象庁の文を読む）
//   安全弁＝ 気象庁の文を読まない言語は、長い理由でも別の発話へ回さない（日本語の文を声にしない）。地震情報・津波の文に気象庁の原文
//          （日本語）が入らない。既読の鍵は言語によらず日本語と同じ。訳せない値は 1 度だけ警告して読む
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { log, UNREADABLE_VALUE_LOG_KINDS } from './logger'
import { readFileSync } from 'node:fs'
import { createSpeechText, speechTextFor, resetUntranslatedValueLogGates, JA_SPEECH_TEXT, type SpeechText, type TtsSpeechOptions } from './ttsText'
import { joinSegments, type SpeechSegment } from './ttsFollow'
import { jaSpeech, type SpeechWords, type QuakeOccurrenceTexts } from '../i18n/speechWords'
import { enSpeech } from '../i18n/speech/en'
import { zhHansSpeech } from '../i18n/speech/zhHans'
import { zhHantSpeech } from '../i18n/speech/zhHant'
import { koSpeech } from '../i18n/speech/ko'
import { ptBRSpeech } from '../i18n/speech/ptBR'
import { esSpeech } from '../i18n/speech/es'
import { JA_PLACE_NAMES, placeNameLookup, validatePlaceNameTable } from '../i18n/placeNames'
import type { Locale } from '../i18n/messages'
import type { EEWAlert, EarthquakePoint, IntensityScale, IssueType, JMAEarthquakeCount, JMAInternationalTsunami, JMAKohatsu, JMALpgm, JMANankai, JMANankaiCommentary, JMAQuakeNotice, JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation, TsunamiSourceEarthquake } from '../types/earthquake'
import { internationalTsunamiToText as relayInternationalTsunamiToText } from './internationalTsunamiSpeech'
import { timeSignalSpeechText, type TimeSignalClock, type TimeSignalPhrase } from './timeSignal'
import { EXPECTED_REST } from './ttsTextLocalesRest.fixture'

type OtherLocale = Exclude<Locale, 'ja'>
const SPEECH_WORDS_BY_LOCALE: Readonly<Record<OtherLocale, SpeechWords>> = {
  en: enSpeech, 'zh-Hans': zhHansSpeech, 'zh-Hant': zhHantSpeech, ko: koSpeech, 'pt-BR': ptBRSpeech, es: esSpeech,
}
const LOCALES = Object.keys(SPEECH_WORDS_BY_LOCALE) as OtherLocale[]

/** その言語の語表（全区分を訳し終えた形） */
function wordsWithDraft(locale: OtherLocale): SpeechWords {
  return SPEECH_WORDS_BY_LOCALE[locale]
}

/** その言語の組（地名は画面の言語の表から引く） */
function speechTextWithDraft(locale: OtherLocale): SpeechText {
  const table: unknown = JSON.parse(readFileSync(new URL(`../../public/data/place-names/${locale}.json`, import.meta.url), 'utf8'))
  validatePlaceNameTable(table)
  return createSpeechText(wordsWithDraft(locale), placeNameLookup(table), locale)
}

const EVENT: EEWAlert = {
  kind: 'eew', origin: 'test', id: 'locale-test', time: '', test: true,
  earthquake: {
    originTime: '', arrivalTime: '', condition: '',
    hypocenter: { name: '三陸沖', latitude: 38.5, longitude: 143.0, depth: 10, magnitude: 7.2 },
  },
  severity: 'Warning', cancelled: false,
}

/** 取り消された報の発表時刻（端末の時刻帯で 12:40） */
const FIRST_ISSUE = new Date(2026, 0, 1, 12, 40).toISOString()
const REASON = 'システムの障害により誤った情報を発表しました。'

/** 表の文（2026-11-17 承認）。キーは下の it が組む文 */
const EXPECTED: Record<OtherLocale, Record<string, string>> = {
  en: {
    warning: 'Earthquake Early Warning. Earthquake: Off the Coast of Sanriku.',
    forecast: 'Ground motion forecast. Earthquake: Off the Coast of Sanriku.',
    hypocenterUpdate: 'Hypocenter updated. Earthquake: Off the Coast of Sanriku.',
    regions: 'Upgraded to an Earthquake Early Warning. Tohoku, Kanto: watch out for strong tremors.',
    regionsAdditional: 'Also Tohoku, Kanto: watch out for strong tremors.',
    intensity: 'Maximum forecast intensity 6 Upper. Maximum forecast long-period ground motion class 3.',
    intensityAbove: 'Maximum forecast intensity about 5 Lower or higher. Maximum forecast long-period ground motion class about 3 or higher.',
    cancelledAt: "The Earthquake Early Warning issued at 12:40 has been cancelled. JMA's original text is in the Telegram Log.",
    cancelled: 'The Earthquake Early Warning has been cancelled.',
  },
  'zh-Hans': {
    warning: '紧急地震警报。三陆冲发生地震。',
    forecast: '地震动预报。三陆冲发生地震。',
    hypocenterUpdate: '震源已更新。三陆冲发生地震。',
    regions: '已升级为紧急地震警报。东北、关东：请注意强烈震动。',
    regionsAdditional: '新增东北、关东：请注意强烈震动。',
    intensity: '预测最大烈度6强。预测最大长周期地震动等级3。',
    intensityAbove: '预测最大烈度约5弱以上。预测最大长周期地震动等级约3以上。',
    cancelledAt: '12时40分发布的紧急地震警报已解除。日本气象局的原文在电文记录中。',
    cancelled: '紧急地震警报已解除。',
  },
  'zh-Hant': {
    warning: '緊急地震警報。三陸沖發生地震。',
    forecast: '地震動預報。三陸沖發生地震。',
    hypocenterUpdate: '震源已更新。三陸沖發生地震。',
    regions: '已升級為緊急地震警報。東北、關東：請警戒強烈的震動。',
    regionsAdditional: '新增東北、關東：請警戒強烈的震動。',
    intensity: '預測最大震度6強。預測最大長週期地震動等級3。',
    intensityAbove: '預測最大震度約5弱以上。預測最大長週期地震動等級約3以上。',
    cancelledAt: '已取消12時40分發表的緊急地震警報。日本氣象局的原文在電文紀錄中。',
    cancelled: '已取消緊急地震警報。',
  },
  ko: {
    warning: '긴급 지진 속보. 산리쿠 앞바다에 지진 발생.',
    forecast: '지진동 예보. 산리쿠 앞바다에 지진 발생.',
    hypocenterUpdate: '진원 갱신. 산리쿠 앞바다에 지진 발생.',
    regions: '긴급 지진 속보로 전환되었습니다. 도호쿠, 간토에서는 강한 흔들림을 주의하십시오.',
    regionsAdditional: '새로 도호쿠, 간토에서도 강한 흔들림을 주의하십시오.',
    intensity: '예상 최대 진도 6강. 예상 최대 장주기 지진동 계급 3.',
    intensityAbove: '예상 최대 진도 5약 정도 이상. 예상 최대 장주기 지진동 계급 3 정도 이상.',
    cancelledAt: '12시 40분에 발표된 긴급 지진 속보는 취소되었습니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
    cancelled: '긴급 지진 속보는 취소되었습니다.',
  },
  'pt-BR': {
    warning: 'Alerta Urgente de Terremoto. Terremoto: Ao largo da costa de Sanriku.',
    forecast: 'Previsão de movimento sísmico. Terremoto: Ao largo da costa de Sanriku.',
    hypocenterUpdate: 'Hipocentro atualizado. Terremoto: Ao largo da costa de Sanriku.',
    regions: 'Elevado para Alerta Urgente de Terremoto. Tohoku, Kanto: fique alerta a fortes tremores.',
    regionsAdditional: 'Também Tohoku, Kanto: fique alerta a fortes tremores.',
    intensity: 'Intensidade máxima prevista 6 forte. Classe máxima prevista de movimento sísmico de longo período 3.',
    intensityAbove: 'Intensidade máxima prevista cerca de 5 fraco ou superior. Classe máxima prevista de movimento sísmico de longo período cerca de 3 ou superior.',
    cancelledAt: 'O Alerta Urgente de Terremoto emitido às 12:40 foi cancelado. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
    cancelled: 'O Alerta Urgente de Terremoto foi cancelado.',
  },
  es: {
    warning: 'Alerta Temprana de Terremoto. Terremoto: Alta mar de Sanriku.',
    forecast: 'Pronóstico del movimiento sísmico. Terremoto: Alta mar de Sanriku.',
    hypocenterUpdate: 'Hipocentro actualizado. Terremoto: Alta mar de Sanriku.',
    regions: 'Elevado a Alerta Temprana de Terremoto. Tohoku, Kanto: manténgase alerta contra fuertes temblores.',
    regionsAdditional: 'También Tohoku, Kanto: manténgase alerta contra fuertes temblores.',
    intensity: 'Intensidad máxima prevista 6 fuerte. Clase máxima prevista de movimiento sísmico de período largo 3.',
    intensityAbove: 'Intensidad máxima prevista alrededor de 5 débil o superior. Clase máxima prevista de movimiento sísmico de período largo alrededor de 3 o superior.',
    cancelledAt: 'La Alerta Temprana de Terremoto emitida a las 12:40 fue cancelada. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
    cancelled: 'La Alerta Temprana de Terremoto fue cancelada.',
  },
}

/** 表の各行を、実運用と同じ関数から組む */
function produce(st: SpeechText): Record<string, string> {
  return {
    warning: st.eewAlertToText(EVENT, 'warning'),
    forecast: st.eewAlertToText(EVENT, 'forecast'),
    hypocenterUpdate: st.eewAlertToText(EVENT, 'hypocenterUpdate'),
    regions: st.eewWarningRegionsText(['東北', '関東'], false, true),
    regionsAdditional: st.eewWarningRegionsText(['東北', '関東'], true),
    intensity: st.eewIntensityText({ scale: 60, orAbove: false }, 3, EVENT, false),
    intensityAbove: st.eewIntensityText({ scale: 45, orAbove: true }, 3, EVENT, false, false, true),
    cancelledAt: st.eewCancelToText({ ...EVENT, cancelled: true, cancelText: REASON }, FIRST_ISSUE),
    cancelled: st.eewCancelToText({ ...EVENT, cancelled: true }, null),
  }
}

describe('日本語以外の緊急地震速報の読み上げ文（2026-11-17 承認の表）', () => {
  it.each(LOCALES)('%s: 組を作れる（語表を足した言語で createSpeechText が投げない）', (locale) => {
    expect(() => speechTextWithDraft(locale)).not.toThrow()
  })

  // `canBuildSpeechText` は日本語の地名の引きで 1 度だけ試し、本物の引きで作る `speechTextFor` と結果が食い違わないとしている。
  // その前提（組を作るときに地名の引きを呼ばない）を固定する
  it.each(LOCALES)('%s: 組を作るときに地名の引きを呼ばない（安全弁）', (locale) => {
    const words = wordsWithDraft(locale)
    const throwing = Object.assign(() => { throw new Error('組を作るときに呼ばれた') }, { has: () => { throw new Error('組を作るときに呼ばれた') } })
    expect(() => createSpeechText(words, throwing, locale)).not.toThrow()
    expect(() => createSpeechText(jaSpeech, throwing, 'ja')).not.toThrow()
  })

  it.each(LOCALES)('%s: 表の文になる（正）', (locale) => {
    expect(produce(speechTextWithDraft(locale))).toEqual(EXPECTED[locale])
  })

  // 読む側は、組で組んだ文にその組の `locale` を添えて声を選ぶ（→ `useLiveEventHandler.ts` の `SpokenText`）
  it.each(LOCALES)('%s: 組は自分の言語を持つ（正）', (locale) => {
    expect(speechTextWithDraft(locale).locale).toBe(locale)
  })

  it.each(LOCALES)('%s: 語表が無く日本語の組へ落ちたときは、組の言語も日本語（安全弁。日本語の文に別の言語の声を付けない）', (locale) => {
    // 語表がそろうまで `speechTextFor` は日本語以外でも日本語の組を返す（→ `i18n/speechWords.ts`）
    expect(speechTextFor(locale, JA_PLACE_NAMES)).toBe(JA_SPEECH_TEXT)
    expect(speechTextFor(locale, JA_PLACE_NAMES).locale).toBe('ja')
  })

  it.each(LOCALES)('%s: 予想震度が無い報の文（正）', (locale) => {
    const nf = SPEECH_WORDS_BY_LOCALE[locale].eew.noForecast
    // 4 つとも空でなく、互いに違う（理由を言い分けている）
    const all = [nf.singleStation, nf.deep, nf.belowScale1, nf.unknown]
    expect(all.every(s => s.trim() !== '')).toBe(true)
    expect(new Set(all).size).toBe(4)
  })

  it.each(LOCALES)('%s: 長い取消の理由も別の発話へ回さない（安全弁。日本語の文を声にしない）', (locale) => {
    const st = speechTextWithDraft(locale)
    const longReason = 'あ'.repeat(st.CANCEL_REASON_INLINE_MAX_CHARS + 1) + '。'
    expect(st.deferredCancelReasonToSpeak('緊急地震速報', longReason)).toBeNull()
    expect(st.eewCancelToText({ ...EVENT, cancelled: true, cancelText: longReason }, null))
      .toBe(`${EXPECTED[locale].cancelled}${SPEECH_WORDS_BY_LOCALE[locale].common.sentenceSep}${SPEECH_WORDS_BY_LOCALE[locale].common.telegramTextElsewhere}`)
  })

  it.each(LOCALES)('%s: 警報の締めの句は文の中にそのまま入る（鳴った文の判定が部分一致で見るため）', (locale) => {
    const st = speechTextWithDraft(locale)
    expect(st.eewWarningRegionsText(['東北'], false)).toContain(st.EEW_WARNING_REGIONS_CLOSING)
    expect(st.eewWarningRegionsText(['東北'], true)).toContain(st.EEW_WARNING_REGIONS_CLOSING)
    expect(st.eewWarningRegionsText(['東北'], false, true).startsWith(st.EEW_UPGRADE_PHRASE)).toBe(true)
  })
})

// ---- 地震情報・震度速報 ----

/** 地震の発生時刻（端末の時刻帯で 9 日 12:34）と、取り消された報の発表時刻（12:40） */
const QUAKE_TIME = new Date(2026, 10, 9, 12, 34).toISOString()
const QUAKE_REPORT_TIME = new Date(2026, 10, 9, 12, 40).toISOString()
/** 遠地地震の付加文（気象庁が書いた日本語の文） */
const DISTANT_FORECAST = '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。'

function area(pref: string, addr: string, scale: number): EarthquakePoint {
  return { pref, addr, isArea: true, scale: scale as IntensityScale }
}
function unreceivedStation(pref: string, addr: string): EarthquakePoint {
  return { pref, addr, isArea: false, scale: 45, unreceived: true }
}

/**
 * 地震情報の電文。震源の座標を 0 にして震源距離での並べ替えを通さず、地名の並びを `points` の順に固定する
 * （並べ替えはこのテストの対象ではない）
 */
function quakeOf(type: IssueType, points: EarthquakePoint[], over: Partial<JMAQuake['earthquake']> = {}, extra: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake', id: 'locale-quake', time: QUAKE_REPORT_TIME,
    issue: { source: '気象庁', time: QUAKE_REPORT_TIME, type, correct: 'なし' },
    earthquake: {
      time: QUAKE_TIME,
      hypocenter: { name: '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 },
      maxScale: 60 as IntensityScale,
      domesticTsunami: 'なし',
      domesticTsunamiCode: '0215',
      ...over,
    },
    points,
    ...extra,
  }
}

const NO_HYPOCENTER = { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN }
const OBSERVED = [area('石川県', '石川県能登', 60), area('富山県', '富山県東部', 50)]
const UNRECEIVED = [
  unreceivedStation('石川県', '輪島市鳳至町'),
  unreceivedStation('石川県', '輪島市門前町走出'),
  unreceivedStation('石川県', '七尾市田鶴浜町'),
]
/** 階級を 3 つまで、地名を 1 つまで読む（未入電の「ほか2地点」を出すため） */
const QUAKE_OPTS: TtsSpeechOptions = { intensityLevels: 2, maxRegions: 1, alwaysReadScale: -1, alwaysReadLpgmClass: -1, regionTolerance: 0 }
/** 地名を上限なしで読む（同じ階級の地名の区切り `regionSep` を出すため） */
const ALL_REGIONS_OPTS: TtsSpeechOptions = { ...QUAKE_OPTS, maxRegions: 0 }

/** 文の終わりの語が持つ空白（英韓葡西）は、発話の末尾では余るので外して比べる */
function textOf(segments: readonly SpeechSegment[]): string {
  return joinSegments(segments).trimEnd()
}

/** 表 12 節の例の報と、14 節で決めた形を、実運用と同じ関数から組む */
function produceQuake(st: SpeechText): Record<string, string> {
  const quake = quakeOf('震源・震度情報', [...OBSERVED, ...UNRECEIVED])
  const state = st.createQuakeSpokenState()
  const first = st.earthquakeToSegments(quake, QUAKE_OPTS, true, state)
  st.applySpokenRefs(state, first.flatMap(s => s.refs))
  const update = quakeOf('震源・震度情報', [...OBSERVED, area('新潟県', '新潟県上越', 45), ...UNRECEIVED], {
    hypocenter: { name: '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: 6.8 },
  })
  return {
    intensityReport: textOf(st.earthquakeToSegments(quakeOf('震度速報', OBSERVED, { hypocenter: NO_HYPOCENTER }), QUAKE_OPTS, true)),
    regionSep: textOf(st.earthquakeToSegments(
      quakeOf('震度速報', [...OBSERVED, area('石川県', '石川県加賀', 60), unreceivedStation('石川県', '輪島市鳳至町'), unreceivedStation('石川県', '輪島市門前町走出')], { hypocenter: NO_HYPOCENTER }),
      ALL_REGIONS_OPTS, true,
    )),
    quake: textOf(first),
    update: textOf(st.earthquakeToSegments(update, QUAKE_OPTS, false, state)),
    cancelled: st.earthquakeCancelToText(QUAKE_REPORT_TIME, REASON),
    reportCancelledAt: st.earthquakeReportCancelToText('震度速報', QUAKE_REPORT_TIME),
    reportCancelled: st.earthquakeReportCancelToText('震源・震度情報', null),
    noName: textOf(st.earthquakeToSegments(quakeOf('震源情報', [], { hypocenter: { ...NO_HYPOCENTER, magnitude: 6.5 } }), QUAKE_OPTS, true)),
    magnitudeCondition: textOf(st.earthquakeToSegments(
      quakeOf('震源情報', [], { hypocenter: { name: '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: NaN, magnitudeCondition: 'Ｍ不明' } }),
      QUAKE_OPTS, true,
    )),
    unreceivedCountOnly: textOf(st.earthquakeToSegments(
      quakeOf('震源・震度情報', [...OBSERVED, ...UNRECEIVED]), { ...QUAKE_OPTS, unreceivedDetail: 'none' }, true,
    )),
    // 付加文 0226 0230 の電文で、022x の欄を持たないカード（日本語以外は、原文の中のコード表の文から 0226 を、区分を決めた
    // コード 0230 の文と一緒に原文の順で訳して読み、在処を続ける）
    distant: textOf(st.earthquakeToSegments(
      quakeOf('遠地地震', [], { hypocenter: { name: 'インドネシア付近', latitude: 0, longitude: 0, depth: -1, magnitude: 7.4 }, maxScale: -1 as IntensityScale, domesticTsunamiCode: '0230' }, { forecastText: DISTANT_FORECAST }),
      QUAKE_OPTS, true,
    )),
    prominent: textOf(st.earthquakeToSegments(
      quakeOf('顕著な地震の震源要素更新のお知らせ', [], { hypocenter: { name: '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: 6.8 } }),
      QUAKE_OPTS, true,
    )),
  }
}

/**
 * 表の文（2026-11-17 承認。14 節の決め —— 発生の文の語順・英語の名乗り・地名の区切り「; 」・遠地地震の付加文・
 * 種類を名指しした取消の名前 —— と、同日の「階級ごとに文を切る (Recommended)」（英葡西）を当てた形）。キーは {@link produceQuake} が組む文。地名は地名の表（`public/data/place-names/`）の値
 */
const EXPECTED_QUAKE: Record<OtherLocale, Record<string, string>> = {
  en: {
    intensityReport: 'Seismic Intensity Information. Maximum intensity 6 Upper observed: Noto, Ishikawa Prefecture. Intensity 5 Upper observed: Eastern Toyama Prefecture.',
    regionSep: 'Seismic Intensity Information. Maximum intensity 6 Upper observed: Noto, Ishikawa Prefecture; Kaga, Ishikawa Prefecture. Intensity 5 Upper observed: Eastern Toyama Prefecture. Wajima-shi Fugeshimachi; Wajima-shi Monzemmachi-hashiride: estimated at intensity 5 Lower or higher, but the intensity has not been received.',
    quake: 'Earthquake and Seismic Intensity Information. Around 12:34, an earthquake of magnitude 6.5 occurred. Hypocenter: Noto, Ishikawa Prefecture, depth 10 kilometers. This earthquake poses no tsunami risk. Maximum intensity 6 Upper observed: Noto, Ishikawa Prefecture. Intensity 5 Upper observed: Eastern Toyama Prefecture. Wajima-shi Fugeshimachi, and 2 other stations: estimated at intensity 5 Lower or higher, but the intensity has not been received.',
    update: 'The Earthquake and Seismic Intensity Information has been updated. The magnitude has been updated to 6.8. Newly, Intensity 5 Lower observed: Joetsu, Niigata Prefecture.',
    cancelled: 'The Earthquake Information issued at 12:40 has been cancelled. JMA\'s original text is in the Telegram Log.',
    reportCancelledAt: 'The Seismic Intensity Information issued at 12:40 has been cancelled.',
    reportCancelled: 'The Earthquake and Seismic Intensity Information has been cancelled.',
    noName: 'Earthquake Information. Around 12:34, an earthquake of magnitude 6.5 occurred. This earthquake poses no tsunami risk.',
    magnitudeCondition: 'Earthquake Information. Around 12:34, an earthquake occurred. Hypocenter: Noto, Ishikawa Prefecture, depth 10 kilometers. The magnitude is unknown. This earthquake poses no tsunami risk.',
    unreceivedCountOnly: 'Earthquake and Seismic Intensity Information. Around 12:34, an earthquake of magnitude 6.5 occurred. Hypocenter: Noto, Ishikawa Prefecture, depth 10 kilometers. This earthquake poses no tsunami risk. Maximum intensity 6 Upper observed: Noto, Ishikawa Prefecture. Intensity 5 Upper observed: Eastern Toyama Prefecture. At 3 stations, intensity 5 Lower or higher is estimated, but the intensity has not been received.',
    distant: 'Distant Earthquake Information. Around 12:34 on the 9th, an earthquake of magnitude 7.4 occurred. Hypocenter: Adjacent Indonesia. There is a possibility of a tsunami near the hypocenter. This earthquake has no tsunami impact on Japan. JMA\'s original text is in the Telegram Log.',
    prominent: 'Notice of Updated Hypocenter of a Significant Earthquake. Earthquake at around 12:34: Noto, Ishikawa Prefecture. Hypocenter depth updated to 10 kilometers, magnitude updated to 6.8.',
  },
  'zh-Hans': {
    intensityReport: '烈度速报。观测到最大烈度6强：石川县能登地方、观测到烈度5强：富山县东部。',
    regionSep: '烈度速报。观测到最大烈度6强：石川县能登地方、石川县加贺地方、观测到烈度5强：富山县东部。轮岛市凤至町、轮岛市门前町走出：推定烈度为5弱以上，但尚未收到烈度。',
    quake: '地震信息。12时34分左右，石川县能登地方，深度10公里处发生了震级6.5的地震。此次地震无海啸之忧。观测到最大烈度6强：石川县能登地方、观测到烈度5强：富山县东部。轮岛市凤至町、另外2个地点：推定烈度为5弱以上，但尚未收到烈度。',
    update: '地震信息已更新。震级已更新为6.8。新增观测到烈度5弱：新泻县上越地方。',
    cancelled: '12时40分发布的地震信息已取消。日本气象局的原文在电文记录中。',
    reportCancelledAt: '12时40分发布的烈度速报已取消。',
    reportCancelled: '震源、烈度信息已取消。',
    noName: '震源信息。12时34分左右，发生了震级6.5的地震。此次地震无海啸之忧。',
    magnitudeCondition: '震源信息。12时34分左右，石川县能登地方，深度10公里处发生了地震。震级不明。此次地震无海啸之忧。',
    unreceivedCountOnly: '地震信息。12时34分左右，石川县能登地方，深度10公里处发生了震级6.5的地震。此次地震无海啸之忧。观测到最大烈度6强：石川县能登地方、观测到烈度5强：富山县东部。3个地点推定烈度为5弱以上，但尚未收到烈度。',
    distant: '远地地震信息。9日12时34分左右，印度尼西亚附近发生了震级7.4的地震。震源附近可能发生海啸。此次地震对日本无海啸影响。日本气象局的原文在电文记录中。',
    prominent: '显著地震震源要素更新通知。关于12时34分左右发生的石川县能登地方的地震，震源深度更新为10公里，震级更新为6.8。',
  },
  'zh-Hant': {
    intensityReport: '震度速報。觀測到最大震度6強：石川縣能登地方、觀測到震度5強：富山縣東部。',
    regionSep: '震度速報。觀測到最大震度6強：石川縣能登地方、石川縣加賀地方、觀測到震度5強：富山縣東部。輪島市鳳至町、輪島市門前町走出：推定震度為5弱以上，但尚未收到震度。',
    quake: '地震訊息。12時34分左右，石川縣能登地方，深度10公里處發生了規模6.5的地震。此次地震無海嘯之虞。觀測到最大震度6強：石川縣能登地方、觀測到震度5強：富山縣東部。輪島市鳳至町、另外2個地點：推定震度為5弱以上，但尚未收到震度。',
    update: '地震訊息已更新。規模已更新為6.8。新增觀測到震度5弱：新潟縣上越地方。',
    cancelled: '已取消12時40分發表的地震訊息。日本氣象局的原文在電文紀錄中。',
    reportCancelledAt: '已取消12時40分發表的震度速報。',
    reportCancelled: '已取消震源、震度訊息。',
    noName: '震源訊息。12時34分左右，發生了規模6.5的地震。此次地震無海嘯之虞。',
    magnitudeCondition: '震源訊息。12時34分左右，石川縣能登地方，深度10公里處發生了地震。規模不明。此次地震無海嘯之虞。',
    unreceivedCountOnly: '地震訊息。12時34分左右，石川縣能登地方，深度10公里處發生了規模6.5的地震。此次地震無海嘯之虞。觀測到最大震度6強：石川縣能登地方、觀測到震度5強：富山縣東部。3個地點推定震度為5弱以上，但尚未收到震度。',
    distant: '遠地地震訊息。9日12時34分左右，印尼附近發生了規模7.4的地震。震源附近可能發生海嘯。此次地震對日本無海嘯影響。日本氣象局的原文在電文紀錄中。',
    prominent: '顯著地震震源要素更新通知。關於12時34分左右發生的石川縣能登地方的地震，震源深度更新為10公里，規模更新為6.8。',
  },
  ko: {
    intensityReport: '진도 속보. 최대 진도 6강을 이시카와현 노토 지방, 진도 5강을 도야마현 동부에서 관측했습니다.',
    regionSep: '진도 속보. 최대 진도 6강을 이시카와현 노토 지방, 이시카와현 카가 지방, 진도 5강을 도야마현 동부에서 관측했습니다. 와지마시 후게시마치, 와지마시 몬젠마치하시리데에서는 진도 5약 이상으로 추정되지만, 미수신입니다.',
    quake: '지진 정보. 12시 34분경, 이시카와현 노토 지방, 깊이 10킬로미터를 진원으로 하는 규모 6.5의 지진이 발생했습니다. 이 지진에 의한 지진해일 걱정은 없습니다. 최대 진도 6강을 이시카와현 노토 지방, 진도 5강을 도야마현 동부에서 관측했습니다. 와지마시 후게시마치 외 2개 지점에서는 진도 5약 이상으로 추정되지만, 미수신입니다.',
    update: '지진 정보가 갱신되었습니다. 규모는 6.8로 갱신되었습니다. 새로 진도 5약을 니가타현 조에쓰 지방에서 관측했습니다.',
    cancelled: '12시 40분에 발표된 지진 정보는 취소되었습니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
    reportCancelledAt: '12시 40분에 발표된 진도 속보는 취소되었습니다.',
    reportCancelled: '진원·진도 정보는 취소되었습니다.',
    noName: '진원 정보. 12시 34분경, 규모 6.5의 지진이 발생했습니다. 이 지진에 의한 지진해일 걱정은 없습니다.',
    magnitudeCondition: '진원 정보. 12시 34분경, 이시카와현 노토 지방, 깊이 10킬로미터를 진원으로 하는 지진이 발생했습니다. 규모는 불명입니다. 이 지진에 의한 지진해일 걱정은 없습니다.',
    unreceivedCountOnly: '지진 정보. 12시 34분경, 이시카와현 노토 지방, 깊이 10킬로미터를 진원으로 하는 규모 6.5의 지진이 발생했습니다. 이 지진에 의한 지진해일 걱정은 없습니다. 최대 진도 6강을 이시카와현 노토 지방, 진도 5강을 도야마현 동부에서 관측했습니다. 3개 지점에서는 진도 5약 이상으로 추정되지만, 미수신입니다.',
    distant: '원지 지진 정보. 9일 12시 34분경, 인도네시아 부근을 진원으로 하는 규모 7.4의 지진이 발생했습니다. 진원 부근에서 지진해일이 발생할 가능성이 있습니다. 이 지진에 의한 일본에 대한 지진해일 영향은 없습니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
    prominent: '현저한 지진의 진원 요소 갱신 알림. 12시 34분경 발생한 이시카와현 노토 지방의 지진에 대해, 진원의 깊이 10킬로미터로, 규모 6.8로 갱신되었습니다.',
  },
  'pt-BR': {
    intensityReport: 'Informação sobre intensidade sísmica. Intensidade máxima 6 forte observada: Região de Noto da Província de Ishikawa. Intensidade 5 forte observada: Leste da Província de Toyama.',
    regionSep: 'Informação sobre intensidade sísmica. Intensidade máxima 6 forte observada: Região de Noto da Província de Ishikawa; Região de Kaga da Província de Ishikawa. Intensidade 5 forte observada: Leste da Província de Toyama. Wajima-shi Fugeshimachi; Wajima-shi Monzemmachi-hashiride: estima-se intensidade 5 fraco ou superior, mas a intensidade não foi recebida.',
    quake: 'Informação sobre terremotos. Por volta das 12:34, ocorreu um terremoto de magnitude 6,5. Hipocentro: Região de Noto da Província de Ishikawa, profundidade de 10 quilômetros. Este terremoto não oferece risco de tsunami. Intensidade máxima 6 forte observada: Região de Noto da Província de Ishikawa. Intensidade 5 forte observada: Leste da Província de Toyama. Wajima-shi Fugeshimachi, e mais 2 estações: estima-se intensidade 5 fraco ou superior, mas a intensidade não foi recebida.',
    update: 'A Informação sobre terremotos foi atualizada. A magnitude foi atualizada para 6,8. Pela primeira vez, Intensidade 5 fraco observada: Região de Jōetsu da Província de Niigata.',
    cancelled: 'A Informação sobre terremotos emitida às 12:40 foi cancelada. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
    reportCancelledAt: 'Informação sobre intensidade sísmica, emitida às 12:40: cancelada.',
    reportCancelled: 'Informação sobre o hipocentro e a intensidade sísmica: cancelada.',
    noName: 'Informação sobre o hipocentro. Por volta das 12:34, ocorreu um terremoto de magnitude 6,5. Este terremoto não oferece risco de tsunami.',
    magnitudeCondition: 'Informação sobre o hipocentro. Por volta das 12:34, ocorreu um terremoto. Hipocentro: Região de Noto da Província de Ishikawa, profundidade de 10 quilômetros. A magnitude é desconhecida. Este terremoto não oferece risco de tsunami.',
    unreceivedCountOnly: 'Informação sobre terremotos. Por volta das 12:34, ocorreu um terremoto de magnitude 6,5. Hipocentro: Região de Noto da Província de Ishikawa, profundidade de 10 quilômetros. Este terremoto não oferece risco de tsunami. Intensidade máxima 6 forte observada: Região de Noto da Província de Ishikawa. Intensidade 5 forte observada: Leste da Província de Toyama. Em 3 estações, estima-se intensidade 5 fraco ou superior, mas a intensidade não foi recebida.',
    distant: 'Informação sobre terremoto distante. Por volta das 12:34 do dia 9, ocorreu um terremoto de magnitude 7,4. Hipocentro: Perto da Indonésia. Há possibilidade de tsunami perto do hipocentro. Este terremoto não causa impacto de tsunami no Japão. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
    prominent: 'Aviso de atualização do hipocentro de um terremoto significativo. Terremoto por volta das 12:34: Região de Noto da Província de Ishikawa. Profundidade do hipocentro atualizada para 10 quilômetros, magnitude atualizada para 6,8.',
  },
  es: {
    intensityReport: 'Información de intensidad sísmica. Intensidad máxima 6 fuerte observada: Región Noto, Prefectura de Ishikawa. Intensidad 5 fuerte observada: Este de Prefectura de Toyama.',
    regionSep: 'Información de intensidad sísmica. Intensidad máxima 6 fuerte observada: Región Noto, Prefectura de Ishikawa; Región Kaga, Prefectura de Ishikawa. Intensidad 5 fuerte observada: Este de Prefectura de Toyama. Wajima-shi Fugeshimachi; Wajima-shi Monzemmachi-hashiride: se estima una intensidad de 5 débil o superior, pero la intensidad no se ha recibido.',
    quake: 'Información de terremotos. Alrededor de las 12:34, se produjo un terremoto de magnitud 6,5. Hipocentro: Región Noto, Prefectura de Ishikawa, profundidad de 10 kilómetros. Este terremoto no presenta riesgo de tsunami. Intensidad máxima 6 fuerte observada: Región Noto, Prefectura de Ishikawa. Intensidad 5 fuerte observada: Este de Prefectura de Toyama. Wajima-shi Fugeshimachi, y 2 estaciones más: se estima una intensidad de 5 débil o superior, pero la intensidad no se ha recibido.',
    update: 'Se ha actualizado la Información de terremotos. Se ha actualizado la magnitud a 6,8. Por primera vez, Intensidad 5 débil observada: Región Jyoetsu, Prefectura de Niigata.',
    cancelled: 'La Información de terremotos emitida a las 12:40 fue cancelada. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
    reportCancelledAt: 'Información de intensidad sísmica, emitida a las 12:40: cancelada.',
    reportCancelled: 'Información del hipocentro y la intensidad sísmica: cancelada.',
    noName: 'Información del hipocentro. Alrededor de las 12:34, se produjo un terremoto de magnitud 6,5. Este terremoto no presenta riesgo de tsunami.',
    magnitudeCondition: 'Información del hipocentro. Alrededor de las 12:34, se produjo un terremoto. Hipocentro: Región Noto, Prefectura de Ishikawa, profundidad de 10 kilómetros. La magnitud es desconocida. Este terremoto no presenta riesgo de tsunami.',
    unreceivedCountOnly: 'Información de terremotos. Alrededor de las 12:34, se produjo un terremoto de magnitud 6,5. Hipocentro: Región Noto, Prefectura de Ishikawa, profundidad de 10 kilómetros. Este terremoto no presenta riesgo de tsunami. Intensidad máxima 6 fuerte observada: Región Noto, Prefectura de Ishikawa. Intensidad 5 fuerte observada: Este de Prefectura de Toyama. En 3 estaciones se estima una intensidad de 5 débil o superior, pero la intensidad no se ha recibido.',
    distant: 'Información de terremoto lejano. Alrededor de las 12:34 del día 9, se produjo un terremoto de magnitud 7,4. Hipocentro: Carca de Indonesia. Es posible que se produzca un tsunami cerca del hipocentro. Este terremoto no tiene impacto de tsunami en Japón. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
    prominent: 'Aviso de actualización del hipocentro de un terremoto significativo. Terremoto alrededor de las 12:34: Región Noto, Prefectura de Ishikawa. Profundidad del hipocentro actualizada a 10 kilómetros, magnitud actualizada a 6,8.',
  },
}

/** 続報で初めて観測した地域が 2 階級にまたがる文（階級の境の区切り `intensityGroupSep`） */
const EXPECTED_FRESH_TWO_GROUPS: Record<OtherLocale, string> = {
  en: 'The Seismic Intensity Information has been updated. Newly, Intensity 5 Lower observed: Joetsu, Niigata Prefecture. Newly, Intensity 4 observed: Chuetsu, Niigata Prefecture.',
  'zh-Hans': '烈度速报已更新。新增观测到烈度5弱：新泻县上越地方、观测到烈度4：新泻县中越地方。',
  'zh-Hant': '震度速報已更新。新增觀測到震度5弱：新潟縣上越地方、觀測到震度4：新潟縣中越地方。',
  ko: '진도 속보가 갱신되었습니다. 새로 진도 5약을 니가타현 조에쓰 지방, 진도 4를 니가타현 주에쓰 지방에서 관측했습니다.',
  'pt-BR': 'A Informação sobre intensidade sísmica foi atualizada. Pela primeira vez, Intensidade 5 fraco observada: Região de Jōetsu da Província de Niigata. Pela primeira vez, Intensidade 4 observada: Região de Chūetsu da Província de Niigata.',
  es: 'Se ha actualizado la Información de intensidad sísmica. Por primera vez, Intensidad 5 débil observada: Región Jyoetsu, Prefectura de Niigata. Por primera vez, Intensidad 4 observada: Región Chuetsu, Prefectura de Niigata.',
}

/** 地震情報の自由付加文（気象庁が書いた日本語の文）と、続報で増えた 1 文 */
const FREE_TEXT = '石川県で被害の情報が入っています。'
const FREE_TEXT_ADDED = '揺れの強かった地域では引き続き注意してください。'

/** 日本語の組の同じ報の文（今の読み上げのまま。対照） */
const EXPECTED_QUAKE_JA: Record<string, string> = {
  intensityReport: '震度速報。最大震度6強を石川県能登、震度5強を富山県東部で観測しました。',
  regionSep: '震度速報。最大震度6強を石川県能登、石川県加賀、震度5強を富山県東部で観測しました。輪島市鳳至町、輪島市門前町走出では、震度5弱以上と推定されますが、未入電です。',
  quake: '地震情報。12時34分頃、石川県能登地方、深さ10キロメートルを震源とするマグニチュード6.5の地震が発生しました。この地震による津波の心配はありません。最大震度6強を石川県能登、震度5強を富山県東部で観測しました。輪島市鳳至町、ほか2地点では、震度5弱以上と推定されますが、未入電です。',
  update: '地震情報が更新されました。マグニチュードは6.8に更新されました。新たに震度5弱を新潟県上越で観測しました。',
  cancelled: `12時40分に発表された地震情報は取り消されました。${REASON}`,
  reportCancelledAt: '12時40分に発表された震度速報は取り消されました。',
  reportCancelled: '震源・震度情報は取り消されました。',
  noName: '震源情報。12時34分頃、マグニチュード6.5の地震が発生しました。この地震による津波の心配はありません。',
  magnitudeCondition: '震源情報。12時34分頃、石川県能登地方、深さ10キロメートルを震源とする地震が発生しました。マグニチュードは不明です。この地震による津波の心配はありません。',
  unreceivedCountOnly: '地震情報。12時34分頃、石川県能登地方、深さ10キロメートルを震源とするマグニチュード6.5の地震が発生しました。この地震による津波の心配はありません。最大震度6強を石川県能登、震度5強を富山県東部で観測しました。3地点では、震度5弱以上と推定されますが、未入電です。',
  distant: `遠地地震に関する情報。9日12時34分頃、インドネシア付近を震源とするマグニチュード7.4の地震が発生しました。${DISTANT_FORECAST}`,
  prominent: '顕著な地震の震源要素更新のお知らせ。12時34分頃発生した石川県能登地方の地震について、震源の深さ10キロメートル、マグニチュード6.8に更新されました。',
}

/** 既読の鍵を、並びによらず比べられる形にする（`Map` は中身の組へ直す） */
function refKeys(segments: readonly SpeechSegment[]): string[] {
  return segments
    .flatMap(s => s.refs)
    .map(r => JSON.stringify(r, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v)))
    .sort()
}

/** 仮名（気象庁が書いた日本語の文と、日本語の語表の語に必ず入る字） */
const KANA = /[぀-ヿ]/

// 記録は「言語:種類」を札に、名前ごとに 1 度だけ出す（モジュールに 1 つの控え）。実行順で「最初の 1 回」が変わらないよう、
// テストごとに控えを空に戻す（`resetUntranslatedValueLogGates`）
describe('地名の表・情報名の表で引けなかった名前（安全弁）', () => {
  beforeEach(() => { resetUntranslatedValueLogGates() })
  afterEach(() => { vi.restoreAllMocks() })

  // 表が届く前（日本語の引き方で組を作った回）と空の名前は記録しない
  it('表が未読込の組・空の名前では警告を残さない（安全弁）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const loading = createSpeechText(wordsWithDraft('en'), JA_PLACE_NAMES, 'en')
    loading.earthquakeToSegments(quakeOf('震度速報', [area('架空県', '架空の区域', 40)], { hypocenter: NO_HYPOCENTER, maxScale: 40 as IntensityScale }), QUAKE_OPTS, true)
    loading.earthquakeToSegments(quakeOf('震源情報', [], { hypocenter: { name: '架空の震央', latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } }), QUAKE_OPTS, true)
    speechTextWithDraft('en').earthquakeToSegments(quakeOf('震源情報', [], { hypocenter: { name: ' ', latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } }), QUAKE_OPTS, true)
    expect(warn.mock.calls.filter(c => String(c[0]).includes('地名の表に無い名前'))).toHaveLength(0)
  })

  it('日本語以外の組は、表に無い地名を日本語のまま読み、名前ごとに 1 度だけ警告を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const placeWarns = () => warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('地名の表に無い名前'))
    const st = speechTextWithDraft('en')
    const unknownEpi = (name: string) => quakeOf('震源情報', [], { hypocenter: { name, latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } })
    const first = textOf(st.earthquakeToSegments(unknownEpi('架空の震央その一'), QUAKE_OPTS, true))
    textOf(st.earthquakeToSegments(unknownEpi('架空の震央その一'), QUAKE_OPTS, true))
    expect(first).toContain('架空の震央その一')
    // 同じ名前の続報では増えない（正）。別の名前は同じ種類でも残す（種類で 1 度きりにすると、2 つ目の欠けが残らない）
    expect(placeWarns().filter(m => m.includes('種類 epi'))).toHaveLength(1)
    textOf(st.earthquakeToSegments(unknownEpi('架空の震央その二'), QUAKE_OPTS, true))
    expect(placeWarns().filter(m => m.includes('種類 epi'))).toHaveLength(2)
    expect(placeWarns().some(m => m.includes('架空の震央その二'))).toBe(true)
    const regionWarn = () => textOf(st.earthquakeToSegments(
      quakeOf('震度速報', [area('架空県', '架空の区域', 40)], { hypocenter: NO_HYPOCENTER, maxScale: 40 as IntensityScale }), QUAKE_OPTS, true,
    ))
    expect(regionWarn()).toContain('架空の区域')
    const afterFirst = placeWarns().filter(m => m.includes('種類 region')).length
    expect(afterFirst).toBeGreaterThan(0)
    regionWarn()
    expect(placeWarns().filter(m => m.includes('種類 region'))).toHaveLength(afterFirst)
  })

  it('同じ種類で名前の数が上限を超えても黙らない（時間で間引いて出し続ける。安全弁）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const st = speechTextWithDraft('en')
    const kinds = UNREADABLE_VALUE_LOG_KINDS
    for (let i = 0; i <= kinds; i++) {
      st.earthquakeToSegments(quakeOf('震源情報', [], { hypocenter: { name: `架空の震央${i}`, latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } }), QUAKE_OPTS, true)
    }
    const epiWarns = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('地名の表に無い名前') && m.includes('種類 epi'))
    expect(epiWarns).toHaveLength(kinds + 1)
    expect(epiWarns[kinds]).toContain('以後は間引きます')
  })

  it('日本語の組は表を引かないので、警告を残さない（対照）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    JA_SPEECH_TEXT.earthquakeToSegments(quakeOf('震度速報', [area('架空県', '架空の区域', 40)], { hypocenter: NO_HYPOCENTER, maxScale: 40 as IntensityScale }), QUAKE_OPTS, true)
    expect(warn.mock.calls.filter(c => String(c[0]).includes('地名の表に無い名前'))).toHaveLength(0)
  })

  // 継いだ関数（`constructor` など）に当たらない。外れたら種別の名前のまま言い、1 度だけ記録する
  it('取消の情報名は自前のキーだけを引き、外れたら種別の名前のまま言う', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const st = speechTextWithDraft('en')
    const odd = 'constructor' as Parameters<SpeechText['earthquakeReportCancelToText']>[0]
    expect(st.earthquakeReportCancelToText(odd, null)).toBe('The constructor has been cancelled.')
    st.earthquakeReportCancelToText(odd, null)
    expect(warn.mock.calls.filter(c => String(c[0]).includes('取消で名指す情報の名前'))).toHaveLength(1)
  })
})

// 並び順の関数は、渡した要素をちょうど 1 回ずつ並べ、渡さない要素を並べない（既読の鍵が欠けも重なりもしない）。
// 組み合わせは読み上げの関数の組が渡しうるものすべて（深さは震央名があるときだけ・規模の句と規模の文は同時に渡さない。
// → `QuakeOccurrenceTexts`）
describe('発生の文の並び順（quake.occurrence）', () => {
  const combos: QuakeOccurrenceTexts[] = []
  for (const name of [undefined, '震央']) {
    for (const depth of name ? [undefined, '深さ'] : [undefined]) {
      for (const mag of ['none', 'magnitude', 'magnitudeSentence'] as const) {
        combos.push({
          ...(name ? { name } : {}),
          ...(depth ? { depth } : {}),
          ...(mag === 'magnitude' ? { magnitude: '規模' } : {}),
          ...(mag === 'magnitudeSentence' ? { magnitudeSentence: '規模の文' } : {}),
        })
      }
    }
  }
  const words: Record<string, SpeechWords> = { ja: jaSpeech, ...Object.fromEntries(LOCALES.map(l => [l, wordsWithDraft(l)])) }

  it.each(Object.keys(words))('%s: 9 通りの組み合わせで、渡した要素がちょうど 1 回ずつ並ぶ', (locale) => {
    expect(combos).toHaveLength(9)
    for (const t of combos) {
      const parts = words[locale].quake.occurrence(t)
      for (const kind of ['name', 'depth', 'magnitude', 'magnitudeSentence'] as const) {
        expect(parts.filter(p => p.kind === kind).length, `${JSON.stringify(t)} の ${kind}`).toBe(t[kind] !== undefined ? 1 : 0)
      }
    }
  })
})

describe('日本語以外の地震情報・震度速報の読み上げ文（2026-11-17 承認の表）', () => {
  // 時刻が読めない報は、発生の文が名乗りの直後の文頭に来るので大文字で始める。大文字の無い字の言語は変わらない
  it('時刻が読めない報の発生の文は大文字で始まる（正）。日本語・中国語・韓国語は変わらない（対照）', () => {
    const noTime = quakeOf('震源情報', [], { time: '' })
    expect(textOf(speechTextWithDraft('en').earthquakeToSegments(noTime, QUAKE_OPTS, true)))
      .toBe('Earthquake Information. An earthquake of magnitude 6.5 occurred. Hypocenter: Noto, Ishikawa Prefecture, depth 10 kilometers. This earthquake poses no tsunami risk.')
    expect(textOf(speechTextWithDraft('pt-BR').earthquakeToSegments(noTime, QUAKE_OPTS, true))).toContain('Informação sobre o hipocentro. Ocorreu um terremoto')
    expect(textOf(speechTextWithDraft('es').earthquakeToSegments(noTime, QUAKE_OPTS, true))).toContain('Información del hipocentro. Se produjo un terremoto')
    expect(textOf(JA_SPEECH_TEXT.earthquakeToSegments(noTime, QUAKE_OPTS, true)))
      .toBe('震源情報。石川県能登地方、深さ10キロメートルを震源とするマグニチュード6.5の地震が発生しました。この地震による津波の心配はありません。')
    expect(textOf(speechTextWithDraft('zh-Hans').earthquakeToSegments(noTime, QUAKE_OPTS, true))).toContain('震源信息。石川县能登地方，深度10公里处')
    expect(textOf(speechTextWithDraft('ko').earthquakeToSegments(noTime, QUAKE_OPTS, true))).toContain('진원 정보. 이시카와현 노토 지방, 깊이')
  })

  it('en・pt-BR・es: 深さ 1 キロメートルは単数（正）、10 は複数（対照）', () => {
    const one = (l: OtherLocale) => SPEECH_WORDS_BY_LOCALE[l].quake
    expect(one('en').depthOf(1, '')).toBe('depth 1 kilometer')
    expect(one('en').depthKm(1, '')).toBe('1 kilometer')
    expect(one('en').depthAmendKm(1, '')).toBe('Hypocenter depth updated to 1 kilometer')
    expect(one('pt-BR').depthOf(1, '')).toBe('profundidade de 1 quilômetro')
    expect(one('pt-BR').depthKm(10, '')).toBe('10 quilômetros')
    expect(one('es').depthAmendKm(1, '')).toBe('Profundidad del hipocentro actualizada a 1 kilómetro')
    expect(one('es').depthOf(10, '')).toBe('profundidad de 10 kilómetros')
  })

  // 知らない規模の表記（2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）。日本語は表記をそのまま読む
  it.each(LOCALES)('%s: 知らない規模の表記は読まず、数値でないことと在処を言う（安全弁）', (locale) => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const odd = quakeOf('震源情報', [], { hypocenter: { name: '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: NaN, magnitudeCondition: 'Ｍ不定' } })
    const text = textOf(speechTextWithDraft(locale).earthquakeToSegments(odd, QUAKE_OPTS, true))
    expect(text).not.toContain('不定')
    expect(text).toContain(SPEECH_WORDS_BY_LOCALE[locale].common.telegramTextElsewhere!)
    expect(textOf(JA_SPEECH_TEXT.earthquakeToSegments(odd, QUAKE_OPTS, true))).toContain('マグニチュードは不定です。')
    vi.restoreAllMocks()
  })

  // 在処の文は発話の末尾に 1 度だけ足す（規模の文は持たない）
  it('en: 知らない規模の表記の文（正）', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(SPEECH_WORDS_BY_LOCALE.en.quake.magnitudeConditionUnknown('不定')).toBe('The magnitude is not given as a number. ')
    const odd = quakeOf('震源情報', [], { hypocenter: { name: '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: NaN, magnitudeCondition: 'Ｍ不定' } })
    expect(textOf(speechTextWithDraft('en').earthquakeToSegments(odd, QUAKE_OPTS, true)))
      .toBe("Earthquake Information. Around 12:34, an earthquake occurred. Hypocenter: Noto, Ishikawa Prefecture, depth 10 kilometers. The magnitude is not given as a number. This earthquake poses no tsunami risk. JMA's original text is in the Telegram Log.")
    vi.restoreAllMocks()
  })

  it.each(LOCALES)('%s: 表の文になる（正）', (locale) => {
    expect(produceQuake(speechTextWithDraft(locale))).toEqual(EXPECTED_QUAKE[locale])
  })

  it.each(LOCALES)('%s: 気象庁の原文（日本語）が文に入らない（安全弁。遠地地震の付加文・取消の理由・規模の表記）', (locale) => {
    const produced = produceQuake(speechTextWithDraft(locale))
    for (const [key, text] of Object.entries(produced)) {
      expect(text, key).not.toMatch(KANA)
      expect(text, key).not.toContain(DISTANT_FORECAST)
      expect(text, key).not.toContain(REASON)
    }
    // 付加文が無い遠地地震で、海外への津波の見通し（これも気象庁の文）を値で持つ形も原文を読まない
    const st = speechTextWithDraft(locale)
    const foreign = '太平洋の広域に津波発生の可能性があります。'
    const text = textOf(st.earthquakeToSegments(
      quakeOf('遠地地震', [], { hypocenter: { name: 'インドネシア付近', latitude: 0, longitude: 0, depth: -1, magnitude: 7.4 }, maxScale: -1 as IntensityScale, domesticTsunamiCode: undefined }, { foreignTsunamiText: foreign }),
      QUAKE_OPTS, true,
    ))
    expect(text).not.toContain(foreign)
    expect(text.endsWith(SPEECH_WORDS_BY_LOCALE[locale].common.telegramTextElsewhere!)).toBe(true)
  })

  // 既読と追従の鍵は言語によらない（→ `utils/ttsFollow.ts`）。発生の文の語順を言語が変えても、付く鍵の組は日本語と同じ
  it.each(LOCALES)('%s: 既読の鍵は日本語の組と同じ（安全弁）', (locale) => {
    const quake = quakeOf('震源・震度情報', [...OBSERVED, ...UNRECEIVED])
    const ja = JA_SPEECH_TEXT.earthquakeToSegments(quake, QUAKE_OPTS, true)
    const other = speechTextWithDraft(locale).earthquakeToSegments(quake, QUAKE_OPTS, true)
    expect(refKeys(other)).toEqual(refKeys(ja))
  })

  // 階級の境（2026-11-17 ユーザー選択「階級ごとに文を切る (Recommended)」）。続報で初めて観測した地域が 2 階級にまたがると、
  // 文で切る言語は次の文の頭にも「新たに」を置く
  it.each(LOCALES)('%s: 続報で初めて観測した地域が 2 階級にまたがる文（正）', (locale) => {
    const st = speechTextWithDraft(locale)
    const state = st.createQuakeSpokenState()
    const first = st.earthquakeToSegments(quakeOf('震度速報', OBSERVED, { hypocenter: NO_HYPOCENTER }), QUAKE_OPTS, true, state)
    st.applySpokenRefs(state, first.flatMap(s => s.refs))
    const second = quakeOf('震度速報', [...OBSERVED, area('新潟県', '新潟県上越', 45), area('新潟県', '新潟県中越', 40)], { hypocenter: NO_HYPOCENTER })
    expect(textOf(st.earthquakeToSegments(second, { ...QUAKE_OPTS, intensityLevels: 3 }, false, state))).toBe(EXPECTED_FRESH_TWO_GROUPS[locale])
  })

  // 気象庁の発表文（`telegramTextToSpeak`）も、日本語以外では原文を読まず在処だけを言う（2026-11-16 ユーザー選択
  // 「読まずに「画面にある」と言う」）。鍵は原文の文のまま持ち、同じ文を運ぶ続報では在処を言い直さない
  it.each(LOCALES)('%s: 気象庁の発表文は読まずに在処だけを言い、鍵は日本語と同じ（安全弁）', (locale) => {
    const st = speechTextWithDraft(locale)
    const elsewhere = SPEECH_WORDS_BY_LOCALE[locale].common.telegramTextElsewhere!
    const opts: TtsSpeechOptions = { ...QUAKE_OPTS, readTelegramText: true }
    const event = quakeOf('震源・震度情報', OBSERVED, {}, { freeText: FREE_TEXT })
    const ja = JA_SPEECH_TEXT.telegramTextToSpeak(event, opts)!
    const speech = st.telegramTextToSpeak(event, opts)!
    // 対照: 日本語は原文を読む
    expect(ja.text).toContain(FREE_TEXT)
    expect(speech.text).toBe(elsewhere)
    expect(speech.text).not.toMatch(KANA)
    expect(speech.units.map(u => u.key)).toEqual(ja.units.map(u => u.key))

    // 読む側（`useLiveEventHandler.ts` の `speakTelegramText`）と同じ選び方で、続報を 2 通流す
    const spoken = new Set<string>()
    const toSay = (s: typeof speech): string | null => {
      const fresh = s.units.filter(u => !spoken.has(u.key))
      if (fresh.length === 0) return null
      for (const u of fresh) spoken.add(u.key)
      return fresh.length === s.units.length ? s.text : `${s.prefix}${fresh.map(u => u.text).join('')}`
    }
    expect(toSay(speech)).toBe(elsewhere)
    // 同じ文を運ぶ続報: 全部既読で黙る（在処を報のたびに言い直さない）
    expect(toSay(st.telegramTextToSpeak(event, opts)!)).toBeNull()
    // 文が 1 つ増えた続報: 在処をもう 1 度だけ言う（原文は入らない）
    const added = quakeOf('震源・震度情報', OBSERVED, {}, { freeText: `${FREE_TEXT}${FREE_TEXT_ADDED}` })
    expect(toSay(st.telegramTextToSpeak(added, opts)!)).toBe(elsewhere)
  })

  // 葡西の時刻の冠詞（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5）。1 時台だけ単数
  it('pt-BR・es: 1 時台は単数の冠詞（正）、12 時台は複数のまま（対照）', () => {
    const at = (h: number, m: number) => new Date(2026, 10, 9, h, m).toISOString()
    const pt = speechTextWithDraft('pt-BR')
    const es = speechTextWithDraft('es')
    expect(pt.earthquakeCancelToText(at(1, 40))).toBe('A Informação sobre terremotos emitida à 1:40 foi cancelada.')
    expect(es.earthquakeCancelToText(at(1, 40))).toBe('La Información de terremotos emitida a la 1:40 fue cancelada.')
    expect(pt.eewCancelToText({ ...EVENT, cancelled: true }, at(1, 40))).toBe('O Alerta Urgente de Terremoto emitido à 1:40 foi cancelado.')
    expect(es.eewCancelToText({ ...EVENT, cancelled: true }, at(1, 40))).toBe('La Alerta Temprana de Terremoto emitida a la 1:40 fue cancelada.')
    const early = quakeOf('震源情報', [], {}, {})
    const earlyAt = { ...early, earthquake: { ...early.earthquake, time: at(1, 5) } }
    expect(textOf(pt.earthquakeToSegments(earlyAt, QUAKE_OPTS, true))).toContain('Por volta da 1:05, ')
    expect(textOf(es.earthquakeToSegments(earlyAt, QUAKE_OPTS, true))).toContain('Alrededor de la 1:05, ')
    expect(textOf(pt.earthquakeToSegments(early, QUAKE_OPTS, true))).toContain('Por volta das 12:34, ')
    expect(textOf(es.earthquakeToSegments(early, QUAKE_OPTS, true))).toContain('Alrededor de las 12:34, ')
  })

  // 韓国語の助詞は直前の語の終わりで選ぶ（받침の有無。数字は読みの終わり）
  it('ko: 助詞を直前の語の終わりで選ぶ（正）', () => {
    const ko = SPEECH_WORDS_BY_LOCALE.ko
    expect(ko.quake.intensityLead(false, '4')).toBe('진도 4를 ')
    expect(ko.quake.intensityLead(false, '5약')).toBe('진도 5약을 ')
    expect(ko.quake.intensityLead(false, '1')).toBe('진도 1을 ')
    expect(ko.quake.magnitudeAmendedTo('6.8')).toBe('규모는 6.8로 갱신되었습니다. ')
    expect(ko.quake.magnitudeAmendedTo('7.0')).toBe('규모는 7.0으로 갱신되었습니다. ')
    expect(ko.quake.magnitudeAmendedTo('6.3')).toBe('규모는 6.3으로 갱신되었습니다. ')
    expect(ko.quake.depthAmendKm(700, '이상')).toBe('진원의 깊이 700킬로미터 이상으로')
    expect(ko.quake.depthAmendIs('매우 얕은 곳')).toBe('진원의 깊이는 매우 얕은 곳으로')
    expect(ko.common.updated('진도 속보')).toBe('진도 속보가 갱신되었습니다. ')
    expect(ko.quake.reportCancelled('진원 정보')).toBe('진원 정보는 취소되었습니다.')
  })

  it('en: 単数・複数と序数を数で選ぶ（正）', () => {
    const en = SPEECH_WORDS_BY_LOCALE.en
    expect(en.quake.regionsOmitted(1)).toBe(', and 1 other area')
    expect(en.quake.regionsOmitted(3)).toBe(', and 3 other areas')
    expect(en.quake.unreceivedOmitted(1, '件')).toBe(', and 1 other place')
    expect(en.common.day(1)).toBe('the 1st')
    expect(en.common.day(22)).toBe('the 22nd')
    expect(en.common.day(13)).toBe('the 13th')
  })
})

// 遠地地震の付加文の実電文の形（2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」）。日本語以外は、022x の文と
// 国内のコードの文を付加文の原文と同じ順に並べ（同日「原文と同じ順 (Recommended)」。実電文は 022x が先）、在処の文を続ける。
// 国内のコードが無く区分が 不明 なら国内の文を言わない
const DISTANT_SHAPES = {
  // 2026-07-17 メキシコ、チアパス州沿岸（テストボタンの遠地地震）
  c0226_0230: { code: '0230', foreign: ['0226'], domestic: 'なし', text: '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。' },
  // 2010-02-27 チリ中部沿岸（気象庁のサンプル電文。テストボタンの巨大地震）
  c0221_0228_0229: {
    code: '0229', foreign: ['0221', '0228'], domestic: '調査中',
    text: '太平洋の広域に津波発生の可能性があります。一般的に、この規模の地震が海域の浅い領域で発生すると津波が発生することがあります。日本への津波の有無については現在調査中です。',
  },
  c0226: { code: undefined, foreign: ['0226'], domestic: '不明', text: '震源の近傍で津波発生の可能性があります。' },
} as const

function distantOf(shape: keyof typeof DISTANT_SHAPES, over: Partial<JMAQuake['earthquake']['hypocenter']> = {}): JMAQuake {
  const s = DISTANT_SHAPES[shape]
  return quakeOf('遠地地震', [], {
    hypocenter: { name: 'インドネシア付近', latitude: 0, longitude: 0, depth: -1, magnitude: 7.4, ...over },
    maxScale: -1 as IntensityScale,
    domesticTsunami: s.domestic,
    domesticTsunamiCode: s.code,
    foreignTsunamiCodes: [...s.foreign],
  }, { forecastText: s.text })
}

const EXPECTED_DISTANT_TAIL: Record<OtherLocale, Record<keyof typeof DISTANT_SHAPES, string>> = {
  en: {
    c0226_0230: 'There is a possibility of a tsunami near the hypocenter. This earthquake has no tsunami impact on Japan. JMA\'s original text is in the Telegram Log.',
    c0221_0228_0229: 'There is a possibility of a tsunami across a wide area of the Pacific Ocean. Generally, when an earthquake of this size occurs in a shallow area under the sea, a tsunami may be generated. Whether a tsunami will affect Japan is currently under investigation. JMA\'s original text is in the Telegram Log.',
    c0226: 'There is a possibility of a tsunami near the hypocenter. JMA\'s original text is in the Telegram Log.',
  },
  'zh-Hans': {
    c0226_0230: '震源附近可能发生海啸。此次地震对日本无海啸影响。日本气象局的原文在电文记录中。',
    c0221_0228_0229: '太平洋大范围可能发生海啸。一般来说，此规模的地震发生在海域浅处时，可能引发海啸。目前正在调查日本是否会受到海啸影响。日本气象局的原文在电文记录中。',
    c0226: '震源附近可能发生海啸。日本气象局的原文在电文记录中。',
  },
  'zh-Hant': {
    c0226_0230: '震源附近可能發生海嘯。此次地震對日本無海嘯影響。日本氣象局的原文在電文紀錄中。',
    c0221_0228_0229: '太平洋大範圍可能發生海嘯。一般來說，此規模的地震發生在海域淺處時，可能引發海嘯。目前正在調查日本是否會受到海嘯影響。日本氣象局的原文在電文紀錄中。',
    c0226: '震源附近可能發生海嘯。日本氣象局的原文在電文紀錄中。',
  },
  ko: {
    c0226_0230: '진원 부근에서 지진해일이 발생할 가능성이 있습니다. 이 지진에 의한 일본에 대한 지진해일 영향은 없습니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
    c0221_0228_0229: '태평양의 넓은 범위에서 지진해일이 발생할 가능성이 있습니다. 일반적으로 이 규모의 지진이 해역의 얕은 곳에서 발생하면 지진해일이 발생할 수 있습니다. 일본에 대한 지진해일 유무는 현재 조사 중입니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
    c0226: '진원 부근에서 지진해일이 발생할 가능성이 있습니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
  },
  'pt-BR': {
    c0226_0230: 'Há possibilidade de tsunami perto do hipocentro. Este terremoto não causa impacto de tsunami no Japão. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
    c0221_0228_0229: 'Há possibilidade de tsunami em uma ampla área do Oceano Pacífico. Em geral, quando um terremoto desta magnitude ocorre em uma área rasa sob o mar, pode ocorrer um tsunami. A possibilidade de tsunami no Japão está em investigação no momento. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
    c0226: 'Há possibilidade de tsunami perto do hipocentro. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
  },
  es: {
    c0226_0230: 'Es posible que se produzca un tsunami cerca del hipocentro. Este terremoto no tiene impacto de tsunami en Japón. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
    c0221_0228_0229: 'Es posible que se produzca un tsunami en una amplia zona del océano Pacífico. En general, cuando un terremoto de esta magnitud ocurre en una zona poco profunda bajo el mar, puede producirse un tsunami. Actualmente está en investigación si habrá tsunami en Japón. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
    c0226: 'Es posible que se produzca un tsunami cerca del hipocentro. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
  },
}

describe('遠地地震の付加文の実電文の形', () => {
  /** 発生の文の後ろ（津波の文から先）。発生の文は表のテストが固定している */
  const tailOf = (st: SpeechText, q: JMAQuake) => {
    const segs = st.earthquakeToSegments(q, QUAKE_OPTS, true)
    const occurred = st.earthquakeToSegments({ ...q, forecastText: undefined, foreignTsunamiText: undefined, earthquake: { ...q.earthquake, domesticTsunami: '不明', domesticTsunamiCode: undefined } }, QUAKE_OPTS, true)
    // 付加文が無い形は「区分の文」で終わるので、その 1 断片を除いた長さが発生の文までの断片数
    return textOf(segs.slice(occurred.length - 1))
  }

  it.each(LOCALES)('%s: 022x の文と国内のコードの文を原文と同じ順に並べ、在処の文を続ける（正）', (locale) => {
    const st = speechTextWithDraft(locale)
    const shapes = Object.keys(DISTANT_SHAPES) as (keyof typeof DISTANT_SHAPES)[]
    expect(Object.fromEntries(shapes.map(shape => [shape, tailOf(st, distantOf(shape))]))).toEqual(EXPECTED_DISTANT_TAIL[locale])
  })

  // 解読がコードを残すようにする前に端末へ控えたカードは、022x の欄も（区分を決めたコードも）持たないことがある。
  // 原文の中のコード表の文から同じ文を言う
  it.each(LOCALES)('%s: コードの欄が無い古いカードでも、原文の中のコード表の文から 0226・0230 を訳して言う（正）', (locale) => {
    const st = speechTextWithDraft(locale)
    const fresh = distantOf('c0226_0230')
    const { foreignTsunamiCodes: _f, domesticTsunamiCode: _d, ...oldEarthquake } = fresh.earthquake
    const old: JMAQuake = { ...fresh, earthquake: oldEarthquake }
    expect(tailOf(st, old)).toBe(EXPECTED_DISTANT_TAIL[locale].c0226_0230)
    // 既読の鍵も、区分を決めたコードの文として付く
    const refs = st.earthquakeToSegments(old, QUAKE_OPTS, true).flatMap(s => s.refs)
    expect(refs).toContainEqual({ kind: 'quakeFact', fact: 'domesticTsunami', value: 'なし:0230' })
  })

  // 決め打ちの順ではなく、原文の文の並びで決まる（原文が国内の文を先に書けば、国内の文が先）
  it('並びは原文の文の位置で決まる（対照: 国内の文が先に書かれた原文）', () => {
    const reversed = {
      ...distantOf('c0226_0230'),
      forecastText: 'この地震による日本への津波の影響はありません。震源の近傍で津波発生の可能性があります。',
    }
    expect(tailOf(speechTextWithDraft('en'), reversed))
      .toBe('This earthquake has no tsunami impact on Japan. There is a possibility of a tsunami near the hypocenter. JMA\'s original text is in the Telegram Log.')
  })

  it.each(LOCALES)('%s: 既読の鍵は言った文にだけ付く（022x だけの形では津波の区分の鍵を付けない。安全弁）', (locale) => {
    const st = speechTextWithDraft(locale)
    const tsunamiRefs = (q: JMAQuake) => st.earthquakeToSegments(q, QUAKE_OPTS, true)
      .flatMap(s => s.refs).filter(r => r.kind === 'quakeFact' && r.fact === 'domesticTsunami')
    expect(tsunamiRefs(distantOf('c0226'))).toHaveLength(0)
    expect(tsunamiRefs(distantOf('c0226_0230'))).toHaveLength(1)
  })

  it('日本語は付加文の原文をそのまま読む（対照）', () => {
    for (const shape of Object.keys(DISTANT_SHAPES) as (keyof typeof DISTANT_SHAPES)[]) {
      expect(textOf(JA_SPEECH_TEXT.earthquakeToSegments(distantOf(shape), QUAKE_OPTS, true))
        .endsWith(`の地震が発生しました。${DISTANT_SHAPES[shape].text}`), shape).toBe(true)
    }
  })

  // 規模の表記が知らないもので、付加文もある遠地地震: 在処の文は末尾の 1 回だけ
  it.each(LOCALES)('%s: 知らない規模の表記と付加文が重なっても、在処の文は 1 回（安全弁）', (locale) => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const elsewhere = SPEECH_WORDS_BY_LOCALE[locale].common.telegramTextElsewhere!
    const text = textOf(speechTextWithDraft(locale).earthquakeToSegments(
      distantOf('c0226_0230', { magnitude: NaN, magnitudeCondition: 'Ｍ不定' }), QUAKE_OPTS, true,
    ))
    expect(text.split(elsewhere).length - 1).toBe(1)
    expect(text.endsWith(elsewhere)).toBe(true)
    vi.restoreAllMocks()
  })
})

describe('日本語の地震情報・震度速報は今の文のまま（対照）', () => {
  it('同じ報で今の文になる（発生の文の語順・地名の区切り・遠地地震の付加文・取消の名前）', () => {
    expect(produceQuake(JA_SPEECH_TEXT)).toEqual(EXPECTED_QUAKE_JA)
  })
})

describe('日本語の組は今の文のまま（対照）', () => {
  it('取消の文と理由は区切りなしで続く', () => {
    expect(JA_SPEECH_TEXT.eewCancelToText({ ...EVENT, cancelled: true, cancelText: REASON }, FIRST_ISSUE))
      .toBe(`12時40分に発表された緊急地震速報は取り消されました。${REASON}`)
  })

  it('切り替え・対象地方・予想値は区切りなしで続く', () => {
    expect(JA_SPEECH_TEXT.eewWarningRegionsText(['東北', '関東'], false, true))
      .toBe('緊急地震速報に切り替わりました。東北、関東では強い揺れに警戒してください。')
    expect(JA_SPEECH_TEXT.eewIntensityText({ scale: 60, orAbove: false }, 3, EVENT, false, true))
      .toBe('緊急地震速報に切り替わりました。予想最大震度6強。予想最大階級3。')
  })
})

// ---- 津波 ----

/** 端末の時刻帯での時刻（1 月 1 日） */
const jan1 = (hour: number, minute: number) => new Date(2026, 0, 1, hour, minute).toISOString()
/** 気象庁の避難の付加文（日本語の組だけが読む） */
const JMA_EVACUATION = 'ただちに避難してください。'
/** 気象庁の見出し文（日本語の組だけが読む） */
const TSUNAMI_HEADLINE = '津波を観測しています。'
const NOTO_SOURCE: TsunamiSourceEarthquake = { hypocenterName: '石川県能登地方', magnitude: 7.6, depth: 10 }

function tsunamiOf(areas: TsunamiArea[], extra: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami', id: 'locale-tsunami', eventId: '20260101161010', time: jan1(16, 22), cancelled: false,
    issue: { source: 'テスト', time: jan1(16, 22), type: 'Focus' }, areas, ...extra,
  }
}
const areaOf = (grade: TsunamiArea['grade'], name: string, height?: string): TsunamiArea =>
  ({ grade, immediate: true, name, ...(height ? { maxHeight: { description: height, value: Number.parseFloat(height.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))) } } : {}) })

/** 表 13 節の例の報 1（大津波警報の発表）。気象庁の避難の付加文を持つ */
const ISSUE = tsunamiOf([
  areaOf('MajorWarning', '石川県能登', '５ｍ'),
  areaOf('Warning', '新潟県上中下越', '３ｍ'),
  areaOf('Warning', '佐渡', '３ｍ'),
  areaOf('Warning', '富山県', '３ｍ'),
  areaOf('Warning', '石川県加賀', '３ｍ'),
  areaOf('Watch', '北海道日本海沿岸南部', '１ｍ'),
], {
  sourceEarthquakes: [NOTO_SOURCE],
  warningComments: [{ key: 'VTSE41', text: `${JMA_EVACUATION}\n海岸から離れてください。` }],
})

/** 表 13 節の例の報 2（観測の続報）の観測点。金沢は前に波高を読んでいる（更新） */
const OBSERVATIONS: TsunamiObservation[] = [
  { name: '輪島港', districtName: '石川県能登', height: { value: 1.2, description: '1.2m', over: true }, maxHeightDateTime: jan1(16, 21), arrivalTime: jan1(16, 10), initial: '押し' },
  { name: '富山', districtName: '富山県', height: { value: 0.8, description: '0.8m' }, maxHeightDateTime: jan1(16, 35) },
  { name: '金沢', districtName: '石川県加賀', height: { value: 0.9, description: '0.9m' }, maxHeightDateTime: jan1(16, 41) },
]

/** 津波の文の断片を、実運用と同じ関数から組む（表 13 節の例と、14・15 節で決めた形） */
function produceTsunamiSegments(st: SpeechText): Record<string, SpeechSegment[]> {
  const remaining = tsunamiOf([areaOf('Warning', '石川県能登'), areaOf('Warning', '石川県加賀')], {
    warningComments: ISSUE.warningComments,
  })
  const forecastOnly = tsunamiOf([areaOf('Forecast', '石川県能登', '０．２ｍ未満')], {
    time: jan1(16, 22), validDateTime: new Date(2026, 0, 2, 14, 0).toISOString(),
  })
  // 早まった失効時刻（1 時台。葡西は単数の冠詞）
  const applied = tsunamiOf([areaOf('Forecast', '石川県能登')], { validDateTime: jan1(1, 5) })
  const arrival: TsunamiObservation[] = [
    { name: '輪島港', districtName: '石川県能登', arrivalTime: jan1(1, 10), initial: '引き', condition: { observing: true } },
    { name: '富山', districtName: '富山県', condition: { weak: true } },
  ]
  const missing: TsunamiObservation[] = [
    { name: '輪島港', districtName: '石川県能登', height: { value: 1.2, description: '1.2m', over: true }, condition: { maxHeightMissing: true } },
    { name: '富山', districtName: '富山県', condition: { weak: true, maxHeightMissing: true } },
    { name: '金沢', districtName: '石川県加賀', condition: { maxHeightMissing: true } },
  ]
  return {
    issue: st.tsunamiToSegments(ISSUE, undefined, undefined, QUAKE_OPTS),
    issueNoHeight: st.tsunamiToSegments(tsunamiOf([areaOf('Watch', '富山県'), areaOf('Forecast', '佐渡')]), undefined, undefined, QUAKE_OPTS),
    // 予報の名前の性（葡: Previsão は女性、西: Pronóstico は男性）で冠詞と過去分詞が変わる
    forecastIssued: st.tsunamiToSegments(tsunamiOf([areaOf('Forecast', '富山県', '０．２ｍ未満')]), undefined, undefined, QUAKE_OPTS),
    forecastIssuedNoHeight: st.tsunamiToSegments(tsunamiOf([areaOf('Forecast', '富山県')]), undefined, undefined, QUAKE_OPTS),
    hugeHeight: st.tsunamiToSegments(tsunamiOf([areaOf('MajorWarning', '石川県能登', '巨大'), areaOf('MajorWarning', '富山県', '10m超')]), undefined, undefined, QUAKE_OPTS),
    downgrade: st.tsunamiDowngradeToSegments(forecastOnly, undefined, undefined),
    downgradeNoHeight: st.tsunamiDowngradeToSegments(tsunamiOf([areaOf('Watch', '富山県')]), undefined, undefined),
    observation: st.tsunamiObservationUpdateToSegments(OBSERVATIONS, TSUNAMI_HEADLINE, 5, new Set(['金沢']), new Map(), new Map()),
    observationOmitted: st.tsunamiObservationUpdateToSegments(OBSERVATIONS, undefined, 1, undefined, new Map(), new Map()),
    areaChange: [
      ...st.tsunamiAreaGradeChangeToSegments([
        { from: 'MajorWarning', to: 'Warning', raised: false, areas: [areaOf('Warning', '石川県能登')] },
        { from: 'Watch', to: 'Warning', raised: true, areas: [areaOf('Warning', '石川県加賀')] },
        { from: 'Watch', to: 'Lifted', raised: false, areas: [areaOf('Watch', '北海道日本海沿岸南部')] },
        { from: undefined, to: 'Lifted', raised: false, areas: [areaOf('Watch', '佐渡')] },
      ]),
      ...st.tsunamiAreaGradeChangeActionSegments(remaining),
    ],
    forecastHeightChange: st.tsunamiForecastHeightChangeToSegments([areaOf('Warning', '石川県能登', '３ｍ')], []),
    expiryExtended: st.tsunamiExpiryChangeSegments(forecastOnly, jan1(13, 5), forecastOnly, undefined),
    expiryChangedOneOClock: st.tsunamiExpiryChangeSegments(forecastOnly, jan1(14, 0), applied, undefined),
    arrival: st.tsunamiArrivalToSegments(arrival, 5, new Map()),
    arrivalUntimed: st.tsunamiArrivalToSegments([{ name: '富山', districtName: '富山県', condition: { observing: true } }], 5, new Map()),
    maxHeightTime: st.tsunamiMaxHeightTimeToSegments([{ ...OBSERVATIONS[2], maxHeightDateTime: jan1(23, 26) }]),
    missingMaxHeightTime: st.tsunamiMissingMaxHeightTimeToSegments([{ ...OBSERVATIONS[2], maxHeightDateTime: jan1(23, 26) }]),
    firstWaveUpdated: st.tsunamiFirstWaveToSegments([{ ...OBSERVATIONS[0], arrivalTime: jan1(16, 32) }], 'updated'),
    firstWaveNew: st.tsunamiFirstWaveToSegments([{ ...OBSERVATIONS[1], arrivalTime: jan1(16, 13) }], 'new'),
    missing: st.tsunamiMissingToSegments(missing, 5),
    missingOmitted: st.tsunamiMissingToSegments(missing, 1),
    warningLevel: st.tsunamiWarningLevelToSegments([{ name: '輪島港', districtName: '石川県能登', condition: { observing: true } }], 5),
    tideFirst: st.tsunamiTideToSegments('first', '各地の満潮時刻と津波到達予想時刻をお知らせします。'),
    tideNone: st.tsunamiTideToSegments('none', '各地の満潮時刻と津波到達予想時刻をお知らせします。'),
    noChange: st.tsunamiObservationNoChangeSegments(),
    lowered: st.tsunamiObservationLoweredSegments(),
  }
}

/** 津波の文（断片の文と、文で返す取消・解除・失効） */
function produceTsunami(st: SpeechText): Record<string, string> {
  const segments = Object.fromEntries(Object.entries(produceTsunamiSegments(st)).map(([key, s]) => [key, textOf(s)]))
  return {
    ...segments,
    lifted: st.tsunamiCancelToText(undefined),
    retracted: st.tsunamiCancelToText('retracted', REASON),
    expired: st.tsunamiCancelToText('expired'),
    infoRetracted: st.tsunamiPartialRetractionToText('VTSE51'),
    offshoreRetracted: st.tsunamiPartialRetractionToText('VTSE52'),
  }
}

/** 日本語の津波の文（今の文のまま。対照） */
const EXPECTED_TSUNAMI_JA: Record<string, string> = {
  issue: '大津波警報が発表されました。ただちに避難してください。石川県能登で5メートルが予想されています。また、次の地域に津波警報が発表されています。新潟県上中下越、佐渡、富山県、石川県加賀で3メートルが予想されています。また、次の地域に津波注意報が発表されています。北海道日本海沿岸南部で1メートルが予想されています。この地震の震源は石川県能登地方、深さ10キロメートル、マグニチュードは7.6です。',
  issueNoHeight: '津波注意報。富山県に津波注意報が発表されました。海の中にいる人はただちに海から上がって、海岸から離れてください。また、佐渡に津波予報（若干の海面変動）が発表されています。',
  forecastIssued: '津波予報（若干の海面変動）が発表されました。若干の海面変動が予想されますが、被害の心配はありません。富山県で0.2メートル未満が予想されています。',
  forecastIssuedNoHeight: '津波予報（若干の海面変動）。富山県に津波予報（若干の海面変動）が発表されました。若干の海面変動が予想されますが、被害の心配はありません。',
  hugeHeight: '大津波警報が発表されました。ただちに高台や避難ビルなど安全な場所へ避難してください。石川県能登で巨大な津波、富山県で10メートル超が予想されています。',
  downgrade: '津波予報（若干の海面変動）に切り替えられました。現在、次の地域に津波予報（若干の海面変動）が発表されています。石川県能登で0.2メートル未満が予想されています。この津波予報（若干の海面変動）の失効時刻は、2日14時0分です。',
  downgradeNoHeight: '津波注意報に切り替えられました。現在、富山県に津波注意報が発表されています。',
  observation: '津波観測に関する情報。津波を観測しています。新たに、次の地点で津波を観測しました。石川県能登、輪島港で、16時10分に押し波が到達し、16時21分に1.2メートル以上を観測、富山県、富山で16時35分に0.8メートルを観測しました。また、次の地点で最大波が更新されました。石川県加賀、金沢で16時41分に0.9メートルへ更新されました。',
  observationOmitted: '津波観測に関する情報。新たに、次の地点で津波を観測しました。石川県能登、輪島港で、16時10分に押し波が到達し、16時21分に1.2メートル以上を観測しました。ほか2地点でも観測しています。',
  areaChange: '石川県能登の大津波警報が津波警報に切り替えられました。また、石川県加賀の津波注意報が津波警報に引き上げられました。また、北海道日本海沿岸南部の津波注意報が解除されました。また、佐渡の津波警報等が解除されました。ただちに避難してください。',
  forecastHeightChange: '予想される津波の高さが変わりました。石川県能登で3メートルが予想されています。',
  expiryExtended: '津波予報（若干の海面変動）の失効時刻が、2日14時0分に延長されました。',
  expiryChangedOneOClock: '津波予報（若干の海面変動）の失効時刻が、1時5分に変更されました。',
  arrival: '次の地点で津波の到達を確認しました。石川県能登、輪島港で1時10分に引き波を観測しました。最大波高は観測中です。また、富山県、富山で到達を確認しました。最大波高は微弱です。',
  arrivalUntimed: '富山県、富山で到達を確認しました。最大波高は観測中です。',
  maxHeightTime: '次の地点で最大波の観測時刻が更新されました。石川県加賀、金沢で23時26分へ更新されました。',
  missingMaxHeightTime: '欠測となっている観測点で、最大波の観測時刻が更新されました。石川県加賀、金沢で23時26分へ更新されました。',
  firstWaveUpdated: '次の地点で第一波が更新されました。石川県能登、輪島港で16時32分の押し波へ更新されました。',
  firstWaveNew: '次の地点で第一波の到達を確認しました。富山県、富山で16時13分に第一波を観測しました。',
  missing: 'これまでに石川県能登、輪島港で1.2メートル以上、富山県、富山で微弱な津波を観測したのち、欠測となっています。また、石川県加賀、金沢は欠測となっています。',
  missingOmitted: 'これまでに石川県能登、輪島港で1.2メートル以上を観測したのち、欠測となっています。ほか2地点も欠測となっています。',
  warningLevel: '石川県能登、輪島港では、津波警報に相当する津波を観測しています。',
  tideFirst: '各地の満潮時刻と津波到達予想時刻をお知らせします。',
  tideNone: '各地の満潮時刻と津波到達予想時刻をお知らせします。内容に変わりはありません。',
  noChange: '津波観測に関する情報。観測された波高に変わりはありません。',
  lowered: '津波観測に関する情報が発表されました。',
  lifted: '津波警報等は全て解除されました。',
  retracted: `津波警報等は誤って発表されたため取り消されました。${REASON}`,
  expired: '津波予報は失効しました。',
  infoRetracted: '津波情報は取り消されました。',
  offshoreRetracted: '沖合の津波観測に関する情報は取り消されました。',
}

/** 表の津波の文（2026-11-17 承認。13 節の例の報と、14・15 節で決めた形） */
const EXPECTED_TSUNAMI: Record<OtherLocale, Record<string, string>> = {
  en: {
    issue: 'Major Tsunami Warning issued. Evacuate immediately to a safer place such as high ground or an evacuation building. Noto Area, Ishikawa Prefecture: estimated height 5 meters. Also, a Tsunami Warning has been issued for the following coastal regions of Japan. Niigata Prefecture, Except Sadogashima Island; Sadogashima Island; Toyama Prefecture; Kaga Area, Ishikawa Prefecture: estimated height 3 meters. Also, a Tsunami Advisory has been issued for the following coastal regions of Japan. Southern part of Japan Sea Coast of Hokkaido: estimated height 1 meter. Hypocenter of this earthquake: Noto, Ishikawa Prefecture, depth 10 kilometers, magnitude 7.6.',
    issueNoHeight: 'Tsunami Advisory. Toyama Prefecture: Tsunami Advisory issued. Get out of the water and leave coastal regions immediately. Also, Sadogashima Island: Tsunami Forecast (slight sea-level change) in effect.',
    forecastIssued: 'Tsunami Forecast (slight sea-level change) issued. A slight sea-level change is expected, but no damage is anticipated. Toyama Prefecture: estimated height under 0.2 meters.',
    forecastIssuedNoHeight: 'Tsunami Forecast (slight sea-level change). Toyama Prefecture: Tsunami Forecast (slight sea-level change) issued. A slight sea-level change is expected, but no damage is anticipated.',
    hugeHeight: 'Major Tsunami Warning issued. Evacuate immediately to a safer place such as high ground or an evacuation building. Noto Area, Ishikawa Prefecture: estimated height huge. Toyama Prefecture: estimated height over 10 meters.',
    downgrade: 'Downgraded to Tsunami Forecast (slight sea-level change). A Tsunami Forecast (slight sea-level change) is now in effect for the following coastal regions of Japan. Noto Area, Ishikawa Prefecture: estimated height under 0.2 meters. This Tsunami Forecast (slight sea-level change) expires at 14:00 on the 2nd.',
    downgradeNoHeight: 'Downgraded to Tsunami Advisory. Currently, Toyama Prefecture: Tsunami Advisory in effect.',
    observation: "Tsunami Observation Information. JMA's original text is in the Telegram Log. A tsunami has been newly observed at the following sites. Noto Area, Ishikawa Prefecture: Wajimako, initial rise arrived at 16:10, observed 1.2 meters or more at 16:21; Toyama Prefecture: Toyama, observed 0.8 meters at 16:35. Also, The maximum wave has been updated at the following sites. Kaga Area, Ishikawa Prefecture: Kanazawa, updated to 0.9 meters, observed at 16:41.",
    observationOmitted: 'Tsunami Observation Information. A tsunami has been newly observed at the following sites. Noto Area, Ishikawa Prefecture: Wajimako, initial rise arrived at 16:10, observed 1.2 meters or more at 16:21. A tsunami is also being observed at 2 other sites.',
    areaChange: 'Noto Area, Ishikawa Prefecture: Major Tsunami Warning downgraded to Tsunami Warning. Also, Kaga Area, Ishikawa Prefecture: Tsunami Advisory upgraded to Tsunami Warning. Also, Southern part of Japan Sea Coast of Hokkaido: Tsunami Advisory lifted. Also, Sadogashima Island: tsunami warnings and advisories lifted. Evacuate immediately to a safer place such as high ground or an evacuation building.',
    forecastHeightChange: 'The estimated maximum tsunami heights have changed. Noto Area, Ishikawa Prefecture: estimated height 3 meters.',
    expiryExtended: 'The Tsunami Forecast (slight sea-level change) has been extended; it now expires at 14:00 on the 2nd.',
    expiryChangedOneOClock: 'The Tsunami Forecast (slight sea-level change) has been changed; it now expires at 1:05.',
    arrival: 'Tsunami arrival has been confirmed at the following sites. Noto Area, Ishikawa Prefecture: Wajimako, initial drop observed at 1:10. Maximum wave height: information pending. Also, Toyama Prefecture: Toyama, arrival confirmed. Maximum wave height: weak.',
    arrivalUntimed: 'Toyama Prefecture: Toyama: arrival confirmed. Maximum wave height: information pending.',
    maxHeightTime: 'The observation time of the maximum wave has been updated at the following sites. Kaga Area, Ishikawa Prefecture: Kanazawa, updated to 23:26.',
    missingMaxHeightTime: 'At sites where data are missing, the observation time of the maximum wave has been updated. Kaga Area, Ishikawa Prefecture: Kanazawa, updated to 23:26.',
    firstWaveUpdated: 'The initial wave has been updated at the following sites. Noto Area, Ishikawa Prefecture: Wajimako, updated to initial rise at 16:32.',
    firstWaveNew: 'Arrival of the initial tsunami wave has been confirmed at the following sites. Toyama Prefecture: Toyama, initial wave observed at 16:13.',
    missing: 'The following was observed before data became unavailable. Noto Area, Ishikawa Prefecture: Wajimako, 1.2 meters or more; Toyama Prefecture: Toyama, a weak tsunami. Data are now missing. Also, Kaga Area, Ishikawa Prefecture: Kanazawa: no data.',
    missingOmitted: 'The following was observed before data became unavailable. Noto Area, Ishikawa Prefecture: Wajimako, 1.2 meters or more. Data are now missing. Data are also missing at 2 other sites.',
    warningLevel: 'Noto Area, Ishikawa Prefecture: Wajimako: a tsunami at the Tsunami Warning level is being observed.',
    tideFirst: 'Here are the high tide times and the estimated initial tsunami arrival times for each area.',
    tideNone: 'Here are the high tide times and the estimated initial tsunami arrival times for each area. There is no change in the content.',
    noChange: 'Tsunami Observation Information. There is no change in the observed wave heights.',
    lowered: 'Tsunami Observation Information has been issued.',
    lifted: 'All tsunami warnings and advisories have been lifted.',
    retracted: "The tsunami warnings and advisories were issued in error and have been cancelled. JMA's original text is in the Telegram Log.",
    expired: 'The Tsunami Forecast has expired.',
    infoRetracted: 'The Tsunami Information has been cancelled.',
    offshoreRetracted: 'The Offshore Tsunami Observation Information has been cancelled.',
  },
  'zh-Hans': {
    issue: '已发布大海啸警报。请立即撤离到高地或疏散到大楼内避难。石川县能登：预计5米。另外，海啸警报发布的沿岸地区如下。新泻县上中下越、佐渡、富山县、石川县加贺：预计3米。另外，海啸注意警报发布的沿岸地区如下。北海道日本海沿岸南部：预计1米。此次地震的震源位于石川县能登地方，深度10公里处，震级为7.6。',
    issueNoHeight: '海啸注意警报。富山县：已发布海啸注意警报。请立刻上岸并远离海岸。另外，佐渡：海啸预报（略有海平面变化）发布中。',
    forecastIssued: '已发布海啸预报（略有海平面变化）。预计海平面略有变化，但无需担心受灾。富山县：预计不足0.2米。',
    forecastIssuedNoHeight: '海啸预报（略有海平面变化）。富山县：已发布海啸预报（略有海平面变化）。预计海平面略有变化，但无需担心受灾。',
    hugeHeight: '已发布大海啸警报。请立即撤离到高地或疏散到大楼内避难。石川县能登：预计巨大海啸；富山县：预计超过10米。',
    downgrade: '已降为海啸预报（略有海平面变化）。目前，海啸预报（略有海平面变化）发布的沿岸地区如下。石川县能登：预计不足0.2米。该海啸预报（略有海平面变化）的失效时间为2日14时0分。',
    downgradeNoHeight: '已降为海啸注意警报。目前，富山县：海啸注意警报发布中。',
    observation: '海啸观测信息。日本气象局的原文在电文记录中。以下地点新观测到海啸。石川县能登的轮岛港：16时10分初波上升到达，16时21分观测到1.2米以上；富山县的富山：16时35分观测到0.8米。另外，以下地点的最大波已更新。石川县加贺的金泽：更新为16时41分观测到的0.9米。',
    observationOmitted: '海啸观测信息。以下地点新观测到海啸。石川县能登的轮岛港：16时10分初波上升到达，16时21分观测到1.2米以上。另外2个地点也正在观测到海啸。',
    areaChange: '石川县能登：大海啸警报降为海啸警报。另外，石川县加贺：海啸注意警报升为海啸警报。另外，北海道日本海沿岸南部：海啸注意警报已被解除。另外，佐渡：海啸警报等已被解除。请立即撤离到高地或大楼内避难。',
    forecastHeightChange: '预计海啸最大高度已变更。石川县能登：预计3米。',
    expiryExtended: '海啸预报（略有海平面变化）的失效时间已延长，现为2日14时0分。',
    expiryChangedOneOClock: '海啸预报（略有海平面变化）的失效时间已变更，现为1时5分。',
    arrival: '以下地点已确认海啸到达。石川县能登的轮岛港：1时10分观测到初波下降。最大波高观测中。另外，富山县的富山：确认到达。最大波高微弱。',
    arrivalUntimed: '富山县的富山：已确认到达。最大波高观测中。',
    maxHeightTime: '以下地点的最大波观测时间已更新。石川县加贺的金泽：更新为23时26分。',
    missingMaxHeightTime: '在缺测的观测点，最大波观测时间已更新。石川县加贺的金泽：更新为23时26分。',
    firstWaveUpdated: '以下地点的首波已更新。石川县能登的轮岛港：更新为16时32分的初波上升。',
    firstWaveNew: '以下地点已确认首波的到来。富山县的富山：16时13分观测到首波。',
    missing: '缺测前的观测值如下。石川县能登的轮岛港：1.2米以上；富山县的富山：微弱海啸。目前处于缺测状态。另外，石川县加贺的金泽：缺测。',
    missingOmitted: '缺测前的观测值如下。石川县能登的轮岛港：1.2米以上。目前处于缺测状态。另外2个地点也处于缺测状态。',
    warningLevel: '石川县能登的轮岛港：正在观测到相当于海啸警报的海啸。',
    tideFirst: '现发布各地的涨潮时间和首波海啸预计抵达时间。',
    tideNone: '现发布各地的涨潮时间和首波海啸预计抵达时间。内容没有变化。',
    noChange: '海啸观测信息。观测到的波高没有变化。',
    lowered: '海啸观测信息已发布。',
    lifted: '海啸警报等已全部解除。',
    retracted: '海啸警报等因误发而已被取消。日本气象局的原文在电文记录中。',
    expired: '海啸预报已失效。',
    infoRetracted: '海啸信息已被取消。',
    offshoreRetracted: '近海海啸观测信息已被取消。',
  },
  'zh-Hant': {
    issue: '已發佈大海嘯警報。請立即撤離到高地或大樓內避難。石川縣能登：預計5米。另外，海嘯警報發布的沿岸地區如下。新潟縣上中下越、佐渡、富山縣、石川縣加賀：預計3米。另外，海嘯注意警報發布的沿岸地區如下。北海道日本海沿岸南部：預計1米。此次地震的震源位於石川縣能登地方，深度10公里處，規模為7.6。',
    issueNoHeight: '海嘯注意警報。富山縣：已發佈海嘯注意警報。請立刻上岸並遠離海岸。另外，佐渡：海嘯預報（略有海平面變化）發佈中。',
    forecastIssued: '已發佈海嘯預報（略有海平面變化）。預計海平面略有變化，但無需擔心受災。富山縣：預計不足0.2米。',
    forecastIssuedNoHeight: '海嘯預報（略有海平面變化）。富山縣：已發佈海嘯預報（略有海平面變化）。預計海平面略有變化，但無需擔心受災。',
    hugeHeight: '已發佈大海嘯警報。請立即撤離到高地或大樓內避難。石川縣能登：預計巨大海嘯；富山縣：預計超過10米。',
    downgrade: '已降為海嘯預報（略有海平面變化）。目前，海嘯預報（略有海平面變化）發布的沿岸地區如下。石川縣能登：預計不足0.2米。該海嘯預報（略有海平面變化）的失效時間為2日14時0分。',
    downgradeNoHeight: '已降為海嘯注意警報。目前，富山縣：海嘯注意警報發佈中。',
    observation: '海嘯觀測訊息。日本氣象局的原文在電文紀錄中。以下地點新觀測到海嘯。石川縣能登的輪島港：16時10分初波上升到達，16時21分觀測到1.2米以上；富山縣的富山：16時35分觀測到0.8米。另外，以下地點的最大波已更新。石川縣加賀的金澤：更新為16時41分觀測到的0.9米。',
    observationOmitted: '海嘯觀測訊息。以下地點新觀測到海嘯。石川縣能登的輪島港：16時10分初波上升到達，16時21分觀測到1.2米以上。另外2個地點也正在觀測到海嘯。',
    areaChange: '石川縣能登：大海嘯警報降為海嘯警報。另外，石川縣加賀：海嘯注意警報升為海嘯警報。另外，北海道日本海沿岸南部：海嘯注意警報已被解除。另外，佐渡：海嘯警報等已被解除。請立即撤離到高地或大樓內避難。',
    forecastHeightChange: '預計海嘯最大高度已變更。石川縣能登：預計3米。',
    expiryExtended: '海嘯預報（略有海平面變化）的失效時間已延長，現為2日14時0分。',
    expiryChangedOneOClock: '海嘯預報（略有海平面變化）的失效時間已變更，現為1時5分。',
    arrival: '以下地點已確認海嘯到達。石川縣能登的輪島港：1時10分觀測到初波下降。最大波高觀測中。另外，富山縣的富山：確認到達。最大波高微弱。',
    arrivalUntimed: '富山縣的富山：已確認到達。最大波高觀測中。',
    maxHeightTime: '以下地點的最大波觀測時間已更新。石川縣加賀的金澤：更新為23時26分。',
    missingMaxHeightTime: '在缺測的觀測點，最大波觀測時間已更新。石川縣加賀的金澤：更新為23時26分。',
    firstWaveUpdated: '以下地點的首波已更新。石川縣能登的輪島港：更新為16時32分的初波上升。',
    firstWaveNew: '以下地點已確認首波的到來。富山縣的富山：16時13分觀測到首波。',
    missing: '缺測前的觀測值如下。石川縣能登的輪島港：1.2米以上；富山縣的富山：微弱海嘯。目前處於缺測狀態。另外，石川縣加賀的金澤：缺測。',
    missingOmitted: '缺測前的觀測值如下。石川縣能登的輪島港：1.2米以上。目前處於缺測狀態。另外2個地點也處於缺測狀態。',
    warningLevel: '石川縣能登的輪島港：正在觀測到相當於海嘯警報的海嘯。',
    tideFirst: '現發佈各地的漲潮時間和首波海嘯預計抵達時間。',
    tideNone: '現發佈各地的漲潮時間和首波海嘯預計抵達時間。內容沒有變化。',
    noChange: '海嘯觀測訊息。觀測到的波高沒有變化。',
    lowered: '海嘯觀測訊息已發佈。',
    lifted: '海嘯警報等已全部解除。',
    retracted: '海嘯警報等因誤發而已被取消。日本氣象局的原文在電文紀錄中。',
    expired: '海嘯預報已失效。',
    infoRetracted: '海嘯訊息已被取消。',
    offshoreRetracted: '近海海嘯觀測訊息已被取消。',
  },
  ko: {
    issue: '대형 지진해일 경보가 발효되었습니다. 즉시 높은 지대나 피난 빌딩 등 안전한 곳으로 대피하십시오. 이시카와현 노토에서 5미터의 지진해일이 예상됩니다. 또한 지진해일 경보가 발효된 연안은 다음과 같습니다. 니가타현 조에쓰·주에쓰·가에쓰, 사도, 도야마현, 이시카와현 카가에서 3미터의 지진해일이 예상됩니다. 또한 지진해일 주의보가 발효된 연안은 다음과 같습니다. 홋카이도 일본해 연안 남부에서 1미터의 지진해일이 예상됩니다. 이 지진의 진원은 이시카와현 노토 지방, 깊이 10킬로미터, 규모는 7.6입니다.',
    issueNoHeight: '지진해일 주의보. 도야마현에 지진해일 주의보가 발효되었습니다. 바닷속에 있는 사람은 즉시 바다에서 나와 해안에서 벗어나 주십시오. 또한 사도에 지진해일 예보(약간의 해수면 변동)이 발효 중입니다.',
    forecastIssued: '지진해일 예보(약간의 해수면 변동)이 발효되었습니다. 약간의 해수면 변동이 예상되지만 피해 걱정은 없습니다. 도야마현에서 0.2미터 미만의 지진해일이 예상됩니다.',
    forecastIssuedNoHeight: '지진해일 예보(약간의 해수면 변동). 도야마현에 지진해일 예보(약간의 해수면 변동)이 발효되었습니다. 약간의 해수면 변동이 예상되지만 피해 걱정은 없습니다.',
    hugeHeight: '대형 지진해일 경보가 발효되었습니다. 즉시 높은 지대나 피난 빌딩 등 안전한 곳으로 대피하십시오. 이시카와현 노토에서 거대한 규모, 도야마현에서 10미터 초과의 지진해일이 예상됩니다.',
    downgrade: '지진해일 예보(약간의 해수면 변동)으로 변경되었습니다. 현재 지진해일 예보(약간의 해수면 변동)이 발효된 연안은 다음과 같습니다. 이시카와현 노토에서 0.2미터 미만의 지진해일이 예상됩니다. 이 지진해일 예보(약간의 해수면 변동)의 만료 시각은 2일 14시 0분입니다.',
    downgradeNoHeight: '지진해일 주의보로 변경되었습니다. 현재 도야마현에 지진해일 주의보가 발효 중입니다.',
    observation: '지진해일 관측 정보. 일본 기상청의 원문은 전문 로그에 있습니다. 새로 다음 지점에서 지진해일을 관측했습니다. 이시카와현 노토, 와지마코에서, 16시 10분에 초동 상승이 도달하고, 16시 21분에 1.2미터 이상을 관측, 도야마현, 도야마에서 16시 35분에 0.8미터를 관측했습니다. 또한 다음 지점에서 최대파가 갱신되었습니다. 이시카와현 카가, 가나자와에서 16시 41분에 0.9미터로 갱신되었습니다.',
    observationOmitted: '지진해일 관측 정보. 새로 다음 지점에서 지진해일을 관측했습니다. 이시카와현 노토, 와지마코에서, 16시 10분에 초동 상승이 도달하고, 16시 21분에 1.2미터 이상을 관측했습니다. 그 외 2개 지점에서도 관측하고 있습니다.',
    areaChange: '이시카와현 노토의 대형 지진해일 경보가 지진해일 경보로 변경되었습니다. 또한 이시카와현 카가의 지진해일 주의보가 지진해일 경보로 상향되었습니다. 또한 홋카이도 일본해 연안 남부의 지진해일 주의보가 해제되었습니다. 또한 사도의 지진해일 경보 등이 해제되었습니다. 즉시 높은 지대나 피난 빌딩 등 안전한 곳으로 대피하십시오.',
    forecastHeightChange: '예상되는 지진해일 최대 높이가 변경되었습니다. 이시카와현 노토에서 3미터의 지진해일이 예상됩니다.',
    expiryExtended: '지진해일 예보(약간의 해수면 변동)의 만료 시각이 연장되었습니다. 현재 만료 시각은 2일 14시 0분입니다.',
    expiryChangedOneOClock: '지진해일 예보(약간의 해수면 변동)의 만료 시각이 변경되었습니다. 현재 만료 시각은 1시 5분입니다.',
    arrival: '다음 지점에서 지진해일 도달을 확인했습니다. 이시카와현 노토, 와지마코에서 1시 10분에 초동 하강을 관측했습니다. 최대파 높이는 관측 중입니다. 또한 도야마현, 도야마에서 도달 확인했습니다. 최대파 높이는 미약합니다.',
    arrivalUntimed: '도야마현, 도야마에서 도달을 확인했습니다. 최대파 높이는 관측 중입니다.',
    maxHeightTime: '다음 지점에서 최대파의 관측 시각이 갱신되었습니다. 이시카와현 카가, 가나자와에서 23시 26분으로 갱신되었습니다.',
    missingMaxHeightTime: '결측 상태인 관측점에서 최대파의 관측 시각이 갱신되었습니다. 이시카와현 카가, 가나자와에서 23시 26분으로 갱신되었습니다.',
    firstWaveUpdated: '다음 지점에서 제1파가 갱신되었습니다. 이시카와현 노토, 와지마코에서 16시 32분의 초동 상승으로 갱신되었습니다.',
    firstWaveNew: '다음 지점에서 제1파 도달을 확인했습니다. 도야마현, 도야마에서 16시 13분에 제1파를 관측했습니다.',
    missing: '지금까지 이시카와현 노토, 와지마코에서 1.2미터 이상, 도야마현, 도야마에서 미약한 지진해일 관측 후, 결측 상태입니다. 또한 이시카와현 카가, 가나자와의 데이터는 결측 상태입니다.',
    missingOmitted: '지금까지 이시카와현 노토, 와지마코에서 1.2미터 이상 관측 후, 결측 상태입니다. 그 외 2개 지점도 결측 상태입니다.',
    warningLevel: '이시카와현 노토, 와지마코에서는 지진해일 경보에 상당하는 지진해일을 관측하고 있습니다.',
    tideFirst: '각지의 만조 시간과 지진해일 제1파 도달 예상 시각을 알려 드립니다.',
    tideNone: '각지의 만조 시간과 지진해일 제1파 도달 예상 시각을 알려 드립니다. 내용에 변화는 없습니다.',
    noChange: '지진해일 관측 정보. 관측된 파고에 변화는 없습니다.',
    lowered: '지진해일 관측 정보가 발표되었습니다.',
    lifted: '지진해일 경보 등은 모두 해제되었습니다.',
    retracted: '지진해일 경보 등은 잘못 발표되어 취소되었습니다. 일본 기상청의 원문은 전문 로그에 있습니다.',
    expired: '지진해일 예보는 만료되었습니다.',
    infoRetracted: '지진해일 정보는 취소되었습니다.',
    offshoreRetracted: '앞바다 지진해일 관측 정보는 취소되었습니다.',
  },
  'pt-BR': {
    issue: 'Foi decretado o Alerta de Mega Tsunami. Refugiem-se imediatamente em lugares altos, prédios designados para refúgio ou outro lugar seguro. Noto da Prov. de Ishikawa: previsão de 5 metros. Além disso, as costas litorâneas em Alerta de Tsunami são as seguintes. Regiões de Jōetsu, Chūetsu, Kaetsu da Prov. de Niigata; Sado; Província de Toyama; Kaga da Prov. de Ishikawa: previsão de 3 metros. Além disso, as costas litorâneas em Alerta Preventivo de Tsunami são as seguintes. Litoral sul do Lado do Mar do Japão de Hokkaidō: previsão de 1 metro. Hipocentro deste terremoto: Região de Noto da Província de Ishikawa, profundidade de 10 quilômetros, magnitude 7,6.',
    issueNoHeight: 'Alerta Preventivo de Tsunami. Província de Toyama: Alerta Preventivo de Tsunami decretado. Saia imediatamente do mar e se afaste da praia. Além disso, Sado: Previsão de tsunami (ligeiras variações no nível do mar) em vigor.',
    forecastIssued: 'Foi decretada a Previsão de tsunami (ligeiras variações no nível do mar). Esperam-se ligeiras variações no nível do mar, mas não há risco de danos. Província de Toyama: previsão de menos de 0,2 metros.',
    forecastIssuedNoHeight: 'Previsão de tsunami (ligeiras variações no nível do mar). Província de Toyama: Previsão de tsunami (ligeiras variações no nível do mar) decretada. Esperam-se ligeiras variações no nível do mar, mas não há risco de danos.',
    hugeHeight: 'Foi decretado o Alerta de Mega Tsunami. Refugiem-se imediatamente em lugares altos, prédios designados para refúgio ou outro lugar seguro. Noto da Prov. de Ishikawa: previsão de tsunami gigante. Província de Toyama: previsão de mais de 10 metros.',
    downgrade: 'Rebaixamento do nível para Previsão de tsunami (ligeiras variações no nível do mar). No momento, as costas litorâneas em Previsão de tsunami (ligeiras variações no nível do mar) são as seguintes. Noto da Prov. de Ishikawa: previsão de menos de 0,2 metros. Previsão de tsunami (ligeiras variações no nível do mar): expira às 14:00 do dia 2.',
    downgradeNoHeight: 'Rebaixamento do nível para Alerta Preventivo de Tsunami. No momento, Província de Toyama: Alerta Preventivo de Tsunami em vigor.',
    observation: 'Informação sobre observação de tsunami. O texto original da Agência Meteorológica do Japão está no Registro de telegramas. Foi observado tsunami pela primeira vez nos seguintes locais. Noto da Prov. de Ishikawa: Wajimako, a subida inicial chegou às 16:10, observação de 1,2 metros ou mais às 16:21; Província de Toyama: Toyama, observação de 0,8 metros às 16:35. Além disso, A onda máxima foi atualizada nos seguintes locais. Kaga da Prov. de Ishikawa: Kanazawa, atualização para 0,9 metros, observados às 16:41.',
    observationOmitted: 'Informação sobre observação de tsunami. Foi observado tsunami pela primeira vez nos seguintes locais. Noto da Prov. de Ishikawa: Wajimako, a subida inicial chegou às 16:10, observação de 1,2 metros ou mais às 16:21. Também se observa tsunami em mais 2 locais.',
    areaChange: 'Noto da Prov. de Ishikawa: Alerta de Mega Tsunami, rebaixamento do nível para Alerta de Tsunami. Além disso, Kaga da Prov. de Ishikawa: Alerta Preventivo de Tsunami, elevação do nível para Alerta de Tsunami. Além disso, Litoral sul do Lado do Mar do Japão de Hokkaidō: Alerta Preventivo de Tsunami desativado. Além disso, Sado: alertas de tsunami desativados. Refugiem-se imediatamente em lugares altos, prédios designados para refúgio ou outro lugar seguro.',
    forecastHeightChange: 'A altura máxima estimada do tsunami mudou. Noto da Prov. de Ishikawa: previsão de 3 metros.',
    expiryExtended: 'Previsão de tsunami (ligeiras variações no nível do mar): o prazo foi prorrogado; agora expira às 14:00 do dia 2.',
    expiryChangedOneOClock: 'Previsão de tsunami (ligeiras variações no nível do mar): o horário foi alterado; agora expira à 1:05.',
    arrival: 'Foi confirmada a chegada do tsunami nos seguintes locais. Noto da Prov. de Ishikawa: Wajimako, descida inicial observada à 1:10. Altura máxima da onda: informações pendentes. Além disso, Província de Toyama: Toyama, chegada confirmada. Altura máxima da onda: fraca.',
    arrivalUntimed: 'Província de Toyama: Toyama: chegada confirmada. Altura máxima da onda: informações pendentes.',
    maxHeightTime: 'O horário de observação da onda máxima foi atualizado nos seguintes locais. Kaga da Prov. de Ishikawa: Kanazawa, atualização para 23:26.',
    missingMaxHeightTime: 'Nos locais sem dados, o horário de observação da onda máxima foi atualizado. Kaga da Prov. de Ishikawa: Kanazawa, atualização para 23:26.',
    firstWaveUpdated: 'A primeira onda foi atualizada nos seguintes locais. Noto da Prov. de Ishikawa: Wajimako, atualização para subida inicial às 16:32.',
    firstWaveNew: 'Foi confirmada a chegada da primeira onda do tsunami nos seguintes locais. Província de Toyama: Toyama, primeira onda observada às 16:13.',
    missing: 'Observado antes da falta de dados. Noto da Prov. de Ishikawa: Wajimako, 1,2 metros ou mais; Província de Toyama: Toyama, tsunami fraco. No momento, sem dados. Além disso, Kaga da Prov. de Ishikawa: Kanazawa: sem dados.',
    missingOmitted: 'Observado antes da falta de dados. Noto da Prov. de Ishikawa: Wajimako, 1,2 metros ou mais. No momento, sem dados. Mais 2 locais também estão sem dados.',
    warningLevel: 'Noto da Prov. de Ishikawa: Wajimako: observa-se tsunami de nível de Alerta de Tsunami.',
    tideFirst: 'Seguem os horários de maré alta e os horários estimados da chegada da primeira onda do tsunami em cada local.',
    tideNone: 'Seguem os horários de maré alta e os horários estimados da chegada da primeira onda do tsunami em cada local. Não há alteração no conteúdo.',
    noChange: 'Informação sobre observação de tsunami. Não há alteração nas alturas de onda observadas.',
    lowered: 'Foi emitida a Informação sobre observação de tsunami.',
    lifted: 'Todos os alertas de tsunami foram desativados.',
    retracted: 'Os alertas de tsunami foram emitidos por engano e foram cancelados. O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
    expired: 'A Previsão de tsunami expirou.',
    infoRetracted: 'A Informação sobre tsunami foi cancelada.',
    offshoreRetracted: 'A Informação sobre observação de tsunami em alto-mar foi cancelada.',
  },
  es: {
    issue: 'Se ha decretado la Alerta de Mega Tsunami. Por favor refúgiense en un lugar más alto o bien entren en edificios destinados a refugio. Noto, Prefectura de Ishikawa: previsión de 5 metros. Además, las costas en Alerta de Tsunami son las siguientes. Jōetsu, Chūetsu, Kaetsu de Prefectura de Niigata; Sado; Prefectura de Toyama; Kaga, Prefectura de Ishikawa: previsión de 3 metros. Además, las costas en Advertencia de Tsunami son las siguientes. Parte sur de Costa de mar de Japón de Hokkaido: previsión de 1 metro. Hipocentro de este terremoto: Región Noto, Prefectura de Ishikawa, profundidad de 10 kilómetros, magnitud 7,6.',
    issueNoHeight: 'Advertencia de Tsunami. Prefectura de Toyama: Advertencia de Tsunami decretada. Salgan inmediatamente del mar quienes estén en él y aléjense de la playa. Además, Sado: Pronóstico del tsunami (ligeras alteraciones en la superficie del mar) en vigor.',
    forecastIssued: 'Se ha decretado el Pronóstico del tsunami (ligeras alteraciones en la superficie del mar). Se prevén ligeras alteraciones en la superficie del mar, pero no hay riesgo de daños. Prefectura de Toyama: previsión de menos de 0,2 metros.',
    forecastIssuedNoHeight: 'Pronóstico del tsunami (ligeras alteraciones en la superficie del mar). Prefectura de Toyama: Pronóstico del tsunami (ligeras alteraciones en la superficie del mar) decretado. Se prevén ligeras alteraciones en la superficie del mar, pero no hay riesgo de daños.',
    hugeHeight: 'Se ha decretado la Alerta de Mega Tsunami. Por favor refúgiense en un lugar más alto o bien entren en edificios destinados a refugio. Noto, Prefectura de Ishikawa: previsión de tsunami gigante. Prefectura de Toyama: previsión de más de 10 metros.',
    downgrade: 'Bajada del nivel a Pronóstico del tsunami (ligeras alteraciones en la superficie del mar). Actualmente, las costas en Pronóstico del tsunami (ligeras alteraciones en la superficie del mar) son las siguientes. Noto, Prefectura de Ishikawa: previsión de menos de 0,2 metros. Pronóstico del tsunami (ligeras alteraciones en la superficie del mar): vence a las 14:00 del día 2.',
    downgradeNoHeight: 'Bajada del nivel a Advertencia de Tsunami. Actualmente, Prefectura de Toyama: Advertencia de Tsunami en vigor.',
    observation: 'Información de observación del tsunami. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas. Se ha observado un tsunami por primera vez en los siguientes lugares. Noto, Prefectura de Ishikawa: Wajimako, la subida inicial llegó a las 16:10, observación de 1,2 metros o más a las 16:21; Prefectura de Toyama: Toyama, observación de 0,8 metros a las 16:35. Además, Se ha actualizado la ola máxima en los siguientes lugares. Kaga, Prefectura de Ishikawa: Kanazawa, actualización a 0,9 metros, observados a las 16:41.',
    observationOmitted: 'Información de observación del tsunami. Se ha observado un tsunami por primera vez en los siguientes lugares. Noto, Prefectura de Ishikawa: Wajimako, la subida inicial llegó a las 16:10, observación de 1,2 metros o más a las 16:21. También se observa el tsunami en 2 lugares más.',
    areaChange: 'Noto, Prefectura de Ishikawa: Alerta de Mega Tsunami, bajada del nivel a Alerta de Tsunami. Además, Kaga, Prefectura de Ishikawa: Advertencia de Tsunami, subida del nivel a Alerta de Tsunami. Además, Parte sur de Costa de mar de Japón de Hokkaido: Advertencia de Tsunami desactivada. Además, Sado: alertas y advertencias de tsunami desactivadas. Por favor refúgiense en un lugar más alto o bien entren en edificios destinados a refugio.',
    forecastHeightChange: 'La altura máxima prevista del tsunami ha cambiado. Noto, Prefectura de Ishikawa: previsión de 3 metros.',
    expiryExtended: 'Pronóstico del tsunami (ligeras alteraciones en la superficie del mar): el plazo se ha prorrogado; ahora vence a las 14:00 del día 2.',
    expiryChangedOneOClock: 'Pronóstico del tsunami (ligeras alteraciones en la superficie del mar): la hora se ha cambiado; ahora vence a la 1:05.',
    arrival: 'Se ha confirmado la llegada del tsunami en los siguientes lugares. Noto, Prefectura de Ishikawa: Wajimako, bajada inicial observada a la 1:10. Altura máxima de la ola: información pendiente. Además, Prefectura de Toyama: Toyama, llegada confirmada. Altura máxima de la ola: débil.',
    arrivalUntimed: 'Prefectura de Toyama: Toyama: llegada confirmada. Altura máxima de la ola: información pendiente.',
    maxHeightTime: 'Se ha actualizado la hora de observación de la ola máxima en los siguientes lugares. Kaga, Prefectura de Ishikawa: Kanazawa, actualización a las 23:26.',
    missingMaxHeightTime: 'En los lugares sin datos, se ha actualizado la hora de observación de la ola máxima. Kaga, Prefectura de Ishikawa: Kanazawa, actualización a las 23:26.',
    firstWaveUpdated: 'Se ha actualizado la primera ola en los siguientes lugares. Noto, Prefectura de Ishikawa: Wajimako, actualización a subida inicial a las 16:32.',
    firstWaveNew: 'Se ha confirmado la llegada de la primera ola del tsunami en los siguientes lugares. Prefectura de Toyama: Toyama, primera ola observada a las 16:13.',
    missing: 'Observado antes de quedar sin datos. Noto, Prefectura de Ishikawa: Wajimako, 1,2 metros o más; Prefectura de Toyama: Toyama, tsunami débil. Actualmente, sin datos. Además, Kaga, Prefectura de Ishikawa: Kanazawa: sin datos.',
    missingOmitted: 'Observado antes de quedar sin datos. Noto, Prefectura de Ishikawa: Wajimako, 1,2 metros o más. Actualmente, sin datos. Otros 2 lugares también están sin datos.',
    warningLevel: 'Noto, Prefectura de Ishikawa: Wajimako: se observa un tsunami de nivel de Alerta de Tsunami.',
    tideFirst: 'A continuación, las horas de marea alta y las horas previstas de llegada de la primera ola del tsunami en cada lugar.',
    tideNone: 'A continuación, las horas de marea alta y las horas previstas de llegada de la primera ola del tsunami en cada lugar. No hay cambios en el contenido.',
    noChange: 'Información de observación del tsunami. No hay cambios en las alturas de ola observadas.',
    lowered: 'Se ha emitido la Información de observación del tsunami.',
    lifted: 'Todas las alertas y advertencias de tsunami han sido desactivadas.',
    retracted: 'Las alertas y advertencias de tsunami se emitieron por error y se han cancelado. El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
    expired: 'El Pronóstico del tsunami ha vencido.',
    infoRetracted: 'Se ha cancelado la Información del tsunami.',
    offshoreRetracted: 'Se ha cancelado la Información de observación del tsunami en alta mar.',
  },
}

/** 原因地震の規模が続報で変わったときの文（1 つ目の地震・2 つ目の地震。葡西は小数点をコンマで言う） */
const EXPECTED_SOURCE_AMENDED: Record<OtherLocale, readonly [string, string]> = {
  en: ['The magnitude of this earthquake has been updated to 7.6.', 'The magnitude of the other earthquake has been updated to 6.2.'],
  'zh-Hans': ['此次地震的震级已更新为7.6。', '另一次地震的震级已更新为6.2。'],
  'zh-Hant': ['此次地震的規模已更新為7.6。', '另一次地震的規模已更新為6.2。'],
  ko: ['이 지진의 규모는 7.6으로 갱신되었습니다.', '또 다른 지진의 규모는 6.2로 갱신되었습니다.'],
  'pt-BR': ['A magnitude deste terremoto foi atualizada para 7,6.', 'A magnitude do outro terremoto foi atualizada para 6,2.'],
  es: ['Se ha actualizado la magnitud de este terremoto a 7,6.', 'Se ha actualizado la magnitud del otro terremoto a 6,2.'],
}

describe('日本語以外の津波の読み上げ文（2026-11-17 承認の表）', () => {
  it.each(LOCALES)('%s: 表の文になる（正）', (locale) => {
    expect(produceTsunami(speechTextWithDraft(locale))).toEqual(EXPECTED_TSUNAMI[locale])
  })

  // 気象庁が書いた日本語の文（避難の付加文・観測情報と満潮時刻の見出し文・取消の理由）は読まない（2026-11-10 ユーザー選択
  // 「等級ごとの訳文を出す (Recommended)」、2026-11-17 ユーザー選択「報ごとに在処を言う」）
  it.each(LOCALES)('%s: 気象庁の原文（日本語）が文に入らない（安全弁。避難の付加文・見出し文・取消の理由）', (locale) => {
    for (const [key, text] of Object.entries(produceTsunami(speechTextWithDraft(locale)))) {
      expect(text, key).not.toMatch(KANA)
      expect(text, key).not.toContain(JMA_EVACUATION)
      expect(text, key).not.toContain(TSUNAMI_HEADLINE)
      expect(text, key).not.toContain(REASON)
    }
  })

  // 見出し文を持つ報だけ、名乗りの後に在処の文を言う（見出し文が無い報では、置き換える文が無い）
  it.each(LOCALES)('%s: 観測情報の在処の文は、見出し文を持つ報で 1 回、持たない報では言わない（対照）', (locale) => {
    const elsewhere = SPEECH_WORDS_BY_LOCALE[locale].common.telegramTextElsewhere!
    const produced = produceTsunami(speechTextWithDraft(locale))
    expect(produced.observation.split(elsewhere).length - 1).toBe(1)
    expect(produced.observationOmitted).not.toContain(elsewhere)
  })

  // 既読と追従の鍵は言語によらない（→ `utils/ttsFollow.ts`）。言った事実の鍵は日本語と同じで、言っていない事実の鍵は付かない
  it.each(LOCALES)('%s: 既読の鍵は日本語の組と同じ（安全弁）', (locale) => {
    const ja = produceTsunamiSegments(JA_SPEECH_TEXT)
    const other = produceTsunamiSegments(speechTextWithDraft(locale))
    for (const key of Object.keys(ja)) expect(refKeys(other[key]), key).toEqual(refKeys(ja[key]))
  })

  it.each(LOCALES)('%s: 原因地震の規模が知らない表記なら数値でないと言い、在処の文を発話の末尾に 1 度だけ言う（正）', (locale) => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const st = speechTextWithDraft(locale)
    const words = SPEECH_WORDS_BY_LOCALE[locale]
    const elsewhere = words.common.telegramTextElsewhere!
    const unknown = { hypocenterName: '石川県能登地方', depth: 10, magnitudeCondition: 'Ｍ不明の新しい表記' }
    // 2 つの地震がどちらも知らない表記でも、在処の文は 1 回
    const text = textOf(st.tsunamiToSegments(tsunamiOf([areaOf('Watch', '富山県', '１ｍ')], { sourceEarthquakes: [unknown, unknown] }), undefined, undefined, QUAKE_OPTS))
    expect(text).toContain(words.quake.magnitudeConditionUnknown(''))
    expect(text.split(elsewhere).length - 1).toBe(1)
    expect(text.endsWith(elsewhere)).toBe(true)
    expect(text).not.toMatch(KANA)
    // 対照: 語表にある表記（「Ｍ不明」）は在処の文を言わない
    const known = textOf(st.tsunamiToSegments(tsunamiOf([areaOf('Watch', '富山県', '１ｍ')], { sourceEarthquakes: [{ ...unknown, magnitudeCondition: 'Ｍ不明' }] }), undefined, undefined, QUAKE_OPTS))
    expect(known).not.toContain(elsewhere)
    vi.restoreAllMocks()
  })

  it('日本語の組は、原因地震の知らない規模の表記を読み、在処の文を足さない（対照）', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const text = textOf(JA_SPEECH_TEXT.tsunamiToSegments(
      tsunamiOf([areaOf('Watch', '富山県', '１ｍ')], { sourceEarthquakes: [{ hypocenterName: '石川県能登地方', depth: 10, magnitudeCondition: 'Ｍ不明の新しい表記' }] }),
      undefined, undefined, QUAKE_OPTS,
    ))
    expect(text.endsWith('マグニチュードは不明の新しい表記です。')).toBe(true)
    vi.restoreAllMocks()
  })

  it.each(LOCALES)('%s: 原因地震の規模が続報で変わったら、2 つの地震を言い分けて言い直す（正）', (locale) => {
    const st = speechTextWithDraft(locale)
    const states = [st.createQuakeSpokenState(), st.createQuakeSpokenState()]
    const spokenOf = (sources: TsunamiSourceEarthquake[]) => ({
      expiry: states[0],
      sources: sources.map((source, i) => ({ source, spoken: states[i], subject: undefined, quakeReportedLater: false })),
    })
    const areas = [areaOf('Watch', '富山県', '１ｍ')]
    const before = [{ ...NOTO_SOURCE, magnitude: 7.4 }, { ...NOTO_SOURCE, magnitude: 6.1 }]
    const first = spokenOf(before)
    st.applyTsunamiSpokenRefs(first, st.tsunamiToSegments(tsunamiOf(areas, { sourceEarthquakes: before }), undefined, first, QUAKE_OPTS).flatMap(s => s.refs))
    const after = [NOTO_SOURCE, { ...NOTO_SOURCE, magnitude: 6.2 }]
    const text = textOf(st.tsunamiToSegments(tsunamiOf(areas, { sourceEarthquakes: after }), undefined, spokenOf(after), QUAKE_OPTS))
    const [thisQuake, otherQuake] = EXPECTED_SOURCE_AMENDED[locale]
    expect(text).toContain(thisQuake)
    // 2 つ目の地震の文は「また、」の後ろ（英葡西は大文字のまま続く）
    expect(text).toContain(`${SPEECH_WORDS_BY_LOCALE[locale].common.also}${otherQuake}`)
  })

  // 取消の長い理由を別の発話で読むときの前置きの名前（11 節の 10）。日本語以外は理由を読まないので今は声にならないが、名乗りと同じ語にしておく
  it.each(LOCALES)('%s: 誤報の取消の前置きに渡す名前は語表の名前（正）', (locale) => {
    expect(speechTextWithDraft(locale).TSUNAMI_WARNINGS_ETC_NAME).toBe(SPEECH_WORDS_BY_LOCALE[locale].tsunami.warningsEtc)
  })

  // 波高の文を持たず、到達・欠測などだけを読む報の名乗り（受信処理が足す）。日本語もこの報では見出し文を読まないので、
  // 日本語以外も在処の文を言わない（2026-11-18 ユーザー選択「日本語が気象庁の文を読む所だけ (Recommended)」）
  it.each(LOCALES)('%s: 到達・欠測だけの報の名乗りは語表の名乗りで、在処の文を付けない（正）', (locale) => {
    const words = SPEECH_WORDS_BY_LOCALE[locale]
    const text = joinSegments(speechTextWithDraft(locale).tsunamiObservationLeadSegments())
    expect(text).toBe(words.tsunami.observationInfoLead)
    expect(text).not.toContain(words.common.telegramTextElsewhere!)
  })

  it('日本語の到達・欠測だけの報の名乗りは今の文のまま（対照）', () => {
    expect(joinSegments(JA_SPEECH_TEXT.tsunamiObservationLeadSegments())).toBe('津波観測に関する情報。')
  })

  // 観測した波高も予想波高と同じ引き直しを通る（数字の無い語が来ても表で引き、訳せなければ記録が残る）
  it.each(LOCALES)('%s: 観測した波高に数字の無い語が来ても、予想波高と同じ表で引き直す（安全弁）', (locale) => {
    const odd: TsunamiObservation[] = [{ name: '輪島港', districtName: '石川県能登', height: { value: NaN, description: '巨大' } }]
    const text = textOf(speechTextWithDraft(locale).tsunamiObservationUpdateToSegments(odd, undefined, 5, undefined, new Map(), new Map()))
    expect(text).toContain(SPEECH_WORDS_BY_LOCALE[locale].tsunami.nonNumericHeight['巨大'])
    expect(text).not.toMatch(KANA)
  })
})

// 記録は「言語:種類」を札に、値ごとに 1 度だけ出す。実行順で変わらないよう、テストごとに控えを空に戻す
describe('津波の文で訳せない値（安全弁）', () => {
  beforeEach(() => { resetUntranslatedValueLogGates() })
  afterEach(() => { vi.restoreAllMocks() })

  it('日本語以外の組は、表に無い区域名・観測点名・波高の表記・押し引き・等級を、値ごとに 1 度だけ警告して読む', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const st = speechTextWithDraft('es')
    const odd = tsunamiOf([areaOf('Warning', '架空の区域', '１ｍ程度')])
    const obs: TsunamiObservation[] = [
      { name: '架空の観測点', districtName: '架空の区域', height: { value: 1, description: '1m' }, arrivalTime: jan1(16, 10), initial: '知らない語' },
    ]
    const bogusGrade = 'Bogus' as TsunamiArea['grade']
    let texts = ''
    for (let i = 0; i < 2; i++) {
      texts += textOf(st.tsunamiToSegments(odd, undefined, undefined, QUAKE_OPTS))
      texts += textOf(st.tsunamiObservationUpdateToSegments(obs, undefined, 5, undefined, new Map(), new Map()))
      texts += textOf(st.tsunamiAreaGradeChangeToSegments([{ from: bogusGrade, to: 'Warning', raised: true, areas: [areaOf('Warning', '富山県')] }]))
    }
    // 名前と表記は電文の語のまま読む。知らない押し引きは「第一波」と言う。型の外の等級は名前を言わない（「undefined」と読まない）
    expect(texts).toContain('架空の区域')
    expect(texts).toContain('架空の観測点')
    expect(texts).toContain('１ｍ程度')
    expect(texts).toContain('la primera ola llegó')
    expect(texts).not.toContain('知らない語')
    expect(texts).not.toContain('undefined')
    const messages = warn.mock.calls.map(c => String(c[0]))
    expect(messages.filter(m => m.includes('地名の表に無い名前') && m.includes('種類 tsunamiArea'))).toHaveLength(1)
    expect(messages.filter(m => m.includes('地名の表に無い名前') && m.includes('種類 tsunamiStation'))).toHaveLength(1)
    expect(messages.filter(m => m.includes('語表が訳せない値') && m.includes('種類 height'))).toHaveLength(1)
    expect(messages.filter(m => m.includes('語表が訳せない値') && m.includes('種類 firstWaveInitial'))).toHaveLength(1)
    expect(messages.filter(m => m.includes('語表が訳せない値') && m.includes('種類 grade'))).toHaveLength(1)
  })

  it('日本語の組は電文の語をそのまま読むので、警告を残さない（対照）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const text = textOf(JA_SPEECH_TEXT.tsunamiToSegments(tsunamiOf([areaOf('Warning', '架空の区域', '１ｍ程度')]), undefined, undefined, QUAKE_OPTS))
    expect(text).toContain('架空の区域で1メートル程度が予想されています。')
    expect(warn.mock.calls.filter(c => /地名の表に無い名前|語表が訳せない値/.test(String(c[0])))).toHaveLength(0)
  })
})

describe('日本語の津波の文は今の文のまま（対照）', () => {
  it('同じ報で今の文になる（区切り・予想と観測の波高・延長の文・避難の付加文・見出し文）', () => {
    expect(produceTsunami(JA_SPEECH_TEXT)).toEqual(EXPECTED_TSUNAMI_JA)
    expect(JA_SPEECH_TEXT.TSUNAMI_WARNINGS_ETC_NAME).toBe('津波警報等')
  })
})

// ---- 長周期・特別情報・揺れ検知・国際津波関連情報・時報（2026-11-18 の表） ----

/** 端末の時刻帯での時刻 */
const localAt = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString()
const REST_OPTS: TtsSpeechOptions = { intensityLevels: 2, maxRegions: 0, alwaysReadScale: -1, alwaysReadLpgmClass: -1, regionTolerance: 0 }
/** お知らせ・後発地震注意情報の気象庁の見出し文（日本語の組だけが読む） */
const NOTICE_HEADLINE = '緊急地震速報（警報）について'
const KOHATSU_HEADLINE = '北海道・三陸沖後発地震注意情報を発表しました。１２月８日２３時１５分頃、青森県東方沖でマグニチュード７．５の地震が発生しました。'

function lpgmOf(regions: { name: string; maxLgInt: number }[], extra: Partial<JMALpgm> = {}): JMALpgm {
  return {
    id: 'locale-lpgm', eventId: '20240101161000', time: localAt(2024, 1, 1, 16, 12), originTime: localAt(2024, 1, 1, 16, 10),
    maxClass: 4, cancelled: false, regions: regions.map((r, i) => ({ code: String(i), ...r })), ...extra,
  }
}
const nankaiOf = (kindCode: string, kindName: string, extra: Partial<JMANankai> = {}) =>
  ({ id: 'n', time: '', eventId: 'n', kindCode, kindName, headline: '', body: '', cancelled: false, ...extra }) as JMANankai
const commentaryOf = (serialName: string, headline: string, extra: Partial<JMANankaiCommentary> = {}) =>
  ({ id: 'c', time: '', eventId: 'c', serialCode: '', serialName, headline, body: '本文', cancelled: false, reportDateTime: '', expireAt: '', ...extra }) as JMANankaiCommentary
const countOf = (number: number | null, feltNumber: number | null, start = localAt(2026, 1, 9, 15, 0), end = localAt(2026, 1, 10, 12, 0), extra: Partial<JMAEarthquakeCount> = {}) =>
  ({ id: 'q', time: '', eventId: 'q', headline: '', cancelled: false, items: [{ type: '累積地震回数', startTime: start, endTime: end, number, feltNumber }], ...extra }) as JMAEarthquakeCount
const noticeOf = (headline: string, extra: Partial<JMAQuakeNotice> = {}) =>
  ({ id: 'o', time: '', eventId: 'o', headline, body: '本文', cancelled: false, reportDateTime: '', expireAt: '', ...extra }) as JMAQuakeNotice
const kohatsuOf = (headline: string, extra: Partial<JMAKohatsu> = {}) =>
  ({ id: 'k', time: '', eventId: 'k', headline, body: '', cancelled: false, ...extra }) as JMAKohatsu
const intlOf = (extra: Partial<JMAInternationalTsunami> = {}): JMAInternationalTsunami => ({
  id: 'i', title: 'WEPA60', time: '', originTime: '2026-03-24T23:43:00Z', isCommunicationsTest: false, text: '',
  epicenter: { latitude: 13.9, longitude: 120.5 }, magnitude: 7.0, depthKm: 139, bulletinNumber: 1, evaluation: 'localNearEpicenter', ...extra,
})
const NOTO_LPGM = [{ name: '石川県能登', maxLgInt: 4 }, { name: '石川県加賀', maxLgInt: 3 }, { name: '富山県東部', maxLgInt: 3 }]

/** 長周期以降の文を、実運用と同じ関数から組む（キーは `ttsTextLocalesRest.fixture.ts`） */
function produceRest(st: SpeechText, words: SpeechWords): Record<string, string> {
  const at = (h: number, m: number) => new Date(2026, 0, 1, h, m).getTime()
  const time = (h: number, m: number, clock: TimeSignalClock, phrase: TimeSignalPhrase) =>
    timeSignalSpeechText(at(h, m), clock, phrase, words.timeSignal.say)
  return {
    lpgm2: st.lpgmToText(lpgmOf(NOTO_LPGM), REST_OPTS, true),
    lpgm2update: st.lpgmToText(lpgmOf(NOTO_LPGM), REST_OPTS, false),
    lpgm3class: st.lpgmToText(lpgmOf([{ name: '石川県能登', maxLgInt: 4 }, { name: '石川県加賀', maxLgInt: 3 }, { name: '富山県東部', maxLgInt: 2 }]), { ...REST_OPTS, intensityLevels: 4 }, true),
    lpgmOmitted: st.lpgmToText(lpgmOf([{ name: '石川県能登', maxLgInt: 3 }, { name: '石川県加賀', maxLgInt: 3 }, { name: '富山県東部', maxLgInt: 3 }]), { ...REST_OPTS, maxRegions: 1 }, true),
    lpgmMaxOnly: st.lpgmToText(lpgmOf([]), REST_OPTS, true),
    lpgmRetracted: st.lpgmToText(lpgmOf(NOTO_LPGM, { cancelled: true, cancelText: REASON }), REST_OPTS, false),
    nankai111: st.nankaiToText(nankaiOf('111', '調査中')),
    nankai112: st.nankaiToText(nankaiOf('112', '調査中')),
    nankai113: st.nankaiToText(nankaiOf('113', '調査中')),
    nankaiInvestigatingNone: st.nankaiToText(nankaiOf('999', '調査中')),
    nankaiEnded: st.nankaiToText(nankaiOf('190', '調査終了')),
    nankaiWarning: st.nankaiToText(nankaiOf('120', '巨大地震警戒')),
    nankaiAdvisory: st.nankaiToText(nankaiOf('130', '巨大地震注意')),
    nankaiOther: st.nankaiToText(nankaiOf('100', 'その他')),
    nankaiRetracted: st.nankaiToText(nankaiOf('120', '巨大地震警戒', { retracted: true, body: REASON })),
    commentaryRegular: st.nankaiCommentaryToText(commentaryOf('定例解説', '南海トラフ地震関連解説情報')),
    commentary1: st.nankaiCommentaryToText(commentaryOf('臨時解説', '南海トラフ地震関連解説情報（第１号）')),
    commentary12: st.nankaiCommentaryToText(commentaryOf('臨時解説', '南海トラフ地震関連解説情報（第１２号）')),
    commentaryRetracted: st.nankaiCommentaryToText(commentaryOf('臨時解説', '', { cancelled: true, body: REASON })),
    count5felt1: st.earthquakeCountToText(countOf(5, 1)),
    count1felt0: st.earthquakeCountToText(countOf(1, 0)),
    count5felt3: st.earthquakeCountToText(countOf(5, 3)),
    countFeltOnly1: st.earthquakeCountToText(countOf(null, 1)),
    countFeltOnly3: st.earthquakeCountToText(countOf(null, 3)),
    countSpanUnknown: st.earthquakeCountToText(countOf(5, 1, '壊れた値', '壊れた値')),
    countOneOClock: st.earthquakeCountToText(countOf(5, 1, localAt(2026, 1, 9, 1, 0), localAt(2026, 1, 10, 1, 0))),
    countRetracted: st.earthquakeCountToText(countOf(5, 1, undefined, undefined, { cancelled: true, cancelText: REASON })),
    noticeHeadline: st.quakeNoticeToText(noticeOf(NOTICE_HEADLINE)),
    noticeEmpty: st.quakeNoticeToText(noticeOf('')),
    noticeRetracted: st.quakeNoticeToText(noticeOf('', { cancelled: true, body: REASON })),
    kohatsu: st.kohatsuToText(kohatsuOf(KOHATSU_HEADLINE)),
    kohatsuRetracted: st.kohatsuToText(kohatsuOf('', { cancelled: true, retracted: true, body: REASON })),
    estimatedNew: st.estimatedIntensityToText(localAt(2026, 1, 1, 12, 34), true),
    estimatedUpdate: st.estimatedIntensityToText(localAt(2026, 1, 1, 12, 34), false),
    estimatedOneOClock: st.estimatedIntensityToText(localAt(2026, 1, 1, 1, 5), true),
    estimatedNoTime: st.estimatedIntensityToText('壊れた値', true),
    kyoshinDetected: st.kyoshinDetectionText({ kind: 'detected', regionName: '石川県能登' }),
    kyoshinDetectedNull: st.kyoshinDetectionText({ kind: 'detected', regionName: null }),
    kyoshinOther: st.kyoshinDetectionText({ kind: 'otherRegion', regionName: '茨城県南部' }),
    kyoshinOtherNull: st.kyoshinDetectionText({ kind: 'otherRegion', regionName: null }),
    kyoshinSagami: st.kyoshinDetectionText({ kind: 'detected', regionName: '相模湾' }),
    intlFull: st.internationalTsunamiToText(intlOf(), 'フィリピン付近'),
    intlCoord: st.internationalTsunamiToText(intlOf()),
    intlSouthWest: st.internationalTsunamiToText(intlOf({ epicenter: { latitude: -13.9, longitude: -120.5 }, depthKm: undefined })),
    intlUpdate: st.internationalTsunamiToText(intlOf({ bulletinNumber: 2, evaluation: 'none' })),
    intlNoEval: st.internationalTsunamiToText(intlOf({ evaluation: undefined })),
    intlOneOClock: st.internationalTsunamiToText(intlOf({ originTime: '2026-03-01T16:05:00Z', evaluation: 'oceanWide' })),
    intlTest: st.internationalTsunamiToText(intlOf({ isCommunicationsTest: true })),
    time_15_30_24h_oshirase: time(15, 30, '24h', 'oshirase'),
    time_15_30_24h_desu: time(15, 30, '24h', 'desu'),
    time_15_30_24h_narimashita: time(15, 30, '24h', 'narimashita'),
    time_15_30_24h_bare: time(15, 30, '24h', 'bare'),
    time_15_0_24h_desu: time(15, 0, '24h', 'desu'),
    time_15_30_12h_desu: time(15, 30, '12h', 'desu'),
    time_15_30_12h_oshirase: time(15, 30, '12h', 'oshirase'),
    time_1_30_24h_desu: time(1, 30, '24h', 'desu'),
    time_1_30_24h_narimashita: time(1, 30, '24h', 'narimashita'),
    time_1_30_24h_oshirase: time(1, 30, '24h', 'oshirase'),
    time_1_30_24h_bare: time(1, 30, '24h', 'bare'),
    time_13_5_12h_desu: time(13, 5, '12h', 'desu'),
  }
}

describe('長周期・特別情報・揺れ検知・国際津波関連情報・時報の文（2026-11-18 の表）', () => {
  for (const locale of LOCALES) {
    it(`${locale}: 表の文になる（正）`, () => {
      expect(produceRest(speechTextWithDraft(locale), wordsWithDraft(locale))).toEqual(EXPECTED_REST[locale])
    })
  }

  it('日本語以外の文に仮名と気象庁の見出し文が入らない（安全弁）', () => {
    for (const locale of LOCALES) {
      const texts = produceRest(speechTextWithDraft(locale), wordsWithDraft(locale))
      for (const [key, text] of Object.entries(texts)) {
        expect(KANA.test(text), `${locale} ${key}: ${text}`).toBe(false)
        expect(text).not.toContain('緊急地震速報（警報）について')
        expect(text).not.toContain('青森県東方沖')
        expect(text).not.toContain(REASON)
      }
    }
  })

  it('日本語以外は、長い取消の理由を別の発話へ回さない（安全弁）', () => {
    const long = '取消の理由です。'.repeat(40)
    for (const locale of LOCALES) {
      const st = speechTextWithDraft(locale)
      expect(st.deferredCancelReasonToSpeak(st.INFO_NAME.lpgm, long)).toBeNull()
      expect(st.lpgmToText(lpgmOf(NOTO_LPGM, { cancelled: true, cancelText: long }), REST_OPTS, false)).not.toContain('取消の理由')
    }
  })

  it('表に無い区域名は日本語の名前のまま読み、記録を 1 度だけ残す（安全弁）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const st = speechTextWithDraft('en')
    expect(st.kyoshinDetectionText({ kind: 'detected', regionName: '架空の揺れ区域' })).toBe('Shaking detected: 架空の揺れ区域.')
    expect(st.kyoshinDetectionText({ kind: 'otherRegion', regionName: '架空の揺れ区域' })).toBe('Shaking also detected: 架空の揺れ区域.')
    expect(warn.mock.calls.filter(c => String(c[0]).includes('地名の表に無い名前') && String(c[0]).includes('架空の揺れ区域'))).toHaveLength(1)
  })

  // 12 時間制の時間帯の語（2026-11-18 ユーザー選択「言語ごとの時間帯の語で言う (Recommended)」）
  it('時報の 12 時間制は言語ごとの時間帯の語で言う（0:30・6:30・12:30・13:30）（正）', () => {
    const EXPECTED_PERIOD: Record<OtherLocale, readonly [string, string, string, string]> = {
      en: ["It's 12:30 a.m.", "It's 6:30 a.m.", "It's 12:30 p.m.", "It's 1:30 p.m."],
      'zh-Hans': ['现在是凌晨0点30分。', '现在是上午6点30分。', '现在是中午12点30分。', '现在是下午1点30分。'],
      'zh-Hant': ['現在是凌晨0點30分。', '現在是上午6點30分。', '現在是中午12點30分。', '現在是下午1點30分。'],
      ko: ['오전 0시 30분입니다.', '오전 6시 30분입니다.', '낮 12시 30분입니다.', '오후 1시 30분입니다.'],
      'pt-BR': ['São 0:30 da madrugada.', 'São 6:30 da manhã.', 'São 12:30 da tarde.', 'É 1:30 da tarde.'],
      es: ['Son las 0:30 de la madrugada.', 'Son las 6:30 de la mañana.', 'Son las 12:30 del mediodía.', 'Es la 1:30 de la tarde.'],
    }
    const at = (h: number, m: number) => new Date(2026, 0, 1, h, m).getTime()
    for (const locale of LOCALES) {
      const say = wordsWithDraft(locale).timeSignal.say
      expect([0, 6, 12, 13].map(h => timeSignalSpeechText(at(h, 30), '12h', 'desu', say)), locale).toEqual(EXPECTED_PERIOD[locale])
    }
    // 正時・ほかの形への当て方は今の作りのまま
    expect(timeSignalSpeechText(at(0, 0), '12h', 'desu', zhHansSpeech.timeSignal.say)).toBe('现在是凌晨0点整。')
    expect(timeSignalSpeechText(at(12, 0), '12h', 'oshirase', koSpeech.timeSignal.say)).toBe('낮 12시를 알려 드립니다.')
    expect(timeSignalSpeechText(at(0, 30), '12h', 'bare', esSpeech.timeSignal.say)).toBe('Las 0:30 de la madrugada')
    expect(timeSignalSpeechText(at(1, 30), '12h', 'narimashita', ptBRSpeech.timeSignal.say)).toBe('Agora é 1:30 da madrugada.')
  })

  // 夜の語（2026-11-18 ユーザー選択「夜の語を足す (Recommended)」）。境は中国語・ポルトガル語が 18 時、スペイン語が 20 時。英語・韓国語は変えない
  it('時報の 12 時間制の夜（18:30・19:30・20:30・22:30）（正・対照）', () => {
    const EXPECTED_NIGHT: Record<OtherLocale, readonly [string, string, string, string]> = {
      en: ["It's 6:30 p.m.", "It's 7:30 p.m.", "It's 8:30 p.m.", "It's 10:30 p.m."],
      'zh-Hans': ['现在是晚上6点30分。', '现在是晚上7点30分。', '现在是晚上8点30分。', '现在是晚上10点30分。'],
      'zh-Hant': ['現在是晚上6點30分。', '現在是晚上7點30分。', '現在是晚上8點30分。', '現在是晚上10點30分。'],
      ko: ['오후 6시 30분입니다.', '오후 7시 30분입니다.', '오후 8시 30분입니다.', '오후 10시 30분입니다.'],
      'pt-BR': ['São 6:30 da noite.', 'São 7:30 da noite.', 'São 8:30 da noite.', 'São 10:30 da noite.'],
      es: ['Son las 6:30 de la tarde.', 'Son las 7:30 de la tarde.', 'Son las 8:30 de la noche.', 'Son las 10:30 de la noche.'],
    }
    const at = (h: number, m: number) => new Date(2026, 0, 1, h, m).getTime()
    for (const locale of LOCALES) {
      const say = wordsWithDraft(locale).timeSignal.say
      expect([18, 19, 20, 22].map(h => timeSignalSpeechText(at(h, 30), '12h', 'desu', say)), locale).toEqual(EXPECTED_NIGHT[locale])
    }
    // 境の手前（17 時台）は午後の語のまま（対照）
    expect(timeSignalSpeechText(at(17, 30), '12h', 'desu', zhHansSpeech.timeSignal.say)).toBe('现在是下午5点30分。')
    expect(timeSignalSpeechText(at(17, 30), '12h', 'desu', ptBRSpeech.timeSignal.say)).toBe('São 5:30 da tarde.')
    expect(timeSignalSpeechText(at(22, 30), '12h', 'bare', esSpeech.timeSignal.say)).toBe('Las 10:30 de la noche')
  })

  it('後発地震注意情報は、見出し文が無い報では在処の文を言わない（対照。日本語も見出し文を読まない報）', () => {
    for (const locale of LOCALES) {
      const text = speechTextWithDraft(locale).kohatsuToText(kohatsuOf(''))
      expect(text, locale).not.toContain(wordsWithDraft(locale).common.telegramTextElsewhere!)
      // 見出し文がある報では言う
      expect(speechTextWithDraft(locale).kohatsuToText(kohatsuOf(KOHATSU_HEADLINE))).toContain(wordsWithDraft(locale).common.telegramTextElsewhere!)
    }
    expect(JA_SPEECH_TEXT.kohatsuToText(kohatsuOf(''))).toBe('北海道・三陸沖後発地震注意情報。今後、大規模地震の発生可能性が平常時より高まっています。防災対応の確認をしてください。')
  })

  it('国際津波関連情報の評価が語表に無い値なら、評価の句を省いて「情報が発表された」で結び、記録を残す（安全弁）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const x = intlOf({ evaluation: 'unknownValue' as JMAInternationalTsunami['evaluation'] })
    expect(speechTextWithDraft('en').internationalTsunamiToText(x)).toBe(EXPECTED_REST.en.intlNoEval)
    expect(warn.mock.calls.some(c => String(c[0]).includes('津波発生の可能性を語表で引けず'))).toBe(true)
  })

  it('全角の号数は日本語では全角のまま、ほかの言語では半角で読む（対照）', () => {
    const c = commentaryOf('臨時解説', '南海トラフ地震関連解説情報（第１号）')
    expect(JA_SPEECH_TEXT.nankaiCommentaryToText(c)).toContain('第１号')
    for (const locale of LOCALES) expect(speechTextWithDraft(locale).nankaiCommentaryToText(c)).not.toMatch(/[０-９]/)
  })
})

describe('日本語の長周期以降の文は今の文のまま（対照）', () => {
  it('長周期・特別情報・揺れ検知・時報が今の文になる', () => {
    const st = JA_SPEECH_TEXT
    expect(st.lpgmToText(lpgmOf(NOTO_LPGM), REST_OPTS, true))
      .toBe('長周期地震動に関する観測情報。16時10分頃発生した地震で、長周期地震動階級4を石川県能登、階級3を石川県加賀、富山県東部で観測しました。')
    expect(st.quakeNoticeToText(noticeOf(NOTICE_HEADLINE))).toBe('地震・津波に関するお知らせ。緊急地震速報（警報）について。')
    expect(st.quakeNoticeToText(noticeOf(''))).toBe('地震・津波に関するお知らせ。')
    expect(st.kohatsuToText(kohatsuOf('１２月８日２３時１５分頃、青森県東方沖でマグニチュード７．５の地震が発生しました。')))
      .toBe('北海道・三陸沖後発地震注意情報。１２月８日２３時１５分頃、青森県東方沖でマグニチュード７．５の地震が発生しました。今後、大規模地震の発生可能性が平常時より高まっています。防災対応の確認をしてください。')
    expect(st.nankaiCommentaryToText(commentaryOf('臨時解説', '南海トラフ地震関連解説情報（第１号）')))
      .toBe('南海トラフ地震関連解説情報、第１号。南海トラフ地震の想定震源域の状況について解説情報が発表されました。')
    expect(st.kyoshinDetectionText({ kind: 'detected', regionName: '相模湾' })).toBe('相模湾で揺れを検知。')
    expect(st.kyoshinDetectionText({ kind: 'otherRegion', regionName: null })).toBe('別の地点でも揺れを検知。')
    expect(timeSignalSpeechText(new Date(2026, 0, 1, 12, 0).getTime(), '12h', 'oshirase', jaSpeech.timeSignal.say)).toBe('午後0時をお知らせします')
  })

  it('国際津波関連情報は、中継へ写した日本語の関数と同じ文になる', () => {
    const cases: [JMAInternationalTsunami, string | undefined][] = [
      [intlOf(), 'フィリピン付近'],
      [intlOf(), undefined],
      [intlOf({ epicenter: { latitude: -13.9, longitude: -120.5 }, depthKm: undefined }), undefined],
      [intlOf({ bulletinNumber: 2, evaluation: 'none' }), '  '],
      [intlOf({ evaluation: undefined }), undefined],
      [intlOf({ originTime: undefined, epicenter: undefined, magnitude: undefined, depthKm: undefined, evaluation: undefined }), undefined],
      [intlOf({ originTime: '2026-02-28T16:05:00Z', evaluation: 'regional' }), undefined],
      [intlOf({ originTime: '壊れた値', magnitude: Number.NaN, evaluation: 'verySmall' }), undefined],
      [intlOf({ isCommunicationsTest: true }), undefined],
    ]
    for (const [x, name] of cases) expect(JA_SPEECH_TEXT.internationalTsunamiToText(x, name)).toBe(relayInternationalTsunamiToText(x, name))
  })

  it('取消の理由の前置きに渡す情報の名前は、今の名前のまま', () => {
    expect(JA_SPEECH_TEXT.INFO_NAME).toEqual({
      eew: '緊急地震速報',
      quake: '地震情報',
      lpgm: '長周期地震動に関する観測情報',
      earthquakeCount: '地震回数に関する情報',
      quakeNotice: '地震・津波に関するお知らせ',
      nankai: '南海トラフ地震臨時情報',
      nankaiCommentary: '南海トラフ地震関連解説情報',
      kohatsu: '北海道・三陸沖後発地震注意情報',
    })
    expect(JA_SPEECH_TEXT.reportNameToSay('震度速報')).toBe('震度速報')
  })
})
