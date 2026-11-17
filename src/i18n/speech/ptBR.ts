import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { ptBR } from '../messages/ptBR'
import { clockTime, decimalComma, intensityIn, isOneOClock, regionNameIn, reportNameIn, showsApproxAbove } from './shared'

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

/**
 * 読み上げの文の語表（ポルトガル語・ブラジル。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（Fique alerta a fortes tremores・cancelou）と
 * 画面の辞書の訳（Alerta Urgente de Terremoto・Intensidade máx. prevista など）にそろえた。震央・対象地方・観測した地名は「:」で示す。
 *
 * 規模の小数点はコンマにする。地震情報の断片は区切りを挟まずにつなぐので、文の終わりになる語は後ろに空白を 1 つ持つ
 */
export const ptBRSpeech: SpeechWordsInProgress = {
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
}
