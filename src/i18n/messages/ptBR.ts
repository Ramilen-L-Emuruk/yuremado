import type { Messages } from '../messages'

/** ポルトガル語（ブラジル式）の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const ptBR: Messages = {
  nav: {
    earthquake: 'Informação sobre terremotos',
    realtime: 'Tempo real',
    tsunami: 'Informação sobre tsunami',
    catalog: 'Catálogo de hipocentros',
    settings: 'Configurações',
    telegrams: 'Registro de telegramas',
  },
  navHint: {
    active: (name, collapsed) => `${name} (toque novamente para ${collapsed ? 'expandir' : 'recolher'} o painel)`,
  },
  appUpdate: {
    reloadIn: (seconds) => `Recarregando em ${seconds} s`,
    updateIn: (seconds) => `Atualizando em ${seconds} s`,
    later: 'Mais tarde',
    newVersion: (version) => (version !== null ? `Nova versão ${version}` : 'Nova versão'),
    whatsNew: 'Novidades',
    updateNow: 'Atualizar agora',
    updatedTo: (version) => `Atualizado para a versão ${version}`,
    close: 'Fechar',
  },
  releaseNotes: {
    titleFor: (version) => `Novidades da versão ${version}`,
    title: 'Novidades',
    close: 'Fechar',
    loading: 'Carregando',
    loadFailed: 'Não foi possível carregar as novidades',
    retry: 'Tentar novamente',
    minorOnly: 'Pequenas correções',
    added: 'Adicionado',
    fixed: 'Corrigido',
  },
  errorScreen: {
    rootTitle: 'Não é mais possível exibir a tela',
    rootReceivingStopped: 'O recebimento de informações também parou',
    reload: 'Recarregar',
    cannotShow: (label) => `Não é possível exibir ${label}`,
    showAgain: 'Exibir novamente',
    reloadMayFix: 'Recarregar pode resolver',
    mapLabel: 'Mapa',
  },
  mapCorner: {
    cannotDraw: (names) => `Não foi possível desenhar ${names}`,
    notClickable: (names) => `${names} não responde a cliques`,
    nameList: (shown, rest) => (rest > 0 ? `${shown.join(', ')} e mais ${rest}` : shown.join(', ')),
    loadingData: 'Carregando dados…',
    updatedAt: (time) => (time !== null ? `Atualizado ${time}` : 'Aguardando dados…'),
    seismoDisconnected: 'Sismógrafo não conectado',
  },
  panelBorder: {
    height: 'Divisor entre o mapa e o painel de informações (arraste para ajustar a altura, toque para recolher)',
    width: 'Divisor entre o mapa e o painel de informações (arraste para ajustar a largura, toque para recolher)',
  },
  rangeSlider: {
    lower: 'Início',
    upper: 'Fim',
    thumb: (label, end) => `${end} de ${label}`,
  },
  replayConfirm: {
    title: 'Reproduzir este terremoto?',
    body: 'Durante a reprodução, novas informações sobre terremotos e os alertas urgentes de terremoto não são exibidos.',
    cancel: 'Cancelar',
    confirm: 'Reproduzir',
  },
  shareCard: {
    idle: 'Compartilhar o mapa como imagem',
    working: 'Criando a imagem',
    error: 'Não foi possível criar a imagem',
    copied: 'Imagem salva e texto copiado',
    copyFailed: 'Imagem salva (não foi possível copiar o texto)',
  },
  usageConsent: {
    title: 'Ajude-nos a melhorar o Yuremado',
    body: 'Permitir o envio de dados de uso (abas abertas, recursos usados, configurações, tipo de dispositivo etc.) ao desenvolvedor? Seu nome, endereço IP e local registrado não são enviados. Você pode alterar esta configuração a qualquer momento.',
    privacyPolicy: 'Política de Privacidade',
    deny: 'Não permitir',
    allow: 'Permitir',
  },
}
