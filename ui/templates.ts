/**
 * TaskLoop 插件 - 內建框架與條件模板
 * 使用者可以引用這些模板，AI 也可以根據 prompt 自動套用
 */

import type { FrameworkTemplate, ConditionTemplate } from './types';

/** 內建框架模板 */
export const BUILT_IN_FRAMEWORKS: FrameworkTemplate[] = [
  {
    id: 'fw-code-review',
    name: 'Code Review 審查',
    category: 'code-review',
    description: '對指定程式碼進行全面審查，檢查架構、效能、安全性、程式碼風格',
    promptTemplate: '請對 {{filePath}} 進行完整 code review，檢查：\n1. 架構設計是否合理\n2. 潛在效能瓶頸\n3. 安全性漏洞\n4. 程式碼風格一致性\n5. 可維護性\n\n對每個問題標註嚴重程度（高/中/低），並給出具體改進建議。',
    expectedInputs: ['filePath', 'branch'],
    defaultConditions: ['cond-auto-retry', 'cond-on-fail-notify'],
    icon: '🔍',
  },
  {
    id: 'fw-bug-fix',
    name: 'Bug Fix 修復',
    category: 'bug-fix',
    description: '定位並修復指定 bug，包含復現步驟、根因分析、修復方案、單元測試',
    promptTemplate: '請分析以下 bug 並修復：\n{{description}}\n\n步驟：\n1. 重現 bug 並確認\n2. 根因分析\n3. 提出修復方案\n4. 實作修復\n5. 加入單元測試確保不回歸',
    expectedInputs: ['description', 'filePath', 'reproSteps'],
    defaultConditions: ['cond-cycle-3'],
    icon: '🐛',
  },
  {
    id: 'fw-optimize',
    name: '效能優化',
    category: 'optimize',
    description: '分析並優化程式碼效能，包含演算法改進、資源使用、載入時間',
    promptTemplate: '請對 {{filePath}} 進行效能優化分析：\n1. 瓶頸定位（使用 profiling 結果）\n2. 演算法複雜度分析\n3. 記憶體/資源使用優化\n4. 建議實作\n5. 優化前後對比',
    expectedInputs: ['filePath', 'bottleneck'],
    defaultConditions: [],
    icon: '⚡',
  },
  {
    id: 'fw-ci-workflow',
    name: 'CI/CD 循環工作流',
    category: 'workflow',
    description: '持續整合循環：程式碼審查 → 修 bug → 優化 → 定期推送',
    promptTemplate: '建立持續整合循環：\n目標：{{description}}\n\n循環內容：\n1. 程式碼審查\n2. 修復發現的問題\n3. 效能優化\n4. 每 {{cycleCount}} 次循環，確認所有已知 bug 已修復後，執行 git push',
    expectedInputs: ['description', 'cycleCount'],
    defaultConditions: ['cond-git-push'],
    icon: '🔄',
  },
  {
    id: 'fw-test-gen',
    name: '測試產生器',
    category: 'testing',
    description: '為指定模組產生完整的單元測試和整合測試',
    promptTemplate: '為 {{filePath}} 產生測試：\n1. 單元測試（覆蓋主要函數和邊界情況）\n2. 整合測試（跨模組互動）\n3. Mock 外部依賴\n4. 測試覆蓋率目標 > {{coverage}}%\n\n使用 {{testFramework}} 框架。',
    expectedInputs: ['filePath', 'coverage', 'testFramework'],
    defaultConditions: ['cond-on-fail-notify'],
    icon: '🧪',
  },
  {
    id: 'fw-refactor',
    name: '重構',
    category: 'refactor',
    description: '重構指定模組，改善程式碼結構、可讀性和可維護性',
    promptTemplate: '對 {{filePath}} 進行重構：\n1. 評估當前架構問題\n2. 設計新架構\n3. 逐步重構（確保每一步測試通過）\n4. 更新相關文件\n\n重構目標：{{goal}}',
    expectedInputs: ['filePath', 'goal'],
    defaultConditions: ['cond-auto-retry'],
    icon: '🏗️',
  },
];

/** 內建條件模板 */
export const BUILT_IN_CONDITIONS: ConditionTemplate[] = [
  {
    id: 'cond-cycle-3',
    name: '每 N 次循環執行',
    description: '每執行完指定次數後觸發動作',
    type: 'cycle',
    configFields: [
      { key: 'count', label: '循環次數', type: 'number', defaultValue: 3, placeholder: '次數' },
    ],
    availableActions: ['git_push', 'notify', 'pause', 'log_summary'],
    icon: '🔄',
  },
  {
    id: 'cond-git-push',
    name: 'Git 推送',
    description: '條件滿足時自動推送 git',
    type: 'result',
    configFields: [
      { key: 'branch', label: '分支名稱', type: 'text', defaultValue: 'main', placeholder: 'main' },
      { key: 'requireClean', label: '需無未提交變更', type: 'select', defaultValue: 'true',
        options: [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] },
    ],
    availableActions: ['git_push'],
    icon: '📤',
  },
  {
    id: 'cond-auto-retry',
    name: '自動重試',
    description: '任務失敗時自動重試指定次數',
    type: 'count',
    configFields: [
      { key: 'maxRetries', label: '最大重試次數', type: 'number', defaultValue: 3, placeholder: '次數' },
      { key: 'delayMs', label: '重試間隔（秒）', type: 'number', defaultValue: 10, placeholder: '秒' },
    ],
    availableActions: ['retry'],
    icon: '🔁',
  },
  {
    id: 'cond-on-fail-notify',
    name: '失敗通知',
    description: '任務失敗時發送通知',
    type: 'result',
    configFields: [
      { key: 'channel', label: '通知頻道', type: 'select', defaultValue: 'console',
        options: [{ value: 'console', label: '主控台' }, { value: 'notify', label: '系統通知' }] },
    ],
    availableActions: ['notify', 'pause'],
    icon: '🔔',
  },
  {
    id: 'cond-time-limit',
    name: '時間限制',
    description: '超過指定時間後觸發動作',
    type: 'time',
    configFields: [
      { key: 'minutes', label: '限制時間', type: 'number', defaultValue: 30, placeholder: '分鐘' },
    ],
    availableActions: ['terminate', 'pause', 'notify'],
    icon: '⏱️',
  },
];

/** 取得框架模板依 ID */
export function getFramework(id: string): FrameworkTemplate | undefined {
  return BUILT_IN_FRAMEWORKS.find(fw => fw.id === id);
}

/** 取得條件模板依 ID */
export function getCondition(id: string): ConditionTemplate | undefined {
  return BUILT_IN_CONDITIONS.find(c => c.id === id);
}

/** 依分類取得框架 */
export function getFrameworksByCategory(category: string): FrameworkTemplate[] {
  return BUILT_IN_FRAMEWORKS.filter(fw => fw.category === category);
}

/** 所有框架分類 */
export const FRAMEWORK_CATEGORIES = [
  { id: 'code-review', label: '程式碼審查', icon: '🔍' },
  { id: 'bug-fix', label: 'Bug 修復', icon: '🐛' },
  { id: 'optimize', label: '效能優化', icon: '⚡' },
  { id: 'testing', label: '測試', icon: '🧪' },
  { id: 'refactor', label: '重構', icon: '🏗️' },
  { id: 'workflow', label: '工作流', icon: '🔄' },
  { id: 'custom', label: '自訂', icon: '📝' },
];
