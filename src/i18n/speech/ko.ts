import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { ko } from '../messages/ko'
import { firstWaveKindIn, intensityIn, koreanParticle, markHeightOrMore, regionNameIn, reportNameIn, showsApproxAbove, tsunamiEvacuationIn, tsunamiGradeNamesIn, tsunamiHeightIn, withKoreanParticle as p } from './shared'

const intensity = intensityIn(ko)
/** 原因地震の呼び方（1 つ目の地震か、2 つ目以降の地震か） */
const theQuake = (first: boolean) => (first ? '이 지진' : '또 다른 지진')
/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = '갱신'
const STEM_OBSERVED = '관측'
/** 未入電の単位（数のすぐ後ろ）。「件」は声で自然な「곳」（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5） */
const UNIT: Readonly<Record<UnreceivedUnit, string>> = { '地点': '개 지점', '地域': '개 지역', '件': '곳' }
const estimated = `진도 ${intensity(45)} 이상으로 추정되지만, 미수신입니다. `
const atLeastOf = (atLeast: string) => (atLeast ? ` ${atLeast}` : '')

/**
 * 読み上げの文の語表（韓国語。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（강한 흔들림을 주의・지진 발생・취소）と
 * 画面の辞書の訳（긴급 지진 속보・예상 최대 진도など）にそろえた。
 *
 * 助詞（을/를・으로/로・은/는・이/가）は直前の語の終わりで選ぶ（`shared.ts` の `withKoreanParticle`）。
 * 地震情報の断片は区切りを挟まずにつなぐので、文の終わりになる語は後ろに空白を 1 つ持つ
 */
