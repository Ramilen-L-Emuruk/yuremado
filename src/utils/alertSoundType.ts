// 通知音の種類。音を鳴らす `alertSound.ts`（AudioContext を持つ）とは分けて置く —— 種類だけを使う判定（`eew.ts` の
// `selectEEWSoundType`）は、音を鳴らさない場所（中継のプッシュ通知が写すアプリのコード）でも読み込まれるため。
export type AlertSoundType =
  'earthquake' | 'earthquakePrompt' | 'earthquakeInfo'
  | 'eew' | 'eewUpdate' | 'eewFinal' | 'eewCancel' | 'eewSpecial' | 'eewForecast'
  | 'tsunami' | 'tsunamiMajor' | 'tsunamiWatch' | 'tsunamiForecast' | 'tsunamiUpdate' | 'tsunamiCancel'
  | 'kyoshin' | 'kyoshinCandidate'
  | 'specialInfo' | 'specialInfoCommentary' | 'earthquakeCount'
  | 'earthquakeCancel' | 'specialInfoCancel'
