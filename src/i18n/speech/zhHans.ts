import type { SpeechWords } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { zhHans } from '../messages/zhHans'
import { firstWaveKindIn, halfWidthDigits, intensityIn, markHeightOrMore, regionNameIn, reportNameIn, showsApproxAbove, tsunamiEvacuationIn, tsunamiGradeNamesIn, tsunamiHeightIn, dayPeriodOf } from './shared'

const intensity = intensityIn(zhHans)
/** 原因地震の呼び方（1 つ目の地震か、2 つ目以降の地震か） */
const theQuake = (first: boolean) => (first ? '此次地震' : '另一次地震')
/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = '更新为'
const STEM_OBSERVED = '观测到'
/** 未入電の単位（量詞つき）。「件」は声で自然な「处」（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5） */
const UNIT: Readonly<Record<UnreceivedUnit, string>> = { '地点': '个地点', '地域': '个地区', '件': '处' }
const notReceived = '但尚未收到烈度。'
const fiveLower = intensity(45)

const ELSEWHERE = '日本气象局的原文在电文记录中。'
const NANKAI = zhHans.telegramLog.controlTitle['南海トラフ地震臨時情報']
const COMMENTARY = zhHans.telegramLog.controlTitle['南海トラフ地震関連解説情報']
const COUNT = zhHans.telegramLog.controlTitle['地震回数に関する情報']
const NOTICE = zhHans.telegramLog.controlTitle['地震・津波に関するお知らせ']
const KOHATSU = zhHans.telegramLog.controlTitle['北海道・三陸沖後発地震注意情報']
const LPGM = zhHans.quake.infoName.lpgm
const INTERNATIONAL_TSUNAMI = zhHans.quake.infoName.internationalTsunami
const WATCH = '请注意今后的信息。'
/** 推計震度分布図を受けた・更新された（日本の気象庁の図。前の段にそろえて「日本气象局」） */
const estimatedMap = (isNew: boolean) => (isNew ? '已收到日本气象局的推算烈度分布图' : '日本气象局的推算烈度分布图已更新')
/** 時報の時刻（時報は話し言葉の「点」。2026-11-18 ユーザー選択「時刻を数字で書く (Recommended)」の 8-2 節） */
const PERIOD = { small: '凌晨', morning: '上午', noon: '中午', afternoon: '下午', night: '晚上' } as const
/**
 * 12 時間制は時間帯の語（2026-11-18 ユーザー選択「言語ごとの時間帯の語で言う (Recommended)」。0 時台は「凌晨0点」）。
 * 18 時以降は「晚上」（同日「夜の語を足す (Recommended)」）
 */
const signalClock = (hour: number, minute: number, clock: '24h' | '12h') => {
  const p = dayPeriodOf(hour, 18)
  const h = clock === '24h' ? `${hour}点` : `${PERIOD[p.period]}${p.hour}点`
  return minute === 0 ? `${h}整` : `${h}${minute}分`
}

/**
 * 読み上げの文の語表（中国語・簡体字）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（緊急地震速報・地震情報・津波）と、2026-11-18 ユーザー選択
 * 「この案で入れる (Recommended)」の表（長周期・特別情報・揺れ検知・国際津波関連情報。時報は同日「時刻を数字で書く (Recommended)」）。
 * 気象庁の多言語辞書の定型文（请注意强烈震动・发生地震・已解除）と画面の辞書の訳（紧急地震警报・预测最大烈度など）にそろえた
 */
