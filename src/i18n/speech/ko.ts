import type { SpeechWordsInProgress } from '../speechWords'
import { ko } from '../messages/ko'
import { intensityIn, regionNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(ko)

/**
 * 読み上げの文の語表（韓国語。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（강한 흔들림을 주의・지진 발생・취소）と
 * 画面の辞書の訳（긴급 지진 속보・예상 최대 진도など）にそろえた
 */
export const koSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: (hour, minute) => `${hour}시 ${minute}분`,
    telegramTextElsewhere: '일본 기상청의 원문은 전문 로그에 있습니다.',
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
}
