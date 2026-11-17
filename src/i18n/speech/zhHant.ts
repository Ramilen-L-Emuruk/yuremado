import type { SpeechWordsInProgress } from '../speechWords'
import { zhHant } from '../messages/zhHant'
import { intensityIn, regionNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(zhHant)

/**
 * 読み上げの文の語表（中国語・繁体字。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（請警戒強烈的震動・發生地震・取消）と
 * 画面の辞書の訳（緊急地震警報・預測最大震度など）にそろえた
 */
export const zhHantSpeech: SpeechWordsInProgress = {
  common: {
    listSep: '、',
    sentenceSep: '',
    intensity,
    time: (hour, minute) => `${hour}時${minute}分`,
    telegramTextElsewhere: '日本氣象局的原文在電文紀錄中。',
  },
  eew: {
    upgrade: '已升級為緊急地震警報。',
    warningRegionsClosing: '請警戒強烈的震動',
    lpgmClassZero: '預測最大長週期地震動等級0。',
    cancelledAt: (time) => `已取消${time}發表的緊急地震警報。`,
    cancelled: '已取消緊急地震警報。',
    lead: {
      forecast: '地震動預報。',
      warning: '緊急地震警報。',
      hypocenterUpdate: '震源已更新。',
    },
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l}${epicenter}發生地震。`,
    warningRegionName: regionNameIn(zhHant),
    warningRegionsAdditional: (names, closing) => `新增${names}：${closing}。`,
    warningRegions: (names, closing) => `${names}：${closing}。`,
    noForecast: {
      singleStation: '單站處理，無預測震度。',
      deep: '深源地震，無預測震度。',
      belowScale1: '預測最大震度0。',
      unknown: '無預測震度。',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `預測最大震度${showsApproxAbove(scale, orAbove) ? `約${label}以上` : label}。`
    },
    maxLpgmClass: (cls, over) => `預測最大長週期地震動等級${over ? `約${cls}以上` : cls}。`,
  },
}
