import type { Messages } from '../messages'

/** 韓国語の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const ko: Messages = {
  nav: {
    earthquake: '지진 정보',
    realtime: '실시간',
    tsunami: '지진해일 정보',
    catalog: '진원 목록',
    settings: '설정',
    telegrams: '전문 로그',
  },
  navHint: {
    active: (name, collapsed) => `${name} (다시 누르면 패널 ${collapsed ? '펼치기' : '접기'})`,
  },
  appUpdate: {
    reloadIn: (seconds) => `${seconds}초 후 다시 불러옵니다`,
    updateIn: (seconds) => `${seconds}초 후 업데이트합니다`,
    later: '나중에',
    newVersion: (version) => (version !== null ? `새 버전 ${version}` : '새 버전'),
    whatsNew: '변경 사항',
    updateNow: '지금 업데이트',
    updatedTo: (version) => `버전 ${version}(으)로 업데이트했습니다`,
    close: '닫기',
  },
  releaseNotes: {
    titleFor: (version) => `${version} 변경 사항`,
    title: '변경 사항',
    close: '닫기',
    loading: '불러오는 중',
    loadFailed: '변경 사항을 불러오지 못했습니다',
    retry: '다시 시도',
    minorOnly: '사소한 수정',
    added: '추가',
    fixed: '수정',
  },
  errorScreen: {
    rootTitle: '화면을 표시할 수 없게 되었습니다',
    rootReceivingStopped: '정보 수신도 중단되었습니다',
    reload: '다시 불러오기',
    cannotShow: (label) => `${label}을(를) 표시할 수 없습니다`,
    showAgain: '다시 표시',
    reloadMayFix: '다시 불러오면 해결될 수 있습니다',
    mapLabel: '지도',
  },
  mapCorner: {
    cannotDraw: (names) => `${names}을(를) 그리지 못함`,
    notClickable: (names) => `${names}이(가) 클릭에 반응하지 않음`,
    nameList: (shown, rest) => (rest > 0 ? `${shown.join(', ')} 외 ${rest}건` : shown.join(', ')),
    loadingData: '데이터를 가져오는 중…',
    updatedAt: (time) => (time !== null ? `갱신 ${time}` : '수신 대기 중…'),
    seismoDisconnected: '지진계 미연결',
  },
  panelBorder: {
    height: '지도와 정보 패널의 경계(드래그하여 높이 조정, 탭하여 접기)',
    width: '지도와 정보 패널의 경계(드래그하여 너비 조정, 탭하여 접기)',
  },
  rangeSlider: {
    lower: '시작',
    upper: '끝',
    thumb: (label, end) => `${label} ${end}`,
  },
  replayConfirm: {
    title: '이 지진을 재생할까요?',
    body: '재생하는 동안에는 새로 발표된 지진 정보와 긴급 지진 속보가 표시되지 않습니다.',
    cancel: '취소',
    confirm: '재생',
  },
  shareCard: {
    idle: '지도를 이미지로 공유',
    working: '이미지 만드는 중',
    error: '이미지를 만들지 못했습니다',
    copied: '이미지를 저장하고 본문을 복사했습니다',
    copyFailed: '이미지를 저장했습니다(본문은 복사하지 못했습니다)',
  },
  usageConsent: {
    title: 'Yuremado 개선에 협조해 주세요',
    body: '사용 현황 데이터(열어 본 탭, 사용하는 기능, 설정, 기기 종류 등)를 개발자에게 보내는 것을 허용하시겠습니까? 이름, IP 주소, 등록한 지점은 보내지 않습니다. 이 설정은 언제든지 변경할 수 있습니다.',
    privacyPolicy: '개인정보 처리방침',
    deny: '허용 안 함',
    allow: '허용',
  },
}