export const zhHansSpeech: SpeechWords = {
  common: {
    listSep: '、',
    sentenceSep: '',
    intensity,
    time: (hour, minute) => `${hour}时${minute}分`,
    telegramTextElsewhere: ELSEWHERE,
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
    label: zhHans.quake.jmaNoteHeading.eew,
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
  tsunami: {
    infoLabel: '海啸信息',
    gradeName: tsunamiGradeNamesIn(zhHans),
    heightToSpeech: tsunamiHeightIn(({ value, limit }) =>
      (limit === 'over' ? `超过${value}米` : limit === 'under' ? `不足${value}米` : limit === 'orMore' ? `${value}米以上` : `${value}米`)),
    nonNumericHeight: { 巨大: '巨大海啸', 高い: '较高的海啸' },
    heightLabel: { height: markHeightOrMore },
    areaSep: '、',
    heightGroupSep: '；',
    // 区域名と観測点名を「的」でつなぐ（「石川县能登的轮岛港」）
    districtStationSep: '的',
    stationSep: '；',
    forecastHeightAt: (h) => `：预计${h}`,
    observedHeightAt: (h) => `：${h}`,
    heightsExpected: '。',
    alsoIssued: (g) => `：也发布了${g}。`,
    issuedForAreasBelow: (g) => `${g}发布的沿岸地区如下。`,
    issuedFor: (g) => `：${g}发布中。`,
    issuedForAreas: (g) => `：已发布${g}。`,
    gradeIssued: (g) => `已发布${g}。`,
    downgradedBelow: (g) => `已降为${g}。目前，${g}发布的沿岸地区如下。`,
    downgradedLead: (g) => `已降为${g}。目前，`,
    areaLifted: (g) => `：${g}已被解除。`,
    warningsEtc: '海啸警报等',
    areaGradeChanged: (from, to, raised) => `：${from}${raised ? '升为' : '降为'}${to}。`,
    forecastHeightChanged: '预计海啸最大高度已变更。',
    fallbackEvacuation: tsunamiEvacuationIn(zhHans, ''),
    sourceLead: '此次地震的震源位于',
    sourceLeadOther: '另外，另一次地震的震源位于',
    sourceMagnitudeLead: '，震级为',
    sourceMagnitude: (magnitude) => magnitude,
    sourceTail: '。',
    sourceHypocenterAmended: (first, name) => `${theQuake(first)}的震源已更新为${name}。`,
    sourceMagnitudeAmendedTo: (first, magnitude) => `${theQuake(first)}的震级已更新为${magnitude}。`,
    sourceMagnitudeAmended: (first, predicate) => `${theQuake(first)}的震级已更新。${predicate}`,
    sourceDepthAmendedTo: (first, depth) => `${theQuake(first)}的震源深度已更新为${depth}。`,
    expiryLead: (g, _time) => `该${g}的失效时间为`,
    expiryTail: '。',
    // 延長か変更かを時刻の前で言う（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節）
    expiryChangeLead: (g, extended, _time) => `${g}的失效时间已${extended ? '延长' : '变更'}，现为`,
    expiryExtended: '。',
    expiryChanged: '。',
    retracted: '海啸警报等因误发而已被取消。',
    expired: '海啸预报已失效。',
    allLifted: '海啸警报等已全部解除。',
    infoRetracted: '海啸信息已被取消。',
    offshoreRetracted: '近海海啸观测信息已被取消。',
    firstWaveKind: firstWaveKindIn('初波上升', '初波下降', '首波'),
    // 更新は時刻を名詞句に畳む（「更新为16时41分观测到的0.9米」。観測の時刻か更新の行き先かを分ける）
    heightClause: (firstWave, at, value, updated) =>
      `：${firstWave ? `${firstWave.time}${firstWave.initial}到达，` : ''}${updated
        ? `${STEM_UPDATED}${at ? `${at}观测到的` : ''}${value}`
        : `${at ?? ''}${STEM_OBSERVED}${value}`}`,
    observationInfoLead: '海啸观测信息。',
    maxWaveUpdatedLead: '以下地点的最大波已更新。',
    newlyObservedLead: '以下地点新观测到海啸。',
    stemUpdated: STEM_UPDATED,
    stemObserved: STEM_OBSERVED,
    tailUpdated: '。',
    tailObserved: '。',
    omittedObserving: (n) => `另外${n}个地点也正在观测到海啸。`,
    omittedArrival: (n) => `另外${n}个地点也已确认到达。`,
    omittedUpdated: (n) => `另外${n}个地点也已更新。`,
    omittedMissing: (n) => `另外${n}个地点也处于缺测状态。`,
    omittedWarningLevel: (n) => `另外${n}个地点也观测到相当于海啸警报的海啸。`,
    arrivalLead: '以下地点已确认海啸到达。',
    firstWaveObservedClause: (time, initial) => `：${time}观测到${initial}`,
    firstWaveUpdatedClause: (time, initial) => `：更新为${time}的${initial}`,
    arrivalConfirmedClause: '：确认到达',
    arrivalConfirmedTail: '：已确认到达。',
    maxHeightObserving: '最大波高观测中。',
    maxHeightWeak: '最大波高微弱。',
    updatedAtClause: (at) => (at ? `：更新为${at}` : '：已更新'),
    maxHeightTimeLead: '以下地点的最大波观测时间已更新。',
    maxHeightTimeTail: '：最大波观测时间已更新。',
    missingMaxHeightTimeLead: '在缺测的观测点，最大波观测时间已更新。',
    missingPrefix: '处于缺测状态的',
    firstWaveUpdatedLead: '以下地点的首波已更新。',
    firstWaveArrivedLead: '以下地点已确认首波的到来。',
    observationNoChange: '海啸观测信息。观测到的波高没有变化。',
    observationLowered: '海啸观测信息已发布。',
    tideFallbackHeadline: '现发布各地的涨潮时间和首波海啸预计抵达时间。',
    tide: {
      tide: '涨潮时间已更新。',
      arrival: '海啸到达情况已更新。',
      arrivalTime: '海啸预计抵达时间已更新。',
      none: '内容没有变化。',
    },
    missingObservedLead: '缺测前的观测值如下。',
    weakTsunamiAt: '：微弱海啸',
    missingObservedTail: '。目前处于缺测状态。',
    missingTail: '：缺测。',
    warningLevelTail: '：正在观测到相当于海啸警报的海啸。',
  },
  lpgm: {
    label: LPGM,
    retracted: `${LPGM}已取消。`,
    occurredAt: (time) => `在${time}左右发生的地震中，`,
    classAt: (cls, names, isFirst) => `${isFirst ? '观测到长周期地震动等级' : '等级'}${cls}：${names}`,
    regions: (regionText) => regionText,
    maxClassOnly: (cls) => `观测到长周期地震动等级${cls}。`,
  },
  special: {
    nankaiLabel: NANKAI,
    nankaiTrigger: {
      '111': '监测区域内发生了震级6.8以上的地震',
      '112': '应变仪观测到显著变化',
      '113': '观测到与平常不同的现象',
    },
    nankaiRetracted: `${NANKAI}已取消。`,
    nankaiEnded: `${NANKAI}：调查结束。南海海槽地震发生的可能性在通常范围内。`,
    nankaiInvestigating: (trigger) => `${NANKAI}：调查中。${trigger ? `由于${trigger}，` : ''}正在调查南海海槽地震发生的可能性。${WATCH}`,
    nankaiMajorWarning: `${NANKAI}：巨大地震警戒。南海海槽地震的设想震源区内发生了大规模地震。请立即采取防灾措施。`,
    nankaiMajorAdvisory: `${NANKAI}：巨大地震注意。南海海槽地震的设想震源区内发生了地震。请确认防灾措施。`,
    nankaiOther: `${NANKAI}。已发布有关南海海槽地震的临时信息。${WATCH}`,
    commentaryLabel: COMMENTARY,
    commentaryRetracted: `${COMMENTARY}已取消。`,
    commentaryRegular: `${COMMENTARY}。已发布南海海槽地震评估检讨会定期会议的调查结果。`,
    commentary: (serial) => `${COMMENTARY}${serial ? `，第${halfWidthDigits(serial)}号` : ''}。已发布关于南海海槽地震设想震源区状况的解说信息。`,
    countLabel: COUNT,
    countRetracted: `${COUNT}已取消。`,
    countLead: `${COUNT}。`,
    countSpanUnknown: '截至目前',
    countSpan: (from, to) => `${from}至${to}`,
    countFeltOnly: (span, felt) => `${span}，观测到烈度1以上的地震共${felt}次。`,
    countOccurred: (span, count) => `${span}，共发生地震${count}次。`,
    countFeltOf: (felt) => `其中观测到烈度1以上的有${felt}次。`,
    countFeltNone: '其中没有观测到烈度1以上的地震。',
    noticeLabel: NOTICE,
    noticeRetracted: `${NOTICE}已取消。`,
    noticeLead: `${NOTICE}。`,
    noticeWithHeadline: (_headline) => `${NOTICE}。${ELSEWHERE}`,
    kohatsuLabel: KOHATSU,
    kohatsuRetracted: `${KOHATSU}已取消。`,
    kohatsu: (headline) => `${KOHATSU}。${headline === null ? ELSEWHERE : ''}今后发生大规模地震的可能性比平常高。请确认防灾措施。`,
    estimatedIntensity: (time, isNew) => `${time ? `关于${time}左右发生的地震，` : ''}${estimatedMap(isNew)}。`,
  },
  kyoshin: {
    detected: (name) => (name ? `${name}检测到摇晃。` : '检测到摇晃。'),
    otherRegion: (name) => (name ? `${name}也检测到摇晃。` : '在其他地点也检测到摇晃。'),
  },
  internationalTsunami: {
    label: INTERNATIONAL_TSUNAMI,
    communicationsTest: `${INTERNATIONAL_TSUNAMI}：通信测试。`,
    evaluation: zhHans.alertText.internationalTsunamiEvaluation,
    when: (d, hour, minute) => `${d}日${hour}时${minute}分`,
    coordinate: (lat, lon) =>
      `${lat < 0 ? '南纬' : '北纬'}${Math.abs(lat).toFixed(1)}度，${lon < 0 ? '西经' : '东经'}${Math.abs(lon).toFixed(1)}度`,
    body: (p) => {
      const details = [p.where, p.depthKm !== null ? `深度${p.depthKm}公里` : null, p.magnitude !== null ? `震级${p.magnitude}` : null]
        .filter((s): s is string => s !== null && s !== '')
      return `${p.when ? `${p.when}左右发生的地震` : '地震'}${details.length > 0 ? `：${details.join('，')}` : ''}。${p.evaluation !== null ? `${p.evaluation}。` : `已发布${INTERNATIONAL_TSUNAMI}。`}`
    },
  },
  timeSignal: {
    say: (phrase, hour, minute, clock) => {
      const t = signalClock(hour, minute, clock)
      switch (phrase) {
        case 'oshirase': return `现在报时，${t}。`
        case 'desu': return `现在是${t}。`
        case 'narimashita': return `现在${t}了。`
        case 'bare': return t
      }
    },
  },
}
