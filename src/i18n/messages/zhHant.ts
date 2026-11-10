import type { Messages } from '../messages'

/** 中国語（繁体字）の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const zhHant: Messages = {
  nav: {
    earthquake: '地震訊息',
    realtime: '即時',
    tsunami: '海嘯訊息',
    catalog: '震源目錄',
    settings: '設定',
    telegrams: '電文紀錄',
  },
  navHint: {
    active: (name, collapsed) => `${name}（再按一次可${collapsed ? '展開' : '收合'}面板）`,
  },
  appUpdate: {
    reloadIn: (seconds) => `${seconds} 秒後重新載入`,
    updateIn: (seconds) => `${seconds} 秒後更新`,
    later: '稍後',
    newVersion: (version) => (version !== null ? `新版本 ${version}` : '新版本'),
    whatsNew: '更新內容',
    updateNow: '立即更新',
    updatedTo: (version) => `已更新至版本 ${version}`,
    close: '關閉',
  },
  releaseNotes: {
    titleFor: (version) => `${version} 的更新內容`,
    title: '更新內容',
    close: '關閉',
    loading: '載入中',
    loadFailed: '無法載入更新內容',
    retry: '重試',
    minorOnly: '小幅修正',
    added: '新增',
    fixed: '修正',
  },
  errorScreen: {
    rootTitle: '無法顯示畫面',
    rootReceivingStopped: '資訊接收也已停止',
    reload: '重新載入',
    cannotShow: (label) => `無法顯示${label}`,
    showAgain: '重新顯示',
    reloadMayFix: '重新載入可能會解決',
    mapLabel: '地圖',
  },
  mapCorner: {
    cannotDraw: (names) => `無法繪製${names}`,
    notClickable: (names) => `${names}無法回應點擊`,
    nameList: (shown, rest) => (rest > 0 ? `${shown.join('、')} 等 ${rest} 項` : shown.join('、')),
    loadingData: '正在取得資料…',
    updatedAt: (time) => (time !== null ? `更新 ${time}` : '等待接收…'),
    seismoDisconnected: '地震計 未連線',
  },
  panelBorder: {
    height: '地圖與資訊面板的邊界（拖曳調整高度，點按收合）',
    width: '地圖與資訊面板的邊界（拖曳調整寬度，點按收合）',
  },
  rangeSlider: {
    lower: '起點',
    upper: '終點',
    thumb: (label, end) => `${label}的${end}`,
  },
  replayConfirm: {
    title: '要重播這次地震嗎？',
    body: '重播期間，不會顯示新發布的地震訊息與緊急地震警報。',
    cancel: '取消',
    confirm: '重播',
  },
  shareCard: {
    idle: '將地圖製成圖片並分享',
    working: '正在製作圖片',
    error: '無法製作圖片',
    copied: '已儲存圖片並複製內文',
    copyFailed: '已儲存圖片（未能複製內文）',
  },
  usageConsent: {
    title: '請協助我們改善 Yuremado',
    body: '是否允許將使用情況資料（開啟的分頁、使用的功能、設定、裝置類型等）傳送給開發者？不會傳送姓名、IP 位址或登錄的地點。此設定可隨時變更。',
    privacyPolicy: '隱私權政策',
    deny: '不允許',
    allow: '允許',
  },
}
