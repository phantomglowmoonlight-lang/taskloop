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

/** 條件觸發後的動作 */
export type ConditionAction = 'pause' | 'jump_to_task' | 'repeat_from' | 'terminate' | 'continue' | 'retry' | 'skip_next' | 'jump_to' | 'repeat';

/** 全局條件 */
export interface GlobalCondition {
  id: string;
  type: GlobalConditionType;
  config: Record<string, unknown>;
  action: ConditionAction;
  actionTarget: string | null; // 目標任務 ID
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
  repeat: number;           // 重複次數，預設 1
  repeatCount: number;      // 已執行次數
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
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  globalConditions: GlobalCondition[];
  status: PipelineStatus;
  currentTaskIndex: number;
  startedAt: string | null;
  completedAt: string | null;
}

/** 建立管線的輸入 */
export interface CreatePipelineInput {
  name: string;
  description?: string;
  tasks?: Omit<Task, 'id' | 'status' | 'result' | 'startedAt' | 'completedAt' | 'repeatCount'>[];
  globalConditions?: GlobalCondition[];
}

/** 管線執行狀態（透過 EventBus 推送給 UI） */
export interface PipelineExecutionEvent {
  type: 'task_started' | 'task_completed' | 'task_failed' | 'pipeline_completed' | 'pipeline_terminated' | 'condition_triggered';
  pipelineId: string;
  taskId?: string;
  taskIndex?: number;
  message?: string;
  timestamp: string;
}

/** UI 專用：條件設定欄位描述 */
export interface ConditionConfigField {
  key: keyof GlobalCondition['config'];
  label: string;
  type: 'number' | 'text';
  placeholder?: string;
}

/** UI 專用：管線表單資料（不含伺服器管理欄位） */
export interface PipelineFormData {
  name: string;
  description: string;
  tasks: Task[];
  globalConditions: GlobalCondition[];
}
