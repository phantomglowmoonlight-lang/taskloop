/**
 * TaskLoop 插件 - 任務管線後端引擎
 *
 * 提供：
 * 1. 管線資料的持久化儲存（CRUD）
 * 2. Agent Session 管理（每個 Agent 一個專屬 Session）
 * 3. EventBus 處理器（taskloop:*）
 * 4. 管線執行引擎（按 Agent 分派任務，發送 prompt 並等待回應）
 */
import {
  definePlugin,
  defineBusHandler,
  HANA_BUS_SKIP,
  sendSessionMessage,
  subscribeSessionEvents,
  createSession,
} from "@hana/plugin-runtime";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════
//  管線儲存層 — pipelines.json
// ═══════════════════════════════════════════════════════════════════════════

const pipelineStore = {
  pipelines: [],
  filePath: null,
  dirty: false,
};

function loadPipelines(filePath) {
  pipelineStore.filePath = filePath;
  try {
    pipelineStore.pipelines = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    pipelineStore.pipelines = [];
  }
}

function flushPipelines() {
  if (!pipelineStore.dirty) return;
  try {
    fs.writeFileSync(pipelineStore.filePath, JSON.stringify(pipelineStore.pipelines, null, 2), "utf-8");
    pipelineStore.dirty = false;
  } catch (err) {
    console.error("[TaskLoop] 無法寫入 pipelines.json:", err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Agent Session 儲存層 — sessions.json
//  Map<agentId, { agentId, sessionPath, createdAt, lastActivity }>
// ═══════════════════════════════════════════════════════════════════════════

const sessionsStore = {
  sessions: {},      // agentId → sessionInfo
  filePath: null,
};

function loadSessions(filePath) {
  sessionsStore.filePath = filePath;
  try {
    sessionsStore.sessions = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    sessionsStore.sessions = {};
  }
}

function flushSessions() {
  try {
    const dir = path.dirname(sessionsStore.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionsStore.filePath, JSON.stringify(sessionsStore.sessions, null, 2), "utf-8");
  } catch (err) {
    console.error("[TaskLoop] 無法寫入 sessions.json:", err);
  }
}

/**
 * 取得或建立某個 Agent 的專屬 Session
 * 每個 Agent 只會建立一次，之後重複使用
 */
async function getAgentSession(ctx, agentId) {
  // 記憶體快取優先
  const existing = sessionsStore.sessions[agentId];
  if (existing && existing.sessionPath) {
    return existing;
  }

  // 建立新 session
  const session = await createSession(ctx, {
    agentId,
    kind: "taskloop",
    visibility: "plugin_private",
    cwd: ctx.dataDir,
  });

  const sessionPath = session.sessionPath || session.path || session.id;
  if (!sessionPath) {
    throw new Error(`建立 Agent "${agentId}" 的 session 成功但無法取得 path`);
  }

  const info = {
    agentId,
    sessionPath,
    createdAt: new Date().toISOString(),
    lastActivity: null,
  };
  sessionsStore.sessions[agentId] = info;
  flushSessions();
  return info;
}

/**
 * 讀取 Agent Session 的最近訊息
 * 回傳 { agentId, messages: [{ role, content, timestamp }] }
 */
function readSessionMessages(agentId, limit = 50) {
  const info = sessionsStore.sessions[agentId];
  if (!info || !info.sessionPath) {
    return { agentId, messages: [] };
  }

  const filePath = info.sessionPath;
  if (!fs.existsSync(filePath)) {
    return { agentId, messages: [] };
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    // 取最後 N 行
    const recent = lines.slice(-limit);

    const messages = [];
    for (const line of recent) {
      try {
        const evt = JSON.parse(line);
        const evtType = evt.type || "";

        // 過濾出 user message 和 assistant response
        if (evtType === "session:conversation:user_message" || evtType.endsWith(":user_message")) {
          messages.push({
            role: "user",
            content: evt.text || evt.content || evt.message || "",
            timestamp: evt.timestamp || evt.createdAt || "",
          });
        } else if (evtType === "session:conversation:response" || evtType.endsWith(":response")) {
          messages.push({
            role: "assistant",
            content: evt.text || evt.content || evt.response || evt.message || "",
            timestamp: evt.timestamp || evt.createdAt || "",
          });
        } else if (evtType === "session:created" || evtType === "session:conversation:started") {
          messages.push({
            role: "system",
            content: `Session 已建立`,
            timestamp: evt.timestamp || evt.createdAt || "",
          });
        }
      } catch {
        // 跳過無法解析的行
      }
    }

    return { agentId, messages };
  } catch (err) {
    console.error(`[TaskLoop] 無法讀取 session 檔案 ${filePath}:`, err);
    return { agentId, messages: [], error: err.message };
  }
}

/** 列舉所有 Agent Sessions */
function listAgentSessions() {
  return Object.entries(sessionsStore.sessions).map(([agentId, info]) => ({
    agentId,
    sessionPath: info.sessionPath,
    lastActivity: info.lastActivity,
    createdAt: info.createdAt,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
//  共用工具函數
// ═══════════════════════════════════════════════════════════════════════════

function uid() { return crypto.randomUUID(); }
function nowISO() { return new Date().toISOString(); }

// ═══════════════════════════════════════════════════════════════════════════
//  管線 CRUD
// ═══════════════════════════════════════════════════════════════════════════

function createPipeline(data) {
  const ts = nowISO();
  const pipeline = {
    id: uid(),
    name: data.name || "未命名管線",
    description: data.description || "",
    agentId: data.agentId || "coder",
    createdAt: ts,
    updatedAt: ts,
    tasks: (data.tasks || []).map((t, i) => ({
      id: uid(),
      orderIndex: i,
      name: t.name || `任務 ${i + 1}`,
      prompt: t.prompt || "",
      agentId: t.agentId || undefined,
      dependsOn: t.dependsOn || [],
      type: t.type || "task",
      repeat: t.repeat ?? 1,
      repeatCount: 0,
      conditions: t.conditions || [],
      status: "pending",
      result: "",
      startedAt: null,
      completedAt: null,
    })),
    globalConditions: data.globalConditions || [],
    status: "idle",
    currentTaskIndex: -1,
    startedAt: null,
    completedAt: null,
  };
  pipelineStore.pipelines.push(pipeline);
  pipelineStore.dirty = true;
  flushPipelines();
  return pipeline;
}

function getPipeline(id) {
  return pipelineStore.pipelines.find((p) => p.id === id) || null;
}

function updatePipeline(id, data) {
  const pipeline = getPipeline(id);
  if (!pipeline) return null;

  if (data.name !== undefined) pipeline.name = data.name;
  if (data.description !== undefined) pipeline.description = data.description;
  if (data.agentId !== undefined) pipeline.agentId = data.agentId;

  if (data.tasks !== undefined) {
    pipeline.tasks = data.tasks.map((t, i) => ({
      id: t.id || uid(),
      orderIndex: i,
      name: t.name || `任務 ${i + 1}`,
      prompt: t.prompt || "",
      agentId: t.agentId || undefined,
      dependsOn: t.dependsOn || [],
      type: t.type || "task",
      repeat: t.repeat ?? 1,
      repeatCount: t.repeatCount ?? 0,
      conditions: t.conditions || [],
      status: t.status || "pending",
      result: t.result || "",
      startedAt: t.startedAt || null,
      completedAt: t.completedAt || null,
    }));
  }

  if (data.globalConditions !== undefined) {
    pipeline.globalConditions = data.globalConditions;
  }

  pipeline.updatedAt = nowISO();
  pipelineStore.dirty = true;
  flushPipelines();
  return pipeline;
}

function deletePipeline(id) {
  const idx = pipelineStore.pipelines.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  pipelineStore.pipelines.splice(idx, 1);
  pipelineStore.dirty = true;
  flushPipelines();
  return true;
}

function listPipelines() {
  return pipelineStore.pipelines;
}

// ═══════════════════════════════════════════════════════════════════════════
//  執行引擎狀態管理
// ═══════════════════════════════════════════════════════════════════════════

const executions = new Map();

function broadcastEvent(ctx, pipelineId, type, taskId, taskIndex, message) {
  ctx.bus.emit("taskloop:execution-event", {
    type,
    pipelineId,
    taskId: taskId || null,
    taskIndex: taskIndex ?? null,
    message: message || "",
    timestamp: nowISO(),
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
//  條件判斷邏輯（與原版相同，略）
// ═══════════════════════════════════════════════════════════════════════════

function countTaskStatuses(pipeline) {
  let completed = 0, failed = 0;
  for (const t of pipeline.tasks) {
    if (t.status === "completed") completed++;
    if (t.status === "failed") failed++;
  }
  return { completed, failed };
}

function checkGlobalConditions(pipeline, ctx) {
  const { completed, failed } = countTaskStatuses(pipeline);
  for (const cond of pipeline.globalConditions) {
    switch (cond.type) {
      case "after_tasks_count": {
        const target = Number(cond.config?.count) || 0;
        if (completed >= target) {
          broadcastEvent(ctx, pipeline.id, "condition_triggered", null, null,
            `全局條件 after_tasks_count 觸發：已完成 ${completed}/${target} 個任務`);
          return applyGlobalConditionAction(cond, pipeline, ctx);
        }
        break;
      }
      case "after_time": {
        if (!pipeline.startedAt) break;
        const minutes = Number(cond.config?.minutes) || 0;
        if (Date.now() - new Date(pipeline.startedAt).getTime() >= minutes * 60000) {
          broadcastEvent(ctx, pipeline.id, "condition_triggered", null, null,
            `全局條件 after_time 觸發：已執行超過 ${minutes} 分鐘`);
          return applyGlobalConditionAction(cond, pipeline, ctx);
        }
        break;
      }
      case "max_failures": {
        normalizeConditionConfig(cond.config);
        const maxFail = Number(cond.config?.count) || 0;
        if (failed >= maxFail && maxFail > 0) {
          broadcastEvent(ctx, pipeline.id, "condition_triggered", null, null,
            `全局條件 max_failures 觸發：已失敗 ${failed}/${maxFail} 次`);
          return applyGlobalConditionAction(cond, pipeline, ctx);
        }
        break;
      }
      case "custom": break;
    }
  }
  return false;
}

function applyGlobalConditionAction(cond, pipeline, ctx) {
  switch (cond.action) {
    case "pause": pipeline.status = "paused"; pipelineStore.dirty = true; flushPipelines(); return true;
    case "terminate":
      pipeline.status = "terminated"; pipeline.completedAt = nowISO();
      for (const t of pipeline.tasks) { if (t.status === "running") { t.status = "failed"; t.completedAt = nowISO(); } }
      pipelineStore.dirty = true; flushPipelines(); broadcastEvent(ctx, pipeline.id, "pipeline_terminated"); return true;
    case "jump_to_task":
      if (cond.actionTarget) { const idx = pipeline.tasks.findIndex(t => t.id === cond.actionTarget); if (idx >= 0) { pipeline.currentTaskIndex = idx; pipelineStore.dirty = true; flushPipelines(); return true; } }
      return false;
    case "repeat_from":
      if (cond.actionTarget) { const idx = pipeline.tasks.findIndex(t => t.id === cond.actionTarget); if (idx >= 0) { pipeline.currentTaskIndex = idx; for (let i = idx; i < pipeline.tasks.length; i++) { pipeline.tasks[i].status = "pending"; pipeline.tasks[i].result = ""; pipeline.tasks[i].startedAt = null; pipeline.tasks[i].completedAt = null; } pipelineStore.dirty = true; flushPipelines(); return true; } }
      return false;
    default: return false;
  }
}

function checkTaskCondition(condition, pipeline, tasks, currentTask, currentIdx, ctx) {
  switch (condition.action) {
    case "continue": return { action: "continue" };
    case "skip_next": if (currentIdx + 1 < tasks.length) { tasks[currentIdx + 1].status = "skipped"; pipelineStore.dirty = true; flushPipelines(); } return { action: "continue" };
    case "jump_to": if (condition.actionTarget) { const idx = tasks.findIndex(t => t.id === condition.actionTarget); if (idx >= 0) { pipeline.currentTaskIndex = idx; pipelineStore.dirty = true; flushPipelines(); return { action: "jump", targetIdx: idx }; } } return { action: "continue" };
    case "retry": currentTask.status = "pending"; currentTask.result = ""; currentTask.startedAt = null; currentTask.completedAt = null; currentTask.repeatCount = 0; pipelineStore.dirty = true; flushPipelines(); return { action: "retry" };
    case "terminate": pipeline.status = "terminated"; pipeline.completedAt = nowISO(); pipelineStore.dirty = true; flushPipelines(); broadcastEvent(ctx, pipeline.id, "pipeline_terminated"); return { action: "terminate" };
    default: return { action: "continue" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  靜態驗證系統（Anti-Hallucination）
// ═══════════════════════════════════════════════════════════════════════════

/** 中文數字映射 */
const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 將 0–9999 的數字轉為 4 位中文數字編號
 * 例：1 → 〇〇〇一, 42 → 〇〇四二, 9999 → 九九九九
 */
function toChineseId(num) {
  const padded = String(num).padStart(4, '0');
  return padded.split('').map(d => CN_DIGITS[parseInt(d, 10)]).join('');
}

/** 靜態驗證表：messageId → { hash, agentId, taskId, timestamp } */
const verificationTable = new Map();
let verificationCounter = 0;

/** 註冊一條將發出的 prompt，回傳其 4 位中文編號 */
function registerMessage(agentId, taskId) {
  verificationCounter++;
  const msgId = toChineseId(verificationCounter);
  verificationTable.set(msgId, {
    agentId,
    taskId,
    index: verificationCounter,
    timestamp: nowISO(),
  });
  return msgId;
}

/**
 * 操作指南 — 每次發送 prompt 給 AI 時帶上
 * 確保 AI 知道自己在哪個系統中、須遵守的規則、以及編號系統
 */
const SYSTEM_OPERATION_GUIDE = `【系統操作指南 — 請嚴格遵守】

你正在 TaskLoop 任務管線系統中執行任務。
每個任務請求都攜帶一個唯一的 4 位中文編號（格式：〇〇〇一）。

規則：
1. 你的回應必須引用你收到的編號，格式：【回應編號：〇〇〇一】
2. 編號是靜態查驗依據，一旦發現編號順序不符或遺漏，系統判定為幻覺
3. 完整執行任務指示，不要跳過步驟
4. 如果有任何不確定的情況，請在回應中明確說明
5. 回應必須對應正確的編號，不可自行偽造或複製舊編號

本次任務編號：`;

/**
 * 驗證 AI 回應中是否包含正確的編號
 * 回傳 { valid, hallucination }
 */
function verifyResponse(msgId, response) {
  // 檢查回應中是否包含正確的編號
  const expectedPattern = msgId;
  if (!response || !response.includes(expectedPattern)) {
    return { valid: false, hallucination: true };
  }
  return { valid: true, hallucination: false };
}

/**
 * 觸發 Session 壓縮（使用 Hanako 標準壓縮機制）
 * 發送壓縮事件至 bus，由 Hana 系統處理
 */
function triggerContextCompression(ctx, sessionPath, agentId, reason) {
  console.warn(`[TaskLoop] 🚨 偵測到幻覺（Agent: ${agentId}），原因：${reason}，開始壓縮上下文`);
  try {
    // 透過 bus 發送壓縮事件
    ctx.bus.emit("taskloop:compression-requested", {
      agentId,
      sessionPath,
      reason,
      timestamp: nowISO(),
    }).catch(() => {});

    // 也直接發送 session 壓縮指令
    sendSessionMessage(ctx, sessionPath, {
      content: "【系統】偵測到幻覺，正在壓縮上下文以重置注意力。請忽略之前的指示，從最新訊息開始。",
    }).catch(() => {});
  } catch (err) {
    console.error("[TaskLoop] 壓縮上下文失敗:", err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  核心執行引擎（支援按 Agent 分派任務 + 靜態驗證）
// ═══════════════════════════════════════════════════════════════════════════

const MAX_CONSECUTIVE_HALLUCINATIONS = 3;

/**
 * 發送 prompt 給 Agent 並等待回應
 * 支援 AbortSignal 中斷
 */
function sendAndWait(ctx, sessionPath, prompt, pipelineId, msgId, agentId, signal) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 300000;
    let settled = false;

    // 如果已經被中止，直接拒絕
    if (signal && signal.aborted) {
      return reject(new Error(`任務已終止（編號 ${msgId}）`));
    }

    const wrappedPrompt = `${SYSTEM_OPERATION_GUIDE}【${msgId}】\n\n${prompt}`;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; unsub(); reject(new Error(`等待 Agent 回應逾時（5 分鐘）— 編號 ${msgId}`)); }
    }, timeoutMs);

    // 監聽中止信號
    const abortHandler = () => {
      if (!settled) {
        settled = true; clearTimeout(timer); unsub();
        reject(new Error(`任務已終止（編號 ${msgId}）`));
      }
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const unsub = subscribeSessionEvents(ctx, sessionPath, (event) => {
      if (settled) return;
      const et = event.type || "";
      if (et === "session:conversation:response" || et === "session:message:response" || et === "session:response" || et.endsWith(":response") || (et.includes("completed") && !et.includes("task") && !et.includes("pipeline"))) {
        const responseText = event.text || event.content || event.response || (typeof event.message === "string" ? event.message : "") || JSON.stringify(event);

        const verdict = verifyResponse(msgId, responseText);
        if (verdict.hallucination) {
          console.warn(`[TaskLoop] ⚠ 幻覺偵測（${agentId}）：回應缺少編號 ${msgId}`);
          triggerContextCompression(ctx, sessionPath, agentId, `回應缺少編號 ${msgId}`);
        }

        settled = true; clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        unsub();
        resolve({
          text: responseText,
          hallucination: verdict.hallucination,
          msgId,
        });
      }
    });

    sendSessionMessage(ctx, sessionPath, { content: wrappedPrompt }).catch((err) => {
      if (!settled) { settled = true; clearTimeout(timer); unsub(); reject(err); }
    });
  });
}

/**
 * 使用 Hanako 標準方式壓縮整個 Agent Session
 */
function compressAgentSession(ctx, agentId, sessionPath) {
  ctx.bus.emit("taskloop:session-compress", {
    agentId, sessionPath, timestamp: nowISO(),
  }).catch(() => {});
}

/**
 * DAG 循環依賴檢測
 * 回傳 true 表示有循環
 */
function hasCycleDependency(tasks) {
  // 建立鄰接表
  const adj = new Map();
  for (const t of tasks) {
    adj.set(t.id, []);
  }
  for (const t of tasks) {
    if (t.dependsOn && t.dependsOn.length > 0) {
      for (const dep of t.dependsOn) {
        // 嘗試比對 ID 或 name
        const target = tasks.find(t2 => t2.id === dep || t2.name === dep);
        if (target && adj.has(target.id)) {
          adj.get(target.id).push(t.id);
        }
      }
    }
  }

  // DFS 檢測循環
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of adj.keys()) color.set(id, WHITE);

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of (adj.get(u) || [])) {
      if (color.get(v) === GRAY) return true; // 找到後向邊 = 循環
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  }

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE && dfs(id)) return true;
  }
  return false;
}

/**
 * 修復條件配置 key 不一致
 * 後端某些地方用 `count`，前端某些地方用 `maxFailures`
 */
function normalizeConditionConfig(config) {
  if (!config) return config;
  // max_failures: 支援 count 或 maxFailures
  if (config.maxFailures !== undefined && config.count === undefined) {
    config.count = config.maxFailures;
  }
  return config;
}

function waitForResume(pipelineId) {
  return new Promise((resolve) => { const exec = executions.get(pipelineId); if (exec) exec.pauseResolve = resolve; });
}

/**
 * 執行完整的管線 — 每個任務會依 agentId 分派到對應的 Agent Session
 */
async function executePipeline(pipeline, ctx) {
  const execCtx = executions.get(pipeline.id);
  if (!execCtx) return;

  // 對 pipeline 中的每個 Agent，先確保 session 已存在
  const agentIds = new Set([pipeline.agentId]);
  for (const t of pipeline.tasks) {
    if (t.agentId) agentIds.add(t.agentId);
  }
  for (const aid of agentIds) {
    try {
      if (!sessionsStore.sessions[aid]) {
        await getAgentSession(ctx, aid);
      }
    } catch (err) {
      console.error(`[TaskLoop] 無法為 Agent "${aid}" 建立 session:`, err);
    }
  }

  // ── DAG 循環依賴檢測 ──
  if (hasCycleDependency(pipeline.tasks)) {
    pipeline.status = "terminated";
    pipeline.completedAt = nowISO();
    pipelineStore.dirty = true; flushPipelines();
    broadcastEvent(ctx, pipeline.id, "pipeline_terminated", null, null, "任務依賴形成循環，管線已終止");
    executions.delete(pipeline.id);
    return;
  }

  try {
    const sortedTasks = [...pipeline.tasks].sort((a, b) => a.orderIndex - b.orderIndex);
    let i = 0;
    const completedIds = new Set();

    while (i < sortedTasks.length) {
      if (pipeline.status === "terminated") break;
      if (pipeline.status === "paused") { await waitForResume(pipeline.id); if (pipeline.status === "terminated") break; }

      const task = sortedTasks[i];

      // ── 依賴檢查 ──
      if (task.dependsOn && task.dependsOn.length > 0) {
        const depsUnmet = task.dependsOn.filter(depId => !completedIds.has(depId));
        if (depsUnmet.length > 0) {
          // 有未完成的依賴，跳過此輪
          i++;
          if (i >= sortedTasks.length) {
            // 回頭檢查之前被跳過的
            i = 0;
          }
          continue;
        }
      }

      pipeline.currentTaskIndex = i;
      pipelineStore.dirty = true; flushPipelines();

      if (task.status === "skipped") { i++; continue; }

      // 決定此任務要發送給哪個 Agent
      const targetAgentId = task.agentId || pipeline.agentId || "coder";
      const sessionInfo = sessionsStore.sessions[targetAgentId];
      if (!sessionInfo || !sessionInfo.sessionPath) {
        throw new Error(`Agent "${targetAgentId}" 沒有可用的 session`);
      }
      const sessionPath = sessionInfo.sessionPath;

      let runCount = 0;
      const maxRepeats = task.repeat || 1;
      while (runCount < maxRepeats) {
        if (pipeline.status === "terminated") break;
        if (pipeline.status === "paused") await waitForResume(pipeline.id);
        if (pipeline.status === "terminated") break;

        task.status = "running";
        task.startedAt = nowISO();
        task.result = "";
        pipelineStore.dirty = true; flushPipelines();

        broadcastEvent(ctx, pipeline.id, "task_started", task.id, i,
          `[${targetAgentId}] 開始執行任務：${task.name}`);

        try {
          // ── 註冊靜態驗證編號 ──
          const msgId = registerMessage(targetAgentId, task.id);

          const signal = execCtx?.abortCtrl?.signal;
          const response = await sendAndWait(ctx, sessionPath, task.prompt, pipeline.id, msgId, targetAgentId, signal);
          if (pipeline.status === "terminated") break;

          const responseText = typeof response === 'object' ? response.text : response;
          const hasHallucination = typeof response === 'object' ? response.hallucination : false;

          task.status = "completed";
          task.result = responseText;
          task.completedAt = nowISO();
          task.repeatCount = runCount + 1;
          pipelineStore.dirty = true; flushPipelines();

          // 註冊完成依賴
          completedIds.add(task.id);
          if (task.name) completedIds.add(task.name);

          // 記錄 session 活動時間
          if (sessionsStore.sessions[targetAgentId]) {
            sessionsStore.sessions[targetAgentId].lastActivity = nowISO();
            flushSessions();
          }

          const completionNote = hasHallucination ? ' ⚠（含幻覺警報）' : '';
          broadcastEvent(ctx, pipeline.id, "task_completed", task.id, i,
            `[${targetAgentId}] 任務完成：${task.name}（第 ${runCount + 1}/${maxRepeats} 次）${completionNote}`);

          const successCond = task.conditions.find(c => c.type === "on_success");
          if (successCond) {
            const result = checkTaskCondition(successCond, pipeline, sortedTasks, task, i, ctx);
            if (result.action === "terminate") break;
            if (result.action === "jump") { i = result.targetIdx; break; }
            if (result.action === "retry") { runCount = 0; continue; }
          }
          runCount++;
        } catch (err) {
          if (pipeline.status === "terminated") break;
          task.status = "failed";
          task.completedAt = nowISO();
          task.result = err.message || String(err);
          pipelineStore.dirty = true; flushPipelines();
          broadcastEvent(ctx, pipeline.id, "task_failed", task.id, i,
            `[${targetAgentId}] 任務失敗：${task.name} - ${err.message}`);
          const failureCond = task.conditions.find(c => c.type === "on_failure");
          if (failureCond) {
            const result = checkTaskCondition(failureCond, pipeline, sortedTasks, task, i, ctx);
            if (result.action === "terminate") break;
            if (result.action === "retry") continue;
          }
          runCount = maxRepeats;
        }
      }
      if (checkGlobalConditions(pipeline, ctx)) break;
      i++;
      if (pipeline.currentTaskIndex >= 0 && pipeline.currentTaskIndex !== i && pipeline.currentTaskIndex < sortedTasks.length) {
        i = pipeline.currentTaskIndex;
      }
    }

    if (pipeline.status === "running") {
      pipeline.status = "completed";
      pipeline.completedAt = nowISO();
      pipeline.currentTaskIndex = -1;
      pipelineStore.dirty = true; flushPipelines();
      broadcastEvent(ctx, pipeline.id, "pipeline_completed");
    }
  } catch (err) {
    console.error("[TaskLoop] 執行引擎錯誤:", err);
    pipeline.status = "terminated";
    pipeline.completedAt = nowISO();
    pipelineStore.dirty = true; flushPipelines();
    broadcastEvent(ctx, pipeline.id, "pipeline_terminated", null, null, err.message);
  } finally {
    executions.delete(pipeline.id);
    flushPipelines();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  EventBus 處理器
// ═══════════════════════════════════════════════════════════════════════════

const createPipelineHandler = defineBusHandler({
  type: "taskloop:create-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.name) return { ok: false, error: "缺少必要欄位：name" };
    return { ok: true, pipeline: createPipeline(payload) };
  },
});

const getPipelineHandler = defineBusHandler({
  type: "taskloop:get-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    const pipeline = getPipeline(payload.id);
    return pipeline ? { ok: true, pipeline } : { ok: false, error: "管線不存在" };
  },
});

const listPipelinesHandler = defineBusHandler({
  type: "taskloop:list-pipelines",
  async handle(payload, ctx) {
    return { ok: true, pipelines: listPipelines() };
  },
});

const updatePipelineHandler = defineBusHandler({
  type: "taskloop:update-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    const pipeline = updatePipeline(payload.id, payload);
    return pipeline ? { ok: true, pipeline } : { ok: false, error: "管線不存在" };
  },
});

const deletePipelineHandler = defineBusHandler({
  type: "taskloop:delete-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    return deletePipeline(payload.id) ? { ok: true, deleted: true } : { ok: false, error: "管線不存在" };
  },
});

const startPipelineHandler = defineBusHandler({
  type: "taskloop:start-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };

    const pipeline = getPipeline(payload.id);
    if (!pipeline) return { ok: false, error: "管線不存在" };
    if (pipeline.status === "running") return { ok: false, error: "管線正在執行中" };

    if (executions.has(pipeline.id)) {
      const existing = executions.get(pipeline.id);
      if (existing.abortCtrl) existing.abortCtrl.abort();
      executions.delete(pipeline.id);
    }

    // 初始化狀態
    pipeline.status = "running";
    pipeline.startedAt = nowISO();
    pipeline.completedAt = null;
    pipeline.currentTaskIndex = 0;
    for (const t of pipeline.tasks) {
      t.status = "pending"; t.result = ""; t.startedAt = null; t.completedAt = null; t.repeatCount = 0;
    }
    pipelineStore.dirty = true; flushPipelines();

    const execCtx = {
      pipeline,
      status: "running",
      abortCtrl: new AbortController(),
      pauseResolve: null,
    };
    executions.set(pipeline.id, execCtx);

    // 背景執行
    executePipeline(pipeline, ctx).catch(err => console.error("[TaskLoop] 執行引擎異常:", err));

    return { ok: true, message: "管線已開始執行", pipeline: { id: pipeline.id, name: pipeline.name, status: pipeline.status, totalTasks: pipeline.tasks.length } };
  },
});

const terminatePipelineHandler = defineBusHandler({
  type: "taskloop:terminate-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    const pipeline = getPipeline(payload.id);
    if (!pipeline) return { ok: false, error: "管線不存在" };

    pipeline.status = "terminated"; pipeline.completedAt = nowISO();
    for (const t of pipeline.tasks) { if (t.status === "running") { t.status = "failed"; t.completedAt = nowISO(); } }
    pipelineStore.dirty = true; flushPipelines();

    const execCtx = executions.get(pipeline.id);
    if (execCtx) {
      if (execCtx.abortCtrl) execCtx.abortCtrl.abort();
      if (execCtx.pauseResolve) execCtx.pauseResolve();
      executions.delete(pipeline.id);
    }
    broadcastEvent(ctx, pipeline.id, "pipeline_terminated");
    return { ok: true, message: "管線已終止" };
  },
});

const pausePipelineHandler = defineBusHandler({
  type: "taskloop:pause-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    const pipeline = getPipeline(payload.id);
    if (!pipeline) return { ok: false, error: "管線不存在" };
    if (pipeline.status !== "running") return { ok: false, error: "管線不在執行中狀態" };
    pipeline.status = "paused"; pipelineStore.dirty = true; flushPipelines();
    return { ok: true, message: "管線已暫停" };
  },
});

const resumePipelineHandler = defineBusHandler({
  type: "taskloop:resume-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    const pipeline = getPipeline(payload.id);
    if (!pipeline) return { ok: false, error: "管線不存在" };
    if (pipeline.status !== "paused") return { ok: false, error: "管線不在暫停狀態" };
    pipeline.status = "running"; pipelineStore.dirty = true; flushPipelines();
    const execCtx = executions.get(pipeline.id);
    if (execCtx && execCtx.pauseResolve) { const resolve = execCtx.pauseResolve; execCtx.pauseResolve = null; resolve(); }
    return { ok: true, message: "管線已恢復執行" };
  },
});

const pipelineStatusHandler = defineBusHandler({
  type: "taskloop:pipeline-status",
  async handle(payload, ctx) {
    if (!payload || !payload.id) return { ok: false, error: "缺少必要欄位：id" };
    const pipeline = getPipeline(payload.id);
    if (!pipeline) return { ok: false, error: "管線不存在" };
    const { completed, failed } = countTaskStatuses(pipeline);
    const execCtx = executions.get(payload.id);
    return {
      ok: true, status: pipeline.status, currentTaskIndex: pipeline.currentTaskIndex,
      totalTasks: pipeline.tasks.length, completedTasks: completed, failedTasks: failed,
      tasks: pipeline.tasks.map(t => ({ id: t.id, name: t.name, orderIndex: t.orderIndex, status: t.status, repeat: t.repeat, repeatCount: t.repeatCount, result: t.result ? t.result.substring(0, 500) : "", startedAt: t.startedAt, completedAt: t.completedAt })),
      isRunning: !!execCtx, startedAt: pipeline.startedAt, completedAt: pipeline.completedAt,
    };
  },
});

const statusHandler = defineBusHandler({
  type: "taskloop:status",
  async handle(payload, ctx) {
    if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
    return { ok: true, pluginId: ctx.pluginId, name: "TaskLoop", pipelinesCount: pipelineStore.pipelines.length, activeExecutions: executions.size };
  },
});

/** 處理器：列出 Agent Sessions */
const listSessionsHandler = defineBusHandler({
  type: "taskloop:list-sessions",
  async handle(payload, ctx) {
    return { ok: true, sessions: listAgentSessions() };
  },
});

/** 處理器：讀取特定 Agent Session 的訊息 */
const readSessionHandler = defineBusHandler({
  type: "taskloop:read-session",
  async handle(payload, ctx) {
    if (!payload || !payload.agentId) return { ok: false, error: "缺少必要欄位：agentId" };
    const limit = payload.limit || 50;
    const result = readSessionMessages(payload.agentId, limit);
    return { ok: true, ...result };
  },
});

/** 處理器：確保 Agent Session 存在（可預先建立） */
const ensureSessionHandler = defineBusHandler({
  type: "taskloop:ensure-session",
  async handle(payload, ctx) {
    if (!payload || !payload.agentId) return { ok: false, error: "缺少必要欄位：agentId" };
    try {
      const info = await getAgentSession(ctx, payload.agentId);
      return { ok: true, session: { agentId: info.agentId, sessionPath: info.sessionPath, createdAt: info.createdAt } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
});

/**
 * 處理器：AI 管線生成
 * prompt + frameworkIds → AI 分析後回傳任務結構
 */
const generatePipelineHandler = defineBusHandler({
  type: "taskloop:generate-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.prompt) return { ok: false, error: "缺少必要欄位：prompt" };

    const agentId = payload.agentId || "coder";
    const frameworkIds = payload.frameworkIds || [];

    try {
      // 1. 確保有 session
      const sessionInfo = await getAgentSession(ctx, agentId);

      // 2. 建構生成 prompt
      const genPrompt = buildGenerationPrompt(payload.prompt, frameworkIds);

      // 3. 發送給 AI 並等待回應
      const response = await sendAndWaitGen(ctx, sessionInfo.sessionPath, genPrompt);

      // 4. 解析 JSON
      const jsonStr = extractJsonFromResponse(response);
      if (!jsonStr) {
        return { ok: false, error: "AI 回傳格式錯誤，無法解析任務結構", raw: response.slice(0, 500) };
      }

      const parsed = JSON.parse(jsonStr);
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const name = parsed.name || payload.prompt.slice(0, 40);
      const description = parsed.description || payload.prompt;

      // 5. 為每個任務補上必填欄位
      const now = new Date().toISOString();
      const enrichedTasks = tasks.map((t, i) => ({
        id: crypto.randomUUID(),
        orderIndex: i,
        name: t.name || `任務 ${i + 1}`,
        prompt: t.prompt || "",
        agentId: t.agentId || undefined,
        dependsOn: t.dependsOn || [],
        type: t.type || "task",
        repeat: t.repeat ?? 1,
        repeatCount: 0,
        conditions: (t.conditions || []).map(c => ({
          id: crypto.randomUUID(),
          type: c.type || "on_success",
          config: c.config || {},
          action: c.action || "continue",
          actionTarget: c.actionTarget || null,
        })),
        status: "pending",
        result: "",
        startedAt: null,
        completedAt: null,
      }));

      return {
        ok: true,
        name,
        description,
        frameworkIds,
        generatedByAI: true,
        tasks: enrichedTasks,
        globalConditions: parsed.globalConditions || [],
        raw: response.slice(0, 1000), // debug
      };
    } catch (err) {
      return { ok: false, error: `AI 生成失敗: ${err.message}` };
    }
  },
});

/**
 * 建構 AI 生成 prompt — 告訴 AI 它在 TaskLoop 中、可用框架、預期輸出格式
 */
function buildGenerationPrompt(userGoal, frameworkIds) {
  const frameworksInfo = frameworkIds.length > 0
    ? frameworkIds.map(id => {
        const fw = BUILT_IN_FRAMEWORKS.find(f => f.id === id);
        return fw ? `【${fw.name}】${fw.description}\n  模板：${fw.promptTemplate.slice(0, 200)}` : `【${id}】（未知框架）`;
      }).join('\n')
    : '（未指定框架，請自行判斷）';

  return `【TaskLoop 管線生成任務】

你正在 TaskLoop 系統中，負責根據使用者目標自動產生任務管線。

## 可用 Agent
- coder（1號程序員）：程式設計、技術實作
- hanako（木頭助理）：需求分析、任務拆解、協調、文件撰寫
- hi（2號程序員）：程式設計、技術分析
- pm（產品經理）：測試、邊界驗證、可用性審查

## 可用框架
${frameworksInfo}

## 使用者目標
${userGoal}

## 輸出格式
請嚴格輸出以下 JSON 格式（不要加入 Markdown 程式碼塊以外的任何文字）：

\`\`\`json
{
  "name": "管線名稱",
  "description": "簡短描述",
  "tasks": [
    {
      "name": "任務名稱",
      "prompt": "完整任務指示，包含所有細節和步驟",
      "agentId": "指定執行的agent（coder/hanako/hi/pm，不填則使用預設）",
      "type": "任務類型：write/review/fix/analyze/implement/cycle",
      "dependsOn": ["依賴的任務ID（填上一個任務的名稱即可，系統會自動對應）"],
      "repeat": 1,
      "conditions": [
        {
          "type": "on_success",
          "action": "continue"
        }
      ]
    }
  ],
  "globalConditions": [
    {
      "type": "after_tasks_count",
      "config": { "count": 5 },
      "action": "pause"
    }
  ]
}
\`\`\`

請完整思考使用者的目標，拆解為多個任務的管線。
考慮以下模式：撰寫→審查→修訂→再審查→實施→修 bug→分析... 循環
每個任務的 prompt 要詳細到 AI 可以直接執行。`;
}

/**
 * 向 AI 發送生成請求並等待回應（不含操作指南和編號，這是元操作）
 */
function sendAndWaitGen(ctx, sessionPath, prompt) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 120000;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; unsub(); reject(new Error("AI 生成逾時（2 分鐘）")); } }, timeoutMs);
    const unsub = subscribeSessionEvents(ctx, sessionPath, (event) => {
      if (settled) return;
      const et = event.type || "";
      if (et === "session:conversation:response" || et === "session:message:response" || et === "session:response" || et.endsWith(":response")) {
        settled = true; clearTimeout(timer); unsub();
        resolve(event.text || event.content || event.response || (typeof event.message === "string" ? event.message : "") || JSON.stringify(event));
      }
    });
    sendSessionMessage(ctx, sessionPath, { content: prompt }).catch((err) => { if (!settled) { settled = true; clearTimeout(timer); unsub(); reject(err); } });
  });
}

