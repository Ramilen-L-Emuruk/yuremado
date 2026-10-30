# コード整合性チェックポイント

> [`CLAUDE.md`](../../CLAUDE.md) の同名の節から案内される詳細。いつ開くかは `CLAUDE.md` 側に書いてある。

新機能追加・修正時にコメントと実装が乖離しやすい項目は、以下の仕様書（`docs/spec/`）に単一情報源として集約している。変更時に該当仕様書を参照し、コード修正と同一コミットで仕様書側も更新する（詳細は[`CLAUDE.md`](../../CLAUDE.md)「ドキュメント更新」節）。

## 読み上げ: 何を・どの語で読むか

**津波の読み上げ文を変えるときは、下記「津波」節も併せて見ること。** 既読の管理・観測波高の並び・等級を伝えていない電文の扱いは読み上げ文の作り方に直結するが、参照先の仕様書が `tsunami-spec.md` のため向こうに置いてある。読み上げに合わせて画面を動かす話は「自動タブ切替と画面の追従」節。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 読む範囲の設定（震度側の 4 項目と長周期の 1 項目）の組み合わせ方を崩すと、想定より広く／狭く読み上げる（読む階級・地域数の絞り込み条件） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「地域列挙の範囲」 |
| 読み上げ詳細度の設定 4 項目を崩すと、誤って未読へ戻る、または声にしうる事実と記録判定がずれて差分の経路に入れなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「読み上げの詳しさ」 |
| 区域名の逆引き手順を崩すと、引き当てを外して地図と読み上げの区域が食い違う、または県名捨て判定を外して県名と区域名が重複して聞こえる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「地域名の粒度」 |
| 階級ごとの県名まとめ判定を差分後の区域で数えると、続報で県の震度を実際より低く伝える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「地域名の粒度」 |
| 「震度5弱以上・未入電」を断定形にすると実際より強い揺れの可能性を隠し、区域名に丸めると観測値のある電文と矛盾して聞こえる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「地域名の粒度」 |
| 地域名がゼロ件のときの最大震度文で、震度不明を確かめずに埋めると助詞だけの壊れた文になる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「地域名の粒度」（地域名を1件も作れなかったときの扱い） |
| 読み上げ地域名の並び順（気象庁標準順・上限で切る選抜だけは震源距離順）を崩すと、震源を持たない電文で位置不明点からの距離を測る事故になる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「地域名の並び順」 |
| 津波 TTS の区域順とカード表示順が食い違うと、追従スクロールが往復する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「津波の区域の並び順」 |
| 新規／更新判定を波高の有無でなく名前の既知性で行うと、初出を「更新」と誤って伝える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「新規と更新を言い分ける」 |
| 観測点の列挙で地点を見出しより先に並べると、列挙が長くなるほど何の話か分からなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「観測情報は「予告型」で読む」 |
| 第1波の初出を地点句へ織り込まず、訂正も専用文に分けないと、同一報の訂正が既読のまま声にならなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「第1波（到達時刻と押し引き）」「更新の着点は「へ」」 |
| 観測点 4 群（波高更新 → 警報相当 → 到達確認 → 欠測）の「また、」接続順を崩すと、話題の境目が耳で追えなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「話題が変わるところは「また、」で継ぐ」 |
| 外した地点数の句を述語に貼り付けると、対象外の地点が「更新された」と誤って聞こえる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「観測点は「選抜」と「並び」を分ける」 |
| 区域名と波高の文を分けると二重読みで警報の読み上げが伸び、優先度の低い電文の割り込みで避難指示が途中で切られる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「区域名は 1 回だけ。等級ごとに「区域と波高」を 1 文で言い切る」 |
| 地域名列挙の区切り記号・助詞位置を崩すと、名前が一続きに聞こえる、または助詞だけが読点に挟まれ発話が途切れる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「特殊な扱い」 |
| 地震の続報を全文でなく差分で読む条件を崩すと、同じ内容を繰り返す、または規模・津波区分の更新を伝え損なう | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 続報の初出区域と震度上昇区域の群分け・「最大」を冠す判定を崩すと、震度が上がった区域が初出に見える、または最大震度が声から消える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| その地震で最初に届く確定情報だけ地域を通しで読む切替を崩すと、確定した観測がまとめて伝わらない、または全区域を毎回読み上げる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 変化の無い続報を名乗りだけで終わらせない扱いを崩すと、「更新されました」だけで内容が伝わらない、または観測点未変化の続報に誤って「追加されました」と言う | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 地震情報の既読を「声になった分」で進める判定を崩すと、割り込みで鳴らなかった地域が二度と読まれない、または続報を先頭から読み直す | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「既読になるのは「声になった分」だけ」「続報は差分だけ読む」 |
| 上限で省いた「ほか○地域」も既読へ含める扱いを崩すと、次報で「新たに」付きの誤読が起き、地域が増えたように聞こえる（長周期は差分を持たないので対象外） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 震度速報を震源要素・津波区分の比較に使うと、震源情報からの変化を誤検出し続報のたびに「調査中です」と言い出す | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| まだ声にしていない震源要素が残る続報を差分にすると、その要素はその地震の続報が続く限り二度と声にならない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 読む条件（声にしうる事実か）と待つ条件を別の述語で判定すると、記録される機会の無い事実を待ち続けその地震だけ永久に全文読みへ戻る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 階級の打ち切り（階数・下限震度）を差分後の並びで数えると、上位が据え置きの続報で下位が繰り上がり普段は読まない震度まで読み始める | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「続報は差分だけ読む」 |
| 続報判定キーを直近 1 件しか保持しないと、種別を跨ぐ報が交互に届いたとき誤って初報として読む | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「特殊な扱い」 |
| ウィンドウタイトルの震度更新判定を「初報かどうか」で行うと、種別ごとに初報が立つため歯止めが効かず震度が消える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §5「タイトル表」 |
| 警報／特別警報の 2 段階を音声区別にも適用すると、気象庁が使わない「特別警報」の呼称を読み上げてしまう | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「レベル判定」 |
| 分布図の初報／続報判定を「直前の 1 通との比較」に差し替えると、地震が連続した際に同じ地震の続報を別地震と誤判定する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「推計震度分布図は地震情報の音を借りる」 |
| 震度が取れない報で長周期階級を読む、または単独点処理の理由づけを他の条件に流用すると、矛盾した発話や誤った理由説明になる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「特殊な扱い」 |
| 津波の失効時刻を等級を名乗る 2 つの文（発表文・降格文）の片方にしか足さないと、気象庁が期限を載せる 2 通りがそれぞれ別の文へ流れるため、その経路の電文では一度も声にならない（型検査・ユニットテスト・テストボタンのいずれも捕まえない） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「津波の失効時刻を語るとき」 |
| 失効時刻の「同じ日か」を端末のタイムゾーンで判定すると、日本時間の深夜をまたぐ組み合わせで日本国外の端末だけ答えが反転する（読み上げに余分な日付が付くか、必要な日付が落ちる）。**テストはタイムゾーンを日本時間に固定して走るのでこの経路は再現できない** | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「津波の失効時刻を語るとき」 |
| 気象庁の文を差し込む 5 箇所で句点補完・文末記号集合を個別に持つと、間が消える、または既読単位が誤って融合する | [`tts-sentence-inventory.md`](../../docs/spec/tts-sentence-inventory.md) §4-8「電文の文を読む箇所で、末尾の句点の扱いが揃っていない」 |

## 読み上げ: 音声合成（読み仮名・チャンク・接続先）

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 日付・時刻の読み替えを辞書側へ足すと、期間表現との曖昧さで誤読が再燃する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「日付・時刻・分の読み」 |
| アプリが組む文で値と述語が 1 句にまとまると、値の在り処が抑揚から読み取れなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「読み上げ文の骨格を割る」 |
| 読み仮名辞書へ標準的な読みまで入れると、その語だけ前後と分けて合成する経路が増え間の挿入も増える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「何を収録するか」 |
| 震度観測点名の辞書キーを部分一致のままにすると、長い地名を語中で切ってしまう（衝突しうる面は 5 つ） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「震度観測点名の読み」 |
| 潮位観測点名（沖合）の距離表記を全数固定しないと覆っていない桁の崩れが検出をすり抜け、辞書エントリの取得に失敗すると識別英字付きの点が全数誤読へ戻る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「潮位観測点名の読み」 |
| 観測点名を市町村境界で句割りしないと、長い観測点名がひと息の不自然な抑揚になる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「観測点名の句割り」 |
| 区域名・津波予報区の句割りは 1 句のまま残す例外があり、核はエンジンの推測に任せず実測を写して手書き辞書へ入れる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「区域名・津波予報区の句割り」 |
| エンジンが置く核のずれは誤読ではないため、誤読突き合わせにも句割り判定にも掛からず、UniDic 突き合わせでしか見つからない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「エンジンが置く核が外れているとき」 |
| 震央地名の句割り・核決定の 3 段基準を崩すと、地名の途中で不自然に句が割れる、または末尾核近似でアクセントが外れる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「震央地名の句割り」 |
| チャンク末尾の句読点に間を足す入口（4 箇所）を 1 つでも渡し忘れると、地名を読点で並べても間が入らず一続きに聞こえる。同じ句を作りうる入口どうしは必ず同じ値を渡す | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「チャンク末尾の句読点には間を足す」 |
| 合成した音のキャッシュキーが足りないと誤った声・間で鳴り、辞書入れ替え中の書き込み競合はそのチャンクだけ誤読を固定化する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「合成した音は控える」 |
| 合成待ちの予算は発話中に鳴った時間を消費に数えないこと。誤って数えると長い発話の後半が丸ごと無音になる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「鳴っている間の合成待ちも数えない」 |
| 辞書分割で落ちた句読点・空白を埋め戻さないと名前が読点なしで一続きに聞こえ、mora_data が間を返さない分岐を欠くと警告も出さずその症状へ戻る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「分割で落ちた句読点・空白を戻す」 |
| 辞書キー直後の助詞をアクセント句へ取り込む処理が例外で失敗したときにチャンクを落とすと、そのチャンクが無音で消える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「助詞は辞書の読みへ取り込む」 |
| EEW 読み上げの継続判定（shouldStillPlay）を誤報取消以外（自動解除・値の引き下げ）でも止めると、正当な発話が途中で切れる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「鳴らす直前の見直し」・§6「第 2 フェーズ（予想値） — 安定待ち」 |
| VOICEVOXへの通信が通す前置き（デバウンス・URL検分・末尾スラッシュ正規化）のいずれかを欠くと、誤接続・誤診断・音声合成の無音化のいずれかが起きる（適用範囲は機構ごとに異なる） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「接続先の確認」 |
| 設定の窓の試聴文を実運用と別に書くと、文型変更時に試聴だけ古い形で残る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §3「試聴で読ませる文」 |
| 先行合成（prewarmVoicevox）が進行中の読み上げを止める、または使用予定のものを打ち切ると、鳴っている音が途切れるか、後から始まった読み上げが先行合成を横取りする | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「間を合成の時間に充てる（先行合成）」 |
| 切り出し語（warmFixedPhrases）の作り置きが応答を待つ・まとめて投げる・辞書を待たずに焼くのいずれかになると、EEW が軒並み無音になる、合成が渋滞する、または辞書を当てていない音が居座る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「間が無い経路には作り置きを用意する（切り出し語）」・§3「接続先の確認」 |
| リプレイの投機合成（speechPrefetch）は1件ごとに上限を張らないと無応答の1件で投機が丸ごと停止し、上限の持ち手をバッチ単位にすると無関係なチャンクまで打ち切られ、続けて焼けなくてもバッチを降りなければ全件が順に上限まで待たされる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「これから来る電文は先に焼いておく（リプレイの投機）」 |
| 間を置く読み上げの予約（scheduleSpeech）を画面終了・リプレイ開始で取り消し忘れると、リセット済みの状態へ古い予約が待ち合わせを経ずに割り込む（記録も残らない） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「間を置く読み上げの予約は追跡する」 |

