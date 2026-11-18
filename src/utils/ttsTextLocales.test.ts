// 日本語以外の語表で、緊急地震速報・地震情報・震度速報の読み上げ文が承認した文面どおりに組まれることを固定する。
//
// 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（6 言語）。語表はまだ共通・緊急地震速報・地震情報の区分しか
// 訳していないので（→ `i18n/speechWords.ts` の `SpeechWordsInProgress`）、日本語の語表に訳した区分を重ねた組で、それらの関数だけを通す。
//
// 正・対照・安全弁の分担:
//   正   ＝ 6 言語とも、名乗り・震央・切り替え・対象地方・予想値・取消が表の文になる。地震情報・震度速報の報（初報・続報・取消・
//          震源名が無い・規模が数値でない・未入電・遠地地震・種類を名指しした取消）が表の文になる
//   対照 ＝ 日本語の組は今の文のまま（区切りを足しても連結と変わらない・取消の理由は気象庁の文を読む・遠地地震は付加文の原文を読む）
//   安全弁＝ 気象庁の文を読まない言語は、長い理由でも別の発話へ回さない（日本語の文を声にしない）。地震情報の文に気象庁の原文
//          （日本語）が入らない。既読の鍵は言語によらず日本語と同じ
import { describe, it, expect, vi, afterEach } from 'vitest'
import { log } from './logger'
import { readFileSync } from 'node:fs'
import { createSpeechText, speechTextFor, JA_SPEECH_TEXT, type SpeechText, type TtsSpeechOptions } from './ttsText'
import { joinSegments, type SpeechSegment } from './ttsFollow'
import { jaSpeech, type SpeechWords, type SpeechWordsInProgress, type QuakeOccurrenceTexts } from '../i18n/speechWords'
import { enSpeech } from '../i18n/speech/en'
import { zhHansSpeech } from '../i18n/speech/zhHans'
import { zhHantSpeech } from '../i18n/speech/zhHant'
import { koSpeech } from '../i18n/speech/ko'
import { ptBRSpeech } from '../i18n/speech/ptBR'
import { esSpeech } from '../i18n/speech/es'
import { JA_PLACE_NAMES, placeNameLookup, validatePlaceNameTable } from '../i18n/placeNames'
import type { Locale } from '../i18n/messages'
import type { EEWAlert, EarthquakePoint, IntensityScale, IssueType, JMAQuake } from '../types/earthquake'

type OtherLocale = Exclude<Locale, 'ja'>
const SPEECH_WORDS_IN_PROGRESS: Readonly<Record<OtherLocale, SpeechWordsInProgress>> = {
  en: enSpeech, 'zh-Hans': zhHansSpeech, 'zh-Hant': zhHantSpeech, ko: koSpeech, 'pt-BR': ptBRSpeech, es: esSpeech,
}
const LOCALES = Object.keys(SPEECH_WORDS_IN_PROGRESS) as OtherLocale[]

/** 日本語の語表に、訳した区分を重ねた語表（訳した区分の関数だけが訳を引く） */
function wordsWithDraft(locale: OtherLocale): SpeechWords {
  const draft = SPEECH_WORDS_IN_PROGRESS[locale]
  return { ...jaSpeech, common: draft.common, eew: draft.eew, quake: draft.quake }
}

/** 訳した区分を重ねた組（地名は画面の言語の表から引く） */
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
    const nf = SPEECH_WORDS_IN_PROGRESS[locale].eew.noForecast
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
      .toBe(`${EXPECTED[locale].cancelled}${SPEECH_WORDS_IN_PROGRESS[locale].common.sentenceSep}${SPEECH_WORDS_IN_PROGRESS[locale].common.telegramTextElsewhere}`)
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

// 記録は「言語:種類」ごとに 1 度だけ出す（ファイルの中で共有する控え）。このファイルでは、ここより前のテストは表に無い名前を
// 読まないので、ここが最初の 1 回になる
describe('地名の表・情報名の表で引けなかった名前（安全弁）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // 表が届く前（日本語の引き方で組を作った回）と空の名前は記録しない。**次のテストより先に置く** —— ここで 1 度きりの枠を
  // 使ってしまうと、次のテストが期待する「表が届いた後の 1 回」が出なくなるので、そちらが落ちる
  it('表が未読込の組・空の名前では警告を残さない（安全弁）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const loading = createSpeechText(wordsWithDraft('en'), JA_PLACE_NAMES, 'en')
    loading.earthquakeToSegments(quakeOf('震度速報', [area('架空県', '架空の区域', 40)], { hypocenter: NO_HYPOCENTER, maxScale: 40 as IntensityScale }), QUAKE_OPTS, true)
    loading.earthquakeToSegments(quakeOf('震源情報', [], { hypocenter: { name: '架空の震央', latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } }), QUAKE_OPTS, true)
    speechTextWithDraft('en').earthquakeToSegments(quakeOf('震源情報', [], { hypocenter: { name: ' ', latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } }), QUAKE_OPTS, true)
    expect(warn.mock.calls.filter(c => String(c[0]).includes('地名の表に無い名前'))).toHaveLength(0)
  })

  it('日本語以外の組は、表に無い地名を日本語のまま読み、言語と種類ごとに 1 度だけ警告を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const st = speechTextWithDraft('en')
    const unknownEpi = (name: string) => quakeOf('震源情報', [], { hypocenter: { name, latitude: 0, longitude: 0, depth: 10, magnitude: 6.5 } })
    const first = textOf(st.earthquakeToSegments(unknownEpi('架空の震央その一'), QUAKE_OPTS, true))
    textOf(st.earthquakeToSegments(unknownEpi('架空の震央その二'), QUAKE_OPTS, true))
    expect(first).toContain('架空の震央その一')
    const regionWarn = () => textOf(st.earthquakeToSegments(
      quakeOf('震度速報', [area('架空県', '架空の区域', 40)], { hypocenter: NO_HYPOCENTER, maxScale: 40 as IntensityScale }), QUAKE_OPTS, true,
    ))
    expect(regionWarn()).toContain('架空の区域')
    regionWarn()
    const placeWarns = warn.mock.calls.filter(c => String(c[0]).includes('地名の表に無い名前'))
    expect(placeWarns).toHaveLength(2)
    expect(String(placeWarns[0][0])).toContain('種類 epi')
    expect(String(placeWarns[1][0])).toContain('種類 region')
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
    const one = (l: OtherLocale) => SPEECH_WORDS_IN_PROGRESS[l].quake
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
    expect(text).toContain(SPEECH_WORDS_IN_PROGRESS[locale].common.telegramTextElsewhere!)
    expect(textOf(JA_SPEECH_TEXT.earthquakeToSegments(odd, QUAKE_OPTS, true))).toContain('マグニチュードは不定です。')
    vi.restoreAllMocks()
  })

  // 在処の文は発話の末尾に 1 度だけ足す（規模の文は持たない）
  it('en: 知らない規模の表記の文（正）', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(SPEECH_WORDS_IN_PROGRESS.en.quake.magnitudeConditionUnknown('不定')).toBe('The magnitude is not given as a number. ')
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
    expect(text.endsWith(SPEECH_WORDS_IN_PROGRESS[locale].common.telegramTextElsewhere!)).toBe(true)
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
    const elsewhere = SPEECH_WORDS_IN_PROGRESS[locale].common.telegramTextElsewhere!
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
    const ko = SPEECH_WORDS_IN_PROGRESS.ko
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
    const en = SPEECH_WORDS_IN_PROGRESS.en
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
    const elsewhere = SPEECH_WORDS_IN_PROGRESS[locale].common.telegramTextElsewhere!
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
