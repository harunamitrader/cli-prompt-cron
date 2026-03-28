# Changelog

## [Unreleased]

## [1.3.0] - 2026-03-29

### Added
- **ダッシュボードからジョブの停止・再開**: スケジュール一覧の各カードに「停止」「再開」ボタンを追加。ブラウザからワンクリックでジョブの有効/無効を切り替え可能
- **`PATCH /api/jobs/:name`**: ジョブの `active` フィールドをトグルする API エンドポイントを追加

## [1.2.1] - 2026-03-29

### Changed
- **SKILL.md 根本改修**: AI CLI が余計なファイル（スクリプト・ラッパー等）を作成しないよう、役割定義と行動制約を明示。ジョブ JSON の作成・編集・削除のみに限定

## [1.2.0] - 2026-03-29

### Added
- **デスクトップショートカット自動作成**: `npm install` 時にアイコン付きショートカットをデスクトップに自動生成（Windows / Mac / Linux 対応）
- **ヘッダー画像・アイコン**: `assets/header.jpg`（リポジトリバナー）、`assets/icon.jpg`（アプリアイコン）を追加
- **create-shortcut.bat**: Windows 向け手動ショートカット作成スクリプト
- **scripts/create-shortcut.js**: クロスプラットフォーム対応のショートカット作成スクリプト（postinstall で自動実行）

### Fixed
- **ICO 変換**: `ImageFormat::Icon` が 0 バイトファイルを生成する問題を修正。PNG-in-ICO コンテナ形式で正しく変換
- **ブラウザ起動**: `cmd /c start` が launch.bat と競合する問題を修正。`explorer` に変更
- **ui-server.js 起動エラー**: `__dirname` の定義順序が壊れていた問題を修正
- **package.json 消失**: リネーム時の `git add -A` で削除されていたのを復元
- **launch.bat**: Node.js 存在チェック追加、日本語メッセージの文字化け防止（ASCII のみに変更）、エラー時 pause 追加

## [1.1.0] - 2026-03-28

### Changed
- **プロジェクト名**: `cli-prompt-cron-ui` → `cli-prompt-cron` に統一（旧ヘッドレス版は廃止）
- **データディレクトリ**: `./data/` → プロジェクト内 `./data/` に移動。作業ディレクトリ制限のある環境でも動作可能に
- **SKILL.md パス解決**: 相対パス（`./data/`）から SKILL.md のファイル位置ベース（`<プロジェクトルート>/data/`）に変更。作業ディレクトリに依存しない
- **ターゲット CLI**: Gemini CLI・Codex をメインに。Claude Code は補助的な位置づけに変更
- **ダッシュボード UI**: ダーク系ターミナル風 → クリーム系モダンデザイン（Design B）に刷新
- **README 構成**: 「プロンプトでの導入・使い方」としてStep 1/2/3のフローに再構成。CLI共通のプロンプトに統一

### Added
- **launch.bat**: Windows 向けワンクリック起動バッチファイル（ポート競合自動解消付き）
- **cron 式の日本語変換**: ダッシュボードで `0 9 * * *` → `毎日 09:00` と表示
- **次回実行の相対表示**: `あと2時間`、`明日 09:00` など
- **ライブインジケーター**: ヘッダーに緑点滅の接続状態表示
- **index.html.backup**: 元のダークテーマデザインのバックアップ

## [1.0.1] - 2026-03-28

### Fixed
- **Windows cmd quoting**: `cmd /c` mangled inner double quotes in complex command strings (e.g. `--system-prompt "..." -p "..."`), causing the prompt to arrive as empty. Switched to `powershell -Command` on Windows, which handles quoted arguments correctly.
- **Codex non-interactive mode**: `codex "..."` requires a TTY and fails in cron. Updated SKILL.md to use `codex exec "..."` for non-interactive execution.
- **Claude system prompt confusion**: `--system-prompt "Non-interactive cron agent..."` caused Claude to answer about cron tools instead of the actual task. Revised to a neutral instruction.
- **README**: Fixed placeholder GitHub URL and git clone URL. Corrected result file format (`.txt` not JSON). Added `--system-prompt` to job example. Added Codex `exec` note.

### Added
- **Permission confirmation flow** in SKILL.md: When adding a job, if no permission flags are specified, the AI presents a numbered menu of options (no-permission, Write, Bash, WebSearch, etc.) before creating the job.
- **Automatic system prompt** in SKILL.md: All Claude Code jobs now automatically include `--system-prompt "Execute the task immediately. Do not ask for confirmation or clarification."` to suppress interactive confirmation requests.
- **Natural language setup and usage** instructions in README.

## [1.0.0] - 2026-03-28

### Added
- File-based cron daemon for AI CLIs (Claude Code, Gemini CLI, Codex)
- Browser dashboard at `http://localhost:3300` (vanilla HTML/CSS/JS, no build step)
- Real-time log streaming via Server-Sent Events (SSE)
- Execution results saved per-job to `./data/results/`
- Job management via `./data/jobs/*.json`
- Hot-reload with Chokidar (add / edit / delete jobs without restarting daemon)
- `start.js`: one-command launch — daemon + UI server + auto browser open
- Per-job timezone support
- Graceful shutdown on SIGINT / SIGTERM / SIGBREAK
- Skills for Claude Code, Gemini CLI, Codex (`skills/SKILL.md`)
- API endpoints: `GET /api/jobs`, `GET /api/results`, `GET /api/logs/stream`
