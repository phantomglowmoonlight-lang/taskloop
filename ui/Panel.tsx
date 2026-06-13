/**
 * TaskLoop 插件 - 前端主面板
 * 任務管線編輯器與執行監控介面
 * 提供管線 CRUD、任務/條件編輯、執行狀態輪詢等完整 UI
 * 使用 @hana/plugin-sdk 與 @hana/plugin-components
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { hana } from '@hana/plugin-sdk';
import {
  Button,
  EmptyState,
  HanaThemeProvider,
  Select,
  TextInput,
} from '@hana/plugin-components';
import '@hana/plugin-components/styles.css';
import './panel.css';
import BlueprintEditor from './BlueprintEditor';

import type {
  Pipeline,
  Task,
  GlobalCondition,
  TaskCondition,
  GlobalConditionType,
  TaskConditionType,
  ConditionAction,
  PipelineFormData,
  SessionMessage,
} from './types';

// ─── 常數定義 ─────────────────────────────────────────────

const API_BASE = `${window.location.origin}/api/plugins/taskloop`;
const POLL_INTERVAL_MS = 2000;

// 從頁面 URL 提取 token（HanaAgent 注入的認證參數）
const TOKEN = new URLSearchParams(window.location.search).get('token') || '';

/** 建構 API URL，自動附加 token 查詢參數 */
function apiUrl(path: string): string {
  if (!TOKEN) return `${API_BASE}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}${path}${sep}token=${encodeURIComponent(TOKEN)}`;
}

/** 是否為手機螢幕 */
const IS_MOBILE = typeof window !== 'undefined' && window.innerWidth < 768;

type ThemeMode = 'inherit' | 'hana' | 'custom';

/** 全局條件類型中文標籤 */
const GLOBAL_CONDITION_LABELS: Record<GlobalConditionType, string> = {
  after_tasks_count: '完成特定任務數後',
  after_time: '執行超過時間後',
  max_failures: '累計失敗次數後',
  custom: '自訂條件',
};

/** 任務條件類型中文標籤 */
const TASK_CONDITION_LABELS: Record<TaskConditionType, string> = {
  on_success: '任務成功時',
  on_failure: '任務失敗時',
  repeat_until: '重複直到條件滿足',
  custom: '自訂條件',
};

/** 動作中文標籤 */
const ACTION_LABELS: Record<ConditionAction, string> = {
  continue: '繼續執行',
  retry: '重試任務',
  skip_next: '跳過下一個',
  jump_to: '跳轉到指定任務',
  jump_to_task: '跳轉到指定任務',
  terminate: '終止管線',
  repeat: '重複此任務',
  pause: '暫停管線',
  repeat_from: '從指定任務重複',
};

// ─── 輔助函數 ────────────────────────────────────────────

/** 生成唯一 ID */
function generateId(): string {
  return crypto.randomUUID();
}

/** 取得可用的全局條件類型選項 */
function getGlobalConditionTypeOptions(): { value: string; label: string }[] {
  return Object.entries(GLOBAL_CONDITION_LABELS).map(([value, label]) => ({ value, label }));
}

/** 取得可用的任務條件類型選項 */
function getTaskConditionTypeOptions(): { value: string; label: string }[] {
  return Object.entries(TASK_CONDITION_LABELS).map(([value, label]) => ({ value, label }));
}

/** 取得全局條件可用的動作選項 */
function getGlobalActionOptions(): { value: string; label: string }[] {
  return [
    { value: 'pause', label: ACTION_LABELS.pause },
    { value: 'jump_to_task', label: ACTION_LABELS.jump_to_task },
    { value: 'repeat_from', label: ACTION_LABELS.repeat_from },
    { value: 'terminate', label: ACTION_LABELS.terminate },
  ];
}

/** 取得任務條件可用的動作選項 */
function getTaskActionOptions(): { value: string; label: string }[] {
  return [
    { value: 'continue', label: ACTION_LABELS.continue },
    { value: 'retry', label: ACTION_LABELS.retry },
    { value: 'skip_next', label: ACTION_LABELS.skip_next },
    { value: 'jump_to', label: ACTION_LABELS.jump_to },
    { value: 'terminate', label: ACTION_LABELS.terminate },
    { value: 'repeat', label: ACTION_LABELS.repeat },
  ];
}

/** 取得條件類型的設定欄位描述 */
function getConditionConfigFields(type: string): { key: string; label: string; type: 'number' | 'text'; placeholder?: string; suffix?: string }[] {
  switch (type) {
    case 'after_tasks_count':
      return [{ key: 'count', label: '完成', type: 'number' as const, placeholder: '任務數', suffix: '個任務後' }];
    case 'after_time':
      return [{ key: 'minutes', label: '執行超過', type: 'number' as const, placeholder: '分鐘', suffix: '分鐘後' }];
    case 'max_failures':
      return [{ key: 'count', label: '累計失敗', type: 'number' as const, placeholder: '次數', suffix: '次後' }];
    case 'repeat_until':
      return [{ key: 'condition', label: '重複直到', type: 'text' as const, placeholder: '條件描述（例如：輸出包含關鍵字）' }];
    case 'custom':
      return [{ key: 'condition', label: '自訂條件', type: 'text' as const, placeholder: '請輸入條件' }];
    default:
      return [];
  }
}

/** 建立預設任務 */
function createDefaultTask(orderIndex: number, existingTasks?: Task[]): Task {
  return {
    id: generateId(),
    orderIndex,
    name: `任務 ${orderIndex + 1}`,
    prompt: '',
    repeat: 1,
    repeatCount: 0,
    conditions: [],
    status: 'pending',
    result: '',
    startedAt: null,
    completedAt: null,
  };
}

