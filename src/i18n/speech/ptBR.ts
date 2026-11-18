import type { SpeechWords } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { ptBR } from '../messages/ptBR'
import { clockTime, decimalComma, firstWaveKindIn, halfWidthDigits, intensityIn, isOneOClock, markHeightOrMore, regionNameIn, reportNameIn, showsApproxAbove, tsunamiEvacuationIn, tsunamiGradeNamesIn, tsunamiHeightIn, dayPeriodOf } from './shared'

const intensity = intensityIn(ptBR)
/** 未入電の単位（単数・複数）。「件」は観測点と地域が混ざったとき */
const UNIT: Readonly<Record<UnreceivedUnit, readonly [string, string]>> = {
  '地点': ['estação', 'estações'],
  '地域': ['área', 'áreas'],
  '件': ['local', 'locais'],
}
const unitOf = (count: number, unit: UnreceivedUnit) => UNIT[unit][count === 1 ? 0 : 1]
const atLeastOf = (atLeast: string) => (atLeast ? ` ${atLeast}` : '')
/** 距離（1 だけ単数） */
const kilometers = (km: number) => `${km} ${km === 1 ? 'quilômetro' : 'quilômetros'}`
const ELSEWHERE = 'O texto original da Agência Meteorológica do Japão está no Registro de telegramas.'
/** 時刻の前の前置詞と冠詞（1 時台だけ単数。「às 12:40」「à 1:40」） */
const at = (time: string) => `${isOneOClock(time) ? 'à' : 'às'} ${time}`
/** 「〜頃」の前置詞と冠詞（「das 12:34」「da 1:05」） */
const around = (time: string) => `${isOneOClock(time) ? 'da' : 'das'} ${time}`
const fiveLowerOrHigher = `${intensity(45)} ou superior`
const notReceived = 'mas a intensidade não foi recebida.'
/** 時刻の前の前置詞と冠詞だけ（後ろに時刻の断片が続くとき） */
const clockPrep = (time: string) => (isOneOClock(time) ? 'à' : 'às')
/** 時刻（前置詞と冠詞つき。{@link at} と同じ。語表の関数の引数 `at`（最大波の時刻）と名前がぶつかる所で使う） */
const atClock = at
/** 津波の等級の呼び名と、前の等級を読めない解除区域の呼び名 */
const GRADE = tsunamiGradeNamesIn(ptBR)
const WARNINGS_ETC = 'alertas de tsunami'
/** 等級の名前の性と数（Alerta は男性・Previsão は女性。`warningsEtc` は男性の複数） */
const FEMININE: ReadonlySet<string> = new Set([GRADE.Forecast])
const PLURAL: ReadonlySet<string> = new Set([WARNINGS_ETC])
/** 名前に合わせた過去分詞（`stem` は「decretad」など語尾の前まで） */
const agree = (name: string, stem: string) => `${stem}${FEMININE.has(name) ? 'a' : 'o'}${PLURAL.has(name) ? 's' : ''}`
/** 名前に合わせた定冠詞 */
const article = (name: string) => (FEMININE.has(name) ? 'a' : 'o')
/** 波高（1 だけ単数） */
const meters = (value: string) => `${decimalComma(value)} ${value === '1' ? 'metro' : 'metros'}`
/** 波高に合わせた「観測した」（1 メートルだけ単数） */
const observedOf = (value: string) => (/\bmetro\b/.test(value) ? 'observado' : 'observados')
/** 上限で読まなかった観測点の数（1 だけ単数） */
const moreSites = (n: number) => `mais ${n} ${n === 1 ? 'local' : 'locais'}`
/** 原因地震の呼び方（1 つ目の地震か、2 つ目以降の地震か） */
const ofTheQuake = (first: boolean) => (first ? 'deste terremoto' : 'do outro terremoto')
/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = 'atualização para'
const STEM_OBSERVED = 'observação de'