export const koSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: (hour, minute) => `${hour}시 ${minute}분`,
    telegramTextElsewhere: '일본 기상청의 원문은 전문 로그에 있습니다.',
    day: (d) => `${d}일`,
    dayTime: (d, hour, minute) => `${d}일 ${hour}시 ${minute}분`,
    cancelReasonLead: (infoName) => `${p(infoName, '이/가')} 취소된 이유를 전해 드립니다. `,
    issued: (label) => `${label}. `,
    updated: (label) => `${p(label, '이/가')} 갱신되었습니다. `,
    atAround: (time) => `${time}경, `,
    also: '또한 ',
    dayHour: (d, hour) => `${d}일 ${hour}시`,
    telegramTextLead: (label) => `${label}에 대해 기상청의 발표문을 전해 드립니다. `,
  },
  eew: {
    upgrade: '긴급 지진 속보로 전환되었습니다.',
    warningRegionsClosing: '강한 흔들림을 주의하십시오',
    lpgmClassZero: '예상 최대 장주기 지진동 계급 0.',
    cancelledAt: (time) => `${time}에 발표된 긴급 지진 속보는 취소되었습니다.`,
    cancelled: '긴급 지진 속보는 취소되었습니다.',
    lead: {
      forecast: '지진동 예보.',
      warning: '긴급 지진 속보.',
      hypocenterUpdate: '진원 갱신.',
    },
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l} ${epicenter}에 지진 발생.`,
    warningRegionName: regionNameIn(ko),
    warningRegionsAdditional: (names, closing) => `새로 ${names}에서도 ${closing}.`,
    warningRegions: (names, closing) => `${names}에서는 ${closing}.`,
    noForecast: {
      singleStation: '단독 관측점 처리로 예상 진도 없음.',
      deep: '심발 지진으로 예상 진도 없음.',
      belowScale1: '예상 최대 진도 0.',
      unknown: '예상 진도 없음.',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `예상 최대 진도 ${showsApproxAbove(scale, orAbove) ? `${label} 정도 이상` : label}.`
    },
    maxLpgmClass: (cls, over) => `예상 최대 장주기 지진동 계급 ${over ? `${cls} 정도 이상` : cls}.`,
  },
  quake: {
    regionSep: ', ',
    intensityGroupSep: () => ', ',
    unreceivedCountOnly: (count, unit) => `${count}${UNIT[unit]}에서는 ${estimated}`,
    // 「외」の前にコンマを置かない（2026-11-17 ユーザー選択「コンマを外す (Recommended)」）
    unreceivedOmitted: (count, unit) => ` 외 ${count}${UNIT[unit]}`,
    unreceivedTailPartial: `에서는 일부 지점에서 ${estimated}`,
    unreceivedTail: `에서는 ${estimated}`,
    intensityLead: (isMax, i) => `${p(`${isMax ? '최대 ' : ''}진도 ${i}`, '을/를')} `,
    regionsOmitted: (count) => ` 외 ${count}개 지역`,
    observedTail: '에서 관측했습니다. ',
    fresh: '새로 ',
    freshAfterUpgraded: '또한 새로 ',
    magnitudeOf: (magnitude) => `규모 ${magnitude}의`,
    magnitudeConditionPredicate: {
      'Ｍ不明': '규모는 불명입니다. ',
      'Ｍ８を超える巨大地震': '지진의 규모가 8을 넘는 거대 지진으로 추정됩니다. ',
    },
    // 知らない表記（日本語）は読まず、数値でないと言う。在処の文は発話の末尾に 1 度だけ続く
    // （2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）
    magnitudeConditionUnknown: (_body) => '규모는 수치로 발표되지 않았습니다. ',
    magnitudeIs: (predicate) => predicate,
    magnitudeAmended: (predicate) => `규모가 갱신되었습니다. ${predicate}`,
    depthVeryShallowPlace: '매우 얕은 곳',
    depthOf: (km, atLeast) => `깊이 ${km}킬로미터${atLeastOf(atLeast)}`,
    depthAtLeast: '이상',
    depthAmendKm: (km, atLeast) => p(`진원의 깊이 ${km}킬로미터${atLeastOf(atLeast)}`, '으로/로'),
    depthAmendVeryShallowContinuing: '진원의 깊이는 매우 얕은 곳으로',
    depthAmendIs: (value) => p(`진원의 깊이는 ${value}`, '으로/로'),
    maxScaleOnlyUnreceived: (i) => `최대 진도 ${i} 이상으로 추정되지만, 미수신입니다. `,
    maxScaleOnly: (i) => `${p(`최대 진도 ${i}`, '을/를')} 관측했습니다. `,
    label: {
      intensityReport: '진도 속보',
      distant: '원지 지진 정보',
      epicenter: '진원 정보',
      quake: '지진 정보',
    },
    hypocenterAmended: (name) => `진원은 ${p(name, '으로/로')} 갱신되었습니다. `,
    magnitudeAmendedTo: (magnitude) => `규모는 ${p(magnitude, '으로/로')} 갱신되었습니다. `,
    depthAmendedTo: (depth) => `진원의 깊이는 ${p(depth, '으로/로')} 갱신되었습니다. `,
    observedIntensityUpdated: '관측된 진도가 갱신되었습니다. ',
    stationsAddedRegionsSame: '관측지점이 추가되었지만, 지역별 최대 진도는 변하지 않았습니다. ',
    stationsUpdatedRegionsSame: '관측된 진도가 갱신되었지만, 지역별 최대 진도는 변하지 않았습니다. ',
    noChange: '내용에 변화는 없습니다. ',
    intensityNoChange: '관측된 진도에 변화는 없습니다. ',
    hypocenterNoChange: '진원 내용에 변화는 없습니다. ',
    prominentAmendHead: (time, epicenter) => `현저한 지진의 진원 요소 갱신 알림. ${time ? `${time}경 발생한 ` : ''}${epicenter}의 지진에 대해, `,
    amendSep: ', ',
    // 助詞は値の側に持つ（値ごとに 으로/로 が変わるため。締めは「갱신되었습니다.」だけ）
    magnitudeValue: (magnitude) => p(`규모 ${magnitude}`, '으로/로'),
    amendedTail: ' 갱신되었습니다. ',
    hypocenterElementsAmended: '진원 요소가 갱신되었습니다. ',
    depthKm: (km, atLeast) => `${km}킬로미터${atLeastOf(atLeast)}`,
    cancelledAt: (time) => `${time}에 발표된 지진 정보는 취소되었습니다.`,
    cancelled: '지진 정보는 취소되었습니다.',
    reportCancelledAt: (name, time) => `${time}에 발표된 ${p(name, '은/는')} 취소되었습니다.`,
    reportCancelled: (name) => `${p(name, '은/는')} 취소되었습니다.`,
    reportName: reportNameIn(ko),
    hypocenterDepthSep: ', ',
    // 「이시카와현 노토 지방, 깊이 10킬로미터를 진원으로 하는 규모 6.5의 지진이 발생했습니다.」（2026-11-17 ユーザー選択
    // 「言語の側で決める (Recommended)」。助詞 을/를 は震源の句の最後の要素で選ぶ）
    occurrence: (t) => [
      ...(t.name !== undefined
        ? [
          { kind: 'name' } as const,
          ...(t.depth !== undefined ? [{ kind: 'text', text: ', ' } as const, { kind: 'depth' } as const] : []),
          { kind: 'text', text: `${koreanParticle(t.depth ?? t.name, '을/를')} 진원으로 하는 ` } as const,
        ]
        : []),
      ...(t.magnitude !== undefined ? [{ kind: 'magnitude' } as const, { kind: 'text', text: ' ' } as const] : []),
      { kind: 'text', text: '지진이 발생했습니다. ' },
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    domesticTsunami: {
      'なし': '이 지진에 의한 지진해일 걱정은 없습니다. ',
      '若干の海面変動': '이 지진으로 일본 연안에서는 약간의 해수면 변동이 있을 수 있지만, 피해의 우려는 없습니다. ',
      '調査中': '이 지진에 의한 지진해일 유무를 조사 중입니다. ',
      '海面変動の可能性': '진원이 해저이기 때문에 지진해일이 발생할 우려가 있습니다. ',
      '注意報': '현재 지진해일 주의보를 발표 중입니다. ',
      '警報等': '현재 지진해일 경보 등을 발표 중입니다. ',
      '不明': '지진해일 정보는 불명입니다. ',
    },
    domesticTsunamiCode: {
      '0211': '지진해일 경보 등 발표 중입니다. ',
      '0212': '이 지진으로 일본 연안에서는 약간의 해수면 변동이 있을 수 있지만, 피해의 우려는 없습니다. ',
      '0213': '앞으로도 당분간 해수면 변동이 계속될 것으로 보이므로, 해수욕이나 갯바위 낚시 등을 할 때는 주의하십시오. ',
      '0214': '앞으로도 당분간 해수면 변동이 계속될 것으로 보이므로, 갯바위 낚시 등을 할 때는 주의하십시오. ',
      '0215': '이 지진에 의한 지진해일 걱정은 없습니다. ',
      '0216': '진원이 해저인 경우, 지진해일이 발생할 우려가 있습니다. ',
      '0217': '향후 정보에 주의하십시오. ',
      '0229': '일본에 대한 지진해일 유무는 현재 조사 중입니다. ',
      '0230': '이 지진에 의한 일본에 대한 지진해일 영향은 없습니다. ',
    },
    // 2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」
    foreignTsunamiCode: {
      '0221': '태평양의 넓은 범위에서 지진해일이 발생할 가능성이 있습니다. ',
      '0222': '태평양에서 지진해일이 발생할 가능성이 있습니다. ',
      '0226': '진원 부근에서 지진해일이 발생할 가능성이 있습니다. ',
      '0228': '일반적으로 이 규모의 지진이 해역의 얕은 곳에서 발생하면 지진해일이 발생할 수 있습니다. ',
    },
  },
  tsunami: {
    infoLabel: '지진해일 정보',
    gradeName: tsunamiGradeNamesIn(ko),
    heightToSpeech: tsunamiHeightIn(({ value, limit }) =>
      `${value}미터${limit === 'over' ? ' 초과' : limit === 'under' ? ' 미만' : limit === 'orMore' ? ' 이상' : ''}`),
    // 締めの「의 지진해일이 예상됩니다」につながる形（「거대한 규모의 지진해일」）
    nonNumericHeight: { 巨大: '거대한 규모', 高い: '높은 수준' },
    heightLabel: { height: markHeightOrMore },
    areaSep: ', ',
    heightGroupSep: ', ',
    districtStationSep: ', ',
    stationSep: ', ',
    forecastHeightAt: (h) => `에서 ${h}`,
    observedHeightAt: (h) => `에서 ${h}`,
    // 予想を締めで言う（気象庁の多言語辞書「최대 3m의 지진해일이 예상되므로」の形）
    heightsExpected: '의 지진해일이 예상됩니다. ',
    alsoIssued: (g) => `에도 ${p(g, '이/가')} 발효 중입니다. `,
    issuedForAreasBelow: (g) => `${p(g, '이/가')} 발효된 연안은 다음과 같습니다. `,
    issuedFor: (g) => `에 ${p(g, '이/가')} 발효 중입니다. `,
    issuedForAreas: (g) => `에 ${p(g, '이/가')} 발효되었습니다. `,
    gradeIssued: (g) => `${p(g, '이/가')} 발효되었습니다. `,
    downgradedBelow: (g) => `${p(g, '으로/로')} 변경되었습니다. 현재 ${p(g, '이/가')} 발효된 연안은 다음과 같습니다. `,
    downgradedLead: (g) => `${p(g, '으로/로')} 변경되었습니다. 현재 `,
    areaLifted: (g) => `의 ${p(g, '이/가')} 해제되었습니다. `,
    warningsEtc: '지진해일 경보 등',
    // 上げ下げを聞き分けられるよう画面の「상향 / 변경」にする（多言語辞書はどちらも「갱신」）
    areaGradeChanged: (from, to, raised) => `의 ${p(from, '이/가')} ${p(to, '으로/로')} ${raised ? '상향되었습니다' : '변경되었습니다'}. `,
    forecastHeightChanged: '예상되는 지진해일 최대 높이가 변경되었습니다. ',
    fallbackEvacuation: tsunamiEvacuationIn(ko, ' '),
    sourceLead: '이 지진의 진원은 ',
    sourceLeadOther: '또한 또 다른 지진의 진원은 ',
    sourceMagnitudeLead: ', 규모는 ',
    sourceMagnitude: (magnitude) => magnitude,
    sourceTail: '입니다. ',
    sourceHypocenterAmended: (first, name) => `${theQuake(first)}의 진원은 ${p(name, '으로/로')} 갱신되었습니다. `,
    sourceMagnitudeAmendedTo: (first, magnitude) => `${theQuake(first)}의 규모는 ${p(magnitude, '으로/로')} 갱신되었습니다. `,
    sourceMagnitudeAmended: (first, predicate) => `${theQuake(first)}의 규모가 갱신되었습니다. ${predicate}`,
    sourceDepthAmendedTo: (first, depth) => `${theQuake(first)}의 진원 깊이는 ${p(depth, '으로/로')} 갱신되었습니다. `,
    expiryLead: (g, _time) => `이 ${g}의 만료 시각은 `,
    expiryTail: '입니다. ',
    // 延長か変更かを時刻の前で言う（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節）
    expiryChangeLead: (g, extended, _time) => `${g}의 만료 시각이 ${extended ? '연장되었습니다' : '변경되었습니다'}. 현재 만료 시각은 `,
    expiryExtended: '입니다. ',
    expiryChanged: '입니다. ',
    retracted: '지진해일 경보 등은 잘못 발표되어 취소되었습니다.',
    expired: '지진해일 예보는 만료되었습니다.',
    allLifted: '지진해일 경보 등은 모두 해제되었습니다.',
    infoRetracted: '지진해일 정보는 취소되었습니다.',
    offshoreRetracted: '앞바다 지진해일 관측 정보는 취소되었습니다.',
    firstWaveKind: firstWaveKindIn('초동 상승', '초동 하강', '제1파'),
    heightClause: (firstWave, at, value, updated) =>
      `에서${firstWave ? `, ${firstWave.time}에 ${p(firstWave.initial, '이/가')} 도달하고,` : ''} ${at ? `${at}에 ` : ''}${updated
        ? `${p(value, '으로/로')} ${STEM_UPDATED}`
        : `${p(value, '을/를')} ${STEM_OBSERVED}`}`,
    observationInfoLead: '지진해일 관측 정보. ',
    maxWaveUpdatedLead: '다음 지점에서 최대파가 갱신되었습니다. ',
    newlyObservedLead: '새로 다음 지점에서 지진해일을 관측했습니다. ',
    stemUpdated: STEM_UPDATED,
    stemObserved: STEM_OBSERVED,
    tailUpdated: '되었습니다. ',
    tailObserved: '했습니다. ',
    omittedObserving: (n) => `그 외 ${n}개 지점에서도 관측하고 있습니다. `,
    omittedArrival: (n) => `그 외 ${n}개 지점에서도 도달을 확인했습니다. `,
    omittedUpdated: (n) => `그 외 ${n}개 지점에서도 갱신되었습니다. `,
    omittedMissing: (n) => `그 외 ${n}개 지점도 결측 상태입니다. `,
    omittedWarningLevel: (n) => `그 외 ${n}개 지점에서도 지진해일 경보에 상당하는 지진해일을 관측하고 있습니다. `,
    arrivalLead: '다음 지점에서 지진해일 도달을 확인했습니다. ',
    firstWaveObservedClause: (time, initial) => `에서 ${time}에 ${p(initial, '을/를')} 관측`,
    firstWaveUpdatedClause: (time, initial) => `에서 ${time}의 ${p(initial, '으로/로')} 갱신`,
    arrivalConfirmedClause: '에서 도달 확인',
    arrivalConfirmedTail: '에서 도달을 확인했습니다. ',
    maxHeightObserving: '최대파 높이는 관측 중입니다. ',
    maxHeightWeak: '최대파 높이는 미약합니다. ',
    updatedAtClause: (at) => (at ? `에서 ${p(at, '으로/로')} 갱신` : '에서 갱신'),
    maxHeightTimeLead: '다음 지점에서 최대파의 관측 시각이 갱신되었습니다. ',
    maxHeightTimeTail: '에서 최대파의 관측 시각이 갱신되었습니다. ',
    missingMaxHeightTimeLead: '결측 상태인 관측점에서 최대파의 관측 시각이 갱신되었습니다. ',
    missingPrefix: '결측 상태인 ',
    firstWaveUpdatedLead: '다음 지점에서 제1파가 갱신되었습니다. ',
    firstWaveArrivedLead: '다음 지점에서 제1파 도달을 확인했습니다. ',
    observationNoChange: '지진해일 관측 정보. 관측된 파고에 변화는 없습니다. ',
    observationLowered: '지진해일 관측 정보가 발표되었습니다. ',
    tideFallbackHeadline: '각지의 만조 시간과 지진해일 제1파 도달 예상 시각을 알려 드립니다. ',
    tide: {
      tide: '만조 시간이 갱신되었습니다. ',
      arrival: '지진해일 도달 상황이 갱신되었습니다. ',
      arrivalTime: '지진해일 도달 예상 시각이 갱신되었습니다. ',
      none: '내용에 변화는 없습니다. ',
    },
    missingObservedLead: '지금까지 ',
    weakTsunamiAt: '에서 미약한 지진해일',
    // 観測した値の後ろに続くので空白で始める。助詞（을/를）を避けて「관측 후」で受ける
    missingObservedTail: ' 관측 후, 결측 상태입니다. ',
    // 観測点の名前の終わりで助詞（은/는）が変わらない形
    missingTail: '의 데이터는 결측 상태입니다. ',
    warningLevelTail: '에서는 지진해일 경보에 상당하는 지진해일을 관측하고 있습니다. ',
  },
}
