import type { SpeechWordsInProgress } from '../speechWords'
import { zhHans } from '../messages/zhHans'
import { intensityIn, regionNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(zhHans)

/**
 * 読み上げの文の語表（中国語・簡体字。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（请注意强烈震动・发生地震・已解除）と
 * 画面の辞書の訳（紧急地震警报・预测最大烈度など）にそろえた
 */
export const zhHansSpeech: SpeechWordsInProgress = {
  common: {
    listSep: '、',
    sentenceSep: '',
    intensity,
    time: (hour, minute) => `${hour}时${minute}分`,
    telegramTextElsewhere: '日本气象局的原文在电文记录中。',
  },
  eew: {
    upgrade: '已升级为紧急地震警报。',
    warningRegionsClosing: '请注意强烈震动',
    lpgmClassZero: '预测最大长周期地震动等级0。',
    cancelledAt: (time) => `${time}发布的紧急地震警报已解除。`,
    cancelled: '紧急地震警报已解除。',
    lead: {
      forecast: '地震动预报。',
      warning: '紧急地震警报。',
      hypocenterUpdate: '震源已更新。',
    },
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l}${epicenter}发生地震。`,
    warningRegionName: regionNameIn(zhHans),
    warningRegionsAdditional: (names, closing) => `新增${names}：${closing}。`,
    warningRegions: (names, closing) => `${names}：${closing}。`,
    noForecast: {
      singleStation: '单站处理，无预测烈度。',
      deep: '深源地震，无预测烈度。',
      belowScale1: '预测最大烈度0。',
      unknown: '无预测烈度。',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `预测最大烈度${showsApproxAbove(scale, orAbove) ? `约${label}以上` : label}。`
    },
    maxLpgmClass: (cls, over) => `预测最大长周期地震动等级${over ? `约${cls}以上` : cls}。`,
  },
}
