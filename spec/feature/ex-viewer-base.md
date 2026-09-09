# Ex Viewer のベースパス

Ex Viewer 内で画面を開いた場合、Ex が注入する script[data-excubitor-viewer] の
data-prefix を BrowserRouter の basename として使用する。直接アクセス時には
この属性が存在しないため従来のルーティングを維持する。
data-prefix は `/services/concordia` のような同一オリジンの絶対パスとし、末尾の
スラッシュは正規化する。空値、外部 URL、query・fragment、パストラバーサルを含む値は
設定不備として画面の初期化前に明示的に失敗させる。

共通メニュー・通信の中継・Cookie変換は Ex が所有し、このサービスは画面ルートのみを所有する。
サービスへの認可や業務状態は変更しない。Ex の feat/unified-viewer-villa と組み合わせて配備する。
元に戻す場合は basename 属性を外す。直接アクセスは継続して使用できる。

利用者の指示により動作・起動・単体テストは未実施。画面遷移とログインの実機確認は配備時に必要。

所属は既存 http-interface（web/src直下）。UX-CC-W1（対象を見失わず確認する）と
CC-INV-02（権限を維持する）を対象とする表示アダプター変更。業務判断・状態所有の追加はない。