const NANKAI = ptBR.telegramLog.controlTitle['南海トラフ地震臨時情報']
const COMMENTARY = ptBR.telegramLog.controlTitle['南海トラフ地震関連解説情報']
const COUNT = ptBR.telegramLog.controlTitle['地震回数に関する情報']
const NOTICE = ptBR.telegramLog.controlTitle['地震・津波に関するお知らせ']
const KOHATSU = ptBR.telegramLog.controlTitle['北海道・三陸沖後発地震注意情報']
const LPGM = ptBR.quake.infoName.lpgm
const INTERNATIONAL_TSUNAMI = ptBR.quake.infoName.internationalTsunami
const WATCH = 'Fique atento às próximas informações.'
const NANKAI_QUAKE = 'um terremoto na Fossa de Nankai'
/** 想定震源域（「área de origem prevista de um terremoto na Fossa de Nankai」） */
const SOURCE_AREA = `da área de origem prevista de ${NANKAI_QUAKE}`
const MEASURES = 'medidas de prevenção de desastres'
const PERIOD = { small: 'da madrugada', morning: 'da manhã', noon: 'da tarde', afternoon: 'da tarde', night: 'da noite' } as const
/**
 * 時報の時刻（数字で書く。2026-11-18 ユーザー選択「時刻を数字で書く (Recommended)」）。12 時間制は時間帯の語
 * （同日「言語ごとの時間帯の語で言う (Recommended)」。0 時台は「0:30 da madrugada」）。18 時以降は「da noite」（同日「夜の語を足す (Recommended)」）
 */
const signalClock = (hour: number, minute: number, clock: '24h' | '12h') => {
  if (clock === '24h') return clockTime(hour, minute)
  const p = dayPeriodOf(hour, 18)
  return `${clockTime(p.hour, minute)} ${PERIOD[p.period]}`
}

/**
 * 読み上げの文の語表（ポルトガル語・ブラジル）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（緊急地震速報・地震情報・津波）と、2026-11-18 ユーザー選択
 * 「この案で入れる (Recommended)」の表（長周期・特別情報・揺れ検知・国際津波関連情報。時報は同日「時刻を数字で書く (Recommended)」）。
 * 気象庁の多言語辞書の定型文（Fique alerta a fortes tremores・cancelou）と画面の辞書の訳（Alerta Urgente de Terremoto・
 * Intensidade máx. prevista など）にそろえた。震央・対象地方・観測した地名は「:」で示す。
 *
 * 規模の小数点はコンマにする。地震情報の断片は区切りを挟まずにつなぐので、文の終わりになる語は後ろに空白を 1 つ持つ
 */
