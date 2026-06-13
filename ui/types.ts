/**
 * TaskLoop 插件 - 共用型別定義
 * 任務管線：Unreal Blueprint 式的 AI 任務編排系統
 */

/** 管線狀態 */
export type PipelineStatus = 'idle' | 'running' | 'paused' | 'completed' | 'terminated';

/** 任務狀態 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 全局條件類型 */
export type GlobalConditionType = 'after_tasks_count' | 'after_time' | 'max_failures' | 'custom';

/** 任務條件類型 */
export type TaskConditionType = 'on_success' | 'on_failure' | 'repeat_until' | 'custom';

/** 條件動作 */
export type ConditionAction = 'pause' | 'jump_to_task' | 'repeat_from' | 'terminate'
  | 'continue' | 'retry' | 'skip_next' | 'jump_to' | 'repeat';

/** ─── 框架模板（Framework） ─────────────────────────── */

export interface FrameworkTemplate {
  id: string;
  name: string;
  description: string;
  category: string;              // 分類：code-review / bug-fix / optimize / custom
  promptTemplate: string;        // 指令模板，含 {{placeholder}}
  expectedInputs: string[];      // 預期輸入（如 filePath, branch）
  defaultConditions: string[];   // 預設套用的條件模板 ID
  icon?: string;                 // 圖示 emoji
}

/** ─── 條件模板（Condition Template） ─────────────────── */

export interface ConditionTemplate {
  id: string;
  name: string;
  description: string;
  type: 'cycle' | 'time' | 'count' | 'result' | 'custom';
  configFields: {
    key: string;
    label: string;
    type: 'number' | 'text' | 'select';
    options?: { value: string; label: string }[];
    defaultValue?: string | number;
    placeholder?: string;
  }[];
  availableActions: string[];
  icon?: string;
}

/** 全局條件 */
export interface GlobalCondition {
  id: string;
  type: GlobalConditionType;
  config: Record<string, unknown>;
  action: ConditionAction;
  actionTarget: string | null;
}

/** 任務條件 */
export interface TaskCondition {
  id: string;
  type: TaskConditionType;
  config: Record<string, unknown>;
  action: ConditionAction;
  actionTarget: string | null;
}

/** 單一任務 */
export interface Task {
  id: string;
  orderIndex: number;
  name: string;
  prompt: string;
  agentId?: string;
  dependsOn?: string[];     // 依賴的任務 ID 列表，完成後才執行此任務
  type?: string;             // 任務類型：write / review / fix / analyze / implement / cycle
  repeat: number;
  repeatCount: number;
  conditions: TaskCondition[];
  status: TaskStatus;
  result: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** 管線 */
export interface Pipeline {
  id: string;
  name: string;
  description: string;
  agentId: string;
  // AI 生成模式
  prompt: string;                // 高層級目標 prompt
  frameworkIds: string[];        // 選用的框架 ID 列表
  generatedByAI: boolean;        // 是否由 AI 自動生成
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  globalConditions: GlobalCondition[];
  status: PipelineStatus;
  currentTaskIndex: number;
  startedAt: string | null;
  completedAt: string | null;
}

/** UI 表單資料 */
export interface PipelineFormData {
  name: string;
  description: string;
  agentId: string;
  prompt: string;
  frameworkIds: string[];
  tasks: Task[];
  globalConditions: GlobalCondition[];
}

/** Session 訊息 */
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/** Agent Session 資訊 */
export interface AgentSessionInfo {
  agentId: string;
  sessionPath: string;
  lastActivity: string | null;
  messageCount: number;
}

/** ─── React Flow 節點資料 ───────────────────────────── */

export type NodeType = 'taskNode' | 'startNode' | 'endNode' | 'branchNode' | 'frameworkNode';

export interface TaskNodeData {
  type: 'taskNode';
  task: Task;
  onChange: (taskId: string, field: string, value: unknown) => void;
  onDelete: (taskId: string) => void;
}

export interface StartNodeData {
  type: 'startNode';
  label: string;
}

export interface EndNodeData {
  type: 'endNode';
  label: string;
}

export interface BranchNodeData {
  type: 'branchNode';
  condition: GlobalCondition;
  onChange: (cond: GlobalCondition) => void;
}

export type CustomNodeData = TaskNodeData | StartNodeData | EndNodeData | BranchNodeData;