## 読み上げ: 順番と割り込み

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 読み上げの優先順位（EEW ＞ 津波の等級発表・南海トラフ ＞ 地震情報・長周期・津波の観測情報の順）を崩すと、優先すべき情報が後回しになる、または同格の情報が競合する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げの優先順位」 |
| EEW 読み上げの直列化（全 EEW で 1 本のチェーン）を崩すと、複数の EEW の発話が互いを打ち切り合い、どちらも尻切れになる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げの優先順位」 |
| 震源の言い直しの予約管理（key ごと 1 件、発話直前に最新の電文から決め直す）を崩すと、同じ震源更新の文言が積み上がる、または待っている間に差し替わった推定を声にする | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「震源の言い直し」 |
| 予報から警報へ上がったときの伝え方（進み具合で 3 通り）を崩すと、区分の告知が重複する、または同じ文言を重ねる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「予報から警報へ上がったとき」 |
| 第 1 フェーズの進み具合（「いま鳴っているか」）をリプレイの復元で埋めると、鳴っていない音を止めて言い直す形になり、窓の手前で名乗った震源をもう一度名乗る（録画では区間の境目で重なる） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「予報から警報へ上がったとき」 |
| 「まだ生きているか」の印（発表中の電文・誤報取消）を読み上げ設定の中だけで書くと、消す側は外にあるため片方向にしか動かず、後から読み上げを有効にしたときに発話を黙らせる向きの食い違いが残る（リプレイの復元でも同じ印を埋める） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「「まだ生きているか」の印は、読み上げ設定と独立に持つ」 |
| 解除で捨てる記憶の顔ぶれをライブと復元で別々に並べると、記憶を 1 つ足すたびに片方へ書き忘れ、取り消された緊急地震速報が「いま発表中のもの」の帳面に居座る（本物が全部解除されてもタイトルが戻らず既定タブへも帰らない） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「「まだ生きているか」の印は、読み上げ設定と独立に持つ」 |
| 言い直しを前の発話を待たずに投入すると、待ち行列にいた別の EEW の予約が「前が止まったこと」で解放され、始まったばかりのその言い直しが後ろから消される | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「予報から警報へ上がったとき」 |
| 予想値の引き上げが進行中のときに区分の言い直しで割り込むと、数秒ごとに書き換わるたびに切られて予想値が最後まで読み終わらない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「予報から警報へ上がったとき」 |
| EEW 読み上げ第 2 フェーズの安定待ち（震度・階級を独立に確定させ、跳躍幅で待ち時間を可変にする仕組み）を崩すと、確定前の値を読む、または確定後の値が反映されない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「第 2 フェーズ（予想値） — 安定待ち」 |
| 「何も切らない」層（解説情報）が待ちきれなくても割り込まない規約を崩すと、優先度の低い情報が上位を追い出す | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「割り込みを許す条件」 |
| 内容が重ならない同格の相互譲り（`MUTUAL_YIELD_TOPICS`）を崩すと、同格の情報同士が互いを切り合い、どちらも最後まで伝わらない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「内容が重ならない同格は互いに待つ（相互譲り）」 |
| 警報の対象地方を予想値の前に伝える仕組み（第 1.5 フェーズ、電文の全地方 − 声にした地方で読む）を崩すと、地方の告知漏れ・重複が起きる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「警報の対象地方を、予想値の前に伝える」 |
| 気象庁が書いた文を電文本体とは別の発話で最下位の層に読む仕組み（既読の鍵・定型文の抑制）を崩すと、同じ内容を繰り返す、または一度も読まれない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「気象庁が書いた文は最下位の層で読む」 |
| 到来順を守る取り下げ判定（優先度・主題・連番）を崩すと、順番どおり待っていた読み上げが誤って取り下げられる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「到来順を守る」 |
| 理由不明タイマー（3 秒）が張られている間に非 EEW の読み上げを到来順の取り下げ判定へ通すと、その電文は一言も鳴らずに消える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「第 2 フェーズ（予想値） — 安定待ち」 |
| 「予想震度なし」への訂正判定を「一度でも確定したか」で行うと、気象庁が取り下げた予想震度が確定値として残り続ける | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「第 2 フェーズ（予想値） — 安定待ち」 |
| 合成が 1 チャンクも成功しなかったときに `SpeechOutcome.spoke` を見ずに既読を進めると、1 音も出ていないのに既読が進み、その電文について以後同じ内容が二度と声にならない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「第 2 フェーズ（予想値） — 安定待ち」・§6「警報の対象地方を、予想値の前に伝える」 |
| 鳴っている途中で降りた発話の既読を、句ごとではなくまとめて戻すと同じ予想震度を二度読み、まとめて残すと降りたせいで鳴らなかった階級が一度も声にならない（判定は `SpeechOutcome.spokenChunks`。区分の告知も同じ粒度で見る） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「鳴っている間に上がったら、その先は鳴らさない」 |
| 誤報取消の既読巻き戻し判定は書き込む直前の状態と発話中のフラグを併せて見る二重チェックだが、取消検知直後に次の報が届いて記録が消える特定の到着順だけは塞ぎきれず、テストでも再現できていない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「警報の対象地方を、予想値の前に伝える」 |
| 格上げ前置きの記録を書き込んだ後、`return`（`onSettled` の登録）に到達するまでの間に例外を投げうる処理を挟むと、以後その EEW の格上げが二度と声にならない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「警報の対象地方を、予想値の前に伝える」 |
| 対象地方の既読（`spokenEEWRegionsRef`）をリプレイの復元列に含め忘れると、その EEW について他は何も声にしないのに地方だけが鳴る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「警報の対象地方を、予想値の前に伝える」 |
| `EEW_SPEECH_CHAIN_MAX_WAIT_MS` が無いと、応答の無い VOICEVOX への合成要求を待ち続け、後続の EEW が永久に読まれなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げの優先順位」 |
| 既読の震度を階級の数値だけで覚えると、「震度N」→「震度N以上」の変化を据え置きと誤認して黙る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げの優先順位」 |
| 予想長周期階級 0 を言うかの判定（`statesEewLpgmClassZero`）を、第 2 フェーズ・受信のときの呼び出し・初報の文のどこかで別に書くと、言わない報（予想震度なし・階級を読まない設定）でも予約が積まれ、その間ほかの読み上げが止まる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「安定待ちを経由しない特別扱い」 |
| 上限に達して割り込んだときに記録を残さないと、優先度の高い読み上げを消した事実が事後に追えなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「内容が重ならない同格は互いに待つ（相互譲り）」 |
| 安定待ちサイクルを確定させずに捨てる場所を足すとき、確定経路（`clearScaleStability`）を張り直し忘れると、そのイベントの予想震度が無言のまま終わる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「第 2 フェーズ（予想値） — 安定待ち」 |
| 合成要求そのものにタイムアウトが無いと、応答が返らないまま宙に浮き、1 音も出ていないのに既読が進む | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「音が出ている間は、待ちを計時しない」 |
| 予算超過時に `abort()` で 1 チャンクだけ諦めるつもりが、発話全体で共有される`AbortSignal` のため残り全チャンクが要求前に即死する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「音が出ている間は、待ちを計時しない」 |
| 記録に出す予算の値を発話開始時に確定させずモジュールの旗から発火時に読み直すと、「録画中に後半が無音になった」原因を追うための記録自体が事実と食い違う | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「音が出ている間は、待ちを計時しない」 |
| 事象識別子を持たない電文で既読の鍵生成が黙って旧来方式（文のみ）へフォールバックすると、別事象の同一文が二度と読まれなくなる兆候が主題末尾の表記からしか分からない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「気象庁が書いた文は最下位の層で読む」 |
| 取り下げが決まった予約で `onWithdrawn` の呼び出しを忘れると、推計震度分布図を開く最後の機会が記録も残らないまま失われる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「到来順を守る」 |
| 主題ごとの到来順記憶が上限（200 件）に達して全件破棄されると、その回だけ到来順ではなく優先度の割り込み判定に頼ることになる（同時進行は数件程度のため実害は無い設計） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「到来順を守る」 |
| 定型文の抑制判定は文字列一致で行っている（固定付加文のコードでは行わない——コードの並び順がずれると別の文を落とす、より重い失敗になるため）。そのぶん文面が一字変わると抑止が効かなくなり、症状は「読まれるようになる」だけで異常に見えない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「気象庁が書いた文は最下位の層で読む」 |
| 気象庁が書いた文の既読記憶が上限（`TELEGRAM_TEXT_SPOKEN_MAX` = 2000 件）に達して破棄されると、その回だけ既読の文が読み直される | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「気象庁が書いた文は最下位の層で読む」 |

## 通知音

**音を 1 つ作り変えるときは、この節の「通知音の内容と説明文の一致」と「通知音の長さと読み上げまでの間の連動」を必ず両方見ること。** 前者は音そのもの（§2）、後者は音が終わってから声を出すまでの間（§6）で、参照先の節が違う。片方だけ直すと、説明文が実際の音とずれるか、間が音の長さと合わなくなる。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| `PLAYERS` の周波数・音数を仕様書「音の種類」表や設定の窓の説明文と食い違わせると、試聴した音と説明文の内容が一致しなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「音の種類」 |
| `COUNTDOWN_PULSES`（S波カウントダウンのパルス数）を説明文と食い違わせると、「秒が減るほど速く・多く鳴る」という説明と実際のパルス数がずれる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「発火 API」 |
| `kyoshinLevel` を気象庁の階級と1対1（10段。震度0未満だけ震度0の段へ含める）で対応させる規則を崩すと、ある震度で鳴るべき音が鳴らない、または `useKyoshinAlerts` が段の上昇で起動する更新音・タブ移動・揺れフォーカスの3つが畳んだ範囲内の悪化に対して起動しなくなる。震度0（1音）の音量の係数だけ震度1より大きいのは重なりの無い1音の音圧を実測で合わせたためで、係数の大小で段の重さを読むと崩す | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「震度更新音の段は気象庁の階級と対応させる」 |
| 上位3段（6弱・6強・7）を音数・音量ではなく音程で分ける規則、震度7だけ880Hzの外（C6/1047Hz）へ出す規則、1047Hzより上へ音域を上げない規則のいずれかを崩すと、1音の差が聞き取れず隣接段と判別できなくなる、または2度にわたって下げてきた音域を戻す意味が失われる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「震度更新音の段は気象庁の階級と対応させる」 |
| 種別ごとに個別の音量値を書く、または震度更新音で `BEEP_PATTERNS` に音量を持たせる（`BEEP_SEVERITY` と二重管理にする）と、`BASE_GAIN`×`SEVERITY` で揃えた一貫性が崩れる、またはパターン変更のたびに音量が食い違う | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「種別ごとの音量は「系統 × 深刻度」で決める」 |
| 音圧を揃えるため `BASE_GAIN` か `SEVERITY` の片方だけを動かすと、音数・重なりが違う他種別の音圧までつられて変わる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「種別ごとの音量は「系統 × 深刻度」で決める」 |
| 大津波警報の `peakAt`（0.88）を他段と揃える、または弁別を周波数だけに頼ると、大津波警報の音域が津波警報を完全に含むため聞き分けられなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「掃引の形の分け方 — 大津波警報だけ上がりっぱなし」 |
| 新しい通知音を7つのプリミティブのいずれにも属させず音色の好みだけで作ると、利用者が系統から役割を推し量れなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「系統の分け方 — 7 つのプリミティブ」 |
| 残響を「豊かにする」目的で全系統に戻すと、連続して鳴る音で尾が重なって濁る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「残響は持たない（全系統）」 |
| フィルタを `marimba`/`warningBeep` 以外にも掛けると、木の柔らかさ・連打の頭打ちという系統固有の役割の切り分けが崩れる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「系統の分け方 — 7 つのプリミティブ」 |
| `decayTone` の終端処理（0.001まで落としてから0へ切る2段階）を種別ごとに分岐させると、無音区間にティックが出る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「通知音（`alertSound`）」冒頭 |
| アタックに広帯域ノイズを戻すと、小型スピーカーで「プチ」と聞こえる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「厚みの作り方 — 1 本のオシレータでは電子音になる」 |
| `earthquakeCount` の音程の向きを動かす、またはピアノ系（地震そのものの音）を流用すると、南海トラフ臨時情報・解説情報との区別、または群発地震の最中の地震カード増加と回数更新の区別が音で付かなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §2「音の種類」 |
| 間（`ttsDelayFor`）を電文の種別で決める設計に戻す、または余白（`SPEECH_GAP_MS`）を掃引以外にも足す・掃引に足さないと、複数経路で値が食い違う、または尾を持つ音に無駄な空白ができる・掃引で声が重なって詰まる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「間の長さは音の種別で決まる」 |
| 通知音を作り変えたときに `SOUND_AUDIBLE_END_MS` を測り直さないと、音が伸びた分だけ読み上げと重なる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「間の長さは音の種別で決まる」 |
| 聞こえなくなる時刻をピーク比（相対値）で測ると、ピークの低い音ほど深く沈むまで待つ計算になり実際の聞こえる時間から大きくずれる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「聞こえなくなる時刻の測り方」 |
| 音量設計を変えたのに基準の絶対値を引き直さないと、閾値と実際の聞こえ方が合わなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「聞こえなくなる時刻の測り方」 |
| `SOUND_AUDIBLE_END_MS` に全種別を持たせない設計にすると、新しい音を追加したときの測り忘れを型検査が止められなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「実測値と経路」 |

## 自動タブ切替と画面の追従

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 自動タブ切替の 3 系統（読み上げ追従／電文の受信／保持機構）の判定順序を崩すと、想定と違う画面に切り替わる、または切り替わるべき場面で動かない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 気象庁の文を読み上げている間その表示を開く仕組み（`telegramTextFollow`）を崩すと、津波カードが誤って動く、または開いた文が意図せず閉じる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて気象庁の文を開く」 |
| 地震カードへ渡す主題（長周期の識別子）を任意の props にすると、渡し忘れても画面が動かないだけで例外もログも出ない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて気象庁の文を開く」 |
| 開く先が最後まで無かったことを記録しないと、声だけが本文を伝える状態（この機能が直した症状そのもの）が別の理由で再発しても気づけない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて気象庁の文を開く」 |
| 主題を開く側と読む側で別々に組み立てる（同じ関数を通さない）と、片方だけ書式を変えたときに黙って開かなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて気象庁の文を開く」 |
| 「畳んでいるか」を種別ごとに確かめず地震情報と長周期をまとめて扱うと、片方だけ当たっている状態に気づけない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて気象庁の文を開く」 |
| 複数の緊急地震速報が同時発表されたとき声が語っているカードを示す鍵の共有・世代トークン照合（`eewEventKey`）を崩すと、鍵がずれてカードが光らない、またはリプレイ後に別の発話の印がまだ語っている最中に消える（どちらも例外もログも出ない） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 誤報取消の予約を専用の集合で覚えないと、直前まで語っていた発話の後始末が「語ることは無い」と誤判定し、取消の読み上げを待たずに印が落ちる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 印を保つ見直し（0.5 秒）・残像（0.8 秒）・上限（60 秒）の関係を崩すと、印が段のたびに点滅する、消えなくなる、または画面へ目を移す間もなく消える | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 見直しの判定が例外を投げたときに印を落とさないと、見直しのタイマーも張り直されずその印は二度と消えない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 印を捨てる経路（誤報取消・リプレイのリセット・画面を閉じたとき）を数え上げる方式で新しい経路を見落とすと、その分だけ印が永久に残る | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 新しい読み上げフェーズを足すとき `EewPendingSpeechSources` への配線を忘れると、印が語り終わる前に消えるだけで例外もログも出ない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 区分の色（カードの枠線）が表す 3 値の相対的な軽重（予報＜警報＜特別警報）を崩すと、予報／警報／特別警報の区分が読めなくなる（具体的な 16 進色は軽重を保ったまま調整してよい） | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 1 音も鳴らなかった発話でも印を出す規約を崩すと、VOICEVOX が繋がらない端末で画面の進み方が声と食い違う | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて緊急地震速報のカードを示す」 |
| 地震カードの一覧を寄せる相手の順番（語っているカード → 取消の表示が出ているカード → 選択中のカード）を崩すと、縦長の画面で取消カードが枠の外へ押し出される、または選択中のカード自身が取り消されたとき一覧が 2 度動く。寄せる処理をカード側（`scrollIntoView`）へ戻すと、カードの頭が見切れる。取消の読み上げが語る鍵を電文から作ると、暫定 EventID の付け替えがあった地震で一覧が取消カードを見つけられず、記録も残らない | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「一覧の寄せ方」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて地震カードの一覧を寄せる」 |
| 読み上げに合わせた津波カードの追従（視野内なら動かさない・前置きの扱い）を崩すと、読んでいる箇所が画面外へ流れる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせたカードの追従」 |
| 未入電を伝えている間、地震カードの未入電地点一覧を自動で開閉する仕組みを崩すと、無関係な津波カードが動く、または開閉が正しく戻らない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせた未入電モードの自動開閉」 |
| 未入電・震度分布・長周期の 3 つの追加表示が排他であることを崩すと、開くと相手が閉じるのに戻す番が無いため、操作していないのに消えたようにしか見えない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせた未入電モードの自動開閉」 |
| 未入電の開く範囲（`unreceivedChunkRange`）を「最後のチャンクまで」と決め打つと、文の並びを変えたときに黙ってずれる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせた未入電モードの自動開閉」 |
| 未入電の食い違い記録（`mismatch` 等）を崩すと、症状が「読み上げているのに画面が動かない」だけになり表示不具合と区別できない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせた未入電モードの自動開閉」 |
| 読み上げに合わせて借りた震源のカードを見せる仕組みの範囲（`borrowedHypocenterChunkRange`）を決め打つと、文の並びを変えたときに黙ってずれる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げに合わせて借りた震源のカードを見せる」 |
| 津波カードのスクロールを動かす 3 駆動の関係を崩すと、VOICEVOX 未起動・区域コード不一致の端末でカードが動かない、または解除操作でも待たされて位置が戻らない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「スクロールの自動制御」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「追わない条件」 |
| 「寄せ先が無い」受信と「先頭へ戻す」受信を同じ値で表すと、直前の報や読み上げが合わせた位置を捨てる | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「寄せ先が無い受信」「既定の状態への復帰」 |
| 読み上げ追従の引き当て失敗を記録する条件（等級は数えない）を崩すと、診断が二度と発火しなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「対象の特定」 |
| EEW 続報の受信時要求だけを止める片方向抑制（判定 3）と、読み上げ無効端末の受信がその保持を越える規則（判定 4）を崩すと、津波を読み上げて画面を移した直後に続報で引き戻され数秒ごとに往復する、または誤報取消のオーバーレイが無関係な地震情報で消される | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 追従の最小滞留時間（`TAB_FOLLOW_MIN_DWELL_MS`）の免除判定に真偽値（`isAudioPlaying`）を使うと、猶予の長さの差で隙間ができ、正常に鳴っている短い発話の直後の追従が弾かれる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| アイドル復帰が realtime に留まるときの重み（`idleRevertPriority`）を留まる理由に合わせないと、優先度表が逆転し津波警報や別地点の揺れ検知が画面を取れなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 生の `setActiveTab` を `requestAutoTab` 以外からも呼べる状態にすると、優先度判定を通らない移動が保持を張らないまま起き、画面が奪われる、または復帰しない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 自動タブ切替の駆動源・追従印の既定値の扱い（要求側は必須・判定側だけ既定値を残す）を崩すと、EEW 発表中に画面が動かない、読み上げ中の EEW から画面を奪う、または追従印の渡し忘れでタブが動かなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 既定の状態へ戻す経路が保持を張るときの駆動源（`idleRevert`）を渡し忘れると、読み上げ追従を弾く保持になり「喋っているのに画面が動かない」が復活する | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 読み上げている間は既定の状態へ戻さない仕組み（4 経路・拾い直す 3 つの仕掛け）を崩すと、声と画面が食い違う、または未入電モードが一度も開かなくなる | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げている間は既定の状態へ戻さない」 |
| 自動復帰が無効な端末（`idleRevertSec` が 0 以下）で見送りを適用すると、既定タブへ戻る契機が 1 つも残らない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げている間は既定の状態へ戻さない」 |
| `SPEECH_STALE_MS` の安全弁が無いと、読み上げ中の扱いが真に張り付いたとき既定の状態へ戻る仕組みごと止まり、例外もログも出ない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げている間は既定の状態へ戻さない」 |
| 読み上げがある経路でのタブ移動の先出し・受信時要求への切替を崩すと、通知音が鳴っても画面が動かない、またはそのタブへ一度も移らない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 先出し後の追従呼び出し自体を省くと、近接して届いた電文どうしが互いの先出しを上書きし合い、後で声に出る側の画面が二度と戻らない | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「自動タブ切替の優先順位」 |
| 特別情報受信時のパネル一時展開・元へ戻す契機を崩すと、バナーだけが出て中身を確認する導線が無い、または展開したまま戻らない | [`architecture-spec.md`](../../docs/spec/architecture-spec.md) §4 |
| アイドル復帰が震源カタログ表示中は既定タブへ戻さない仕組みを崩すと、眺めている間に画面ごと持っていかれる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §16「眺めている間はタブを奪わない」 |

