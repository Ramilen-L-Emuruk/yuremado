import type { SpeechWords } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { zhHant } from '../messages/zhHant'
import { firstWaveKindIn, halfWidthDigits, intensityIn, markHeightOrMore, regionNameIn, reportNameIn, showsApproxAbove, tsunamiEvacuationIn, tsunamiGradeNamesIn, tsunamiHeightIn, dayPeriodOf } from './shared'

const intensity = intensityIn(zhHant)
/** 原因地震の呼び方（1 つ目の地震か、2 つ目以降の地震か） */
const theQuake = (first: boolean) => (first ? '此次地震' : '另一次地震')
/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = '更新為'
const STEM_OBSERVED = '觀測到'
/** 未入電の単位（量詞つき）。「件」は声で自然な「處」（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5） */
const UNIT: Readonly<Record<UnreceivedUnit, string>> = { '地点': '個地點', '地域': '個地區', '件': '處' }
const notReceived = '但尚未收到震度。'
const fiveLower = intensity(45)

const ELSEWHERE = '日本氣象局的原文在電文紀錄中。'
const NANKAI = zhHant.telegramLog.controlTitle['南海トラフ地震臨時情報']
const COMMENTARY = zhHant.telegramLog.controlTitle['南海トラフ地震関連解説情報']
const COUNT = zhHant.telegramLog.controlTitle['地震回数に関する情報']
const NOTICE = zhHant.telegramLog.controlTitle['地震・津波に関するお知らせ']
const KOHATSU = zhHant.telegramLog.controlTitle['北海道・三陸沖後発地震注意情報']
const LPGM = zhHant.quake.infoName.lpgm
const INTERNATIONAL_TSUNAMI = zhHant.quake.infoName.internationalTsunami
const WATCH = '請注意今後的訊息。'
/** 推計震度分布図を受けた・更新された（日本の気象庁の図。前の段にそろえて「日本氣象局」） */
const estimatedMap = (isNew: boolean) => (isNew ? '已收到日本氣象局的推算震度分布圖' : '日本氣象局的推算震度分布圖已更新')
/** 時報の時刻（時報は話し言葉の「點」。2026-11-18 ユーザー選択「時刻を数字で書く (Recommended)」の 8-2 節） */
const PERIOD = { small: '凌晨', morning: '上午', noon: '中午', afternoon: '下午', night: '晚上' } as const
/**
 * 12 時間制は時間帯の語（2026-11-18 ユーザー選択「言語ごとの時間帯の語で言う (Recommended)」。0 時台は「凌晨0點」）。
 * 18 時以降は「晚上」（同日「夜の語を足す (Recommended)」）
 */
const signalClock = (hour: number, minute: number, clock: '24h' | '12h') => {
  const p = dayPeriodOf(hour, 18)
  const h = clock === '24h' ? `${hour}點` : `${PERIOD[p.period]}${p.hour}點`
  return minute === 0 ? `${h}整` : `${h}${minute}分`
}

/**
 * 読み上げの文の語表（中国語・繁体字）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（緊急地震速報・地震情報・津波）と、2026-11-18 ユーザー選択
 * 「この案で入れる (Recommended)」の表（長周期・特別情報・揺れ検知・国際津波関連情報。時報は同日「時刻を数字で書く (Recommended)」）。
 * 気象庁の多言語辞書の定型文（請警戒強烈的震動・發生地震・取消）と画面の辞書の訳（緊急地震警報・預測最大震度など）にそろえた
 */
