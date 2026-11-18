import type { SpeechWordsInProgress } from '../speechWords'
import { es } from '../messages/es'
import { clockTime, intensityIn, regionNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(es)

/**
 * 読み上げの文の語表（スペイン語。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（Manténgase alerta contra fuertes temblores・canceló）と
 * 画面の辞書の訳（Alerta Temprana de Terremoto・Intensidad máx. prevista など）にそろえた。震央・対象地方は「:」で示す
 */
export const esSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: clockTime,
    telegramTextElsewhere: 'El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.',
  },
  eew: {
    upgrade: 'Elevado a Alerta Temprana de Terremoto.',
    warningRegionsClosing: 'manténgase alerta contra fuertes temblores',
    lpgmClassZero: 'Clase máxima prevista de movimiento sísmico de período largo 0.',
    cancelledAt: (time) => `La Alerta Temprana de Terremoto emitida a las ${time} fue cancelada.`,
    cancelled: 'La Alerta Temprana de Terremoto fue cancelada.',
    lead: {
      forecast: 'Pronóstico del movimiento sísmico.',
      warning: 'Alerta Temprana de Terremoto.',
      hypocenterUpdate: 'Hipocentro actualizado.',
    },
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l} Terremoto: ${epicenter}.`,
    warningRegionName: regionNameIn(es),
    warningRegionsAdditional: (names, closing) => `También ${names}: ${closing}.`,
    warningRegions: (names, closing) => `${names}: ${closing}.`,
    noForecast: {
      singleStation: 'Sin intensidad prevista: estación única.',
      deep: 'Sin intensidad prevista: sismo profundo.',
      belowScale1: 'Intensidad máxima prevista 0.',
      unknown: 'Sin intensidad prevista.',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `Intensidad máxima prevista ${showsApproxAbove(scale, orAbove) ? `alrededor de ${label} o superior` : label}.`
    },
    maxLpgmClass: (cls, over) => `Clase máxima prevista de movimiento sísmico de período largo ${over ? `alrededor de ${cls} o superior` : cls}.`,
  },
}