## 地震情報

| 項目 | 単一情報源となる仕様書 |
|---|---|
| `points` のバリアント差・`pref` 空の識別規則を取り違えると、経路によって観測点や区域が欠落する | [`quake-spec.md`](../../docs/spec/quake-spec.md) §4「points 構造（バリアント・経路差）」 |
| 観測点名の `＊` を外し忘れる・戻し忘れると、地図から点が消える、または電文と違う表記になる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「気象庁以外が運用する観測点（`＊`）」 |
| 固定付加文（その他）を省くと、`＊` 印の説明が画面から消え何と対比しているか分からなくなる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「固定付加文（その他）（`VarComment/Text`）はそのまま出す」 |
| 電文のコード値（都道府県・区域・市町村・観測点コード等）を名前の代わりに出す、またはカードや読み上げへ混ぜると、意味の読めない識別子が前に出る（出すのは地図の吹き出しの末尾だけ） | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「電文のコード値は読み、地図の吹き出しの末尾に添える」 |
| 震源の補助要素・`Revise` の読み取りを 1 か所（`readHypocenterAreaLabels`）に集約しないと、経路ごとに震央補助表現や続報の変化が抜け落ちる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「震源の補助要素と続報での変化は、値を文字では出さない」 |
| 震度5弱以上未入電を階級・地図・カードのどこかで一般の震度と同列に扱うと、最も強い地点や区域が画面・地図・音声のいずれかから消える | [`quake-spec.md`](../../docs/spec/quake-spec.md) §4「震度5弱以上未入電」 |
| 震度点が積めなかったことの記録条件（全滅時のみ）を誤ると、大多数が脱落し数件だけ残る形の障害に気付けない | [`quake-spec.md`](../../docs/spec/quake-spec.md) §4「地図には観測値と混ぜずに出す」内「読めなかった点は記録する」 |
| 取消の述語を種別間でそろえないと、同じ取消という事実なのに画面と読み上げ・種別ごとに言葉が食い違う | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「取消は「取り消された事実」だけを伝える」 |
| 取消電文の理由（`Body/Text`）を状態更新で移し忘れると、画面にだけ理由が出ない（型検査・他のテストは通る） | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「取消しの理由は電文にしかない」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「取消の宣言だけの本文は読まない」 |
| 緊急地震速報の精度・最大予測値変化を資料の語のまま出さないと、確度の意味や変化理由が読者に伝わらない、または誤った評価を足すことになる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「震源要素の精度」「最大予測値の変化」 |
| 市町村の震度を `points` に混在させると、カード・地図・読み上げの3種判別が一斉に狂い、未入電の意味も区別できなくなる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「市町村の震度（`Pref/Area/City`）」 |
| 受信した電文種別の見出し表記を誤ると、震源情報を受け取った事実が画面から消える、または受信通数が水増し・過小に出る | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「見出しには受け取った種別を並べる」・[`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7 の一覧「種別遷移テスト」 |
| 震度一覧の4段構成・並び順・配下描画の規則を崩すと、画面（県単位）と音声（区域単位）の粒度がずれる、または一覧が数千行に膨れて操作不能になる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「震度一覧は 4 段の入れ子」 |
| 押せる判定と寄り先の解決を別々に実装すると押せるのに動かない不具合になり、寄り上限に絶対上限のクランプを誤って適用すると押した観測点が区域塗りに隠れて選べなくなる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「一覧の行をクリックしたときの寄り先」・[`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「寄り上限と閾値の単位」 |
| 観測点の市町村・区域の紐付けを電文の並び順読み取り以外に頼ると、同名市町村での観測点混在や未入電の印が親の県まで届かない食い違いが起きる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「観測点がどの市町村・区域に属するか」 |
| テストデータの静的 import を1つでも戻すとコード分割が無言で解除され、Service Worker のプリキャッシュ上限超過が本番ビルドでしか発覚しない | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「台本は押されてから読む」 |
| 訓練・試験報の印付け（`Control/Status`）は2点守ること——①`EEWAlert.test` 抑制フラグと混同しない（混同すると試験報が画面に出なくなる）②全パース関数に通す（漏らすと訓練報の印が電文種別によって出たり出なかったりする） | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「電文の運用種別」 |
| 震源要素不明の電文を捨てる、またはセンチネル値（`-200`）の判定を `Number.isFinite` 等で代用すると、震度速報並みの重要情報が丸ごと消える | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「震源要素不明の電文は捨てない」 |
| 深さ不明のセンチネル `-1` を `0`（ごく浅い）と混同する、または `hasDepth` を通さず数値として使うと、深さ不明の地震が最も浅い地震として扱われる （予報円は描かない・地図は地表へ置く） | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「深さだけが判らない電文」・[`eew-spec.md`](../../docs/spec/eew-spec.md) §6・[`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §16 |
| `LgCategory` の分類番号をそのまま表示する、または値2・4の意味を書かないと、揺れは強くないのに高層階が大きく揺れた地域があるという事実が伝わらない | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「長周期地震動の「観測情報の種類」は意味を出す」 |
| 周期帯（`PeriodicBand`）の対応付けを文書順で決め打つと帯欠落の電文で以後すべてがずれる、階級0を落とすと短周期しか観測していないように誤読される | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「長周期地震動は「どの周期帯が強く出たか」まで出す」 |
| 長周期地震動の階級と震度は片方だけを拾わないこと——片方だけ拾うと、揺れが小さいのに高層階が大きく揺れた地域を見逃す | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「階級と震度は並べて出す」 |
| 長周期地震動の一覧の3段構成（県→区域→観測点、市町村段は混ぜない）を崩すと、親子関係を取り違え観測点の所属区域が消える | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「長周期地震動の一覧は 3 段の入れ子」 |
| 長周期地震動のテストデータを手組みすると、新項目を足しても実機で一度も画面に出ないまま気づけない | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「テストボタンのデータは実電文から作る」 |
| 推計震度分布図（BUFR二進電文）の読み取り・地震カードとの結び付け（発現時刻・300km判定）・初報続報の言い分け（`isNewEstimatedIntensity`）・古い報の排除規則のいずれかを崩すと、分布が別地震のものへ混ざる、または初報続報を正しく言い分けられない | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「推計震度分布図」・§9「震度分布モード」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「推計震度分布図は地震情報の音を借りる」・[`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §19 |
| 地震回数に関する情報（VXSE60）で空欄と0回を混同すると、群発の最中に地震は起きていないと伝わる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「地震回数に関する情報」 |
| 地震・津波に関するお知らせ（VZSE40）の音・読み上げを既定で有効にする・最下位の層より上で読む・相互譲りから外すと、運用連絡が本物の地震・津波・EEW の読み上げを塞ぐ（音と読み上げは設定で有効にしたときだけ） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「扱う電文種別」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「地震・津波に関するお知らせは設定で有効にしたときだけ読む」 |
| 扱わない電文種別（VXSE56）の判断理由・配信終了種別の棚卸し範囲を書き残さないと、次の棚卸しで同じ調査をやり直すか配信終了種別を存在しないと誤認する | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「扱う電文種別」 |
| 利用者へ出す語を気象庁の公式表現から理由なく外すと、短縮が意味を狭めて誤読を招く（「警報等」を「津波警報」と書くと大津波警報の地震が一段軽く見える） | [`quake-spec.md`](../../docs/spec/quake-spec.md) §3「「警報等」を「津波警報」と書かない」・§8「気象庁の表現からわざと外している語」 |
| 地震の同一性判定（`eventKey`）を経路ごとに再実装すると、同じ地震が別カードへ割れるか取消済みの報が復活する | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.1「同一イベントの判定」・§6.2「取消のマッチング」 |
| 続報マージで震源・震度・付加文の引き継ぎ規則を取り違えると、確定した震源が消える／取り下げた値を出し続ける／確定した安全判断が定型文で巻き戻る | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.4「置換時の項目の引き継ぎ」 |
| 取消電文の前後判定（`isRetractedQuakeReport`）を誤ると、取り下げ済みの報を復活させる／別地震の報を握りつぶす | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.2「取消の後に届いた報」 |
| 据え置き判定を副作用側（音・読み上げ・タイトル・タブ切替・カードの選択・震度分布モードのクローズ）へ反映し損なうと、画面は据え置いたままなのに音や声だけが誤った内容を伝える、または据え置かれた電文で選択や分布表示が奪われる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.3「据え置いた電文は、音・読み上げ・タイトル・タブ移動・選択・分布モードのクローズも起こさない」 |
| 震度一覧の行の並びを電文の到着順に依存させると、気象庁側の電文書式が変わるだけで画面の並びが無言で動く | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「震度一覧は 4 段の入れ子」内「行の並び」 |
| 続報の更新印（欄・行）の色分け・比較対象・自動展開の規則を取り違えると、動いていない箇所が光る／本当に動いた箇所が埋もれる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「カードの更新の印」・[`eew-spec.md`](../../docs/spec/eew-spec.md) §4「続報で動いた欄を示す（減衰）」 |
| 震度の区域集約閾値を自動フィットの寄り上限と別の値に固定すると、大きな画面でフィットしても震度塗りが出ない | [`quake-spec.md`](../../docs/spec/quake-spec.md) §7.1「ズームによる集約の切替」 |
| 震度の面・区域塗り・観測点ドットの排他条件を1つでも変えると、発表値と推定値が同じ画面に混ざって見分けが付かなくなる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §9「QuakeIntensitySurfaceGL」 |
| 観測点0件の電文（震度速報等）でズームに応じて個別表示へ切り替えると、意味の無い単一ドット表示になる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §7「地図描画の切替」 |
| VXSE61の座標をtype属性ではなく桁数で判定すると、度単位の丸め値を震源座標に採用してしまい座標も深さもずれる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §3「震源要素更新（VXSE61）の座標」 |
| 規模が数値にならない電文の説明（`description`）を数値の有無だけで不明と出すと、M8超えの最大級の地震ほど画面が不明の一語になる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「震度一覧は 4 段の入れ子」内「値が不明なときの表示」 |
| 訂正報の訂正内容を固定付加文（`VarComment/Code`）以外から推測すると、震度だけの訂正を表すコードは無いのに震源訂正と取り違える | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.2「取消のマッチング」内「訂正の扱い」 |
| 震度速報（VXSE51）の規模を `0` にすると、`hasMagnitude(0)` が真になり実測値のように表示・読み上げされる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「震源未確定（震度速報）の扱い」 |
| 震源・津波区分を津波電文から借りる条件（`eventId` 一致限定・統合の後に置く・借り物の印を値ごとに持つ）を崩すと、別地震の震源が混ざるか印が消えて追随しなくなる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §5「震源・津波区分を津波電文から借りる」・§8「借りた値の出どころ」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「津波が原因地震の震源を語るとき」・§6「読み上げに合わせて借りた震源のカードを見せる」 |
| 遠地地震の識別（VXSE53・`Head/Title`）を誤ると、震度を伴わない電文が国内地震と同じ扱いになり震度欄が壊れる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §3「遠地地震に関する情報」 |
| 付加文の固定（区分が変わらない限り動かない）と自由（続報で動く）を取り違えると、区分が変わっていないのに文面が続報で書き換わる、または本文が更新されているのに画面が古いままになる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §3「津波の付加文（固定と自由の 2 種類）」 |

## 津波

**読み上げ文の組み立て方は上記「読み上げ」の 3 節にある。** この節にあるのは、そこから参照される並び順・既読の管理・電文の判定。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 津波の観測点の並び順（カードと共有。**選抜と並びは別物**） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「観測点の並び順」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「観測点は「選抜」と「並び」を分ける」 |
| 並べ替えに渡す材料はカードと同じものにする | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「並べ替えに渡す材料はカードと同じものにする」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「津波の区域の並び順」 |
| 読み上げた観測点の記憶を画面用と分ける（上限で読まなかった到達確認を既読にしない） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「読み上げた観測点の記憶は画面用と分ける」 |
| 波高の表示文字列（`description`）は半角へ揃える | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §6「波高の表示文字列は半角へ揃える」 |
| 観測波高の深刻さの順（「◯m 以上」は値より優先） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §6「観測波高の「以上」」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「観測点は「選抜」と「並び」を分ける」 |
| 観測波高・最大波時刻が**動いたか**を等値比較で見ない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §6「観測波高の「以上」」・[`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「どの項目が動いたかを文字色で示す」・[`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「変化を伝えない続報」 |
| 観測点の行でどの項目が動いたかを文字色で示す | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「どの項目が動いたかを文字色で示す」 |
| 数値にならない予想波高（「巨大」「高い」）を落とさない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「数値にならない予想波高」 |
| 「Ｍ８を超える巨大地震」を規模不明と区別する | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 原因地震（`Earthquake`）は全件読む（同一性の判定は 1 件目だけ） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 沖合から沿岸への推定（`Estimation`）を実測・発表値と混ぜない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」・[`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「沿岸への推定の行」 |
| 「観測中」のまま津波警報相当を落とさない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §6「「観測中」のまま津波警報相当」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「「観測中」のまま津波警報相当は別の文で伝える」 |
| 「重要」（`MaxHeight/Condition`）の基準は電文で 4 通り違う | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §6「「重要」の基準は電文で違う」・[`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 区域の到達状況（`Forecast/Item/FirstHeight`）の 4 形態 | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「区域の到達状況」 |
| 予想波高「あり／なし」の判定（`hasForecastHeight`） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「予想波高の有無」 |
| 区域を読めなかった結果を「正式解除」と取り違えない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 津波電文の `Body/Text` は発表報でも読む | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 津波の等級は `Kind/Code` で読む | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 津波の解除経路（`cancelReason` 3 種・バリアント差） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §3「3 経路の解除フロー」 |
| 有効期限は報ではなく津波に付く事実として扱う（引き継ぎを 1 つ漏らすと失効しない津波ができる） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §3「有効期限は報ではなく津波に付く」 |
| 失効時刻を画面へ出すときの語（「失効」の 2 文字）・日付を常に添えること・語順を「更新」と揃えることを崩すと、右上のブロックが広がって見出しが折り返す、または行ごとに桁数が変わる | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「失効時刻はバナーの右上に出す」 |
| 区域単位で等級が動いた報は、動いた区域だけを伝える | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「区域単位で等級が動いた報」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「区域単位で等級が動いた報は、動いた区域だけを読む」 |
| 解除された区域（`Kind/Code` が 00/50/60）を捨てずに分けて持つ | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「解除された区域」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「区域単位で等級が動いた報は、動いた区域だけを読む」 |
| 等級を伝えていない電文（区域が空の続報）は観測点更新として扱う | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「等級を伝えていない電文」 |
| 等級も観測波高も動かない続報でも黙らない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「変化を伝えない続報」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「読み上げの優先順位」 |
| 観測状態（欠測・微弱・観測中・重要・上昇中）の見分けは `isObservationMissing` に集約する | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §6「観測状態」 |
| 欠測は到達確認と別の文・別の既読で読む | [`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §4「欠測は到達確認と別の文で伝える」 |
| 波高がまだ出ていない観測点（「観測中」）も地図に出す | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §8「到達確認マーカー」・[`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「津波追従の目標範囲」 |
| 観測棒に白フチと影を持たせる（丸バッジの家族へ揃える） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §8「白フチと影」 |
| 観測点の行・区域名をクリックしたときの可否・当たり判定・寄り先・着地の深さ | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「観測点の行・区域名をクリックしたときの寄り先」 |
| 震源の位置要素（`Hypocenter/Area`）は 1 箇所で読む | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 地震発現時刻（`ArrivalTime`）と地震発生時刻（`OriginTime`）を混ぜない | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「DMDATA XML」 |
| 最大波の観測時刻（`MaxHeight/DateTime`）は語を冠して出す | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「最大波の観測時刻」 |
| 実測の到達時刻を出せていない行に予報側の到達予想を添える（条件は生の値でなく整形の結果で見る） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「実測の到達時刻が無い行に添える到達予想」 |
| 観測点の座標表（`tsunami-obs-coords.json`）は生成物 | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §6「津波観測点の座標」 |
| 津波の解除で観測点の記憶を落とす条件 | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §5「解除電文と表示中の津波の照合」・[`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §10「読み上げた観測点の記憶は画面用と分ける」 |
| 気象庁が書いた文（本文・付加文 2 種）はバナーの行動指示の行から開く | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「気象庁が書いた文は、行動指示の行から開く」 |
| 続報のマージで前報から引き継ぐもの（規則は `mergeTsunamiReports` の 1 箇所） | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §5「続報で前報から引き継ぐもの」 |
| 津波の同一性を `isSameTsunamiEvent` 以外で書き直す（EventID の文字列一致など）と、原因地震の追加で `A` → `A B` と番号が伸びたとき同じ津波を別物と取り違え、カードが入れ替わって観測点・期限を落とす | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §3「同じ津波の判定」 |
| 報を 1 通当てた結果（状態更新・DMDSS 版の失効予約・受信処理）を `stepTsunamiState` 以外で決めると、画面と失効予約の期限が食い違い、注意報の発表中に「失効」しうる | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §3「報を 1 通当てた結果は 1 箇所で決める」 |

## 緊急地震速報（EEW）

**EEW を地図にどう描くかは下記「地図」の 2 節にある**（震源の点滅と深さへの配置・予想の区域塗りとカメラ追従対象の一致・追従の引き上限）。この節にあるのは電文の解釈と計算。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| EEW だけは地震の時刻に発生時刻（`OriginTime`）を出す規則を崩すと、他の種別と時刻の基準が食い違う、または `originTime` を読む場所（予報円・S 波到達・自動解除等）の一部が古い値のまま残る | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「地震の時刻は発生時刻を出す」 |
| 起動時に発表中の EEW を復元する仕組み（DMDSS 版限定・1 地震 1 通・`silent` で音を止める）を崩すと、起動直後に驚かせる音が鳴る、または開発モードでだけ画面要求が出なくなる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §2「起動時に、発表中のものを復元する」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6「起動時の復元が出す要求」 |
| EEW 続報の古い報を採らない判定（入口で報番号台帳により棄却）を崩すと、画面と音声が食い違う、または処理順の入れ替わりで退行する | [`eew-spec.md`](../../docs/spec/eew-spec.md) §10「古い報で退行させない」 |
| EEW の区分呼称（予報級／警報級）の対応表を崩すと、表示・ウィンドウタイトルの呼び方が食い違う（読み上げの呼称は別に持つ） | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「電文の名称と表示・読み上げ」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6 |
| 種別ヘッダーの報番号表示を地震情報カードと共有する規則を崩すと、片方だけ見た目が変わる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「報番号の見た目は地震情報カードと共有する」 |
| 上限を定めない予想震度・長周期階級（`over`/`99`）の扱いを崩すと、長周期の予測が NaN で消える、または上限が定まらない変化が安定待ち・既読判定で無音のまま消える | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §8・[`eew-spec.md`](../../docs/spec/eew-spec.md) §4「上限を定めない予想の扱い」・[`audio-tts-spec.md`](../../docs/spec/audio-tts-spec.md) §6 |
| 仮の震源（仮定震源要素・「非常に強い揺れを検知」の報）で連動して隠す・採らない箇所の一覧を崩すと、震度 3 以上の予想が「予想震度なし」に落ちる、または観測点の位置を震源として予報円・M・深さを出す | [`eew-spec.md`](../../docs/spec/eew-spec.md) §5 |
| EEW P/S 波予報円・仮定震源要素の連動箇所を崩すと、地図の描画が電文の内容と食い違う | [`eew-spec.md`](../../docs/spec/eew-spec.md) §5-§6 |
| 走時を JMA2001 走時表から引く仕組み（自前速度モデル禁止・二分探索の逆引き・バンドル分離）を崩すと、電文が名乗る時刻と画面の波面が食い違う、またはビルドが precache 上限超過で落ちる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §6「走時は JMA2001 走時表から引く」・[`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §6「JMA2001 走時表」 |
| 距離計算を球で解く仕組み（`EARTH_RADIUS_KM` 一本化・`ringVertex` 共有）を崩すと、深発・遠距離で誤差が生じる、または予報円と外接矩形がずれる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §6 |
| 特定地点・区域への到達予想を気象庁の発表値のまま伝える規約（自前計算は発行済みトークンの端末限定）を崩すと、気象業務法の許可が要りうる形になる（当てはまりは未確認） | [`eew-spec.md`](../../docs/spec/eew-spec.md) §6「特定地点への到達予想は気象庁の発表値を伝える」・[`forecast-computation-audit.md`](../../docs/forecast-computation-audit.md) |
| 警報の対象地方（`Head/Headline/Information` の地方予報区ブロック）を読む規則を崩すと、続報の差分取りこぼしで地方が欠落する | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「警報の対象地方」 |
| EEW の固定付加文を画面にだけ出し読み上げには載せない規約を崩すと、秒を争う震度・地域の告知が遅れる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「固定付加文」 |
| EEW の警報級判定を `isEewWarningKindCode` の 1 箇所に一本化する規則を崩すと、電文解釈・地図の塗り分け・県名の振り分けで判定がずれる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「区域の種別コード」 |
| 区域の主要動到達判定を `isEewAreaArrived` で行う規則を崩すと、standard 版で到達済みの区域が画面から黙って消える | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「主要動が届いたかどうか」 |
| 「主要動の到達（予測）」欄の並び順・各行の表示規則（件数で打ち切らない・PLUM 法は末尾・残り秒数表示）を崩すと、到達情報が欠落する、または PLUM 法の過去時刻を「まもなく」と誤読する | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「到達予測時刻は種別によって意味が変わる」 |
| 「警報:」「予報:」欄の出し方（重複排除・件数で打ち切らない）を崩すと、警報の地域が予報と重なって見える、または情報が「…」に隠れる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「「警報:」「予報:」欄の出し方」 |
| EEW レベル判定（特別警報の条件・長周期の DMDATA 限定）を崩すと、特別警報相当の判定を誤る | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4 |
| 特別警報の下げ止まり（`everSpecialWarning`・`computeDisplayEEWLevel`）を崩す、または引き継ぐ経路（ライブ受信・起動時復元・リプレイの初期状態復元・リプレイ復元時の `activeEEWLevelsRef`）を 1 つでも欠くと、震度が下がった続報でカード・タイトル・通知の特別警報表示が消えるか、逆に格上げ音を鳴らし直す。予報→警報の格上げには適用しないこと（気象庁の運用上そもそも起きないため） | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「特別警報の下げ止まり」 |
| EEW の取消の文字（「取消」・定型文・理由の塊）を幕の縦の真ん中に固定する、または見張り（枠のスクロール・枠とカードと塊の寸法）か取消が届いたときの寄せを外すと、スマホでカードが枠より高いとき「取消」が枠の外に残る。ずらしを `transform` 以外（`top`・`margin`）で書くと、寸法の見張りが自分の書き込みで呼ばれ続ける | [`eew-spec.md`](../../docs/spec/eew-spec.md) §8「取消の表示は、カードのうち見えている範囲の真ん中に置く」 |
| 「予想が変わった」の帯の表示寿命（最低 10 秒・報番号で計時し直す）を崩すと、帯が 1 秒で消える、または起動時の復元・リプレイの初期状態・取消の報で帯が出なくなる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §3「最大予測値の変化」 |

## 強震モニタの揺れ検知

**地図上の見え方のうち揺れフォーカス・カメラ追従は下記「地図: カメラ・投影・表示閾値」節にある。検知点マーカーとカードの点集合の一致は下記の表にある。** この節にあるのは検知エンジンの判定ロジックと UI 連携。
| 項目 | 単一情報源となる仕様書 |
|---|---|
| 割合や点数のような数値の確信度、または「あと何点で確定」のような要求値を作ると、要求値を持たない検知器に実装が持っていない判定を装わせることになる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「判定の根拠を見せる」 |
| 見出しに検知器の内部用語（統計・波面・近道のような部分の名前）を出すと、表を開いた利用者にはその語の手がかりが無い（部分は働きで呼ぶ） | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「判定の根拠を見せる」 |
| 表示用の組み立て（`kyoshinEnsembleEvidence.ts`）を判定の入力にすると、表示専用の値が判定の一部になる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「判定の根拠を見せる」 |
| 確かな段の一行を `confirmedSnapshot`（確定した瞬間の凍結）以外から作ると、収まりかけた後に点数も震度も確定した時と違って見える | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「判定の根拠を見せる」 |
| 表の「加わった観測点」（束が生きている間に加わった点・減らない）とカード本文の観測点数（いま地図に描いている点）の違いを脚注で示さない、または地域番号を検知の id の順以外で振ると、同じ画面の 2 つの点数が食い違って見える、または並びが変わったときラベルだけ別の地域へ移る | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「判定の根拠を見せる」 |
| 診断ログ（`detectionDiagnostics.ts`）の確定の内訳を、確かな段になった瞬間の `confirmedSnapshot` 以外から採ると、記録が画面の一行と黙って食い違う | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §12「判定の根拠も残す」 |
| 震度0ドット表示フィルタの慢性ノイズ床（`chronicNoiseFloor`）を震度1以上のドット表示・最大効果表示にも適用すると、実測値をそのまま見せるべき表示が慢性ノイズ床で歪む | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「震度0ドット表示フィルタ」 |
| 床を観測点と同じ並びの配列で渡す規則、またはその床が対象の観測点配列に対して計算されたものかを位置で使う前に照合する規則を崩すと、座標が重複する観測点の2つ目以降が別センサーの床で判定される、または観測点が差し替わった直後の1レンダーで新旧の対応がずれる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「震度0ドット表示フィルタ」・[`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「取得と再生の分離」 |
| 欠測の瞬断を直前値で保持する範囲（表示・カードは保持値で強い揺れのバッジの明滅を防ぐ・音も保持値・検知エンジンは生値）を崩すと、強い揺れのバッジが1秒消えて次の秒で戻る明滅になる、復帰時に更新音が誤って鳴る、または検知の学習・慢性ノイズ床の判定が保持値で汚れる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「欠測の瞬断は直前値を保持して描く」 |
| 検知結果を出せないフレームのカウンタを理由（例外／観測点数と震度の件数の食い違い）で分けると、片方だけ交互に起きたとき凍結が解けない | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「検知結果を出せないフレームが続いたとき」 |
| 慢性ノイズ床の係が途絶明け（`MAX_DT_GAP_MS` 超・`MAX_RESUME_GAP_MS` 以内）で点ごとの履歴を残すと、途絶の前のサンプルが立ち上がりの起点に拾われて「今揺れ始めた点」を取り違える。時間軸の切替をフレームの間隔に任せる（検知器の `reset` を呼ばない）と、数秒先へ飛ぶ切替で旧い軸の検知が新しい軸へ流れ込む | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「フレームの間隔が飛んだとき」・[`kyoshin-detection-v3-design.md`](../../docs/spec/kyoshin-detection-v3-design.md) §37 |
| 復帰時の同一地震判定を経過時間で測る、場所照合を省く、または物差しに `SAME_SHAKE_KM` 以外を使うと、復帰時に別地震を「同じ揺れの続き」と誤認して無音になる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「発報ロジック」・[`kyoshin-detection-v3-design.md`](../../docs/spec/kyoshin-detection-v3-design.md) §35 |
| 供給開始前のフレームを検知エンジンへ先読みで渡す「助走」を用意しない、または供給元が `prefill` を呼ばないと、履歴内の上昇量で判定する立ち上がり判定が既に揺れている状態を初動と区別できず検知が漏れる（実測で確認済み） | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「助走」・[`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「助走」 |
| 助走が届くまで通常フレームを食わせない・待つのは時間軸が変わったとき（供給元識別子の変化では待たない）という規則を崩すと、後から届いた助走が「時刻の巻き戻り」として落とされて丸ごと効かなくなる、またはローカル履歴アーカイブの収録範囲を跨いだだけで検知が古い値のまま凍結する | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「助走」 |
| 待たせたフレームに観測点集合の識別子を持たせて食わせる直前に照合する規則を崩すと、観測点リストの版が替わった直後のフレームが点数の偶然一致で誤って通ってしまう | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「助走」 |
| 同じデータ時刻を二重に積まない規則を崩すと、待たせていた最後のフレームの検知結果が画面へ出ない（次のフレームまで音も自動タブ切替も動かない） | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「助走」 |
| 消費側で届いた助走の1件も使えなかったことを記録しないと、画面からは「助走が無かった」のと見分けが付かない | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「助走」 |
| 取得側で遡った結果を必ず記録しないと、取得の全滅と「静穏で正常に打ち切った」場合が画面から見分けられない | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「助走」 |
| リプレイの時間軸切替時に強震モニタの値（震度・データ時刻・観測点識別子・更新停止表示）をレンダー中に専用経路で落とす規則を崩すと、旧い時間軸の値が新しい画面に流れ込み、消えた地震・EEW で動く判定がそれを誤読する。`localArchiveId` 切替も巻き込むと揺れの最中に検知が鳴り直し、`stalled` を立てると通知が誤って抑制される | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「強震モニタは自分で落とす」・[`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「供給が作り直されたとき」 |
| 別地点発報のエピソード状態をリプレイの開始・停止で落とさないと、時刻を前へ飛ばす切替では自動的に解けず、新しい時間軸で鳴らすべき別地点発報の検知音・通知が黙って抑え込まれる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「リプレイの開始・停止で落とすもの」 |
| 欠測の保持値を捨てる条件（位置の対応が壊れた・時間軸が変わった）の順序を崩し、位置対応の判定を時刻のガードより後へ置くと、供給の作り直し直後に旧い時間軸の保持値が新しい軸の最初のフレームで蘇る | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「欠測の瞬断は直前値を保持して描く」 |
| 検知点マーカー（地図）と検知カード（リアルタイムタブ）が共有する点集合・下限（全検知・値のある点・App が用意した1本の点列）を崩すと、地図の表示と数値表示の点数が食い違う | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「検知点マーカーとカードの点数の一致」 |
| 検知カードの震度分布バーの分母（`scalePeakRef`）を可視中も下げると、揺れが収まっていく最中にバーが伸びて「増えた」と誤読させる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「検知カードの震度分布バーの幅スケール」 |
| 非可視中だけ現在値へ張り直す規則を崩すと、前の揺れの減衰を見続けている最中に分母がピークのままでバーが実際より細く見え続ける（検知イベントが一度でも0件になればカードごとアンマウントされて分母は独立にリセットされるため、影響が及ぶのは同じ検知が続いている間だけ） | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「検知カードの震度分布バーの幅スケール」 |
| 「別地点」の動的距離閾値（EEW ごとの個別判定を優先し、無ければエピソード起点でフォールバック・上下限で打ち止め）を崩すと、広域地震の伝播中に周辺地域を誤って「別地点」と連発する | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「別地点」判定の動的距離閾値 |
| 距離条件に加えた2つの抑制（EEW 吸収の記憶・発報済みの地域は二度鳴らない）を崩すと、EEW 解除後の一斉発報・同じ地域での再発報のいずれかが起きる（震度3の下限は2026-10-22に外した） | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「別地点」判定の動的距離閾値 |
| 「別地点」の3つの窓（持続・クールダウン・破棄猶予）をフレーム数ではなくデータ時刻で測る・持続を観測回数ではなく初検知からの経過で見る規則を崩すと、ライブと過去再生とで実際の長さがずれる、または欠測を挟む揺れの持続判定が壊れる | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「別地点」判定の動的距離閾値 |
| 破棄判定をフレームの末尾（その地域の確定点更新の後）に置く規則を崩し冒頭で破棄すると、コマ飛びの直後に現存する地域がまとめて捨てられ、同じフレームの確定点が新規地域として登録し直されて発報済みの地域が別地点として鳴り直す | [`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「別地点」判定の動的距離閾値・[`kyoshin-detection-v3-design.md`](../../docs/spec/kyoshin-detection-v3-design.md) §31 |

## 地図: 描画するもの

**レイヤーを 1 枚足すときは、下記「地図: カメラ・投影・表示閾値」も併せて見ること。** 表示範囲（`minzoom`/`maxzoom`）の決め方とカスタムレイヤーの投影対応はそちらにある。震度の面と区域塗りを重ねない規則は「地震情報」節。

[`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) の実装列挙のうち 4 つは [`scripts/mapRenderingSpecLists.test.ts`](../../scripts/mapRenderingSpecLists.test.ts) が `npm test` で実装と突き合わせるので、手で数え直さなくてよい——§3 カスタムレイヤーの id・§6 投影ごとのプログラムが要るファイル・§12 コンテキストロストから載せ直すコンポーネント・§13 の `gl/` ファイル構成。見るのは**両方向**で、足したものを一覧へ書き忘れても、消したものが一覧に残っていても落ちる。
**§7「mode 別レイヤー一覧」は名前が実在するかだけで、どの mode に出るかは手作業のまま**（JSX の条件分岐から機械的に導けない）。ほかの節の列挙（§8 の毎秒更新レイヤー・§13 の `gl/` 以外の行など）も手作業。

**`MAP_LAYER_ORDER`（描画順の単一情報源）への登録漏れは型で落ちる。** 忘れるとそのレイヤーだけ最前面に積まれ、描画順が静かに崩れる。仕組みと、カスタムレイヤーを作るときに使う型は [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §3。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 点滅する Marker の差分更新キー・innerHTML 更新を誤ると点滅が停止しポップアップも閉じる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §10「maplibregl.Marker の注意点」 |
| `maplibregl.Marker` 要素への `position` 書き込み・`cssText` の丸ごと置換で、マーカーが南へ流れる／既定スタイルが消える | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §10「maplibregl.Marker の注意点」 |
| `MAP_LAYER_ORDER` の順序・EEW 予想レイヤーの kyoshin 限定・Marker opacity と CSS アニメーションの乗算、いずれかを崩すと描画順崩壊・タブ間の予測実測混同・点滅の実効消失のいずれかが起きる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §2・§3・§7・§10 |
| 静的な形は共有ソース 2 本（`basemap-shapes`/`overlay-lines`）へ相乗りさせないと、マスク描画・タイル被覆計算がソース数倍に増え、`kind` の綴り違いでレイヤーが無言で消える | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §9「静的な形はソースを共有する」 |
| 観測点補間面の生成規則（階級変換・外挿禁止・evenodd クリップ・Mercator 等間隔・非有限値排除・配る側走査・描けない理由の判別）を崩すと震度分布が実態と食い違う、または前の視野の絵が残る | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §17「観測点の値を面にする」 |
| 深さを持つ点（震源・長期カタログ）の描画規則を崩すと、地下に消える・地球の裏側へ飛ぶ・表示とクリック判定がずれる、のいずれかが起きる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §16「深さを持つ点」「補助の点と柄」 |
| 長期震源カタログの点群は、点の入口統一・完全性フィルタとの整合・期間操作の不変条件（3 つの関数経由）のいずれかを崩すと値が黙って壊れる、または消える | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §16「長期震源カタログの点群」「期間は日で持つ」 |
| 描画・クリック判定の不調検出は、取り下げ経路を混ぜる・`onAdd` で例外を投げるのいずれかで機能しなくなる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §16「描けているかを画面に出す」「`onAdd` は投げない」 |
| EEW の震源の深さ表現を地震情報と揃えないと見た目が食い違い、点滅の同期を崩すと続報の到着間隔によっては止まって見える | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §16「EEW の震源も同じ仕組みで置く」「点滅は『明・暗の 2 値』と『全点共通の位相』で作る」 |
| 同じ震度階級のバッジの手前/奥判定で `symbol-sort-key` と `viewport-y` を併用すると、排他制約が壊れる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §15「同じ階級なら画面の手前から」 |
| 夜の側（`DayNightGL`）の各規約は独立に複数あり、崩すといずれかの症状（色相のずれ・8bit 段差・極付近だけ夜が掛からない・投影切替時に濃さが変わる・コンテキストロスト後に消えたまま戻らない・NaN で夜側が消え設定オフと見分けが付かない 等）が個別に出る | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §18「夜の側」 |
| グリフ収録文字の網羅性・フォント適用範囲（ラベル限定）を崩すと、文字が空白になる、または震度バッジ等に地名用フォントが混入する | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §5「ラベル描画」 |
| 地名ラベル×バッジの重なり回避で守る前提（代表点判定で自区域を除外しない・`room` は非負まで確認する・判定結果は `feature-state` ではなく `properties` で渡す 等）を崩すと、退避が発火しない、ラベル 1 件の破損で全ラベルの判定が止まる、`text-offset` に反映されない、のいずれかが起きる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §5「バッジとの重なりを避ける」 |
| 地名ラベル重なり判定の実行間隔・世代破棄・録画モードでの停止条件を崩すと、判定が過剰に走る、前後で混ざった中間状態が画面に出る、別視点の結果が混ざる、録画モードで移動後もラベルの重なりが直らない、のいずれかが起きる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §5「判定をいつ走らせるか」 |
| symbol レイヤー（地名ラベル・観測点ドット・区域中心震度バッジ・長周期 2 種・検知点ハイライトの 6 種）の出入りフェードは地図全体設定でのみ制御できる（レイヤー個別の `-transition` は効かない） | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §8「symbol の配置フェード」 |
| 地震活動ヒートマップの色配置・半径・不透明度を崩すと、密度の濃淡が読めなくなる、または実座標より精密な位置が分かるように見える | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §14「地震活動ヒートマップの見せ方」 |
| バッジの文字色自動選択とアイコン倍率の上限を外すと、コントラスト規格を割る、または高倍率で文字がぼやける | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §15「バッジの文字色とサイズ」 |
| `isMapStyleGone` の判定条件・呼び出しタイミングを崩すと、後始末を異常ログとして誤検出するか、逆に本物の異常を握り潰す | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §9「静的な形はソースを共有する」「MapLibre を上げたときに確かめるもの」・§17「描けないときは必ず消す」 |
| 地図初期化失敗を例外の型で選り分けると、いちばん救いたい端末を取りこぼす（取りこぼしても地図の ErrorBoundary が受け止めるが、原因を伝えられない案内になる） | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §12「地図をそもそも作れなかったとき」 |
| 凡例の対象抽出・並び順・畳んだときの代表選定を崩すと、地図に無い色が凡例に残る、または畳んだ代表が画面の主役と食い違う | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §20「凡例」・[`share-card-spec.md`](../../docs/spec/share-card-spec.md) （画像への焼き込み） |

## 地図: カメラ・投影・表示閾値

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 揺れ検知追従で寄り直し先を算出できない場合（コンテナ寸法が取れない・座標が壊れている）に、その状態へ入ったこともログへ残す規則を崩すと、成長フォローも同時に「収まっている」と誤判定してどちらのフォローも動かなくなったことへ気づけなくなる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「揺れ検知追従の目標範囲」 |
| 揺れフォーカスの要求を音を鳴らすのと同じ判定（`useKyoshinAlerts`）で出す規則を崩すと、判定がずれて「音は鳴るのに画は動かない」経路が黙って生まれる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「揺れフォーカス」・[`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §8「発報ロジック」 |
| 津波追従で持ち越しを見送ったことを`log.debug`で記録する規則を崩すと、入室時俯瞰が出たのか観測点フィットが落ちたのかを事後に区別できなくなる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「津波追従の目標範囲」 |
| 上限が固定の帯では可変の下限を追い越させない規則（`clampMinZoom`）を崩すと、`minzoom > maxzoom` の状態が生まれ、どのズームでも描かれないレイヤーが黙って出来上がる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「寄り上限と閾値の単位」 |
| 自動フィットの完了待ちを印と通し番号（連番カウンタ）で数える規則を崩すと、重なった飛行が一斉に解けた直後の自分のフィットが起こす`zoomstart`をユーザー操作と誤認し、誰も触っていないのにEEW 追従が抑制の保持時間ぶん黙って止まる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「ユーザー操作の尊重」・「カメラの重複制御」 |
| WebGL 文脈復旧時に `onAdd` で投影プログラムキャッシュを捨てる規則を崩すと、文脈喪失で無効になった前プログラムをキャッシュがそのまま返し続け、そのレイヤーだけが無音で描かれなくなる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図の投影」 |
| `onRemove` だけに後始末を任せず `onAdd` 側で完結させる設計を崩すと、MapLibre 6.9.0 の文脈喪失時の解体ループがレイヤーごとの try/catch を持たないため、1 枚が例外を投げると以降のレイヤーの後始末が黙ってスキップされる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図の投影」 |
| 判定用 FBO の寸法を `onAdd` で落とす規則を崩すと、残った無効な FBO への描画が黙って捨てられ、`readPixels` が 0 を返し続けて「クリックしても何も返らない」だけが残る | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図の投影」 |
| `warnedFbo` を `onAdd` で戻す規則を崩すと、一度警告が出た後は画面へ出す経路が無いため2 度目以降は記録にも出ないまま黙って抑制され続ける | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図の投影」 |
| リセットを資源を作る前に置く順序を崩すと、`onAdd` 途中の例外後も MapLibre がレイヤー登録済みのまま `render()` を回し続けるため、リセットだけが飛んだことに気づけない | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図の投影」 |
| 収まり判定を地理座標の矩形で行うと、回転した視野で実際にはみ出しているものを「収まっている」と誤判定し、追従が黙って止まる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図の傾きと回転」 |
| 確認を起動直後だけでなく以後も一定間隔で続ける規則を崩すと、依存指定 `^6.10.0` のマイナー更新で前提が崩れても起動直後の数回がたまたま一致しただけで気づかず省き続ける | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §9「カメラ更新の空振りを省く」 |
| 照合を transform の観測できる状態だけに絞っているため、transform の値を変えずにカメラや地図の別の状態を書き換える変更は原理的に検知できない（既知の限界） | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §9「カメラ更新の空振りを省く」 |
| 省略が効いているかどうかは画面に現れないため、診断用の公開（`window.__cameraUpdateSkip()`）を欠く・崩すと、追加した省略が効いているかを切り分けられなくなる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §9「カメラ更新の空振りを省く」・§11「デバッグ用の公開」 |
| コンソールの警告が前提崩壊の瞬間に一度しか出ない（かつ省略に入れないまま留まる場合は警告すら出ない）仕様を知らずに使うと、「いま効いていない」という状態を検知する手段を持たないまま地図が重くなった原因を見失う | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §11「デバッグ用の公開」 |
| MapLibre を余白付きで呼ぶ経路（`cameraForBounds` / `fitBounds`）を `gl/camera.ts` の外に作る、または余白の切り詰め（`clampPaddingToPane`）を寄せる側と判定側のどちらかで外すと、地図が小さいとき（縦長でパネルを広げた状態）に MapLibre 6.10.0 が例外を投げて地図が丸ごと止まる、または寄せ直しが止まらなくなる。寸法 0 のときの保留をやめて見送りにすると、地震カードの寄せなどが二度と走らない | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「地図ペインが小さいときの余白」 |
| EEW 予想の区域塗りとカメラ追従対象の一致（`useEewLayerData` の `eewFitPositions` と `JapanMapGL` の塗り分けが、同じ「予想長周期を優先する」判定を使っていること）を崩すと、表示していない塗りへカメラが寄る | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「EEW 追従の目標範囲」 |
| EEW 追従の引き上限（上限は円の半径にかける。矩形の辺を枠で切り詰めると箱の中心が震源から外れる・検知点と区域塗りには上限をかけない）を崩すと、枠の外に震源がある地震で震源を含まない箱になる、または画に入れるべきものが切り落とされる | [`map-rendering-spec.md`](../../docs/spec/map-rendering-spec.md) §6「EEW 追従の目標範囲」 |

## データの取得と時刻

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 外部への取得を素の `fetch` で書くと、応答が返らない 1 本でリプレイの開始・履歴・強震モニタ・ライブの受信の起点が「取得中」のまま止まる（失敗に数えられず、再試行も「更新停止」も動かない） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §1「応答が返らない取得には上限を置く」 |
| 上限を応答の見出しが届いた時点で外すと、中身が流れてこない取得がまた黙って止まる。門（`requestGate`）で待つ前から計ると、混んでいるだけの取得が時間切れに化ける | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §1「応答が返らない取得には上限を置く」 |
| 複数の呼び出し元が相乗りする取得（アーカイブ本体・電文本体・標準版の日ごとの控え）に止める合図を渡すと、1 人が止めただけで相乗りしている本編・初期状態・履歴まで巻き添えで落ちる。止めた打ち切りを「取得に失敗」と数えると、再生を止めるたびに本物の障害と見分けの付かない記録が積もる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §1「止めたら打ち切る」 |
| 標準版（P2PQuake）の黙った接続の見張り（`P2P_SILENT_RECONNECT_MS`）を DMDATA と同じ短さにすると、ping の無い配信元は平常でも 6 分半ほど黙るので（実測 386.5 秒）、静かなだけの時間に張り直しを繰り返す。張り直しを `onclose` 待ちにすると、半開きの接続では閉じる知らせが届かずいつまでも張り直さない | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §3「黙った接続は 15 分で張り直す」 |
| 標準版で張り直したときの取り戻しの起点を「接続を始めた時刻」にすると、繋がらない試行を繰り返した間の分を落とす。津波を「その接続で見たどの報より新しいか」で比べずに差し替えると、張り直した直後にライブで届いた取消を取り戻した古い発表報が上書きし、終わった津波が甦る | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §3「張り直したら、切れていた間の分を取り戻す」 |
| 購読区分の判定（`eewHeadTypeFor`・`isHandledType` の必須引数）をライブ・リプレイ・起動時の復元のどれかで別に持つと、一部の区分しか契約していない人に経路によって届く電文が食い違う。履歴と復元を、前回受け付けられた区分の覚えも `classificationsReady` の結果も無いまま始める、または一時的な失敗で既定の区分に決めると、受けていない区分を引いて断られる。覚えの扱い（鍵ごとに分ける・認証エラーで消す・突き合わせは最初の 1 回だけ）を崩すと、前の鍵の区分で引く・断られる区分を毎回引く・再接続のたびに履歴を取り直す | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「一部の区分だけ受けられる人」 |
| 配信元のレート制限（リクエスト数・429）を守る仕組みを崩すと 429 連発・利用制限に触れる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「リクエスト数を抑える」・§2「429 は「頻度」ではなく「同じ id の取り直し」に返る」 |
| 取得失敗時の間隔調整・更新停止の通知条件を誤ると、更新停止の見逃しまたは無限リトライになる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「取得に失敗したら間隔を空ける」・[`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「再生する時刻は入口で弾く」 |
| 目録・電文パース結果のキャッシュの鍵を誤ると、誤った電文を使い回す | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「大量に取るならアーカイブを使う」 |
| 電文本体の紐付けを filename 以外（識別子推測・拡張子）で行うと、誤った本体を取得しうる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「DMDSS 版の取得（アーカイブの構造）」 |
| 目録の発表時刻欠落時にファイル名補完をしないと、窓の時刻判定を誤り取りこぼす | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「大量に取るならアーカイブを使う」 |
| 履歴取得の部分失敗を表示しないと、欠落したカードを地震が無かったと誤認させる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「大量に取るならアーカイブを使う」 |
| 読み取り失敗を 3 層で記録しないと、電文の欠損が検知されず気づけない | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「読めなかったものは記録する」 |
| 同じ日を読み直したときに取りこぼしを二重カウントすると、件数が水増しまたは黙って消える | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「読めなかったものは記録する」 |
| 標準版リプレイの日次控え（dayCache）に寿命を持たせないと、後から届いた電文が反映されなくなる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §3「再生の取得は日ごとに控える（当日ぶんだけ寿命がある）」 |
| 日時の壊れ方を検知する層（電文層・表示層）の境界を見誤ると、時間帯を明示しない壊れた値が無警告で `NaN:N` と表示される | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「日時は 2 つの層で確かめる」 |
| P2PQuakeレスポンスの不正値破棄条件・震度正規化テーブルを外すと、階級外の値が特別警報の判定エンジンへ渡り地域を丸ごと無視する | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §3「convertEvent の検証と日本語化」 |
| APIキー文字検証を通信前に弾く経路と弾かない経路で揃えないと、無効な鍵のまま401/403を連発するか原因の違う「未設定」「不正」を同じ文言で伝える | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「認証」 |
| 南海トラフ 3 種別・後発地震に共通する見出し文/次回発表予定/参考情報の読み取り窓口を 1 箇所に保たないと、経路ごとに要約の有無が食い違う | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「3 種別に共通する要素は 1 箇所で読む」 |
| 見出し文（`Head/Headline/Text`）をそのまま画面へ出すと、本文と重複する事実が二重に表示される | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「見出し文（`Head/Headline/Text`）は読むが、地震情報では出さない」 |
| 見出しの構造化（`Head/Headline/Information`）を新しい事実の入口として読むと、`Body` の部分集合を二重に読み込む（例外は 2 つ。緊急地震速報の警報報の地方予報区ブロックと、震源・震度に関する情報で本文に無い市町村） | [`quake-spec.md`](../../docs/spec/quake-spec.md) §8「見出しの構造化（`Head/Headline/Information`）は読まない」 |
| 南海トラフ 3 電文の段階判定を `Head/InfoKind` で行うと、臨時情報/解説情報でコード体系が重複し段階が上書きされる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「南海トラフ関連の 3 種別（VYSE50 / VYSE51 / VYSE52）」 |
| 長期震源カタログの数値欄を桁数固定で読むと、緯度が最大 78km ずれる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §6「読み取りで踏んだ罠」「異常を検知する仕組み」 |
| DMDATA震源カタログの欠測地震を個別除外せず一括で捨てると、表示できる地震まで消える | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「震源カタログ」 |
| 強震モニタの供給元→時刻順キュー→反映の 3 段を飛ばして直接反映すると、表示が乱れる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「取得と再生の分離」 |
| リプレイの秒フレームをその場取得にすると、更新間隔が取得の往復時間に化け欠落が生じる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「リプレイは先に取って積む」 |
| 強震モニタの秒フレームはライブでは控えず、失敗秒も控えると欠落が固定化する | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「秒フレームの控え（`utils/kyoshinFrameCache.ts`）」 |
| クロック同期でYahoo経路を主経路と同時に供給すると、精度の良い方にバイアスが混ざる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「クロック同期（`startClockSync`）」 |
| 外部時刻サービスの応答を中点換算すると -RTT/2 の系統誤差が乗り、`?ms` を落とすと精度が秒単位に劣化する | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4「主経路: 外部の時刻サービス（`akamaiClock.ts`）」 |
| 生成データ取得のタイムアウト値と失敗時の扱いを仕様書と揃えず個別に決めると、低速回線向けの一括 60 秒と読み上げ専用の短縮 5 秒がずれる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §6「生成データ」 |
| 生成データの中身の検分を取得後（呼び出し側）で行うと、失敗が地図の「〇〇を取り込めず」に計上されず取り直しも走らず、console にしか残らない | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §6「生成データ」 |
| README「ライセンス」節の地図データ出典表記を仕様書側の用語へ揃えると、配信元 GIS レイヤーの実名を言い換えたことになり出典表示として不正確になる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §1「概要」 |
| 報の新旧を比べる・並べる箇所で `compareReportAge` / `reportOrderKey` を通さず分単位の発表時刻（ReportDateTime）を直接比べると、同じ分に発表された報の前後が入力順で決まり、履歴・リプレイの並びが発表順と食い違う | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.3「報の新旧は電文の作成時刻（秒）で比べる」 |
| 作成時刻を持たない報どうしの比較で ReportDateTime と Control/DateTime のタイムゾーン表記を混在させると、その報だけ辞書順比較で永久に「古い」と判定され捨てられる | [`quake-spec.md`](../../docs/spec/quake-spec.md) §6.3「報の新旧は電文の作成時刻（秒）で比べる」 |
| 電文が名乗る情報名を「最初に現れる Title」から読むと、種別の固定名（Control/Title）を拾い遠地地震などの判別が効かなくなる | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「電文が名乗る情報名」 |
| 観測時点（TargetDateTime）を観測情報以外の種別や発表時刻と同義に扱うと、最大 6 分さかのぼる別時点を「いまの高さ」として誤解させる | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「観測状況を確定した時刻」 |
| 電文の読み取り経路をXML以外（DMDATAのJSON変換版）にも広げると、独自スキーマが端折る項目（津波の注意文・予想波高の「未満」）が黙って落ちる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2「受信する電文種別」 |
| onLiveEventへ渡す電文の型を潰す（`as unknown as AppEvent`）と、種別ごとにしか無い項目の付け忘れが型検査をすり抜ける | [`architecture-spec.md`](../../docs/spec/architecture-spec.md) §2「副作用への入口（`onLiveEvent`）」 |
| 自作地震計の震度を観測点の合成（`station-reading`）だけから採ると、**有効なセンサーが 2 台未満の観測点では震度が 1 件も出ない**（ホストが合成を作らないため）。どちらを採るかをホストの設定から判断しても、設定と実際が食い違ったときに狂う | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「震度の出どころは 3 つある」 |
| 自作地震計の震度を落とす判断を表示側へ回すと、届かなくなったときは再描画も起きないため古さを検出できず、「揺れていない」と区別が付かなくなる（接続の停滞検出 45 秒は「繋がっているのにその観測点だけ沈黙」を捉えられない） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「途絶えたら行を残し、値だけ落とす（5 秒）」 |
| 自作地震計の波形を届いた順に詰めて繋ぐと、まとまりが 1 つ欠けたときそこだけ時間の縮んだ絵になる（絵としては普通に見えるので確かめる手立てが無い）。刻みのわずかな揺らぎで作り直すと、まとまりごとに絵が消える | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「波形は直近 180 秒だけ抱える」 |
| 自作地震計の波形の位置を「起点 ＋ 固定した刻み」で測ると、**正常な刻みの揺らぎ（実機の実測で 0.16%）で丸めの誤差が積み上がり、連続して届いているデータが偽の欠測に化ける**（その幅で 10 分ぶん流した再現で 94 回）。巻き戻りの復旧閾値を緩めると、**緩い間ずっと新しく届いたデータを捨てる** | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「波形は直近 180 秒だけ抱える」・回数の出どころは §11 改訂履歴 |
| 自作地震計の台帳で「割り当てが無い」と答えられた基板を取り直しの対象から外すと、**ホスト側で割り当てを直してもそのブラウザが生きている間は震度が出ない**（`PUT /api/boards/:boardKey` は upsert なので割り当ては後から変わる）。台帳を引けなかったときの間隔を引けたときと共有すると、機能が止まっている間も 1 分待つ | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「繋ぎ方」 |
| 計測震度から震度階級を引く表を書き写して増やすと、**同じ揺れが画面の場所によって違う階級で出る**（強震モニタと自作地震計が同じ表を通る） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「地図の右上へ重ねる」 |
| **気象庁の震度0 に下限は無い**ので、負の計測震度を弾くと静穏時の自作地震計が階級を持たない行になる（強震モニタが震度0 未満を描かないのはあちらの都合）。比較だけで振り分ける形は**非有限値がすべてを素通りしていちばん強い階級（震度7）に落ちる** | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「地図の右上へ重ねる」 |
| 自作地震計の帯を接続の状態で出し分けると、**同じ事実に判定が 2 つできる**（短い切断は状態層の 5 秒が吸収し、長い切断では消える）。空の帯を常駐させると「揺れていない」と「繋がっていない」が見分けられなくなる。計測震度を `toFixed` でそのまま出すと、静穏時によく出る `-0.04` が `-0.0` になり**表示が壊れたようにしか見えない** | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「地図の右上へ重ねる」 |
| 計測震度の数字と階級を別々の丸め方で出すと、「2.5」の隣に震度2 が並ぶ（気象庁は第 3 位を四捨五入し第 2 位を切り捨ててから階級を引く）。手順は `utils/measuredIntensityRounding.ts` の 1 箇所で、管理コンソールも同じ部品を読む —— **書き写すと、同じ揺れの数字がアプリと管理コンソールで 0.1 違う** | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「地図の右上へ重ねる」 |
| 繋がらなくなったことを知らせる行の待ちを、震度を落とす `READING_STALE_MS` と別の値にすると、**右上の帯と左上の行が同時に出る**（値があるのに繋がっていないと名乗る）か、**どちらも出ない間ができる**。待ちを張り直す契機を繋がり具合そのもの（`SeismoStreamState`）にすると、**繋ぎ直しのたびに待ち時間の違う値が届くので永久に出ない**。括弧へ行動の案内を書くと、**購読の上限で断られているとき「ホストが起動しているか確認」は誤った案内になる**（ホストは動いている）。**この行が拾えない形が 2 つある** ——黙って切れた繋ぎ（停滞の検出を待つので最大 45 秒の空白）と、観測点だけが沈黙する形（押し出しは生きているので状態が変わらない） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「繋がらなくなったことを地図の左上へ出す」 |
| 自作地震計の「値が来ていない」3 形（黙って切れた繋ぎ・観測点だけの沈黙・カードの波形が凍る）を別々の述語で解くと、**画面上で区別が付かないまま食い違う** ——前 2 つはどちらも「行が消えるだけ」で見分けられなかった。**`never`（一度も届いていない）と `silent`（届いていたのに途絶えた）を混ぜると、購読を始めた直後に全行が「値が来ていない」と名乗る**（購読直後は必ずその状態を通る） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「震度の出どころは 3 つある」「途絶えたら行を残し、値だけ落とす（5 秒）」 |
| 途絶えた震度の行を**消す**と、画面からその観測点が居なくなるだけなので「揺れていない」と「届いていない」がまた見分けられなくなる（値を落とす側で避けた症状を表示する側で作り直す形）。逆に `intensity` を残すと、止まった値を「いまの震度」として読む。**行は残して値だけ落とし、色だけ替える** ——文言を足すと、隣の更新時刻の帯と同じ事実が 2 通りの見え方になる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「途絶えた行は赤くする。文言は 1 つも足さない」 |
| カードの波形の「伸ばす番か」に**押し出しを繋いでいること**を入れ忘れると、**再生を始めて 5 秒で 7 日ぶんの絵が全部薄くなる**（再生中は購読を切るので、列が伸びないのは当たり前）。印を戻す経路（安全弁を過ぎた・先頭から降りた）を 1 つ落とすと、その絵は薄いまま固定される。**途絶えている間は列が 1 つも変わらない**ので、「変わったら出し直す」だけの作りでは画面に出ない | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「繋ぎ足しが途切れたら濃さを落とす」 |
| ホストが**番号は続きながら時刻だけが飛んだ**パケットを同じ区間へ繋ぐと、両方のエポックのアンカーが 1 本の直線に乗って当てはめが壊れ、足場が 1970 年のまま**二度と戻らない**（**ファームの `configTime()` は SNTP の応答を待たない**）。**時間で重なる対が無くなるので合成が 1 つも組めず、震度は単独で出続けるので外からは「動いている」ようにしか見えない**。逆に番号が飛んでいる側で時刻を見ると、公称間隔とのずれが積み上がって長い欠落が「時計が飛んだ」に化ける。**基板の側でも送らないようにしたが、受け手の判定は外さない** —— どの版のファームが焼かれているかを受け手は選べない | [`seismo-host/README.md`](../../seismo-host/README.md)「時計が合う前のパケットを、同じ区間へ繋がない」・[`firmware/README.md`](../../firmware/README.md)「時計が合う前は送らない」 |
| 基板の「送れたつもり」を本物の送信と見なすと、**`endPacket()` が真を返しながら 1 バイトも出ていない状態に気づけない**（実機で 5 日・144 万パケットぶん。HTTP も ping も応えるので外からは健全に見える）。Wi-Fi の繋がり直しを **`loop()` の見張りだけで捉えると、`loop()` の 1 周より短い明滅を取りこぼしてソケットが無効なまま残る**。**`setAutoReconnect(true)` は「意図した切断」では繋ぎ直さない**ので、`WiFi.disconnect()` だけを呼ぶと基板がネットワークから出たまま戻らない（実際に 1 枚落とした。ping も通らず、電源を入れ直すまで戻らなかった）。**起動時に Wi-Fi を待って諦める形にすると、その回は SNTP も OTA も状態ページも UDP も立たないまま走り続ける**（停電復帰で普通に踏む。遠隔で焼き直す手段ごと失う） | [`firmware/README.md`](../../firmware/README.md)「ネットワークが黙ったとき」 |
| ホストの「届いた」の返事を**震度や区間の処理より後ろで返すと、ホスト側の例外を基板が「送れていない」と取り違えて繋ぎ直しと再起動を始める**。基板が返事を読んだあと**読み残しを捨て損ねると、ESP32 の `parsePacket()` が以後ずっと 0 を返して返事が途絶えたように見える**。再起動の回数を **`RTC_DATA_ATTR` に置くと `ESP.restart()` で初期値へ戻り、上限が効かない**（`RTC_NOINIT_ATTR` に置き、電源投入では白紙にする）。**「この起動で返事を一度も受けていない」ときに段を上げると、返事を返さないホストへ繋いだ基板が再起動を延々と繰り返す** | [`firmware/README.md`](../../firmware/README.md)「届いたかをホストに訊く」・[`seismo-host/README.md`](../../seismo-host/README.md)「基板へ「届いた」と返す」 |
| 基板が黙ったことを**センサーの生存（`sensors[]`）から探すと、ホストを起動してから一度も届かない基板は一覧にすら現れない**（届いたセンサーしか載らない。時計が合うまで送らない基板はまさにこの形）。「来るはずのもの」は観測点の設定にしか無いので、突き合わせはそこから始める。**判定を保留する猶予の起点をホストの起動時刻 1 つにすると、稼働中に足した基板が足した瞬間に「届いていない」になる**（割り当てが設定に現れた時刻を基板ごとに持つ）。警告の間引きの鍵を**「いま黙っている顔ぶれ全体」にすると、顔ぶれが揺れるたびに枠を食い潰し、新しく黙った基板の最初の 1 行まで遅れる** | [`seismo-host/README.md`](../../seismo-host/README.md)「割り当てた基板が届いていないことを知らせる」 |
| 自作地震計を再生中（テスト時刻設定）も押し出しへ繋いだままにすると、ホストが押し出すのは**いまの震度**だけなので、**画面の他が過去なのにそこだけ現在**になる。再生中は押し出しを切り、**再生時刻のぶんをホストから読み返す**（`useSeismoReplay`）。先回りして読んだ分を再生時刻で切らないと、まだ来ていない時刻を描く。再生時刻が飛んだかを巡回の間隔で見ると、隠れたタブで巡回が間引かれるたびに読み直す | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「再生中は当時の記録を読み返して出す」 |
| 取れなかった取得の取り直しを場所ごとに書くと、同じ「取れなかった」に諦めるまでの時間が場所ごとに違ってくる。自作地震計の穴埋め・地震カード・再生中の読み返し・公開観測点のカード・リプレイの先読みは `utils/retrySchedule.ts`（30 秒から倍々・5 回）を通す。**強震モニタの抜けた区間（リプレイの全滅区間・ライブの途切れ）だけは別**（検知は巻き戻せず 90 フレームしか待てないので、先読みと同じ秒ごとの規則で取る） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4・§4.5・[`kyoshin-detection-spec.md`](../../docs/spec/kyoshin-detection-spec.md) §7「抜けた区間の取り直し」 |
| 地図へ重ねるものを下端（凡例・特別情報バナー）の側へ置くと、**あの帯は全幅の絶対配置なので押し上げてもらえず重なる**（自作地震計を右下へ置いた時点の実測で、共有ボタンの枠と縦に 33 px 重なっていた）。観測している値とアプリの状態（更新時刻・取得状況・描画の不調）を同じ隅へ積むと、異常表示が伸びたぶんだけ観測値が押し下がる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「地図の右上へ重ねる」 |
| 自作地震計の波形を**揺れてから購読し始める**と、粒度の切り替えが押し出しの繋ぎ直しになり**その時点から 0 秒ぶんしか無い**（いちばん見たい初動が絵に入らない）。余韻を「条件が成立した時刻」から数えると、**60 秒を超える揺れで起点が更新されず**、収まった瞬間に絵が消える | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「波形を地図の下へ描く」 |
| 自作地震計の**波形にだけ鮮度の判定を置かない**と、`station-wave` が止まっても絵が凍ったまま「いま静かに揺れている」ように見え続ける（震度の鮮度は震度にしか掛からず、接続層の停滞検出も震度が届いていれば発火しない）。**観測点の有効なセンサーが 2 台を切ると実際にこの形になる** —— 合成だけが止まり、震度は単独へ落ちて生き続ける | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「波形を地図の下へ描く」 |
| 波形の縦スケールに下限を置かないと、**静穏時のノイズが画面いっぱいに広がって「揺れている」ようにしか見えない**。下限を決め打ちの gal で書くと、**センサーを替えて静かさが変わったとき静かな線が平らに潰れる** —— 測った静かさの倍率で決める（`utils/seismoQuietScale.ts`）。`NaN` をそのまま `lineTo` へ渡しても Canvas 2D は**何もしない**（no-op）ので、自分で線を切らないと**欠測を分けて持った意味が描画で消える**。点を間引く形にすると単発のピークが確率的に落ちる | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「波形を地図の下へ描く」 |
| 有感の地震カードへ出す波形の繋ぎ足しを**描画側へ置くと、カードを開いている間・タブが見えている間しか繋がらない**（`requestAnimationFrame` はタブが隠れると止まる）。打ち切りを**壁時計で測ると、再生中に比較が常に真になって静かに止まる**（`serverNow()` 基準にする）。収まり判定に猶予を置かないと**弱い地震で揺れの最中に打ち切る**（弱い揺れの加速度は静穏時のノイズと同じ桁。**階級から加速度の帯を引かない** ——計測震度は加速度だけで決まらない）。取得の中断を「取った」に数えると、**その観測点は二度と取りに行かれない**（群発・余震ほど起きやすい） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「有感の地震カードへ、その区間の波形を出す」 |
| 有感の地震カードへ出す波形の読み返しで、**中断を「繋がらなかった」として記録へ残すと、群発のときほどその行が埋まって本物のホスト障害と混ざる**（時間切れとの見分けは呼び出し側の `signal` で付ける。例外の型では付かない） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「有感の地震カードへ、その区間の波形を出す」 |
| 状態の口が**「観測点 0 件」で応えたのを「取り直す値打ちが無い」に数えると、その地震の波形を二度と取りに行かない** ——**ホストの起動直後は必ずこの形を通る**（実際にパケットを受けたセンサーしか載らない） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「有感の地震カードへ、その区間の波形を出す」 |
| 波形へ引く P/S の到達線を**自前の速度モデルで解くと、同じ地震について予報円と別の時刻を名乗る**（JMA2001 走時表を引く）。**深さ不明のセンチネル（`-1`）を 0 と読み替えると、深い地震ほど早い時刻へ線を引く**（`0` は「ごく浅い」という有効値）。横位置を**末尾を切る前の窓で割ると、まだ来ていない時刻ぶんだけ分母が伸びて線が左へ寄る** | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「P 波・S 波が届いた時刻に線を引く」・[`forecast-computation-audit.md`](../../docs/forecast-computation-audit.md) |
| 波形の向きを消したときに**振れ幅の分母から外さないと、いちばん大きい成分を消しても残りが潰れたまま**で、消した意味がなくなる。3 成分の色を**淡いパステルで揃えると、3 本重ねたときに見分けられない**（色相を 120 度ずつ離す） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「向きを押すと、その成分を消せる」 |
| 自作地震計の波形の 3 成分はホストが送る順（東・北・上）のまま描き、`AXIS_LABELS` の名前をその順に合わせる。**受け取る口で並べ替えると**、口は押し出しと読み返しの 2 つあるので、**片方で入れ替え忘れると同じ揺れが窓によって違う向きの名前で出る**（型にもテストにも掛からない）。1 番目を南北と呼んでいた取り違えがまさにこの形で、画面の「南北」の線は東西の揺れだった | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「向きを押すと、その成分を消せる」 |
| 地震カードへ自作地震計の波形を出す地震を**選び直すたびに外れうる形にすると、普段の計測震度が 10 分ごとに測り直されるだけで出ていた波形が消える**。逆に**普段が読めない間（下限なし）に選んだ組まで持ち越すと、ホストの起動直後に読んだだけで 7 日ぶんの遠い地震が開き直すまで外れない**。普段や座標が読めないことを「届かない」と読むと、観測していても出ない | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「有感の地震カードへ、その区間の波形を出す」 |
| 地震カードへ押されたことを伝える関数を**親側で `() => onSelect(key)` と包むと、毎レンダー新しい関数になって `EarthquakeCard` の `memo` が素通りする** —— 自作地震計の波形を繋いでいる間は 0.3 秒ごとに親が描き直されるので、**関わりのないカードまで 7 日ぶん全部**描き直される（地震の鍵はカード側で作って渡す） | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「有感の地震カードへ、その区間の波形を出す」 |

## 画面構成と設定

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 設定の窓のセクション構成・並び順の方針（`<Section>` の出現順そのもの・重大度は軽い順・カテゴリ順は両テストセクションとブラウザ通知の種別トグルで共通）を崩すと、想定と違う並びで表示される | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「並び順の方針」 |
| 特別情報バナー 5 枚の並び順（同じ事象を隣り合わせる）・消え方（7 日失効・電文 id の正規化）を崩すと、閉じた帯が復活する、または並びが分かりづらくなる | [`architecture-spec.md`](../../docs/spec/architecture-spec.md) §4 |
| 自動復帰までの時間（`idleRevertSec`）を計り直す契機のうち自動タブ切替・電文受信の両方を崩す（＝ユーザー操作の起点だけで測る形に変える）と、据え置きの端末で津波警報が一瞬映って消える | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 自動復帰までの時間を計り直す契機のうちユーザー操作を崩すと、操作中でも既定タブへ戻ってしまう | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 自動復帰までの時間を計り直す契機のうち読み上げ終了（`onSpeechIdle`）を崩すと、読み終えた直後に唐突にタブが切り替わる、または戻るまでに余分な遅延が生じる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 倍率の適用範囲（UI は rem・地図の描画物には `iconScale`・枠線は倍率に連動させない）を崩すと、UI 倍率設定が一部の要素に効かない、または下限側でフチが主役になる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 画面サイズ別レイアウトの分岐条件（`side`/`sideNarrow`/`sideShort`/`roomy`）を崩すと、狭い画面でパネル比率・折りたたみが崩れる | [`architecture-spec.md`](../../docs/spec/architecture-spec.md) §4「画面サイズ別のレイアウト」 |
| 録画モードの原則（ON は OFF より劣化させない）と止めるもの 1 つ（通知音のキープアライブ）を崩すと、動画の書き出し・アップロード後の再エンコードで常時ループ音が可聴のノイズに化ける（地名ラベルの重なり判定と揺れ検知の診断ログは録画モード中も止めない） | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 録画モードで有効にするもの 3 つ（合成待ち予算の拡大・海底地形タイルの先読み・震度の面の前描き）を崩すと、負荷時に長い文の後半が欠ける、自動フィット直後の暗転が長引く、または寄せている間に震度の面の外側が空のまま映る | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 録画モードで追加復元する 7 項目（気象庁の文・地震の地域と震源要素・確定情報の通し読み・EEW 誤報取消・EEW 最後の告知震源・津波取消・津波が語った原因地震の震源）を崩すと、区間の境目で同じ内容を読み直す（EEW 最後の告知震源と津波が語った原因地震の震源は読み上げを増やす側にも働く。崩すと区間の境目で震源が動いても言い直さない） | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| リプレイ復元で地震の主題を `mergeQuakeInto` で組み立てる規則を崩すと、震源名が空の報が別の地震を吸い込む、または訂正報の名前変更に追随できない | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| 復元の既読にマージ後のカードを使う規則（生の入電を使わない）を崩すと、据え置かれた内容が既読として記録され、後で届く正規の報が省かれる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §2「主な項目の補足」 |
| dev サーバーでの API キー自動投入の条件（dev・DMDSS 版・`--host` なし・未入力）と受け取る側の二重チェック（本番ビルド・テスト）を崩すと、本番へ値が漏れる、または未入力の判定が壊れる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「dev サーバーでの API キー自動投入」 |
| 自前計算を開く門と設定の窓の表示を同じ 1 つの検証結果から出す規則（`useArrivalTokenCheck`）を崩すと、期限の境目で画面表示と機能の開閉が食い違う | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §4.7「検証結果を画面へ出す」 |
| 設定の書き出しと読み込み（API キーは含めない・`sanitize()` 任せ・`rejectedKeys`・バリアント違いは拒否しない・全項目まとめて置換）を崩すと、書いたはずのキーが消える、または新しい項目が既定値に戻らない | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §4.5 |
| `window.__replay` によるリプレイの外部操作を崩すと、録画自動化が UI の文言・レイアウト変更のたびに壊れる | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) |
| 録画ツール向けのイベントログ（読み上げは 1 本ごとに記録・記録失敗は `seq` の飛びとして外から見える）を崩すと、連続した読み上げが融合して 1 本に見える、または記録の欠番から失敗を追えなくなる | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) §4「読み上げ」・§2 |
| 読み上げの持ち主を受信処理の文脈から掴む仕組み（`withReplayTelegramContext`・同期の入口でしか掴めない）を崩すと、持ち主が空のまま記録される | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) §5 |
| 画面の変化の記録を「状態を書き換える唯一の口」へ寄せる規則（`quakeOverlayChangeLog`）を崩すと、書き手を足すたびに記録が抜ける | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) §4「画面の変化」 |
| 高頻度イベントを出さない方針を崩すと、バッファが埋まる | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) §6 |
| 既存の共有 ref（`activeTabRef`）を録画用途へ流用しない規則を崩すと、一度も描かれていない中間値で判断してしまう | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) §4「画面の変化」 |
| `voicevox.ts`・`alertSound.ts` に電文の概念を持ち込まない分離原則を崩すと、合成・再生層と電文の意味づけが混ざる | [`recording-interface-spec.md`](../../docs/spec/recording-interface-spec.md) §6 |
| 例外の受け止め方（3 層＝根・地図・各タブ・`App` 自身のレンダー例外は根でしか拾えない）を崩すと、地図だけを包んだつもりが周辺の要素も一緒に消える、または `App` 自身の例外を取りこぼす | [`architecture-spec.md`](../../docs/spec/architecture-spec.md) §4.6 |
| 取得の失敗・制限を知らせる通知の文の形（`{状態}（{行動または内訳}）`・主節は言い切り）を崩すと、狭いパネルで文が折り返して何本出ているか読めなくなる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §5.5「通知の文の形」 |
| precache の上限・予算・拾う拡張子・出力先を `scripts/precacheBudget.ts`・`scripts/buildOutDir.ts` の外へ書き戻す、または `package.json` のビルドから検査を外すと、**検査だけが無効になる**（型チェックもビルドも通り、落ちるのは上限まで達してから）。この結線は `npm test` が検査するので、**テストを飛ばして `npm run build` だけ回したときに気づけない** | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §5「上限の手前で止める」 |

## 行動チェックリスト

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 発火経路を3つ（EEW・強震モニタ・地震情報）より減らすと、その経路でしか気づけない揺れを見逃す | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「出す条件 — 3 つの経路」 |
| 同時に成立したものを緊急度の順で見て最初の1つだけを出す規則を崩すと、最後に評価したものが勝ちEEW発報中に「ありました」という過去形へ落ちる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「同時に成立したら緊急度の順」 |
| EEWが複数あるとき受け取った順の最初の1件で打ち切ると、後発のより強い地震の予想を見落とす | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「同時に成立したら緊急度の順」 |
| 設定で「出さない」に切り替えたとき判定側の早期returnだけで済ませると、既に開いている帯が手動で閉じるまで残り続ける | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §7「エッジケース」 |
| 3経路とも真偽ではなく判定に使った範囲の最大震度を返す規則を崩すと、判定した範囲と表示する震度がずれる（自宅の区域で判定したのに全国最大をバッジに出す） | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「返すのは「判定に使った範囲の最大震度」」 |
| 地点があるとき半径30km（`NEARBY_RADIUS_KM`）で絞らず最寄り1点や近い順K点で代表させると、前者はその1点が止まった瞬間に判定が死に、後者は観測点が疎な地域で数百km先の点までまったく別の場所の揺れとして数え入れる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §3「なぜ半径で切るか」 |
| 「近くに観測点が無い」と「近くの観測点が揺れていない」を分けず後者まで全国基準へ倒すと、遠方の地震で毎回出ることになり地点を登録した意味が消える | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §3「「近くに観測点が無い」と「近くの観測点が揺れていない」は別物」 |
| 「載っていない」から言えることを電文の粒度（観測点持ちか区域だけか）で分けず一律に扱うと、震度速報しか届いていない窓で判定を保留し、続報が届く前に別の地震が起きるとその地震を二度と評価できなくする | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §3「「載っていない」から何が言えるかは電文の粒度で決まる」 |
| 強震モニタで検知エンジンが確定したメンバーの保持値ではなく生値を見ると、機器異常など地震でない1点の跳ね上がりがそのまま表示震度になる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「なぜ検知エンジンを通すか」 |
| エンジンが詰まった（`stalled`）間に判定を保留せず、強震モニタの帯を出している間も地震情報へ落とす経路を残すと、揺れの最中に「ありました」という過去形へ差し替わる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「なぜ検知エンジンを通すか」 |
| 半径内の確定メンバーが全欠測のときに全国基準へ倒さないと、近くの観測点がまとめて途絶した最も情報が要る場面で経路が黙って止まる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「出す条件 — 3 つの経路」 |
| リアルタイム震度が発表震度より高く振れることを表示側で指標名として明示しないと、同じ画面の地震カードの発表震度と食い違って見える | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「表示する震度は発表震度と一致しない」・[`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §5「強震モニタ経路だけ指標名を出す」 |
| 震度0を閾値によらず対象外にする規則を崩すと、震度0と震度1の階級値が同じ（どちらも10）であるため震度1まで下げた設定で平常時のノイズが閾値を通り帯が鳴りっぱなしになる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「出す条件 — 3 つの経路」 |
| 観測点名の突き合わせに県名を含めると、DMDATAの電文は `pref` が常に空なのでDMDSS版では構造的に1件も一致せず、地点を登録した人ほど判定が死ぬ | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §3「3 つの照合対象」 |
| 地震情報の判定で観測点の点だけを見て区域の点を見ないと、区域別震度しか持たない震度速報（多くの地震で最初に届く報）で何も出せなくなる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「出す条件 — 3 つの経路」 |
| 区域を持たない EEW（予測震度の下限が震度 3 以下の報・区域が補われる前の hypoInfo 由来の報）を、自宅の区域を引けるのに全国基準で判定すると、遠くの地震でも自宅に帯が出る。自前の予測震度で埋めると、自宅に向けて自前の予想を出すことになる。「非常に強い揺れを検知」の報まで区域なしとして捨てると、自宅のすぐ近くで強く揺れていても帯が出ない（この報だけは検知点からの距離で見る） | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「出す条件 — 3 つの経路」 |
| 地図の下端の自作地震計の波形を EEW で出す判定を区域の突き合わせへ戻すと、区域を持たない小さい報で遠くの地震でも出る。範囲の中心をホーム地点へ戻すと、地点が無い端末では全国どこの検知でも出る。普段が読めない観測点の下限を地震カードと同じ「下限なし」へ揃えると、ホストの起動直後に遠くの小さい地震で出る | [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §4.5「EEW の経路は予測計測震度で決める」 |
| 階級表に無い震度を判定・表示から弾かないと、型検査を通らない経路（実地震テストシナリオの手書きJSON等）から来た壊れた値がそのまま使われる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §2「階級表に無い震度は見なかったことにする」 |
| 畳んだままにする3条件（いま畳んでいる・期限内・震度が畳んだときを超えていない）を全部満たすことを崩すと、震度条件が欠けた場合は震度5弱で閉じたあとの震度6強のような引き上げが伝わらない | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「畳んだままにする 3 条件」 |
| 畳んでいる間の揺れで基準の震度を上書きすると、余震で下がっていく値に追随してそのうち小さな揺れでも「上がった」と見なして開いてしまう | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「畳んだままにする 3 条件」 |
| リロード時に記録があっても畳んだ状態から始めないと、閉じたあとにリロードした端末で次の余震が帯として開き直り閉じた意味が無くなる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「永続化」 |
| 記録の震度を階級表で検証しないと、階級外の値（例: 99）が混入したとき「これを超えたら開き直す」が永久に成立せずリロードでも直らない | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「永続化」 |
| 開いている間も期限で消すと、読んでいる最中にボタンが消えることになる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「寿命」 |
| 寿命の延長判定を表示の更新より後に決めると、「中身が変わらないなら触らない」で先に抜けてしまい、同じ震度が続く揺れで延長が一度も走らずまだ揺れている最中にボタンが消えうる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「寿命」 |
| 消した対象を覚えておかないと、地震情報は最新の1件が長く居座るため消した次の再描画で同じ地震をそのまま出し直してしまう | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §4「寿命」 |
| 強震モニタだけで検知した揺れの識別子で時刻を丸めると、EEWも地震情報も無い窓で続けて起きた別々の地震（群発・離れた2地域の同時発生）が同じものとして扱われる | [`action-checklist-spec.md`](../../docs/spec/action-checklist-spec.md) §7「エッジケース」 |

## 共有カード

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 撮影で寄せ直さずに画面の構図のまま撮ると、カードと画面の縦横比が違うぶん余計な範囲まで写り込む（縦長の画面から 16:9 で撮ると横へ 2 倍以上）。カメラを動かす関数を `camera.ts` の寄せる関数の外に足すと、その寄せは目標として覚えられず、撮影が古い目標へ寄せ直す | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「追従の目標へ寄せ直す」 |
| 撮影の寄せ直しと戻しに `beginProgrammaticFlight` の印を渡さないと、印の無いカメラ操作はユーザーの手動操作として扱われ、地図の自動追従が `INTERACTION_HOLD_SEC`（30秒）止まる。撮影の間に来た追従の寄せを預からず動かすと、タイルを待つ間に撮影の寸法のまま飛び始めて構図が崩れる（寄せる関数の冒頭の `beginFit` を通さない寄せを足したときも同じ） | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「追従の目標へ寄せ直す」 |
| 仮定震源要素（震源未確定）の緊急地震速報の共有カードで規模を出すと、地震学的に意味を持たない仮の値を画像へ焼き込むことになる（画像は後から訂正できない） | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §3「カードの構成」 |
| 出典を描いているものだけに絞らず、地図へレイヤーを足したときに `ATTRIBUTION_SOURCES` と載せる条件を見直さないと、描いていないものを挙げて読み手が画像の中に見つけられない、または描いているのに挙げず帰属表示の欠落になる（プレート境界PB2002は帰属表示自体が利用条件） | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §4「出典と注意文」 |
| 緊急地震速報の注意文の要否を地図のモードで判定すると、予報円と震源はモードに関わらず描かれるため、予報円が写っているのに注意文が無い画像を作ってしまう | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §4「出典と注意文」 |
| WebGLキャンバスの写し取り（`ctx.drawImage`）を `render` コールバックの同期実行の外（`toBlob()` 等の非同期API）で行うと、フレームバッファは既に捨てられており空の画像を撮ることになる | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「フレームバッファは同期の窓でしか読めない」 |
| `preserveDrawingBuffer` を撮影のたびに切り替えようとしても、Mapの初期化オプションで実行時には変えられないため、地図を作り直さない限り効かない（レイヤー・データを丸ごと積み直すことになる） | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「フレームバッファは同期の窓でしか読めない」 |
| 撮影中に地図コンテナの親を切り抜かないと、描く寸法が画面の地図領域より大きいとき広げた分がそのまま隣のパネルへはみ出して見える。描く寸法を出力寸法の CSS px にすると、画面の地図領域が小さい端末ほど記号が画像に対して小さくなる。自前の描画レイヤーが `window.devicePixelRatio` を直に読むと、撮影のときだけ点や線が小さく描かれる | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「カードの縦横比でレンダーし直す」 |
| 撮影後の後始末（寸法・切り抜き・地図の再計測・静止画の除去）を個別に囲わず束ねて実行すると、途中の1つが失敗した時点で以降が飛び、とくに静止画の除去に届かないと地図が撮影直前の画で覆われたままになる（リロードするまで戻らない） | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「後始末は 1 つずつ」 |
| 津波の観測棒・到達確認マーカー（`maplibregl.Marker` のDOM要素）を撮影後の2Dキャンバスへ描き直さないと画像から消える。描き直しを撮影の同期窓の外（復元後）で行うと `map.project()` が画面寸法で答え、棒が別の場所に立つ | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §5「地図キャンバスに写らないもの」 |
| 共有先の本文を見出しと別の材料で組み立てると、画像と本文で違うことを述べる矛盾したカードになる | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §6「本文の中身」 |
| 緊急地震速報の注意文・出典を本文にも重ねると、Xの全角140字にほぼ届き（震源名が長いと超える）利用者が削ることになり、削られた結果注意文そのものが落ちうる | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §6「本文の中身」 |
| DMDSS版から共有した本文にDMDSS版のURLを載せると、DMDATA.JPのAPIキーが要るため受け取った人がそのまま開くと設定画面に突き当たる | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §6「本文の中身」 |
| 共有シートを持たない環境で、本文をクリップボードへ置けたか確かめずにボタンの表示を変えると、置けていないのに「コピーしました」と見せてしまい利用者は貼り付け先で初めて気づく | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §6「共有シートを持たない環境」 |
| 表示を分ける判定に `textCopied` だけを使うと、共有シートが応じた正常系（クリップボードは使っていない）も偽になり「置けなかった」と同じ扱いになる | [`share-card-spec.md`](../../docs/spec/share-card-spec.md) §6「共有シートを持たない環境」 |

## テストとリプレイ

**テストボタンの電文は、実配信で起こり得る形だけにすること。** 収録した実電文はそのまま流し、標本が無い形だけを書き換えで作る。以下は個別に見つかっている具体例。

| 項目 | 単一情報源となる仕様書 |
|---|---|
| 台本の素材（どの地震のどの報か）を差し替えたとき設定の窓の説明文（震源名・規模・震度・件数・秒数が焼き込んである）を追随させないと、押したときに流れるものと説明文が食い違う | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「ボタン一覧」 |
| 書き換えで報を作るとき、報番号を進めず直前の電文に印を立てて最終報にする・取消を新規発表の形で作るなど実配信に無い形にすると、続報固有の挙動（差分読み上げ・見出しの続報表記等）や取消・解除特有の経路を実機で確認できなくなる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「実配信に無い形を作らない」 |
| 取消・解除電文に予想（震源座標・予想震度・区域）を残すと、実配信にない形になる | [`eew-spec.md`](../../docs/spec/eew-spec.md) §8「誤報取消（明示的な取消電文）」・[`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §3「3 経路の解除フロー」 |
| 台本の基準（`anchor`）を取り違えると、地震情報・津波では未来の発表時刻を持つ報が届き、緊急地震速報では到達までの秒読みが過ぎた形で出る | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「時刻は「いま」へ寄せる」 |
| 実測時刻を観測状況確定時刻より後にしない規則、区域地点の到達予想は未来にする規則のいずれかを崩すと、まだ来ていない波を観測したことになる、または実測が届いた地点の到達予想が消えるという実配信と違う形になる | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §4「観測状況を確定した時刻」・§9「区域の到達状況」 |
| 区域の到達状況と実測の組み合わせ規則を崩すと、実配信に存在しない組み合わせ（「まもなく到達」の区域に実測がある等）を作ってしまう | [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9「区域の到達状況」「実測との関係」 |
| EEWの警報コードを予想震度5弱未満の区域に使う、または種別コード（未到達・到達済み・PLUM法）とarrivalTimeの整合を崩すと、警報コードと予想震度の対応が電文仕様と食い違う、または「主要動の到達（予測）」欄にその区域が出ない | [`eew-spec.md`](../../docs/spec/eew-spec.md) §4「区域の種別コード」「到達予測時刻は種別によって意味が変わる」 |
| 区域を持たない報の条件を実際の発表条件と違う基準に置き換えると、PLUM法2点以上で区域を持つ実在報・深さの例外規定を反映しない誤った深発報を再現してしまう | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「実配信に無い形を作らない」・[`eew-spec.md`](../../docs/spec/eew-spec.md) §4「上限を定めない予想の扱い」「仮定震源要素の扱い」 |
| 深発地震テストの続報を予報級のまま固定する規則を崩し警報級へ格上げすると、実配信にない形になる（気象庁は深さ150km超の地震に、PLUM法による2点以上の震度予測がある場合を除いて警報を発表せず、このテストは区域を持たないのでその例外に当たらない） | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「実配信に無い形を作らない」 |
| 同じ事実を両バリアントで違う形に作ると、落ちる欄の二重管理が戻る。台本が `onlyIn` で分けてよいのは、電文そのものが片方の受信元から届かないときだけ | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §7「バリアントで中身を変えない」 |
| 補完対象種別の列挙（`HISTORY_EXTRA_TYPES`）に新種別を足し忘れると、その種別だけ初期状態（24時間）で足りない分が復元されない | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」 |
| 初期状態・本編で既に流れた種別を補完対象から除かず、注入を初期状態より後に置かないと、履歴側の古い報が新しい値を上書きしてしまう | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」 |
| 履歴の帯（`nankai`/`nankaiCommentary`/`kohatsu`/`quakeNotice`/`earthquakeCount`）を種別ごとに最新 1 通へ畳む、または同じ受信時刻で取消を発表より先に並べると、取消が空振りして取り消された帯が出る（並べ方は仕様書） | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」 |
| 初期状態の材料（24 時間の電文＋履歴の津波・帯・長周期）を 1 本にまとめず後から別経路で流すと、記憶の復元を通らず、24 時間より前から続く津波の最初の続報を新たな発表として読む | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」 |
| 履歴の津波の報を `id` だけで突き合わせると、報番号が種別ごとに別々なので別種別の報を「既にある」と取り違え、24 時間より前の報が 1 通も足されない（鍵は id・発表時刻・情報名）。期限を伝えていない津波を 24 時間より先まで生かすと、終わった津波が甦る | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」 |
| 推計震度分布図を履歴の補完で種別ごとに畳む（`historyExtraKey` を電文ごとの鍵から外す）と、同じ地震かの判定が受け手（`upsertEstimatedIntensity`）と 2 か所に分かれ、別の地震の分布が消える。二進電文の解析結果を最後の断片の id にしか控えないと、その日のアーカイブを毎回落とす | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」・[`quake-spec.md`](../../docs/spec/quake-spec.md) §8「地震ごとに 1 通を持ち、同じ地震の古い報は採らない」 |
| ライブ接続時の初回履歴で同じ補完（`HISTORY_EXTRA_TYPES`）を行わないと、7日間表示されるはずの帯・長周期がリロードのたびに消える | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」 |
| 地震カードの一覧をライブ接続時の初回履歴と別の範囲で復元する（初期状態の 24 時間と同じ扱いにする・DMDSS 版で件数を打ち切る）、または再生中に「もっと見る」を出すと、ライブ接続時と見え方が食い違う、または押した際にライブの最新履歴が混ざり再生時刻より未来の地震が一覧に入る | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「地震カードの履歴はライブ接続時と同じ範囲で遡る」 |
| 履歴の取得が失敗したときに再生そのものを止めると、一覧が薄くなるだけで済むはずの失敗が電文の再生を止めてしまう。成功したときに揃うのを待たずに再生を始めると、初期状態を 1 本の材料で作れない | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「地震カードの履歴はライブ接続時と同じ範囲で遡る」 |
| 実地震テストシナリオで電文から新しく時刻を読むようにしたら時刻シフトの対象へ足すことを崩すと、その時刻だけが収録当時の絶対値のまま画面に出る（全部の欄を埋めた見本のテストが落とす。ただし受信処理・統合が後から付ける欄は見本から外してあり、そこは捕まらない） | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6 |
| テスト時刻設定のバリアント差（standardはP2PQuakeの日付クエリ、DMDSSはDMDATAアーカイブ＋当日ぶんの別経路。EEWはどちらも取得元が異なりstandardでは強震モニタ側の検知に頼る）を崩すと、バリアントごとの取得経路の違いを実機で確認できなくなる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「テスト時刻設定」 |
| archiveリプレイの重複排除（目録に載るXML版／JSON版のどちらを採用するか）を崩す、またはアーカイブが全滅したときに強震モニタの再生まで止めると、失敗の封じ込め範囲が崩れる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「テスト時刻設定」配下 |
| アーカイブが無い日を埋める当日経路の日付基準（アーカイブはJST日、`/v2/telegram`・`/v2/gd/eew` はUTCの半開区間）を取り違える、または予報（`eew.forecast`）を受けている人にVXSE43をライブ・当日経路のどちらかで取り込ませると、担当日の重複判定が壊れる、または対応するVXSE45の警報報と同一内容の複製が区域塗りを削る | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「当日ぶんの取得元」 |
| リプレイの取りこぼしの分母を取得元の日数ではなくアーカイブの本数で取る、または当日経路の3本の一覧を隔離しないと、取得元が当日経路1本しか無い窓で電文0件のまま「再生中」になる、またはEEW一覧の一時障害で地震・津波も巻き込んで再生ごと止まる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「取りこぼしの扱い」 |
| `ConnectionStatus` の `replay` を `disconnected` と混ぜると、再生中なのに地図に切断警告が出る | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「再生中はライブ接続を止める（接続状態の表示）」 |
| 再生中の予約（EEWの自動解除・津波の失効）を再生時計の「いま」へ潰すと、最終報の直後にEEWが消え猶予が無くなる | [`settings-pwa-spec.md`](../../docs/spec/settings-pwa-spec.md) §6「再生中も予約は発火時刻を待つ」 |

各仕様書は冒頭で「食い違う場合は実コードを正とする」と宣言している。放置すると即座に嘘になる文書なので、実装変更時に必ず追従させる。
