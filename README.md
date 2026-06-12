# TaskLoop - 任務管線

HanaAgent 插件，提供 Unreal Blueprint 式的 AI 任務編排系統。

插件 ID：`taskloop`

## 功能概述

TaskLoop 讓你可以定義**多步驟任務管線**，AI Agent 會依序執行每個任務，並根據你設定的條件自動決定下一步動作。

### 核心能力

- **任務序列**：定義多個任務，AI 完成一個後自動推進到下一個
- **全局條件**：對整個管線生效的條件（完成 N 個任務後暫停、執行超時終止等）
- **任務條件**：每個任務獨立的條件（成功時跳過後續、失敗時重試等）
- **重複執行**：設定任務重複次數（例如「代碼審查 ×3」）
- **即時狀態**：執行中顯示進度，任務完成/失敗有明確標示
- **終止控制**：隨時可以暫停或終止管線執行

### 條件類型

| 條件 | 作用域 | 說明 | 可用動作 |
|------|--------|------|---------|
| `after_tasks_count` | 全局 | 完成 N 個任務後 | pause, jump_to_task, repeat_from, terminate |
| `after_time` | 全局 | 執行超過 N 分鐘 | pause |
| `max_failures` | 全局 | 累計失敗 N 次 | terminate |
| `on_success` | 任務 | 任務成功完成時 | continue, skip_next, jump_to |
| `on_failure` | 任務 | 任務失敗時 | retry, skip, terminate |
| `repeat_until` | 任務 | 重複直到條件滿足 | repeat |

### 使用場景

1. **程式碼重構管線**：分析 → 重構 → 審查 ×3 → 測試
2. **文件生成管線**：研究 → 撰寫大綱 → 撰寫正文 → 校對 → 格式化
3. **資料處理管線**：擷取 → 清洗 → 分析 → 報告

## 目錄結構

- `manifest.json` — 插件元數據和能力聲明
- `index.js` — 插件生命週期入口、EventBus 處理器、管線執行引擎
- `tools/run-pipeline.js` — Agent 可調用的管線執行工具
- `routes/ui.js` — iframe shell 與管線 API 路由
- `ui/Panel.tsx` — React UI（管線編輯器、執行狀態面板）
- `ui/types.ts` — TypeScript 型別定義
- `ui/panel.css` — UI 樣式
- `vite.config.ts` — Vite 建置設定

## 開發

```bash
npm install
npm run build:ui
npm run typecheck
```

## 安裝

將此資料夾拖入 HanaAgent 設定 > 插件，或放置於 `/api/plugins/settings` 回報的使用者插件目錄。

此插件需要 full-access 權限（iframe UI + EventBus 通訊）。

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/pipelines` | 取得所有管線 |
| POST | `/api/pipelines` | 建立新管線 |
| PUT | `/api/pipelines/:id` | 更新管線 |
| DELETE | `/api/pipelines/:id` | 刪除管線 |

## Agent 工具

| 工具名 | 說明 | 參數 |
|--------|------|------|
| `taskloop_run_pipeline` | 執行指定管線 | `pipelineId` (string) |

## EventBus 事件

| 事件 | 方向 | 說明 |
|------|------|------|
| `taskloop:create-pipeline` | UI → 後端 | 建立管線 |
| `taskloop:start-pipeline` | UI/Agent → 後端 | 開始執行 |
| `taskloop:terminate-pipeline` | UI → 後端 | 終止執行 |
| `taskloop:execution-event` | 後端 → UI | 執行狀態推送 |