/** 建立預設全局條件 */
function createDefaultGlobalCondition(): GlobalCondition {
  return {
    id: generateId(),
    type: 'after_tasks_count',
    config: { count: 5 },
    action: 'pause',
    actionTarget: null,
  };
}

/** 建立預設任務條件 */
function createDefaultTaskCondition(): TaskCondition {
  return {
    id: generateId(),
    type: 'on_success',
    config: {},
    action: 'continue',
    actionTarget: null,
  };
}

// ─── API 函數 ─────────────────────────────────────────────

async function fetchPipelines(): Promise<Pipeline[]> {
  const res = await fetch(apiUrl('/pipelines'));
  if (!res.ok) throw new Error(`Failed to fetch pipelines: ${res.status}`);
  const json = await res.json();
  return json.pipelines || json;
}

async function createPipeline(data: PipelineFormData): Promise<Pipeline> {
  const res = await fetch(apiUrl('/pipelines'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to create pipeline: ${res.status}`);
  const json = await res.json();
  return json.pipeline || json;
}

async function updatePipeline(id: string, data: PipelineFormData): Promise<Pipeline> {
  const res = await fetch(apiUrl(`/pipelines/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update pipeline: ${res.status}`);
  const json = await res.json();
  return json.pipeline || json;
}

async function deletePipeline_(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/pipelines/${id}`), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete pipeline: ${res.status}`);
}

async function executePipeline_(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/pipelines/${id}/execute`), { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to execute pipeline: ${res.status}`);
}

async function terminatePipeline_(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/pipelines/${id}/terminate`), { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to terminate pipeline: ${res.status}`);
}

// ─── 面板主元件 ──────────────────────────────────────────

function Panel() {
  const rootEl = document.getElementById('root');
  const surface = rootEl?.dataset.surface || 'page';

  // 主題
  const [themeMode, setThemeMode] = useState<ThemeMode>('inherit');

  // 檢視模式：blueprint | form
  const [viewMode, setViewMode] = useState<'blueprint' | 'form'>('blueprint');

  // 管線列表狀態
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [isNewPipeline, setIsNewPipeline] = useState(false);

  // 手機側欄開關
  const [sidebarOpen, setSidebarOpen] = useState(!IS_MOBILE);

  // 編輯狀態
  const [formData, setFormData] = useState<PipelineFormData>({
    name: '',
    description: '',
    tasks: [],
    globalConditions: [],
  });
  const [expandedConditionsTaskId, setExpandedConditionsTaskId] = useState<string | null>(null);
  const [expandedGlobalConditions, setExpandedGlobalConditions] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');

  // Session 檢視器狀態
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<{agentId: string; lastActivity: string | null; createdAt: string}[]>([]);
  const [sessionMessages, setSessionMessages] = useState<Record<string, SessionMessage[]>>({});
  const [expandedSessionAgent, setExpandedSessionAgent] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // AI 生成狀態
  const [generating, setGenerating] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 選取的管線物件
  const selectedPipeline = useMemo(
    () => pipelines.find((p) => p.id === selectedPipelineId) || null,
    [pipelines, selectedPipelineId],
  );

  // 所選管線的執行狀態（用於狀態面板）
  const livePipeline = useMemo(
    () => {
      if (!selectedPipelineId) return null;
      return pipelines.find((p) => p.id === selectedPipelineId) || selectedPipeline;
    },
    [pipelines, selectedPipelineId, selectedPipeline],
  );

  // 表單是否被修改過（與所選管線相比，包括 tasks 和條件）
  const hasChanges = useMemo(() => {
    if (!selectedPipeline) return isNewPipeline;
    if (selectedPipeline.name !== formData.name) return true;
    if (selectedPipeline.description !== formData.description) return true;
    if (JSON.stringify(selectedPipeline.tasks) !== JSON.stringify(formData.tasks)) return true;
    if (JSON.stringify(selectedPipeline.globalConditions) !== JSON.stringify(formData.globalConditions)) return true;
    return false;
  }, [selectedPipeline, formData, isNewPipeline]);

  // ─── 初始化 ──────────────────────────────────────────

  useEffect(() => {
    // 通知 HanaAgent 宿主頁面已就緒（iframe 內必須呼叫，否則宿主轉圈）
    // 在獨立瀏覽器中此呼叫會安全失敗（被 catch 攔截）
    try {
      hana.ready();
      hana.ui.resize({ height: surface === 'widget' ? 420 : 720 });
    } catch {
      // 獨立瀏覽器模式：hana host API 不可用，安全忽略
    }
    loadPipelines();
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [surface]);

  // ─── 載入管線列表 ──────────────────────────────────

  async function loadPipelines() {
    try {
      setLoading(true);
      setListError(null);
      const data = await fetchPipelines();
      setPipelines(data);
    } catch (err) {
      setListError('無法載入管線列表，請確認伺服器是否正常');
    } finally {
      setLoading(false);
    }
  }

  // ─── 選擇管線 ────────────────────────────────────────

  function selectPipeline(pipeline: Pipeline) {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setSelectedPipelineId(pipeline.id);
    setIsNewPipeline(false);
    setFormData({
      name: pipeline.name,
      description: pipeline.description,
      agentId: pipeline.agentId || 'coder',
      prompt: pipeline.prompt || '',
      frameworkIds: pipeline.frameworkIds || [],
      tasks: pipeline.tasks.map((t) => ({ ...t, conditions: t.conditions.map((c) => ({ ...c })) })),
      globalConditions: pipeline.globalConditions.map((g) => ({ ...g })),
    });
    setExpandedConditionsTaskId(null);
    setExpandedGlobalConditions(false);
    setIsRunning(pipeline.status === 'running' || pipeline.status === 'paused');
    setExecError(null);
    setSaveStatus('idle');
  }

  // ─── 新增管線 ────────────────────────────────────────

  function startNewPipeline() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setSelectedPipelineId(null);
    setIsNewPipeline(true);
    setFormData({
      name: '',
      description: '',
      agentId: 'coder',
      prompt: '',
      frameworkIds: [],
      tasks: [],
      globalConditions: [],
    });
    setExpandedConditionsTaskId(null);
    setExpandedGlobalConditions(false);
    setIsRunning(false);
    setExecError(null);
    setSaveStatus('idle');
  }

  // ─── 表單欄位更新 ────────────────────────────────────

  function updateName(name: string) {
    setFormData((prev) => ({ ...prev, name }));
  }

  function updateDescription(description: string) {
    setFormData((prev) => ({ ...prev, description }));
  }

  function updatePrompt(prompt: string) {
    setFormData((prev) => ({ ...prev, prompt }));
  }

  // ─── 任務 CRUD ────────────────────────────────────────

  function addTask() {
    setFormData((prev) => ({
      ...prev,
      tasks: [...prev.tasks, createDefaultTask(prev.tasks.length, prev.tasks)],
    }));
  }

  function removeTask(taskId: string) {
    setFormData((prev) => {
      const filtered = prev.tasks.filter((t) => t.id !== taskId);
      // 重新計算 orderIndex
      const reindexed = filtered.map((t, i) => ({ ...t, orderIndex: i }));
      return { ...prev, tasks: reindexed };
    });
    if (expandedConditionsTaskId === taskId) {
      setExpandedConditionsTaskId(null);
    }
  }

  function updateTask(taskId: string, field: string, value: unknown) {
    setFormData((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, [field]: value } : t)),
    }));
  }

  // ─── 任務條件 CRUD ──────────────────────────────────

  function addTaskCondition(taskId: string) {
    setFormData((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? { ...t, conditions: [...t.conditions, createDefaultTaskCondition()] }
          : t,
      ),
    }));
  }

  function removeTaskCondition(taskId: string, conditionId: string) {
    setFormData((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? { ...t, conditions: t.conditions.filter((c) => c.id !== conditionId) }
          : t,
      ),
    }));
  }

  function updateTaskCondition(taskId: string, conditionId: string, field: string, value: unknown) {
    setFormData((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              conditions: t.conditions.map((c) =>
                c.id === conditionId ? { ...c, [field]: value } : c,
              ),
            }
          : t,
      ),
    }));
  }

  function handleTaskConditionTypeChange(taskId: string, conditionId: string, newType: string) {
    const isGlobalType = ['after_tasks_count', 'after_time', 'max_failures'].includes(newType);
    // 根據類型決定初始 config
    let config: Record<string, unknown> = {};
    if (newType === 'repeat_until' || newType === 'custom') {
      config = { condition: '' };
    }
    // 如果選到了全局類型，當作 custom 處理
    if (isGlobalType) {
      config = { condition: '' };
    }
    updateTaskCondition(taskId, conditionId, 'type', newType as TaskConditionType);
    updateTaskCondition(taskId, conditionId, 'config', config);
    // 重置 action 為安全預設值
    updateTaskCondition(taskId, conditionId, 'action', 'continue');
  }

  // ─── 全局條件 CRUD ─────────────────────────────────

  function addGlobalCondition() {
    setFormData((prev) => ({
      ...prev,
      globalConditions: [...prev.globalConditions, createDefaultGlobalCondition()],
    }));
  }

  function removeGlobalCondition(conditionId: string) {
    setFormData((prev) => ({
      ...prev,
      globalConditions: prev.globalConditions.filter((c) => c.id !== conditionId),
    }));
  }

  function updateGlobalCondition(conditionId: string, field: string, value: unknown) {
    setFormData((prev) => ({
      ...prev,
      globalConditions: prev.globalConditions.map((c) =>
        c.id === conditionId ? { ...c, [field]: value } : c,
      ),
    }));
  }

  function handleGlobalConditionTypeChange(conditionId: string, newType: string) {
    let config: Record<string, unknown> = {};
    switch (newType) {
      case 'after_tasks_count':
        config = { count: 5 };
        break;
      case 'after_time':
        config = { minutes: 30 };
        break;
      case 'max_failures':
        config = { count: 3 };
        break;
      case 'custom':
        config = { condition: '' };
        break;
    }
    updateGlobalCondition(conditionId, 'type', newType as GlobalConditionType);
    updateGlobalCondition(conditionId, 'config', config);
  }

  // ─── 條件設定欄位更新 ──────────────────────────────

  function handleConditionConfigChange(
    condition: GlobalCondition | TaskCondition,
    key: string,
    value: unknown,
    updateFn: (id: string, field: string, value: unknown) => void,
    id: string,
  ) {
    updateFn(id, 'config', { ...condition.config, [key]: value });
  }

  // ─── 儲存 ──────────────────────────────────────────────

  async function handleSave() {
    if (saveStatus === 'saving') return;
    try {
      setSaveStatus('saving');
      setExecError(null);
      const data: PipelineFormData = {
        name: formData.name || '未命名管線',
        description: formData.description,
        agentId: formData.agentId,
        tasks: formData.tasks,
        globalConditions: formData.globalConditions,
      };

      let saved: Pipeline;
      if (isNewPipeline) {
        saved = await createPipeline(data);
      } else if (selectedPipelineId) {
        saved = await updatePipeline(selectedPipelineId, data);
      } else {
        throw new Error('無效的狀態：沒有選取的管線');
      }

      // 更新列表
      setPipelines((prev) => {
        const idx = prev.findIndex((p) => p.id === saved.id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = saved;
          return copy;
        }
        return [...prev, saved];
      });
      setSelectedPipelineId(saved.id);
      window.__taskloop_lastSavedId = saved.id;
      setIsNewPipeline(false);
      // 同步 formData 以反映已儲存狀態
      setFormData({
        name: saved.name,
        description: saved.description,
        tasks: saved.tasks.map((t) => ({ ...t, conditions: t.conditions.map((c) => ({ ...c })) })),
        globalConditions: saved.globalConditions.map((g) => ({ ...g })),
      });
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      setSaveStatus('error');
      setExecError(err instanceof Error ? err.message : '儲存失敗');
    }
  }

  // ─── 執行 ──────────────────────────────────────────────

  async function handleExecute() {
    try {
      setExecError(null);

      // 新管線或尚未儲存：先儲存取得 id
      let pipelineId = selectedPipelineId;
      if (!pipelineId || isNewPipeline || hasChanges) {
        await handleSave();
        // handleSave 會 setSelectedPipelineId，但 React state 非同步
        // 從全域變數或 ref 取最新 id
        pipelineId = window.__taskloop_lastSavedId || selectedPipelineId;
      }

      if (!pipelineId) {
        setExecError('無法取得管線 ID，請先儲存');
        return;
      }

      await executePipeline_(pipelineId);
      setIsRunning(true);
      setPipelines((prev) =>
        prev.map((p) =>
          p.id === pipelineId ? { ...p, status: 'running' as const } : p,
        ),
      );
    } catch (err) {
      setExecError(err instanceof Error ? err.message : '啟動執行失敗');
    }
  }

  // ─── 終止 ──────────────────────────────────────────────

  async function handleTerminate() {
    if (!selectedPipelineId) return;
    try {
      setExecError(null);
      await terminatePipeline_(selectedPipelineId);
      setIsRunning(false);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      // 更新本地狀態
      setPipelines((prev) =>
        prev.map((p) =>
          p.id === selectedPipelineId ? { ...p, status: 'terminated' as const } : p,
        ),
      );
    } catch (err) {
      setExecError(err instanceof Error ? err.message : '終止執行失敗');
    }
  }

  // ─── 刪除管線 ──────────────────────────────────────────

  async function handleDeletePipeline() {
    if (!selectedPipelineId) return;
    if (!window.confirm('確定要刪除此管線？此操作無法復原。')) return;
    try {
      await deletePipeline_(selectedPipelineId);
      setPipelines((prev) => prev.filter((p) => p.id !== selectedPipelineId));
      setSelectedPipelineId(null);
      setIsNewPipeline(false);
      setFormData({ name: '', description: '', agentId: 'coder', prompt: '', frameworkIds: [], tasks: [], globalConditions: [] });
      setIsRunning(false);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      setExecError(err instanceof Error ? err.message : '刪除失敗');
    }
  }

  // ─── Session 檢視器 ───────────────────────────────────

  async function toggleSessions() {
    if (showSessions) {
      setShowSessions(false);
      return;
    }
    setShowSessions(true);
    setLoadingSessions(true);
    try {
      const res = await fetch(apiUrl('/sessions'));
      const json = await res.json();
      if (json.ok && json.sessions) {
        setSessions(json.sessions);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadSessionMessages(agentId: string) {
    if (expandedSessionAgent === agentId) {
      setExpandedSessionAgent(null);
      return;
    }
    setExpandedSessionAgent(agentId);
    if (!sessionMessages[agentId]) {
      try {
        const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(agentId)}`));
        const json = await res.json();
        if (json.ok && json.messages) {
          setSessionMessages((prev) => ({ ...prev, [agentId]: json.messages }));
        }
      } catch (err) {
        console.error(`Failed to load messages for ${agentId}:`, err);
      }
    }
  }

  // ─── AI 生成 ────────────────────────────────────────────

  async function handleGenerate(prompt: string) {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    try {
      const res = await fetch(apiUrl('/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          frameworkIds: formData.frameworkIds,
          agentId: formData.agentId,
        }),
      });
      const json = await res.json();
      if (json.ok && json.tasks) {
        setFormData((prev) => ({
          ...prev,
          name: json.name || prev.name,
          description: json.description || prev.description,
          tasks: json.tasks,
          globalConditions: json.globalConditions || [],
        }));
        // 如果是新增管線模式，自動切到有內容狀態
        if (json.name) {
          updateName(json.name);
        }
      } else {
        console.error('AI 生成失敗:', json.error, json.raw);
        alert(`AI 生成失敗：${json.error || '未知錯誤'}`);
      }
    } catch (err) {
      console.error('AI 生成請求失敗:', err);
      alert(`請求失敗：${err instanceof Error ? err.message : '未知錯誤'}`);
    } finally {
      setGenerating(false);
    }
  }

  // ─── 狀態輪詢 ──────────────────────────────────────────

  useEffect(() => {
    if (isRunning && selectedPipelineId) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(apiUrl(`/pipelines/${selectedPipelineId}`));
          if (!res.ok) throw new Error('Poll failed');
          const json = await res.json();
          const pipeline: Pipeline = json.pipeline || json;
          setPipelines((prev) =>
            prev.map((p) => (p.id === pipeline.id ? pipeline : p)),
          );
          if (
            pipeline.status === 'completed' ||
            pipeline.status === 'terminated' ||
            pipeline.status === 'idle'
          ) {
            setIsRunning(false);
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        } catch {
          // 輪詢失敗時靜默處理
        }
      }, POLL_INTERVAL_MS);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isRunning, selectedPipelineId]);

  // ─── 主題 ──────────────────────────────────────────────

  const customTheme = useMemo(
    () => (themeMode === 'custom' ? { bg: '#F7F4EF', bgCard: '#FFFDF8', accent: '#537D96' } : undefined),
    [themeMode],
  );

  // ─── 渲染：左側邊欄 ────────────────────────────────────

  function renderSidebar() {
    const sidebarClass = `tl-sidebar${IS_MOBILE && sidebarOpen ? ' tl-sidebar--open' : ''}`;

    return (
      <>
        {IS_MOBILE && (
          <div
            className={`tl-sidebar-backdrop${sidebarOpen ? ' tl-sidebar-backdrop--visible' : ''}`}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside className={sidebarClass}>
          <div className="tl-sidebar-header">
            <h2 className="tl-sidebar-title">管線列表</h2>
            <Button variant="primary" onClick={() => { startNewPipeline(); if (IS_MOBILE) setSidebarOpen(false); }}>
              + 新增
            </Button>
          </div>

          <div className="tl-sidebar-list">
            {loading && (
              <div className="tl-sidebar-loading">載入中...</div>
            )}
            {listError && (
              <div className="tl-sidebar-error">
                <span>{listError}</span>
                <Button variant="ghost" onClick={loadPipelines}>
                  重試
                </Button>
              </div>
            )}
            {!loading && !listError && Array.isArray(pipelines) && pipelines.length === 0 && (
              <EmptyState
                title="尚未建立管線"
                description="點擊「+ 新增」按鈕建立你的第一個任務管線。"
              />
            )}
            {!loading &&
              !listError &&
              Array.isArray(pipelines) && pipelines.map((pipeline) => {
                const isActive = pipeline.id === selectedPipelineId;
                const statusIcon = getStatusIcon(pipeline.status);
                return (
                  <button
                    key={pipeline.id}
                    className={`tl-sidebar-item ${isActive ? 'tl-sidebar-item--active' : ''}`}
                    onClick={() => { selectPipeline(pipeline); if (IS_MOBILE) setSidebarOpen(false); }}
                  >
                    <span className="tl-sidebar-item-icon">{statusIcon}</span>
                    <div className="tl-sidebar-item-info">
                      <span className="tl-sidebar-item-name">{pipeline.name}</span>
                      <span className="tl-sidebar-item-meta">
                        {pipeline.tasks.length} 個任務
                      </span>
                    </div>
                  </button>
                );
              })}
            {isNewPipeline && (
              <div className="tl-sidebar-item tl-sidebar-item--new">
                <span className="tl-sidebar-item-icon">✏️</span>
                <div className="tl-sidebar-item-info">
                  <span className="tl-sidebar-item-name">新管線（未儲存）</span>
                </div>
              </div>
            )}
          </div>
        </aside>
      </>
    );
  }

  // ─── 渲染：條件設定欄位 ──────────────────────────────

  function renderConditionConfigFields(
    condition: GlobalCondition | TaskCondition,
    onConfigChange: (key: string, value: unknown) => void,
  ) {
    const fields = getConditionConfigFields(condition.type);
    if (fields.length === 0) return null;

    const config = condition.config || {};

    return (
      <div className="tl-cond-config-fields">
        {fields.map((field) =>
          field.type === 'number' ? (
            <div className="tl-cond-config-row" key={field.key}>
              <span className="tl-cond-config-label">{field.label}</span>
              <input
                type="number"
                className="tl-cond-config-input"
                value={(config[field.key] as number) ?? 0}
                onChange={(e) =>
                  onConfigChange(field.key, parseInt(e.target.value, 10) || 0)
                }
                min={0}
                placeholder={field.placeholder}
              />
              {field.suffix && (
                <span className="tl-cond-config-suffix">{field.suffix}</span>
              )}
            </div>
          ) : (
            <div className="tl-cond-config-row" key={field.key}>
              <span className="tl-cond-config-label">{field.label}</span>
              <input
                type="text"
                className="tl-cond-config-input tl-cond-config-input--text"
                value={(config[field.key] as string) ?? ''}
                onChange={(e) => onConfigChange(field.key, e.target.value)}
                placeholder={field.placeholder}
              />
            </div>
          ),
        )}
      </div>
    );
  }

  // ─── 渲染：任務條件編輯器 ──────────────────────────────

  function renderTaskConditionsEditor(taskId: string, conditions: TaskCondition[]) {
    return (
      <div className="tl-cond-section">
        {conditions.length === 0 && (
          <div className="tl-cond-empty">暫無條件設定。點擊下方按鈕新增條件。</div>
        )}
        {conditions.map((cond, idx) => {
          const taskActions = getTaskActionOptions();
          return (
            <div className="tl-cond-item" key={cond.id}>
              <div className="tl-cond-item-header">
                <span className="tl-cond-item-number">條件 {idx + 1}</span>
                <button
                  className="tl-cond-remove"
                  onClick={() => removeTaskCondition(taskId, cond.id)}
                  title="刪除條件"
                >
                  ✕
                </button>
              </div>
              <div className="tl-cond-item-body">
                <div className="tl-cond-field">
                  <label className="tl-cond-field-label">類型</label>
                  <Select
                    value={cond.type}
                    onChange={(v) => handleTaskConditionTypeChange(taskId, cond.id, v)}
                    options={getTaskConditionTypeOptions()}
                  />
                </div>
                {renderConditionConfigFields(cond, (key, value) =>
                  handleConditionConfigChange(
                    cond,
                    key,
                    value,
                    (_, field, val) => {
                      setFormData((prev) => ({
                        ...prev,
                        tasks: prev.tasks.map((t) =>
                          t.id === taskId
                            ? {
                                ...t,
                                conditions: t.conditions.map((c) =>
                                  c.id === cond.id ? { ...c, [field]: val } : c,
                                ),
                              }
                            : t,
                        ),
                      }));
                    },
                    cond.id,
                  ),
                )}
                <div className="tl-cond-field">
                  <label className="tl-cond-field-label">動作</label>
                  <Select
                    value={cond.action}
                    onChange={(v) => updateTaskCondition(taskId, cond.id, 'action', v)}
                    options={taskActions}
                  />
                </div>
                {(cond.action === 'jump_to' || cond.action === 'jump_to_task') && (
                  <div className="tl-cond-field">
                    <label className="tl-cond-field-label">目標任務</label>
                    <Select
                      value={cond.actionTarget ?? ''}
                      onChange={(v) => updateTaskCondition(taskId, cond.id, 'actionTarget', v || null)}
                      options={[
                        { value: '', label: '-- 選擇任務 --' },
                        ...formData.tasks.map((t) => ({
                          value: t.id,
                          label: `${t.orderIndex + 1}. ${t.name || '未命名'}`,
                        })),
                      ]}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <Button variant="ghost" onClick={() => addTaskCondition(taskId)}>
          + 新增條件
        </Button>
      </div>
    );
  }

  // ─── 渲染：全局條件編輯器 ──────────────────────────────

  function renderGlobalConditionsEditor() {
    const conditions = formData.globalConditions;
    return (
      <div className="tl-section">
        <button
          className="tl-section-toggle"
          onClick={() => setExpandedGlobalConditions(!expandedGlobalConditions)}
        >
          <span className={`tl-chevron ${expandedGlobalConditions ? 'tl-chevron--open' : ''}`}>▶</span>
          全局條件
          {conditions.length > 0 && (
            <span className="tl-badge">{conditions.length}</span>
          )}
        </button>
        {expandedGlobalConditions && (
          <div className="tl-section-content">
            <div className="tl-cond-section">
              {conditions.length === 0 && (
                <div className="tl-cond-empty">暫無全局條件設定。</div>
              )}
              {conditions.map((cond, idx) => {
                const globalActions = getGlobalActionOptions();
                return (
                  <div className="tl-cond-item" key={cond.id}>
                    <div className="tl-cond-item-header">
                      <span className="tl-cond-item-number">全局條件 {idx + 1}</span>
                      <button
                        className="tl-cond-remove"
                        onClick={() => removeGlobalCondition(cond.id)}
                        title="刪除條件"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="tl-cond-item-body">
                      <div className="tl-cond-field">
                        <label className="tl-cond-field-label">類型</label>
                        <Select
                          value={cond.type}
                          onChange={(v) => handleGlobalConditionTypeChange(cond.id, v)}
                          options={getGlobalConditionTypeOptions()}
                        />
                      </div>
                      {renderConditionConfigFields(cond, (key, value) =>
                        handleConditionConfigChange(
                          cond,
                          key,
                          value,
                          (id, _field, val) =>
                            updateGlobalCondition(id, 'config', {
                              ...cond.config,
                              [key]: val,
                            }),
                          cond.id,
                        ),
                      )}
                      <div className="tl-cond-field">
                        <label className="tl-cond-field-label">動作</label>
                        <Select
                          value={cond.action}
                          onChange={(v) => updateGlobalCondition(cond.id, 'action', v)}
                          options={globalActions}
                        />
                      </div>
                      {(cond.action === 'jump_to_task' || cond.action === 'repeat_from') && (
                        <div className="tl-cond-field">
                          <label className="tl-cond-field-label">目標任務</label>
                          <Select
                            value={cond.actionTarget ?? ''}
                            onChange={(v) =>
                              updateGlobalCondition(cond.id, 'actionTarget', v || null)
                            }
                            options={[
                              { value: '', label: '-- 選擇任務 --' },
                              ...formData.tasks.map((t) => ({
                                value: t.id,
                                label: `${t.orderIndex + 1}. ${t.name || '未命名'}`,
                              })),
                            ]}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <Button variant="ghost" onClick={addGlobalCondition}>
                + 新增全局條件
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── 渲染：任務卡片 ────────────────────────────────────

  function renderTaskCard(task: Task) {
    const isExpanded = expandedConditionsTaskId === task.id;

    return (
      <div className={`tl-task-card ${isExpanded ? 'tl-task-card--expanded' : ''}`}>
        <div className="tl-task-card-header">
          <span className="tl-task-card-index">{task.orderIndex + 1}.</span>
          <div className="tl-task-card-fields">
            <TextInput
              label="任務名稱"
              value={task.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                updateTask(task.id, 'name', e.currentTarget.value)
              }
            />
          </div>
          <button
            className="tl-task-card-remove"
            onClick={() => removeTask(task.id)}
            title="刪除任務"
          >
            ✕
          </button>
        </div>

        <div className="tl-task-card-prompt">
          <label className="tl-task-card-label">Prompt</label>
          <textarea
            className="tl-task-card-textarea"
            value={task.prompt}
            onChange={(e) => updateTask(task.id, 'prompt', e.target.value)}
            placeholder="輸入 AI 任務指示..."
            rows={3}
          />
        </div>

        <div className="tl-task-card-repeat">
          <label className="tl-task-card-label">重複次數</label>
          <input
            type="number"
            className="tl-number-input"
            value={task.repeat}
            onChange={(e) =>
              updateTask(task.id, 'repeat', Math.max(1, parseInt(e.target.value, 10) || 1))
            }
            min={1}
          />
          <span className="tl-task-card-label tl-task-card-label--inline">次</span>
        </div>

        <div className="tl-task-card-conditions">
          <button
            className="tl-task-card-toggle"
            onClick={() =>
              setExpandedConditionsTaskId(isExpanded ? null : task.id)
            }
          >
            <span className={`tl-chevron ${isExpanded ? 'tl-chevron--open' : ''}`}>▶</span>
            條件設定
            {task.conditions.length > 0 && (
              <span className="tl-badge">{task.conditions.length}</span>
            )}
          </button>
          {isExpanded && renderTaskConditionsEditor(task.id, task.conditions)}
        </div>
      </div>
    );
  }

  // ─── 渲染：執行狀態面板 ────────────────────────────────

  function renderExecutionStatus() {
    if (!livePipeline || (livePipeline.status !== 'running' && livePipeline.status !== 'completed' && livePipeline.status !== 'terminated' && livePipeline.status !== 'paused')) {
      return null;
    }

    const pipeline = livePipeline;
    const tasks = Array.isArray(pipeline.tasks) ? pipeline.tasks : [];
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === 'completed').length;
    const failedTasks = tasks.filter((t) => t.status === 'failed').length;
    const runningTask = tasks.find((t) => t.status === 'running');
    const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return (
      <div className="tl-section tl-execution-status">
        <div className="tl-section-title-bar">
          <span className="tl-section-title">執行狀態</span>
          <span className={`tl-status-badge tl-status-badge--${pipeline.status}`}>
            {pipeline.status === 'running' && '● 執行中'}
            {pipeline.status === 'paused' && '⏸ 已暫停'}
            {pipeline.status === 'completed' && '✓ 已完成'}
            {pipeline.status === 'terminated' && '■ 已終止'}
          </span>
        </div>

        <div className="tl-progress-bar">
          <div
            className="tl-progress-fill"
            style={{ width: `${progressPct}%` }}
          />
          <span className="tl-progress-text">
            {completedTasks} / {totalTasks} 完成
          </span>
        </div>

        <div className="tl-task-status-list">
          {tasks.map((task) => {
            const statusClass = `tl-task-status-item tl-task-status-item--${task.status}`;
            const label =
              task.status === 'running'
                ? '執行中'
                : task.status === 'completed'
                  ? '已完成'
                  : task.status === 'failed'
                    ? '失敗'
                    : task.status === 'skipped'
                      ? '已跳過'
                      : '等待中';
            return (
              <div className={statusClass} key={task.id}>
                <span className="tl-task-status-icon">
                  {task.status === 'running' && '●'}
                  {task.status === 'completed' && '✓'}
                  {task.status === 'failed' && '✕'}
                  {task.status === 'skipped' && '→'}
                  {task.status === 'pending' && '○'}
                </span>
                <span className="tl-task-status-name">
                  {task.orderIndex + 1}. {task.name || '未命名'}
                </span>
                <span className="tl-task-status-label">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── 渲染：Session 檢視器 ──────────────────────────────

  function renderSessionViewer() {
    if (loadingSessions) {
      return (
        <div className="tl-editor-content">
          <p style={{ padding: '2rem', color: 'var(--hana-plugin-text-muted, #888)' }}>載入 Session 列表中...</p>
        </div>
      );
    }

    return (
      <div className="tl-editor-content">
        <h2 style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>Agent Session</h2>
        <p style={{ marginBottom: 16, color: 'var(--hana-plugin-text-muted, #888)', fontSize: 13 }}>
          每個 Agent 有一個專屬 Session。點擊展開查看對話記錄。
        </p>
        {sessions.length === 0 ? (
          <EmptyState
            title="尚無 Session"
            description="執行管線時會自動為各 Agent 建立 Session。"
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sessions.map((s) => (
              <div
                key={s.agentId}
                className={`tl-section ${expandedSessionAgent === s.agentId ? '' : ''}`}
              >
                <button
                  className="tl-section-toggle"
                  onClick={() => loadSessionMessages(s.agentId)}
                >
                  <span className={`tl-chevron ${expandedSessionAgent === s.agentId ? 'tl-chevron--open' : ''}`}>▶</span>
                  <strong>{s.agentId}</strong>
                  {s.lastActivity && (
                    <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--hana-plugin-text-muted, #888)' }}>
                      最後活動: {new Date(s.lastActivity).toLocaleString()}
                    </span>
                  )}
                </button>
                {expandedSessionAgent === s.agentId && (
                  <div className="tl-section-content" style={{ maxHeight: 500, overflowY: 'auto' }}>
                    {sessionMessages[s.agentId]?.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {sessionMessages[s.agentId].map((msg, i) => (
                          <div
                            key={i}
                            style={{
                              padding: '8px 12px',
                              borderRadius: 8,
                              background: msg.role === 'user'
                                ? 'var(--hana-plugin-accent-light, rgba(83, 125, 150, 0.06))'
                                : 'var(--hana-plugin-bg, #f8f5ed)',
                              borderLeft: msg.role === 'assistant'
                                ? '3px solid var(--hana-plugin-accent, #537d96)'
                                : '3px solid transparent',
                            }}
                          >
                            <div style={{ fontSize: 11, color: 'var(--hana-plugin-text-muted, #888)', marginBottom: 4 }}>
                              {msg.role === 'user' ? '👤 User' : msg.role === 'assistant' ? '🤖 AI' : '⚙ System'}
                              {msg.timestamp && ` · ${new Date(msg.timestamp).toLocaleString()}`}
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p style={{ color: 'var(--hana-plugin-text-muted, #888)', fontSize: 13, fontStyle: 'italic' }}>
                        暂無訊息記錄
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── 渲染：管線編輯器 ──────────────────────────────────

  function renderPipelineEditor() {
    return (
      <div className="tl-editor-content">
        <div className="tl-editor-info">
          <TextInput
            label="管線名稱"
            value={formData.name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateName(e.currentTarget.value)
            }
            placeholder="輸入管線名稱"
          />
          <TextInput
            label="描述"
            value={formData.description}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateDescription(e.currentTarget.value)
            }
            placeholder="簡短描述此管線的用途"
          />
          <label className="tl-task-card-label" style={{marginTop:4}}>主負責 Agent</label>
          <Select
            value={formData.agentId}
            onChange={(v) => setFormData((prev) => ({ ...prev, agentId: v }))}
            options={[
              { value: 'coder', label: '1號程序員 (coder)' },
              { value: 'hanako', label: '木頭助理 (hanako)' },
              { value: 'hi', label: '2號程序員 (hi)' },
              { value: 'pm', label: '產品經理 (pm)' },
            ]}
          />
        </div>

        <div className="tl-section">
          <div className="tl-section-title-bar">
            <span className="tl-section-title">任務列表</span>
            <Button variant="ghost" onClick={addTask}>
              + 新增任務
            </Button>
          </div>
          {formData.tasks.length === 0 ? (
            <EmptyState
              title="尚無任務"
              description="點擊「+ 新增任務」按鈕來加入第一個 AI 任務。"
            />
          ) : (
            <div className="tl-task-list">
              {formData.tasks.map((task) => renderTaskCard(task))}
            </div>
          )}
        </div>

        {renderGlobalConditionsEditor()}

        {renderExecutionStatus()}

        {execError && (
          <div className="tl-error-banner">
            <span>{execError}</span>
            <button className="tl-error-close" onClick={() => setExecError(null)}>
              ✕
            </button>
          </div>
        )}

        {selectedPipelineId && (
          <div className="tl-editor-actions">
            <Button variant="danger" onClick={handleDeletePipeline}>
              刪除管線
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ─── 取得管線狀態圖標 ──────────────────────────────────

  function getStatusIcon(status: string): string {
    switch (status) {
      case 'running':
        return '▶';
      case 'paused':
        return '⏸';
      case 'completed':
        return '✓';
      case 'terminated':
        return '■';
      default:
        return '○';
    }
  }

  // ─── 主渲染 ────────────────────────────────────────────

  return (
    <HanaThemeProvider
      mode={themeMode}
      theme={customTheme || (themeMode === 'hana' ? 'warm-paper' : undefined)}
      className="plugin-panel"
    >
      <div className="tl-container" data-surface={surface}>
        {/* 頂部工具列 */}
        <header className="tl-toolbar">
          <div className="tl-toolbar-left">
            {IS_MOBILE && (
              <button
                className="tl-hamburger"
                onClick={() => setSidebarOpen((prev) => !prev)}
                aria-label="切換側欄"
              >
                {sidebarOpen ? '✕' : '☰'}
              </button>
            )}
            <h1 className="tl-title">TaskLoop</h1>
            <Select
              value={themeMode}
              onChange={(v) => setThemeMode(v as ThemeMode)}
              options={[
                { value: 'inherit', label: '跟隨主題' },
                { value: 'hana', label: '暖色' },
                { value: 'custom', label: '自訂' },
              ]}
            />
            <div className="tl-view-toggle">
              <button
                className={`tl-view-btn ${viewMode === 'blueprint' ? 'tl-view-btn--active' : ''}`}
                onClick={() => setViewMode('blueprint')}
              >
                🧊 Blueprint
              </button>
              <button
                className={`tl-view-btn ${viewMode === 'form' ? 'tl-view-btn--active' : ''}`}
                onClick={() => setViewMode('form')}
              >
                📝 表單
              </button>
            </div>
            <Button
              variant="ghost"
              onClick={toggleSessions}
            >
              {showSessions ? '✕ 關閉' : '📋 Sessions'}
            </Button>
          </div>
          <div className="tl-toolbar-actions">
            <Button
              variant="primary"
              onClick={handleExecute}
              disabled={
                isRunning ||
                formData.tasks.length === 0 ||
                (!selectedPipelineId && !isNewPipeline)
              }
            >
              {isRunning ? '⏸ 執行中' : '▶ 執行'}
            </Button>
            <Button
              variant="danger"
              onClick={handleTerminate}
              disabled={!isRunning}
            >
              ■ 終止
            </Button>
            <Button
              variant="ghost"
              onClick={handleSave}
              disabled={
                saveStatus === 'saving' ||
                (!selectedPipelineId && !isNewPipeline)
              }
            >
              {saveStatus === 'saving'
                ? '儲存中...'
                : saveStatus === 'success'
                  ? '✓ 已儲存'
                  : saveStatus === 'error'
                    ? '✕ 儲存失敗'
                    : '💾 儲存'}
            </Button>
          </div>
        </header>

        {/* 主要內容區 */}
        <div className="tl-main">
          {renderSidebar()}
          <main className="tl-editor" style={{ padding: viewMode === 'blueprint' ? 0 : undefined, overflow: viewMode === 'blueprint' ? 'hidden' : undefined }}>
            {showSessions ? (
              renderSessionViewer()
            ) : selectedPipelineId || isNewPipeline ? (
              viewMode === 'blueprint' ? (
                <BlueprintEditor
                  tasks={formData.tasks}
                  globalConditions={formData.globalConditions}
                  pipelineName={formData.name}
                  pipelinePrompt={formData.prompt}
                  frameworkIds={formData.frameworkIds}
                  onTasksChange={(tasks) => setFormData((prev) => ({ ...prev, tasks }))}
                  onConditionsChange={(conditions) => setFormData((prev) => ({ ...prev, globalConditions: conditions }))}
                  onNameChange={updateName}
                  onPromptChange={updatePrompt}
                  onFrameworkIdsChange={(ids) => setFormData((prev) => ({ ...prev, frameworkIds: ids }))}
                  onGenerate={handleGenerate}
                  generating={generating}
                />
              ) : (
                renderPipelineEditor()
              )
            ) : (
              <EmptyState
                title="選擇或建立管線"
                description="從左側列表選擇一個管線開始編輯，或點擊「+ 新增」建立新的任務管線。"
              />
            )}
          </main>
        </div>
      </div>
    </HanaThemeProvider>
  );
}

// ─── 掛載 ────────────────────────────────────────────────

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
