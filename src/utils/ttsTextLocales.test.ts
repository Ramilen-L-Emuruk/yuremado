// 日本語以外の語表で、緊急地震速報の読み上げ文が承認した文面どおりに組まれることを固定する。
//
// 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（6 言語）。語表はまだ緊急地震速報の区分しか訳していないので
// （→ `i18n/speechWords.ts` の `SpeechWordsInProgress`）、日本語の語表に訳した区分を重ねた組で、緊急地震速報の関数だけを通す。
//
// 正・対照・安全弁の分担:
//   正   ＝ 6 言語とも、名乗り・震央・切り替え・対象地方・予想値・取消が表の文になる
//   対照 ＝ 日本語の組は今の文のまま（区切りを足しても連結と変わらない・取消の理由は気象庁の文を読む）
//   安全弁＝ 気象庁の文を読まない言語は、長い理由でも別の発話へ回さない（日本語の文を声にしない）
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSpeechText, speechTextFor, JA_SPEECH_TEXT, type SpeechText } from './ttsText'
import { jaSpeech, type SpeechWords, type SpeechWordsInProgress } from '../i18n/speechWords'
import { enSpeech } from '../i18n/speech/en'
import { zhHansSpeech } from '../i18n/speech/zhHans'
import { zhHantSpeech } from '../i18n/speech/zhHant'
import { koSpeech } from '../i18n/speech/ko'
import { ptBRSpeech } from '../i18n/speech/ptBR'
import { esSpeech } from '../i18n/speech/es'
import { JA_PLACE_NAMES, placeNameLookup, validatePlaceNameTable } from '../i18n/placeNames'
import type { Locale } from '../i18n/messages'
import type { EEWAlert } from '../types/earthquake'

type OtherLocale = Exclude<Locale, 'ja'>
const SPEECH_WORDS_IN_PROGRESS: Readonly<Record<OtherLocale, SpeechWordsInProgress>> = {
  en: enSpeech, 'zh-Hans': zhHansSpeech, 'zh-Hant': zhHantSpeech, ko: koSpeech, 'pt-BR': ptBRSpeech, es: esSpeech,
}
const LOCALES = Object.keys(SPEECH_WORDS_IN_PROGRESS) as OtherLocale[]

/** 日本語の語表に、訳した区分を重ねた組（緊急地震速報の関数だけが訳を引く） */
function speechTextWithEew(locale: OtherLocale): SpeechText {
  const draft = SPEECH_WORDS_IN_PROGRESS[locale]
  const words: SpeechWords = { ...jaSpeech, common: { ...jaSpeech.common, ...draft.common }, eew: draft.eew }
  const table: unknown = JSON.parse(readFileSync(new URL(`../../public/data/place-names/${locale}.json`, import.meta.url), 'utf8'))
  validatePlaceNameTable(table)
  return createSpeechText(words, placeNameLookup(table), locale)
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
    expect(() => speechTextWithEew(locale)).not.toThrow()
  })

  // `canBuildSpeechText` は日本語の地名の引きで 1 度だけ試し、本物の引きで作る `speechTextFor` と結果が食い違わないとしている。
  // その前提（組を作るときに地名の引きを呼ばない）を固定する
  it.each(LOCALES)('%s: 組を作るときに地名の引きを呼ばない（安全弁）', (locale) => {
    const draft = SPEECH_WORDS_IN_PROGRESS[locale]
    const words: SpeechWords = { ...jaSpeech, common: { ...jaSpeech.common, ...draft.common }, eew: draft.eew }
    const throwing = Object.assign(() => { throw new Error('組を作るときに呼ばれた') }, { has: () => { throw new Error('組を作るときに呼ばれた') } })
    expect(() => createSpeechText(words, throwing, locale)).not.toThrow()
    expect(() => createSpeechText(jaSpeech, throwing, 'ja')).not.toThrow()
  })

  it.each(LOCALES)('%s: 表の文になる（正）', (locale) => {
    expect(produce(speechTextWithEew(locale))).toEqual(EXPECTED[locale])
  })

  // 読む側は、組で組んだ文にその組の `locale` を添えて声を選ぶ（→ `useLiveEventHandler.ts` の `SpokenText`）
  it.each(LOCALES)('%s: 組は自分の言語を持つ（正）', (locale) => {
    expect(speechTextWithEew(locale).locale).toBe(locale)
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
    const st = speechTextWithEew(locale)
    const longReason = 'あ'.repeat(st.CANCEL_REASON_INLINE_MAX_CHARS + 1) + '。'
    expect(st.deferredCancelReasonToSpeak('緊急地震速報', longReason)).toBeNull()
    expect(st.eewCancelToText({ ...EVENT, cancelled: true, cancelText: longReason }, null))
      .toBe(`${EXPECTED[locale].cancelled}${SPEECH_WORDS_IN_PROGRESS[locale].common.sentenceSep}${SPEECH_WORDS_IN_PROGRESS[locale].common.telegramTextElsewhere}`)
  })

  it.each(LOCALES)('%s: 警報の締めの句は文の中にそのまま入る（鳴った文の判定が部分一致で見るため）', (locale) => {
    const st = speechTextWithEew(locale)
    expect(st.eewWarningRegionsText(['東北'], false)).toContain(st.EEW_WARNING_REGIONS_CLOSING)
    expect(st.eewWarningRegionsText(['東北'], true)).toContain(st.EEW_WARNING_REGIONS_CLOSING)
    expect(st.eewWarningRegionsText(['東北'], false, true).startsWith(st.EEW_UPGRADE_PHRASE)).toBe(true)
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