/**
 * 從 AI 回覆中萃取 JSON 區塊
 */
function extractJsonFromResponse(text) {
  if (!text) return null;
  // 嘗試匹配 ```json ... ```
  const match = text.match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/);
  if (match && match[1]) return match[1].trim();
  // 嘗試匹配 { ... }
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch && braceMatch[1]) return braceMatch[1].trim();
  return null;
}

const handlers = [
  createPipelineHandler, getPipelineHandler, listPipelinesHandler,
  updatePipelineHandler, deletePipelineHandler,
  startPipelineHandler, terminatePipelineHandler,
  pausePipelineHandler, resumePipelineHandler, pipelineStatusHandler,
  statusHandler,
  listSessionsHandler, readSessionHandler, ensureSessionHandler,
  generatePipelineHandler,
];

// ═══════════════════════════════════════════════════════════════════════════
//  插件匯出
// ═══════════════════════════════════════════════════════════════════════════

export default definePlugin({
  async onload(ctx, { register }) {
    const dataDir = ctx.dataDir || ctx.pluginDir;
    if (!dataDir) {
      ctx.log.error("TaskLoop: dataDir 和 pluginDir 均為空，無法初始化儲存");
      return;
    }
    fs.mkdirSync(dataDir, { recursive: true });

    // 載入管線資料
    loadPipelines(path.join(dataDir, "pipelines.json"));
    // 載入 Session 資料
    loadSessions(path.join(dataDir, "session-map.json"));

    // 註冊所有 bus handler
    for (const h of handlers) {
      if (ctx.bus.handle) {
        register(ctx.bus.handle(h.type, (payload) => h.handle(payload, ctx)));
      }
    }

    ctx.log.info(`TaskLoop loaded (${pipelineStore.pipelines.length} pipelines, ${Object.keys(sessionsStore.sessions).length} agent sessions)`);
  },

  async onunload(ctx) {
    for (const [pid, execCtx] of executions) {
      const pipeline = getPipeline(pid);
      if (pipeline) {
        pipeline.status = "terminated"; pipeline.completedAt = nowISO();
        for (const t of pipeline.tasks) { if (t.status === "running") { t.status = "failed"; t.completedAt = nowISO(); } }
      }
      if (execCtx.abortCtrl) execCtx.abortCtrl.abort();
    }
    executions.clear();
    flushPipelines();
    flushSessions();
    ctx.log.info("TaskLoop unloaded");
  },
});
