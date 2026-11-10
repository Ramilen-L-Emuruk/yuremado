import type { Messages } from '../messages'

/** 中国語（簡体字）の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const zhHans: Messages = {
  nav: {
    earthquake: '地震信息',
    realtime: '实时',
    tsunami: '海啸信息',
    catalog: '震源目录',
    settings: '设置',
    telegrams: '电文记录',
  },
  navHint: {
    active: (name, collapsed) => `${name}（再次点按可${collapsed ? '展开' : '折叠'}面板）`,
  },
  appUpdate: {
    reloadIn: (seconds) => `${seconds} 秒后重新加载`,
    updateIn: (seconds) => `${seconds} 秒后更新`,
    later: '稍后',
    newVersion: (version) => (version !== null ? `新版本 ${version}` : '新版本'),
    whatsNew: '更新内容',
    updateNow: '立即更新',
    updatedTo: (version) => `已更新到版本 ${version}`,
    close: '关闭',
  },
  releaseNotes: {
    titleFor: (version) => `${version} 的更新内容`,
    title: '更新内容',
    close: '关闭',
    loading: '加载中',
    loadFailed: '无法加载更新内容',
    retry: '重试',
    minorOnly: '小幅修正',
    added: '新增',
    fixed: '修正',
  },
  errorScreen: {
    rootTitle: '无法显示画面',
    rootReceivingStopped: '信息接收也已停止',
    reload: '重新加载',
    cannotShow: (label) => `无法显示${label}`,
    showAgain: '重新显示',
    reloadMayFix: '重新加载可能会解决',
    mapLabel: '地图',
  },
  mapCorner: {
    cannotDraw: (names) => `无法绘制${names}`,
    notClickable: (names) => `${names}无法响应点击`,
    nameList: (shown, rest) => (rest > 0 ? `${shown.join('、')} 等 ${rest} 项` : shown.join('、')),
    loadingData: '正在获取数据…',
    updatedAt: (time) => (time !== null ? `更新 ${time}` : '等待接收…'),
    seismoDisconnected: '地震计 未连接',
  },
  panelBorder: {
    height: '地图与信息面板的边界（拖动调整高度，点按折叠）',
    width: '地图与信息面板的边界（拖动调整宽度，点按折叠）',
  },
  rangeSlider: {
    lower: '起点',
    upper: '终点',
    thumb: (label, end) => `${label}的${end}`,
  },
  replayConfirm: {
    title: '要回放这次地震吗？',
    body: '回放期间，不会显示新发布的地震信息和紧急地震警报。',
    cancel: '取消',
    confirm: '回放',
  },
  shareCard: {
    idle: '将地图生成图片并分享',
    working: '正在生成图片',
    error: '无法生成图片',
    copied: '已保存图片并复制正文',
    copyFailed: '已保存图片（未能复制正文）',
  },
  usageConsent: {
    title: '请协助我们改进 Yuremado',
    body: '是否允许向开发者发送使用情况数据（打开的标签页、使用的功能、设置、设备类型等）？不会发送姓名、IP 地址或登记的地点。此设置可随时更改。',
    privacyPolicy: '隐私政策',
    deny: '不允许',
    allow: '允许',
  },
}
