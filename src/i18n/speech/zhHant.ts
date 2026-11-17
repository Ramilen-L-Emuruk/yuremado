import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { zhHant } from '../messages/zhHant'
import { intensityIn, regionNameIn, reportNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(zhHant)
/** 未入電の単位（量詞つき）。「件」は声で自然な「處」（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5） */
const UNIT: Readonly<Record<UnreceivedUnit, string>> = { '地点': '個地點', '地域': '個地區', '件': '處' }
const notReceived = '但尚未收到震度。'
const fiveLower = intensity(45)

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
    day: (d) => `${d}日`,
    dayTime: (d, hour, minute) => `${d}日${hour}時${minute}分`,
    cancelReasonLead: (infoName) => `以下是${infoName}被取消的原因。`,
    issued: (label) => `${label}。`,
    updated: (label) => `${label}已更新。`,
    atAround: (time) => `${time}左右，`,
    also: '另外，',
    dayHour: (d, hour) => `${d}日${hour}時`,
    telegramTextLead: (label) => `以下是日本氣象局關於${label}的發表文。`,
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
  quake: {
    regionSep: '、',
    intensityGroupSep: () => '、',
    unreceivedCountOnly: (count, unit) => `${count}${UNIT[unit]}推定震度為${fiveLower}以上，${notReceived}`,
    unreceivedOmitted: (count, unit) => `、另外${count}${UNIT[unit]}`,
    unreceivedTailPartial: `：部分地點推定震度為${fiveLower}以上，${notReceived}`,
    unreceivedTail: `：推定震度為${fiveLower}以上，${notReceived}`,
    intensityLead: (isMax, i) => `觀測到${isMax ? '最大' : ''}震度${i}：`,
    regionsOmitted: (count) => `、另外${count}個地區`,
    observedTail: '。',
    fresh: '新增',
    freshAfterUpgraded: '另外，新增',
    magnitudeOf: (magnitude) => `規模${magnitude}的`,
    magnitudeConditionPredicate: {
      'Ｍ不明': '規模不明。',
      'Ｍ８を超える巨大地震': '預計為規模超過8的巨大地震。',
    },
    // 知らない表記（日本語）は読まず、数値でないと言う。在処の文は発話の末尾に 1 度だけ続く
    // （2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）
    magnitudeConditionUnknown: (_body) => '規模未以數值發布。',
    magnitudeIs: (predicate) => predicate,
    magnitudeAmended: (predicate) => `規模已更新。${predicate}`,
    depthVeryShallowPlace: '極淺處',
    depthOf: (km, atLeast) => `深度${km}公里${atLeast}處`,
    depthAtLeast: '以上',
    depthAmendKm: (km, atLeast) => `震源深度更新為${km}公里${atLeast}`,
    depthAmendVeryShallowContinuing: '震源深度更新為極淺',
    depthAmendIs: (value) => `震源深度更新為${value}`,
    maxScaleOnlyUnreceived: (i) => `推定最大震度為${i}以上，${notReceived}`,
    maxScaleOnly: (i) => `觀測到最大震度${i}。`,
    label: {
      intensityReport: '震度速報',
      distant: '遠地地震訊息',
      epicenter: '震源訊息',
      quake: '地震訊息',
    },
    hypocenterAmended: (name) => `震源已更新為${name}。`,
    magnitudeAmendedTo: (magnitude) => `規模已更新為${magnitude}。`,
    depthAmendedTo: (depth) => `震源深度已更新為${depth}。`,
    observedIntensityUpdated: '觀測到的震度已更新。',
    stationsAddedRegionsSame: '已追加觀測地點，但各地區的最大震度沒有變化。',
    stationsUpdatedRegionsSame: '觀測到的震度已更新，但各地區的最大震度沒有變化。',
    noChange: '內容沒有變化。',
    intensityNoChange: '觀測到的震度沒有變化。',
    hypocenterNoChange: '震源內容沒有變化。',
    prominentAmendHead: (time, epicenter) => `顯著地震震源要素更新通知。關於${time ? `${time}左右發生的` : ''}${epicenter}的地震，`,
    amendSep: '，',
    magnitudeValue: (magnitude) => `規模更新為${magnitude}`,
    amendedTail: '。',
    hypocenterElementsAmended: '震源要素已更新。',
    depthKm: (km, atLeast) => `${km}公里${atLeast}`,
    cancelledAt: (time) => `已取消${time}發表的地震訊息。`,
    cancelled: '已取消地震訊息。',
    reportCancelledAt: (name, time) => `已取消${time}發表的${name}。`,
    reportCancelled: (name) => `已取消${name}。`,
    reportName: reportNameIn(zhHant),
    hypocenterDepthSep: '，',
    // 「石川縣能登地方，深度10公里處發生了規模6.5的地震。」（2026-11-17 ユーザー選択「言語の側で決める (Recommended)」）
    occurrence: (t) => [
      ...(t.name !== undefined
        ? [{ kind: 'name' } as const, ...(t.depth !== undefined ? [{ kind: 'text', text: '，' } as const, { kind: 'depth' } as const] : [])]
        : []),
      { kind: 'text', text: '發生了' },
      ...(t.magnitude !== undefined ? [{ kind: 'magnitude' } as const] : []),
      { kind: 'text', text: '地震。' },
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    domesticTsunami: {
      'なし': '此次地震無海嘯之虞。',
      '若干の海面変動': '受此次地震影響，日本沿岸海面可能有若干波動，但無危害。',
      '調査中': '正在調查此次地震是否引發海嘯。',
      '海面変動の可能性': '由於震源在海底，可能發生海嘯。',
      '注意報': '目前正在發佈海嘯注意警報。',
      '警報等': '目前正在發佈海嘯警報等。',
      '不明': '海嘯訊息不明。',
    },
    domesticTsunamiCode: {
      '0211': '正在發佈海嘯警報等。',
      '0212': '受此次地震影響，日本沿岸海面可能有若干波動，但無危害。',
      '0213': '預計海面變化還將持續一段時間，進行海水浴或磯釣等活動時請注意。',
      '0214': '預計海面變化還將持續一段時間，進行磯釣等活動時請注意。',
      '0215': '此次地震無海嘯之虞。',
      '0216': '如果震源在海底，可能發生海嘯。',
      '0217': '請注意後續訊息。',
      '0229': '目前正在調查日本是否會受到海嘯影響。',
      '0230': '此次地震對日本無海嘯影響。',
    },
    // 2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」
    foreignTsunamiCode: {
      '0221': '太平洋大範圍可能發生海嘯。',
      '0222': '太平洋可能發生海嘯。',
      '0226': '震源附近可能發生海嘯。',
      '0228': '一般來說，此規模的地震發生在海域淺處時，可能引發海嘯。',
    },
  },
}
