import type { SpeechWordsInProgress } from '../speechWords'
import { ptBR } from '../messages/ptBR'
import { clockTime, intensityIn, regionNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(ptBR)

/**
 * 読み上げの文の語表（ポルトガル語・ブラジル。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（Fique alerta a fortes tremores・cancelou）と
 * 画面の辞書の訳（Alerta Urgente de Terremoto・Intensidade máx. prevista など）にそろえた。震央・対象地方は「:」で示す
 */
export const ptBRSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: clockTime,
    telegramTextElsewhere: 'O texto original da Agência Meteorológica do Japão está no Registro de telegramas.',
  },
  eew: {
    upgrade: 'Elevado para Alerta Urgente de Terremoto.',
    warningRegionsClosing: 'fique alerta a fortes tremores',
    lpgmClassZero: 'Classe máxima prevista de movimento sísmico de longo período 0.',
    cancelledAt: (time) => `O Alerta Urgente de Terremoto emitido às ${time} foi cancelado.`,
    cancelled: 'O Alerta Urgente de Terremoto foi cancelado.',
    lead: {
      forecast: 'Previsão de movimento sísmico.',
      warning: 'Alerta Urgente de Terremoto.',
      hypocenterUpdate: 'Hipocentro atualizado.',
    },
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l} Terremoto: ${epicenter}.`,
    warningRegionName: regionNameIn(ptBR),
    warningRegionsAdditional: (names, closing) => `Também ${names}: ${closing}.`,
    warningRegions: (names, closing) => `${names}: ${closing}.`,
    noForecast: {
      singleStation: 'Sem intensidade prevista: estação única.',
      deep: 'Sem intensidade prevista: terremoto profundo.',
      belowScale1: 'Intensidade máxima prevista 0.',
      unknown: 'Sem intensidade prevista.',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `Intensidade máxima prevista ${showsApproxAbove(scale, orAbove) ? `cerca de ${label} ou superior` : label}.`
    },
    maxLpgmClass: (cls, over) => `Classe máxima prevista de movimento sísmico de longo período ${over ? `cerca de ${cls} ou superior` : cls}.`,
  },
}