export const ptBRSpeech: SpeechWords = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: clockTime,
    telegramTextElsewhere: ELSEWHERE,
    day: (d) => `dia ${d}`,
    dayTime: (d, hour, minute) => `${clockTime(hour, minute)} do dia ${d}`,
    cancelReasonLead: (infoName) => `Segue o motivo do cancelamento da ${infoName}. `,
    issued: (label) => `${label}. `,
    updated: (label) => `A ${label} foi atualizada. `,
    atAround: (time) => `Por volta ${around(time)}, `,
    also: 'Além disso, ',
    dayHour: (d, hour) => `${hour}:00 do dia ${d}`,
    telegramTextLead: (label) => `Segue o texto da Agência Meteorológica do Japão sobre a ${label}. `,
  },
  eew: {
    label: ptBR.quake.jmaNoteHeading.eew,
    upgrade: 'Elevado para Alerta Urgente de Terremoto.',
    warningRegionsClosing: 'fique alerta a fortes tremores',
    lpgmClassZero: 'Classe máxima prevista de movimento sísmico de longo período 0.',
    cancelledAt: (time) => `O Alerta Urgente de Terremoto emitido ${at(time)} foi cancelado.`,
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
  quake: {
    regionSep: '; ',
    // 階級ごとに文を切る（2026-11-17 ユーザー選択「階級ごとに文を切る (Recommended)」）。初めて観測した地域の文は次の文にも「Pela primeira vez」（同日ユーザー選択「文ごとに繰り返す (Recommended)」）
    intensityGroupSep: (fresh) => (fresh ? '. Pela primeira vez, ' : '. '),
    unreceivedCountOnly: (count, unit) => `Em ${count} ${unitOf(count, unit)}, estima-se intensidade ${fiveLowerOrHigher}, ${notReceived} `,
    unreceivedOmitted: (count, unit) => `, e mais ${count} ${unitOf(count, unit)}`,
    unreceivedTailPartial: `: em algumas estações, estima-se intensidade ${fiveLowerOrHigher}, ${notReceived} `,
    unreceivedTail: `: estima-se intensidade ${fiveLowerOrHigher}, ${notReceived} `,
    intensityLead: (isMax, i) => `${isMax ? 'Intensidade máxima' : 'Intensidade'} ${i} observada: `,
    regionsOmitted: (count) => `, e mais ${count} ${count === 1 ? 'área' : 'áreas'}`,
    observedTail: '. ',
    fresh: 'Pela primeira vez, ',
    freshAfterUpgraded: 'Além disso, pela primeira vez, ',
    magnitudeOf: (magnitude) => `de magnitude ${decimalComma(magnitude)}`,
    magnitudeConditionPredicate: {
      'Ｍ不明': 'A magnitude é desconhecida. ',
      'Ｍ８を超える巨大地震': 'Estima-se um terremoto extremamente forte, de magnitude superior a 8. ',
    },
    // 知らない表記（日本語）は読まず、数値でないと言う。在処の文は発話の末尾に 1 度だけ続く
    // （2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）
    magnitudeConditionUnknown: (_body) => 'A magnitude não foi divulgada como número. ',
    magnitudeIs: (predicate) => predicate,
    magnitudeAmended: (predicate) => `A magnitude foi atualizada. ${predicate}`,
    depthVeryShallowPlace: 'muito raso',
    depthOf: (km, atLeast) => `profundidade de ${kilometers(km)}${atLeastOf(atLeast)}`,
    depthAtLeast: 'ou mais',
    depthAmendKm: (km, atLeast) => `Profundidade do hipocentro atualizada para ${kilometers(km)}${atLeastOf(atLeast)}`,
    depthAmendVeryShallowContinuing: 'Profundidade do hipocentro atualizada para muito rasa',
    // 値（「muito raso」）を受け取るだけなので、性と前置詞が崩れないよう「:」で示す
    depthAmendIs: (value) => `Profundidade do hipocentro atualizada: ${value}`,
    maxScaleOnlyUnreceived: (i) => `Estima-se intensidade máxima ${i} ou superior, ${notReceived} `,
    maxScaleOnly: (i) => `Intensidade máxima ${i} observada. `,
    label: {
      intensityReport: 'Informação sobre intensidade sísmica',
      distant: 'Informação sobre terremoto distante',
      epicenter: 'Informação sobre o hipocentro',
      quake: 'Informação sobre terremotos',
    },
    hypocenterAmended: (name) => `Hipocentro atualizado: ${name}. `,
    magnitudeAmendedTo: (magnitude) => `A magnitude foi atualizada para ${decimalComma(magnitude)}. `,
    depthAmendedTo: (depth) => `A profundidade do hipocentro foi atualizada: ${depth}. `,
    observedIntensityUpdated: 'As intensidades observadas foram atualizadas. ',
    stationsAddedRegionsSame: 'Foram adicionadas estações, mas a intensidade máxima de cada área não mudou. ',
    stationsUpdatedRegionsSame: 'As intensidades observadas foram atualizadas, mas a intensidade máxima de cada área não mudou. ',
    noChange: 'Não há alteração no conteúdo. ',
    intensityNoChange: 'Não há alteração nas intensidades observadas. ',
    hypocenterNoChange: 'Não há alteração no hipocentro. ',
    prominentAmendHead: (time, epicenter) =>
      `Aviso de atualização do hipocentro de um terremoto significativo. Terremoto${time ? ` por volta ${around(time)}` : ''}: ${epicenter}. `,
    amendSep: ', ',
    magnitudeValue: (magnitude) => `magnitude atualizada para ${decimalComma(magnitude)}`,
    amendedTail: '. ',
    hypocenterElementsAmended: 'O hipocentro foi atualizado. ',
    depthKm: (km, atLeast) => `${kilometers(km)}${atLeastOf(atLeast)}`,
    cancelledAt: (time) => `A Informação sobre terremotos emitida ${at(time)} foi cancelada.`,
    cancelled: 'A Informação sobre terremotos foi cancelada.',
    // 名前ごとに性が違う（Aviso は男性）ので、冠詞と過去分詞を名前に合わせない形（画面の `quake.retracted` と同じ「X: cancelada」）
    reportCancelledAt: (name, time) => `${name}, emitida ${at(time)}: cancelada.`,
    reportCancelled: (name) => `${name}: cancelada.`,
    reportName: reportNameIn(ptBR),
    hypocenterDepthSep: ', ',
    // 「地震が起きた」を先に言い、震源を後の文で言う（2026-11-17 ユーザー選択「言語の側で決める (Recommended)」）
    occurrence: (t) => [
      { kind: 'text', text: 'ocorreu um terremoto' },
      ...(t.magnitude !== undefined ? [{ kind: 'text', text: ' ' } as const, { kind: 'magnitude' } as const] : []),
      { kind: 'text', text: '. ' },
      ...(t.name !== undefined
        ? [
          { kind: 'text', text: 'Hipocentro: ' } as const,
          { kind: 'name' } as const,
          ...(t.depth !== undefined ? [{ kind: 'text', text: ', ' } as const, { kind: 'depth' } as const] : []),
          { kind: 'text', text: '. ' } as const,
        ]
        : []),
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    domesticTsunami: {
      'なし': 'Este terremoto não oferece risco de tsunami. ',
      '若干の海面変動': 'Devido a este terremoto, poderá haver ligeiras variações no nível do mar no litoral do Japão, mas não existe risco de dano. ',
      '調査中': 'A ocorrência de tsunami por este terremoto está em investigação. ',
      '海面変動の可能性': 'Como o hipocentro está sob o mar, há possibilidade de tsunami. ',
      '注意報': 'No momento, está sendo anunciado Alerta Preventivo de Tsunami. ',
      '警報等': 'No momento, está sendo anunciado Alerta de Tsunami, etc. ',
      '不明': 'A informação sobre tsunami é desconhecida. ',
    },
    domesticTsunamiCode: {
      '0211': 'Está sendo anunciado Alerta de Tsunami, etc. ',
      '0212': 'Devido a este terremoto, poderá haver ligeiras variações no nível do mar no litoral do Japão, mas não existe risco de dano. ',
      '0213': 'As variações do nível do mar devem continuar por algum tempo; tenha cuidado ao nadar no mar ou pescar nas rochas. ',
      '0214': 'As variações do nível do mar devem continuar por algum tempo; tenha cuidado ao pescar nas rochas. ',
      '0215': 'Este terremoto não oferece risco de tsunami. ',
      '0216': 'Se o hipocentro estiver sob o mar, há possibilidade de tsunami. ',
      '0217': 'Fique atento às próximas informações. ',
      '0229': 'A possibilidade de tsunami no Japão está em investigação no momento. ',
      '0230': 'Este terremoto não causa impacto de tsunami no Japão. ',
    },
    // 2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」
    foreignTsunamiCode: {
      '0221': 'Há possibilidade de tsunami em uma ampla área do Oceano Pacífico. ',
      '0222': 'Há possibilidade de tsunami no Oceano Pacífico. ',
      '0226': 'Há possibilidade de tsunami perto do hipocentro. ',
      '0228': 'Em geral, quando um terremoto desta magnitude ocorre em uma área rasa sob o mar, pode ocorrer um tsunami. ',
    },
  },
  tsunami: {
    infoLabel: 'Informação sobre tsunami',
    gradeName: GRADE,
    heightToSpeech: tsunamiHeightIn(({ value, limit }) => {
      const m = meters(value)
      return limit === 'over' ? `mais de ${m}` : limit === 'under' ? `menos de ${m}` : limit === 'orMore' ? `${m} ou mais` : m
    }),
    nonNumericHeight: { 巨大: 'tsunami gigante', 高い: 'tsunami alto' },
    heightLabel: { height: markHeightOrMore },
    // 区域名の訳はコンマを含むので、区域・観測点の区切りは「; 」、区域と観測点の間は「: 」
    areaSep: '; ',
    heightGroupSep: '. ',
    districtStationSep: ': ',
    stationSep: '; ',
    forecastHeightAt: (h) => `: previsão de ${h}`,
    observedHeightAt: (h) => `, ${h}`,
    heightsExpected: '. ',
    alsoIssued: (g) => `: ${g} também em vigor. `,
    // 必ず「Além disso, 」の後ろに来るので小文字で始める
    issuedForAreasBelow: (g) => `as costas litorâneas em ${g} são as seguintes. `,
    issuedFor: (g) => `: ${g} em vigor. `,
    issuedForAreas: (g) => `: ${g} ${agree(g, 'decretad')}. `,
    gradeIssued: (g) => `Foi ${agree(g, 'decretad')} ${article(g)} ${g}. `,
    downgradedBelow: (g) => `Rebaixamento do nível para ${g}. No momento, as costas litorâneas em ${g} são as seguintes. `,
    downgradedLead: (g) => `Rebaixamento do nível para ${g}. No momento, `,
    areaLifted: (g) => `: ${g} ${agree(g, 'desativad')}. `,
    warningsEtc: WARNINGS_ETC,
    // 「名前, 名詞句」の形にして性の一致を避ける
    areaGradeChanged: (from, to, raised) => `: ${from}, ${raised ? 'elevação' : 'rebaixamento'} do nível para ${to}. `,
    forecastHeightChanged: 'A altura máxima estimada do tsunami mudou. ',
    fallbackEvacuation: tsunamiEvacuationIn(ptBR, ' '),
    sourceLead: 'Hipocentro deste terremoto: ',
    sourceLeadOther: 'Além disso, hipocentro do outro terremoto: ',
    sourceMagnitudeLead: ', magnitude ',
    sourceMagnitude: decimalComma,
    sourceTail: '. ',
    sourceHypocenterAmended: (first, name) => `Hipocentro ${ofTheQuake(first)} atualizado: ${name}. `,
    sourceMagnitudeAmendedTo: (first, magnitude) => `A magnitude ${ofTheQuake(first)} foi atualizada para ${decimalComma(magnitude)}. `,
    sourceMagnitudeAmended: (first, predicate) => `A magnitude ${ofTheQuake(first)} foi atualizada. ${predicate}`,
    // 値は「:」で示す（「muito raso」が入ったとき性と前置詞が崩れないように）
    sourceDepthAmendedTo: (first, depth) => `A profundidade do hipocentro ${ofTheQuake(first)} foi atualizada: ${depth}. `,
    expiryLead: (g, time) => `${g}: expira ${clockPrep(time)} `,
    expiryTail: '. ',
    // 延長か変更かを時刻の前で言う（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節）
    expiryChangeLead: (g, extended, time) => `${g}: ${extended ? 'o prazo foi prorrogado' : 'o horário foi alterado'}; agora expira ${clockPrep(time)} `,
    expiryExtended: '. ',
    expiryChanged: '. ',
    retracted: 'Os alertas de tsunami foram emitidos por engano e foram cancelados.',
    expired: 'A Previsão de tsunami expirou.',
    allLifted: 'Todos os alertas de tsunami foram desativados.',
    infoRetracted: 'A Informação sobre tsunami foi cancelada.',
    offshoreRetracted: 'A Informação sobre observação de tsunami em alto-mar foi cancelada.',
    firstWaveKind: firstWaveKindIn('subida inicial', 'descida inicial', 'primeira onda'),
    // 更新は観測した時刻だと分かる形にする（「atualização para 0,9 metros, observados às 16:41」。同日の 15 節）。第 1 波の 3 つの語はどれも女性名詞
    heightClause: (firstWave, at, value, updated) =>
      `, ${firstWave ? `a ${firstWave.initial} chegou ${atClock(firstWave.time)}, ` : ''}${updated
        ? `${STEM_UPDATED} ${value}${at ? `, ${observedOf(value)} ${atClock(at)}` : ''}`
        : `${STEM_OBSERVED} ${value}${at ? ` ${atClock(at)}` : ''}`}`,
    observationInfoLead: 'Informação sobre observação de tsunami. ',
    maxWaveUpdatedLead: 'A onda máxima foi atualizada nos seguintes locais. ',
    newlyObservedLead: 'Foi observado tsunami pela primeira vez nos seguintes locais. ',
    stemUpdated: STEM_UPDATED,
    stemObserved: STEM_OBSERVED,
    tailUpdated: '. ',
    tailObserved: '. ',
    omittedObserving: (n) => `Também se observa tsunami em ${moreSites(n)}. `,
    omittedArrival: (n) => `A chegada também foi confirmada em ${moreSites(n)}. `,
    omittedUpdated: (n) => `Também houve atualização em ${moreSites(n)}. `,
    omittedMissing: (n) => (n === 1 ? 'Mais 1 local também está sem dados. ' : `Mais ${n} locais também estão sem dados. `),
    omittedWarningLevel: (n) => `Também se observa tsunami de nível de Alerta de Tsunami em ${moreSites(n)}. `,
    arrivalLead: 'Foi confirmada a chegada do tsunami nos seguintes locais. ',
    firstWaveObservedClause: (time, initial) => `, ${initial} observada ${atClock(time)}`,
    firstWaveUpdatedClause: (time, initial) => `, atualização para ${initial} ${atClock(time)}`,
    arrivalConfirmedClause: ', chegada confirmada',
    arrivalConfirmedTail: ': chegada confirmada. ',
    maxHeightObserving: 'Altura máxima da onda: informações pendentes. ',
    maxHeightWeak: 'Altura máxima da onda: fraca. ',
    updatedAtClause: (at) => (at ? `, atualização para ${at}` : ', atualização'),
    maxHeightTimeLead: 'O horário de observação da onda máxima foi atualizado nos seguintes locais. ',
    maxHeightTimeTail: ': o horário de observação da onda máxima foi atualizado. ',
    missingMaxHeightTimeLead: 'Nos locais sem dados, o horário de observação da onda máxima foi atualizado. ',
    missingPrefix: 'Locais sem dados. ',
    firstWaveUpdatedLead: 'A primeira onda foi atualizada nos seguintes locais. ',
    firstWaveArrivedLead: 'Foi confirmada a chegada da primeira onda do tsunami nos seguintes locais. ',
    observationNoChange: 'Informação sobre observação de tsunami. Não há alteração nas alturas de onda observadas. ',
    observationLowered: 'Foi emitida a Informação sobre observação de tsunami. ',
    tideFallbackHeadline: 'Seguem os horários de maré alta e os horários estimados da chegada da primeira onda do tsunami em cada local. ',
    tide: {
      tide: 'Os horários de maré alta foram atualizados. ',
      arrival: 'A situação da chegada do tsunami foi atualizada. ',
      arrivalTime: 'Os horários estimados da chegada do tsunami foram atualizados. ',
      none: 'Não há alteração no conteúdo. ',
    },
    missingObservedLead: 'Observado antes da falta de dados. ',
    weakTsunamiAt: ', tsunami fraco',
    missingObservedTail: '. No momento, sem dados. ',
    missingTail: ': sem dados. ',
    warningLevelTail: ': observa-se tsunami de nível de Alerta de Tsunami. ',
  },
  lpgm: {
    label: LPGM,
    retracted: `A ${LPGM} foi cancelada.`,
    occurredAt: (time) => `Terremoto ocorrido por volta ${around(time)}. `,
    // 2 組目からは短く言う（2026-11-18 ユーザー選択「この案で入れる (Recommended)」の 5 節の 1）
    classAt: (cls, names, isFirst) => `Classe ${cls}${isFirst ? ' de movimento sísmico de longo período' : ''} observada: ${names}`,
    regions: (regionText) => regionText,
    maxClassOnly: (cls) => `Classe ${cls} de movimento sísmico de longo período observada.`,
  },
  special: {
    nankaiLabel: NANKAI,
    // 主語と動詞を持つ形（「Como 〈きっかけ〉,」で受ける）
    nankaiTrigger: {
      '111': 'ocorreu um terremoto de magnitude 6,8 ou superior na área monitorada',
      '112': 'foi observada uma variação significativa nos extensômetros',
      '113': 'foi observado um fenômeno diferente do habitual',
    },
    nankaiRetracted: `A ${NANKAI} foi cancelada.`,
    nankaiEnded: `${NANKAI}: investigação concluída. A possibilidade de ${NANKAI_QUAKE} estava dentro do normal.`,
    nankaiInvestigating: (trigger) =>
      `${NANKAI}: em investigação. ${trigger ? `Como ${trigger}, está sendo investigada` : 'Está sendo investigada'} a possibilidade de ${NANKAI_QUAKE}. ${WATCH}`,
    nankaiMajorWarning: `${NANKAI}: Alerta de megaterremoto. Ocorreu um grande terremoto dentro ${SOURCE_AREA}. Tome imediatamente ${MEASURES}.`,
    nankaiMajorAdvisory: `${NANKAI}: Atenção a megaterremoto. Ocorreu um terremoto dentro ${SOURCE_AREA}. Verifique suas ${MEASURES}.`,
    nankaiOther: `${NANKAI}. Foi emitida uma informação extraordinária sobre ${NANKAI_QUAKE}. ${WATCH}`,
    commentaryLabel: COMMENTARY,
    commentaryRetracted: `O ${COMMENTARY} foi cancelado.`,
    commentaryRegular: `${COMMENTARY}. Foram divulgados os resultados da reunião regular do Comitê de Avaliação de Terremotos da Fossa de Nankai.`,
    // 号数は語で言う（画面の「nº」は声で崩れる）
    commentary: (serial) =>
      `${COMMENTARY}${serial ? `, número ${halfWidthDigits(serial)}` : ''}. Foi emitido um comentário sobre a situação na área de origem prevista de ${NANKAI_QUAKE}.`,
    countLabel: COUNT,
    countRetracted: `A ${COUNT} foi cancelada.`,
    countLead: `${COUNT}. `,
    countSpanUnknown: 'Até agora',
    countSpan: (from, to) => `${isOneOClock(from) ? 'Da' : 'Das'} ${from} ${isOneOClock(to) ? 'à' : 'às'} ${to}`,
    countFeltOnly: (span, felt) =>
      `${span}, ${felt === 1 ? 'foi observado 1 terremoto' : `foram observados ${felt} terremotos`} com intensidade sísmica 1 ou superior. `,
    countOccurred: (span, count) => `${span}, ${count === 1 ? 'ocorreu 1 terremoto' : `ocorreram ${count} terremotos`}. `,
    countFeltOf: (felt) => `Destes, ${felt} ${felt === 1 ? 'teve' : 'tiveram'} intensidade sísmica 1 ou superior. `,
    countFeltNone: 'Nenhum deles teve intensidade sísmica 1 ou superior. ',
    noticeLabel: NOTICE,
    noticeRetracted: `O ${NOTICE} foi cancelado.`,
    noticeLead: `${NOTICE}. `,
    noticeWithHeadline: (_headline) => `${NOTICE}. ${ELSEWHERE}`,
    kohatsuLabel: KOHATSU,
    kohatsuRetracted: `O ${KOHATSU} foi cancelado.`,
    kohatsu: (headline) =>
      `${KOHATSU}. ${headline === null ? `${ELSEWHERE} ` : ''}A possibilidade de um grande terremoto está maior do que o normal. Verifique suas ${MEASURES}.`,
    // 「Mapa」は男性名詞なので「recebido」「atualizado」
    estimatedIntensity: (time, isNew) =>
      `Foi ${isNew ? 'recebido' : 'atualizado'} o ${ptBR.quake.infoName.estimatedIntensity} da Agência Meteorológica do Japão${time ? ` para o terremoto de cerca ${around(time)}` : ''}.`,
  },
  kyoshin: {
    detected: (name) => (name ? `Tremor detectado: ${name}.` : 'Tremor detectado.'),
    otherRegion: (name) => (name ? `Tremor também detectado: ${name}.` : 'Tremor também detectado em outro local.'),
  },
  internationalTsunami: {
    label: INTERNATIONAL_TSUNAMI,
    communicationsTest: `${INTERNATIONAL_TSUNAMI}: teste de comunicação.`,
    evaluation: ptBR.alertText.internationalTsunamiEvaluation,
    when: (d, hour, minute) => `${clockTime(hour, minute)} do dia ${d}`,
    coordinate: (lat, lon) =>
      `latitude ${decimalComma(Math.abs(lat).toFixed(1))} graus ${lat < 0 ? 'sul' : 'norte'}, longitude ${decimalComma(Math.abs(lon).toFixed(1))} graus ${lon < 0 ? 'oeste' : 'leste'}`,
    body: (p) => {
      const details = [p.where, p.depthKm !== null ? `profundidade ${kilometers(p.depthKm)}` : null, p.magnitude !== null ? `magnitude ${decimalComma(p.magnitude)}` : null]
        .filter((s): s is string => s !== null && s !== '')
      return `Terremoto${p.when ? ` por volta ${around(p.when)}` : ''}${details.length > 0 ? `: ${details.join(', ')}` : ''}. ${p.evaluation !== null ? `${p.evaluation}.` : `Foi emitida a ${INTERNATIONAL_TSUNAMI}.`}`
    },
  },
  timeSignal: {
    // 1 時台だけ単数（「É 1:30」）
    say: (phrase, hour, minute, clock) => {
      const t = signalClock(hour, minute, clock)
      const one = isOneOClock(t)
      switch (phrase) {
        case 'oshirase': return `Hora certa: ${t}.`
        case 'desu': return `${one ? 'É' : 'São'} ${t}.`
        case 'narimashita': return `Agora ${one ? 'é' : 'são'} ${t}.`
        case 'bare': return t
      }
    },
  },
}
