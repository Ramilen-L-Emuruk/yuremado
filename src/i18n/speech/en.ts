import type { SpeechWordsInProgress } from '../speechWords'
import { en } from '../messages/en'
import { clockTime, intensityIn, regionNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(en)
const lead = {
  forecast: 'Ground motion forecast.',
  warning: 'Earthquake Early Warning.',
  hypocenterUpdate: 'Hypocenter updated.',
}

/**
 * 読み上げの文の語表（英語。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁「緊急地震速報・津波警報の多言語辞書」の定型文
 * （Watch out for strong tremors など）と画面の辞書の訳にそろえた。震央・対象地方は「:」で示す（前置詞が地名の訳とぶつかるため）
 */
export const enSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: clockTime,
    telegramTextElsewhere: "JMA's original text is in the Telegram Log.",
  },
  eew: {
    upgrade: 'Upgraded to an Earthquake Early Warning.',
    warningRegionsClosing: 'watch out for strong tremors',
    lpgmClassZero: 'Maximum forecast long-period ground motion class 0.',
    cancelledAt: (time) => `The Earthquake Early Warning issued at ${time} has been cancelled.`,
    cancelled: 'The Earthquake Early Warning has been cancelled.',
    lead,
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l} Earthquake: ${epicenter}.`,
    warningRegionName: regionNameIn(en),
    warningRegionsAdditional: (names, closing) => `Also ${names}: ${closing}.`,
    warningRegions: (names, closing) => `${names}: ${closing}.`,
    noForecast: {
      singleStation: 'No intensity forecast: single-station.',
      deep: 'No intensity forecast: deep earthquake.',
      belowScale1: 'Maximum forecast intensity 0.',
      unknown: 'No intensity forecast.',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `Maximum forecast intensity ${showsApproxAbove(scale, orAbove) ? `about ${label} or higher` : label}.`
    },
    maxLpgmClass: (cls, over) => `Maximum forecast long-period ground motion class ${over ? `about ${cls} or higher` : cls}.`,
  },
}
