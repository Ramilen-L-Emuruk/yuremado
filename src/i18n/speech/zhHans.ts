import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { zhHans } from '../messages/zhHans'
import { intensityIn, regionNameIn, reportNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(zhHans)
/** 未入電の単位（量詞つき）。「件」は声で自然な「处」（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5） */
const UNIT: Readonly<Record<UnreceivedUnit, string>> = { '地点': '个地点', '地域': '个地区', '件': '处' }
const notReceived = '但尚未收到烈度。'
const fiveLower = intensity(45)

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
    day: (d) => `${d}日`,
    dayTime: (d, hour, minute) => `${d}日${hour}时${minute}分`,
    cancelReasonLead: (infoName) => `以下是${infoName}被取消的原因。`,
    issued: (label) => `${label}。`,
    updated: (label) => `${label}已更新。`,
    atAround: (time) => `${time}左右，`,
    also: '另外，',
    dayHour: (d, hour) => `${d}日${hour}时`,
    telegramTextLead: (label) => `以下是日本气象局关于${label}的发表文。`,
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
  quake: {
    regionSep: '、',
    intensityGroupSep: () => '、',
    unreceivedCountOnly: (count, unit) => `${count}${UNIT[unit]}推定烈度为${fiveLower}以上，${notReceived}`,
    unreceivedOmitted: (count, unit) => `、另外${count}${UNIT[unit]}`,
    unreceivedTailPartial: `：部分地点推定烈度为${fiveLower}以上，${notReceived}`,
    unreceivedTail: `：推定烈度为${fiveLower}以上，${notReceived}`,
    intensityLead: (isMax, i) => `观测到${isMax ? '最大' : ''}烈度${i}：`,
    regionsOmitted: (count) => `、另外${count}个地区`,
    observedTail: '。',
    fresh: '新增',
    freshAfterUpgraded: '另外，新增',
    magnitudeOf: (magnitude) => `震级${magnitude}的`,
    magnitudeConditionPredicate: {
      'Ｍ不明': '震级不明。',
      'Ｍ８を超える巨大地震': '预计为震级超过8的巨大地震。',
    },
    // 知らない表記（日本語）は読まず、数値でないと言う。在処の文は発話の末尾に 1 度だけ続く
    // （2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）
    magnitudeConditionUnknown: (_body) => '震级未以数值发布。',
    magnitudeIs: (predicate) => predicate,
    magnitudeAmended: (predicate) => `震级已更新。${predicate}`,
    depthVeryShallowPlace: '极浅处',
    depthOf: (km, atLeast) => `深度${km}公里${atLeast}处`,
    depthAtLeast: '以上',
    depthAmendKm: (km, atLeast) => `震源深度更新为${km}公里${atLeast}`,
    depthAmendVeryShallowContinuing: '震源深度更新为极浅',
    depthAmendIs: (value) => `震源深度更新为${value}`,
    maxScaleOnlyUnreceived: (i) => `推定最大烈度为${i}以上，${notReceived}`,
    maxScaleOnly: (i) => `观测到最大烈度${i}。`,
    label: {
      intensityReport: '烈度速报',
      distant: '远地地震信息',
      epicenter: '震源信息',
      quake: '地震信息',
    },
    hypocenterAmended: (name) => `震源已更新为${name}。`,
    magnitudeAmendedTo: (magnitude) => `震级已更新为${magnitude}。`,
    depthAmendedTo: (depth) => `震源深度已更新为${depth}。`,
    observedIntensityUpdated: '观测到的烈度已更新。',
    stationsAddedRegionsSame: '已追加观测地点，但各地区的最大烈度没有变化。',
    stationsUpdatedRegionsSame: '观测到的烈度已更新，但各地区的最大烈度没有变化。',
    noChange: '内容没有变化。',
    intensityNoChange: '观测到的烈度没有变化。',
    hypocenterNoChange: '震源内容没有变化。',
    prominentAmendHead: (time, epicenter) => `显著地震震源要素更新通知。关于${time ? `${time}左右发生的` : ''}${epicenter}的地震，`,
    amendSep: '，',
    magnitudeValue: (magnitude) => `震级更新为${magnitude}`,
    amendedTail: '。',
    hypocenterElementsAmended: '震源要素已更新。',
    depthKm: (km, atLeast) => `${km}公里${atLeast}`,
    cancelledAt: (time) => `${time}发布的地震信息已取消。`,
    cancelled: '地震信息已取消。',
    reportCancelledAt: (name, time) => `${time}发布的${name}已取消。`,
    reportCancelled: (name) => `${name}已取消。`,
    reportName: reportNameIn(zhHans),
    hypocenterDepthSep: '，',
    // 「石川县能登地方，深度10公里处发生了震级6.5的地震。」（2026-11-17 ユーザー選択「言語の側で決める (Recommended)」）
    occurrence: (t) => [
      ...(t.name !== undefined
        ? [{ kind: 'name' } as const, ...(t.depth !== undefined ? [{ kind: 'text', text: '，' } as const, { kind: 'depth' } as const] : [])]
        : []),
      { kind: 'text', text: '发生了' },
      ...(t.magnitude !== undefined ? [{ kind: 'magnitude' } as const] : []),
      { kind: 'text', text: '地震。' },
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    domesticTsunami: {
      'なし': '此次地震无海啸之忧。',
      '若干の海面変動': '受此次地震影响，日本沿岸海面可能有若干波动，但无危害。',
      '調査中': '正在调查此次地震是否引发海啸。',
      '海面変動の可能性': '由于震源在海底，可能发生海啸。',
      '注意報': '目前正在发布海啸注意警报。',
      '警報等': '目前正在发布海啸警报等。',
      '不明': '海啸信息不明。',
    },
    domesticTsunamiCode: {
      '0211': '正在发布海啸警报等。',
      '0212': '受此次地震影响，日本沿岸海面可能有若干波动，但无危害。',
      '0213': '预计海面变化还将持续一段时间，进行海水浴或矶钓等活动时请注意。',
      '0214': '预计海面变化还将持续一段时间，进行矶钓等活动时请注意。',
      '0215': '此次地震无海啸之忧。',
      '0216': '如果震源在海底，可能发生海啸。',
      '0217': '请注意后续信息。',
      '0229': '目前正在调查日本是否会受到海啸影响。',
      '0230': '此次地震对日本无海啸影响。',
    },
    // 2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」
    foreignTsunamiCode: {
      '0221': '太平洋大范围可能发生海啸。',
      '0222': '太平洋可能发生海啸。',
      '0226': '震源附近可能发生海啸。',
      '0228': '一般来说，此规模的地震发生在海域浅处时，可能引发海啸。',
    },
  },
}