export const zhHantSpeech: SpeechWords = {
  common: {
    listSep: '、',
    sentenceSep: '',
    intensity,
    time: (hour, minute) => `${hour}時${minute}分`,
    telegramTextElsewhere: ELSEWHERE,
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
    label: zhHant.quake.jmaNoteHeading.eew,
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
  tsunami: {
    infoLabel: '海嘯訊息',
    gradeName: tsunamiGradeNamesIn(zhHant),
    heightToSpeech: tsunamiHeightIn(({ value, limit }) =>
      (limit === 'over' ? `超過${value}米` : limit === 'under' ? `不足${value}米` : limit === 'orMore' ? `${value}米以上` : `${value}米`)),
    nonNumericHeight: { 巨大: '巨大海嘯', 高い: '較高的海嘯' },
    heightLabel: { height: markHeightOrMore },
    areaSep: '、',
    heightGroupSep: '；',
    // 区域名と観測点名を「的」でつなぐ（「石川縣能登的輪島港」）
    districtStationSep: '的',
    stationSep: '；',
    forecastHeightAt: (h) => `：預計${h}`,
    observedHeightAt: (h) => `：${h}`,
    heightsExpected: '。',
    alsoIssued: (g) => `：也發佈了${g}。`,
    issuedForAreasBelow: (g) => `${g}發布的沿岸地區如下。`,
    issuedFor: (g) => `：${g}發佈中。`,
    issuedForAreas: (g) => `：已發佈${g}。`,
    gradeIssued: (g) => `已發佈${g}。`,
    downgradedBelow: (g) => `已降為${g}。目前，${g}發布的沿岸地區如下。`,
    downgradedLead: (g) => `已降為${g}。目前，`,
    areaLifted: (g) => `：${g}已被解除。`,
    warningsEtc: '海嘯警報等',
    areaGradeChanged: (from, to, raised) => `：${from}${raised ? '升為' : '降為'}${to}。`,
    forecastHeightChanged: '預計海嘯最大高度已變更。',
    fallbackEvacuation: tsunamiEvacuationIn(zhHant, ''),
    sourceLead: '此次地震的震源位於',
    sourceLeadOther: '另外，另一次地震的震源位於',
    sourceMagnitudeLead: '，規模為',
    sourceMagnitude: (magnitude) => magnitude,
    sourceTail: '。',
    sourceHypocenterAmended: (first, name) => `${theQuake(first)}的震源已更新為${name}。`,
    sourceMagnitudeAmendedTo: (first, magnitude) => `${theQuake(first)}的規模已更新為${magnitude}。`,
    sourceMagnitudeAmended: (first, predicate) => `${theQuake(first)}的規模已更新。${predicate}`,
    sourceDepthAmendedTo: (first, depth) => `${theQuake(first)}的震源深度已更新為${depth}。`,
    expiryLead: (g, _time) => `該${g}的失效時間為`,
    expiryTail: '。',
    // 延長か変更かを時刻の前で言う（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節）
    expiryChangeLead: (g, extended, _time) => `${g}的失效時間已${extended ? '延長' : '變更'}，現為`,
    expiryExtended: '。',
    expiryChanged: '。',
    retracted: '海嘯警報等因誤發而已被取消。',
    expired: '海嘯預報已失效。',
    allLifted: '海嘯警報等已全部解除。',
    infoRetracted: '海嘯訊息已被取消。',
    offshoreRetracted: '近海海嘯觀測訊息已被取消。',
    firstWaveKind: firstWaveKindIn('初波上升', '初波下降', '首波'),
    // 更新は時刻を名詞句に畳む（「更新為16時41分觀測到的0.9米」。観測の時刻か更新の行き先かを分ける）
    heightClause: (firstWave, at, value, updated) =>
      `：${firstWave ? `${firstWave.time}${firstWave.initial}到達，` : ''}${updated
        ? `${STEM_UPDATED}${at ? `${at}觀測到的` : ''}${value}`
        : `${at ?? ''}${STEM_OBSERVED}${value}`}`,
    observationInfoLead: '海嘯觀測訊息。',
    maxWaveUpdatedLead: '以下地點的最大波已更新。',
    newlyObservedLead: '以下地點新觀測到海嘯。',
    stemUpdated: STEM_UPDATED,
    stemObserved: STEM_OBSERVED,
    tailUpdated: '。',
    tailObserved: '。',
    omittedObserving: (n) => `另外${n}個地點也正在觀測到海嘯。`,
    omittedArrival: (n) => `另外${n}個地點也已確認到達。`,
    omittedUpdated: (n) => `另外${n}個地點也已更新。`,
    omittedMissing: (n) => `另外${n}個地點也處於缺測狀態。`,
    omittedWarningLevel: (n) => `另外${n}個地點也觀測到相當於海嘯警報的海嘯。`,
    arrivalLead: '以下地點已確認海嘯到達。',
    firstWaveObservedClause: (time, initial) => `：${time}觀測到${initial}`,
    firstWaveUpdatedClause: (time, initial) => `：更新為${time}的${initial}`,
    arrivalConfirmedClause: '：確認到達',
    arrivalConfirmedTail: '：已確認到達。',
    maxHeightObserving: '最大波高觀測中。',
    maxHeightWeak: '最大波高微弱。',
    updatedAtClause: (at) => (at ? `：更新為${at}` : '：已更新'),
    maxHeightTimeLead: '以下地點的最大波觀測時間已更新。',
    maxHeightTimeTail: '：最大波觀測時間已更新。',
    missingMaxHeightTimeLead: '在缺測的觀測點，最大波觀測時間已更新。',
    missingPrefix: '處於缺測狀態的',
    firstWaveUpdatedLead: '以下地點的首波已更新。',
    firstWaveArrivedLead: '以下地點已確認首波的到來。',
    observationNoChange: '海嘯觀測訊息。觀測到的波高沒有變化。',
    observationLowered: '海嘯觀測訊息已發佈。',
    tideFallbackHeadline: '現發佈各地的漲潮時間和首波海嘯預計抵達時間。',
    tide: {
      tide: '漲潮時間已更新。',
      arrival: '海嘯到達情況已更新。',
      arrivalTime: '海嘯預計抵達時間已更新。',
      none: '內容沒有變化。',
    },
    missingObservedLead: '缺測前的觀測值如下。',
    weakTsunamiAt: '：微弱海嘯',
    missingObservedTail: '。目前處於缺測狀態。',
    missingTail: '：缺測。',
    warningLevelTail: '：正在觀測到相當於海嘯警報的海嘯。',
  },
  lpgm: {
    label: LPGM,
    retracted: `已取消${LPGM}。`,
    occurredAt: (time) => `在${time}左右發生的地震中，`,
    classAt: (cls, names, isFirst) => `${isFirst ? '觀測到長週期地震動等級' : '等級'}${cls}：${names}`,
    regions: (regionText) => regionText,
    maxClassOnly: (cls) => `觀測到長週期地震動等級${cls}。`,
  },
  special: {
    nankaiLabel: NANKAI,
    nankaiTrigger: {
      '111': '監測區域內發生了規模6.8以上的地震',
      '112': '應變儀觀測到顯著變化',
      '113': '觀測到與平常不同的現象',
    },
    nankaiRetracted: `已取消${NANKAI}。`,
    nankaiEnded: `${NANKAI}：調查結束。南海海槽地震發生的可能性在通常範圍內。`,
    nankaiInvestigating: (trigger) => `${NANKAI}：調查中。${trigger ? `由於${trigger}，` : ''}正在調查南海海槽地震發生的可能性。${WATCH}`,
    nankaiMajorWarning: `${NANKAI}：巨大地震警戒。南海海槽地震的設想震源區內發生了大規模地震。請立即採取防災措施。`,
    nankaiMajorAdvisory: `${NANKAI}：巨大地震注意。南海海槽地震的設想震源區內發生了地震。請確認防災措施。`,
    nankaiOther: `${NANKAI}。已發布有關南海海槽地震的臨時訊息。${WATCH}`,
    commentaryLabel: COMMENTARY,
    commentaryRetracted: `已取消${COMMENTARY}。`,
    commentaryRegular: `${COMMENTARY}。已發布南海海槽地震評估檢討會定期會議的調查結果。`,
    commentary: (serial) => `${COMMENTARY}${serial ? `，第${halfWidthDigits(serial)}號` : ''}。已發布關於南海海槽地震設想震源區狀況的解說訊息。`,
    countLabel: COUNT,
    countRetracted: `已取消${COUNT}。`,
    countLead: `${COUNT}。`,
    countSpanUnknown: '截至目前',
    countSpan: (from, to) => `${from}至${to}`,
    countFeltOnly: (span, felt) => `${span}，觀測到震度1以上的地震共${felt}次。`,
    countOccurred: (span, count) => `${span}，共發生地震${count}次。`,
    countFeltOf: (felt) => `其中觀測到震度1以上的有${felt}次。`,
    countFeltNone: '其中沒有觀測到震度1以上的地震。',
    noticeLabel: NOTICE,
    noticeRetracted: `已取消${NOTICE}。`,
    noticeLead: `${NOTICE}。`,
    noticeWithHeadline: (_headline) => `${NOTICE}。${ELSEWHERE}`,
    kohatsuLabel: KOHATSU,
    kohatsuRetracted: `已取消${KOHATSU}。`,
    kohatsu: (headline) => `${KOHATSU}。${headline === null ? ELSEWHERE : ''}今後發生大規模地震的可能性比平常高。請確認防災措施。`,
    estimatedIntensity: (time, isNew) => `${time ? `關於${time}左右發生的地震，` : ''}${estimatedMap(isNew)}。`,
  },
  kyoshin: {
    detected: (name) => (name ? `${name}偵測到搖晃。` : '偵測到搖晃。'),
    otherRegion: (name) => (name ? `${name}也偵測到搖晃。` : '在其他地點也偵測到搖晃。'),
  },
  internationalTsunami: {
    label: INTERNATIONAL_TSUNAMI,
    communicationsTest: `${INTERNATIONAL_TSUNAMI}：通訊測試。`,
    evaluation: zhHant.alertText.internationalTsunamiEvaluation,
    when: (d, hour, minute) => `${d}日${hour}時${minute}分`,
    coordinate: (lat, lon) =>
      `${lat < 0 ? '南緯' : '北緯'}${Math.abs(lat).toFixed(1)}度，${lon < 0 ? '西經' : '東經'}${Math.abs(lon).toFixed(1)}度`,
    body: (p) => {
      const details = [p.where, p.depthKm !== null ? `深度${p.depthKm}公里` : null, p.magnitude !== null ? `規模${p.magnitude}` : null]
        .filter((s): s is string => s !== null && s !== '')
      return `${p.when ? `${p.when}左右發生的地震` : '地震'}${details.length > 0 ? `：${details.join('，')}` : ''}。${p.evaluation !== null ? `${p.evaluation}。` : `已發布${INTERNATIONAL_TSUNAMI}。`}`
    },
  },
  timeSignal: {
    say: (phrase, hour, minute, clock) => {
      const t = signalClock(hour, minute, clock)
      switch (phrase) {
        case 'oshirase': return `現在報時，${t}。`
        case 'desu': return `現在是${t}。`
        case 'narimashita': return `現在${t}了。`
        case 'bare': return t
      }
    },
  },
}
