/**
 * TaskLoop 插件 - 任務管線後端引擎
 *
 * 提供：
 * 1. 管線資料的持久化儲存（CRUD）
 * 2. EventBus 處理器（taskloop:*）
 * 3. 管線執行引擎（發送 prompt 給 Agent 並等待回應）
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
//  儲存層 — pipelines.json 的讀寫
// ═══════════════════════════════════════════════════════════════════════════

const store = {
  pipelines: [],
  filePath: null,
  dirty: false,
};

/** 從磁碟載入管線資料 */
function loadStore(filePath) {
  store.filePath = filePath;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    store.pipelines = JSON.parse(raw);
  } catch {
    store.pipelines = [];
  }
}

/** 若資料有變更則寫回磁碟 */
function flushStore() {
  if (!store.dirty) return;
  try {
    fs.writeFileSync(store.filePath, JSON.stringify(store.pipelines, null, 2), "utf-8");
    store.dirty = false;
  } catch (err) {
    console.error("[TaskLoop] 無法寫入 pipelines.json:", err);
  }
}

/** 產生 UUID */
function uid() {
  return crypto.randomUUID();
}

/** 取得當前 ISO 時間字串 */
function nowISO() {
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════
//  管線 CRUD
// ═══════════════════════════════════════════════════════════════════════════

/** 建立新管線 */
function createPipeline(data) {
  const ts = nowISO();
  const pipeline = {
    id: uid(),
    name: data.name || "未命名管線",
    description: data.description || "",
    createdAt: ts,
    updatedAt: ts,
    tasks: (data.tasks || []).map((t, i) => ({
      id: uid(),
      orderIndex: i,
      name: t.name || `任務 ${i + 1}`,
      prompt: t.prompt || "",
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
  store.pipelines.push(pipeline);
  store.dirty = true;
  flushStore();
  return pipeline;
}

/** 依 ID 取得管線 */
function getPipeline(id) {
  return store.pipelines.find((p) => p.id === id) || null;
}

/** 更新管線欄位 */
function updatePipeline(id, data) {
  const pipeline = getPipeline(id);
  if (!pipeline) return null;

  if (data.name !== undefined) pipeline.name = data.name;
  if (data.description !== undefined) pipeline.description = data.description;

  if (data.tasks !== undefined) {
    pipeline.tasks = data.tasks.map((t, i) => ({
      id: t.id || uid(),
      orderIndex: i,
      name: t.name || `任務 ${i + 1}`,
      prompt: t.prompt || "",
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
  store.dirty = true;
  flushStore();
  return pipeline;
}

/** 刪除管線 */
function deletePipeline(id) {
  const idx = store.pipelines.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  store.pipelines.splice(idx, 1);
  store.dirty = true;
  flushStore();
  return true;
}

/** 列出所有管線 */
function listPipelines() {
  return store.pipelines;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Session 快取（從 route 呼叫時沒有 toolCtx.sessionPath，需自動建立）
// ═══════════════════════════════════════════════════════════════════════════

/** 依 agentId 快取已建立的 sessionPath，避免每次執行都新建 session */
const _sessionCache = new Map();

// ═══════════════════════════════════════════════════════════════════════════
//  執行引擎狀態管理
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 活躍執行追蹤
 * Map<pipelineId, ExecutionContext>
 *
 * ExecutionContext 欄位：
 *   pipeline   - 管線物件（引用）
 *   sessionPath - 執行所在的 session 路徑
 *   status     - 'running' | 'paused' | 'terminated'
 *   abortCtrl  - AbortController（用於中斷等待）
 *   pauseResolve - Promise resolve，用於 pause 恢復
 */
const executions = new Map();

/** 透過 EventBus 廣播執行事件 */
function broadcastEvent(ctx, pipelineId, type, taskId, taskIndex, message) {
  const event = {
    type: `taskloop:execution-event`,
    payload: {
      type,
      pipelineId,
      taskId: taskId || null,
      taskIndex: taskIndex ?? null,
      message: message || "",
      timestamp: nowISO(),
    },
  };
  // 廣播給所有訂閱者
  ctx.bus.emit(event.type, event.payload).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
//  條件判斷邏輯
// ═══════════════════════════════════════════════════════════════════════════

/** 計算管線中已完成與失敗的任務數量 */
function countTaskStatuses(pipeline) {
  let completed = 0;
  let failed = 0;
  for (const t of pipeline.tasks) {
    if (t.status === "completed") completed++;
    if (t.status === "failed") failed++;
  }
  return { completed, failed };
}

/**
 * 檢查並執行全局條件
 * 回傳 true 表示有條件觸發了跳轉/終止等動作
 */
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
        const elapsed = Date.now() - new Date(pipeline.startedAt).getTime();
        if (elapsed >= minutes * 60000) {
          broadcastEvent(ctx, pipeline.id, "condition_triggered", null, null,
            `全局條件 after_time 觸發：已執行 ${Math.round(elapsed / 60000)}/${minutes} 分鐘`);
          return applyGlobalConditionAction(cond, pipeline, ctx);
        }
        break;
      }
      case "max_failures": {
        const maxFail = Number(cond.config?.count) || 0;
        if (failed >= maxFail && maxFail > 0) {
          broadcastEvent(ctx, pipeline.id, "condition_triggered", null, null,
            `全局條件 max_failures 觸發：已失敗 ${failed}/${maxFail} 次`);
          return applyGlobalConditionAction(cond, pipeline, ctx);
        }
        break;
      }
      case "custom":
        // 自訂條件：由前端或外部判斷，此處不處理
        break;
    }
  }
  return false;
}

/** 執行全局條件動作 */
function applyGlobalConditionAction(cond, pipeline, ctx) {
  switch (cond.action) {
    case "pause":
      pipeline.status = "paused";
      store.dirty = true;
      flushStore();
      return true;
    case "terminate":
      pipeline.status = "terminated";
      pipeline.completedAt = nowISO();
      // 將執行中的任務設為 failed
      for (const t of pipeline.tasks) {
        if (t.status === "running") {
          t.status = "failed";
          t.completedAt = nowISO();
        }
      }
      store.dirty = true;
      flushStore();
      broadcastEvent(ctx, pipeline.id, "pipeline_terminated");
      return true;
    case "jump_to_task":
      if (cond.actionTarget) {
        const targetIdx = pipeline.tasks.findIndex((t) => t.id === cond.actionTarget);
        if (targetIdx >= 0) {
          pipeline.currentTaskIndex = targetIdx;
          store.dirty = true;
          flushStore();
          return true; // 跳轉由外層迴圈處理
        }
      }
      return false;
    case "repeat_from":
      // 從某任務重新開始（跳回指定任務）
      if (cond.actionTarget) {
        const targetIdx = pipeline.tasks.findIndex((t) => t.id === cond.actionTarget);
        if (targetIdx >= 0) {
          pipeline.currentTaskIndex = targetIdx;
          // 重設該任務之後的所有任務狀態
          for (let i = targetIdx; i < pipeline.tasks.length; i++) {
            pipeline.tasks[i].status = "pending";
            pipeline.tasks[i].result = "";
            pipeline.tasks[i].startedAt = null;
            pipeline.tasks[i].completedAt = null;
          }
          store.dirty = true;
          flushStore();
          return true;
        }
      }
      return false;
    default:
      return false;
  }
}

/** 檢查任務層級條件（on_success / on_failure） */
function checkTaskCondition(condition, pipeline, tasks, currentTask, currentIdx, ctx) {
  switch (condition.action) {
    case "continue":
      return { action: "continue" };
    case "skip_next":
      // 跳過下一個任務
      if (currentIdx + 1 < tasks.length) {
        tasks[currentIdx + 1].status = "skipped";
        store.dirty = true;
        flushStore();
      }
      return { action: "continue" };
    case "jump_to":
      if (condition.actionTarget) {
        const targetIdx = tasks.findIndex((t) => t.id === condition.actionTarget);
        if (targetIdx >= 0) {
          pipeline.currentTaskIndex = targetIdx;
          store.dirty = true;
          flushStore();
          return { action: "jump", targetIdx };
        }
      }
      return { action: "continue" };
    case "retry":
      // 重設目前任務為 pending
      currentTask.status = "pending";
      currentTask.result = "";
      currentTask.startedAt = null;
      currentTask.completedAt = null;
      currentTask.repeatCount = 0;
      store.dirty = true;
      flushStore();
      return { action: "retry" };
    case "terminate":
      pipeline.status = "terminated";
      pipeline.completedAt = nowISO();
      store.dirty = true;
      flushStore();
      broadcastEvent(ctx, pipeline.id, "pipeline_terminated");
      return { action: "terminate" };
    default:
      return { action: "continue" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  核心執行引擎
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 發送 prompt 給 Agent 並等待回應
 *
 * 透過 subscribeSessionEvents 監聽 session 事件，
 * 當接收到回應事件時 resolve Promise。
 */
function sendAndWait(ctx, sessionPath, prompt, pipelineId) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 300000; // 5 分鐘
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        reject(new Error("等待 Agent 回應逾時（5 分鐘）"));
      }
    }, timeoutMs);

    const unsub = subscribeSessionEvents(ctx, sessionPath, (event) => {
      if (settled) return;

      // 偵測回應事件 — 支援多種可能的事件型別
      const eventType = event.type || "";
      if (
        eventType === "session:conversation:response" ||
        eventType === "session:message:response" ||
        eventType === "session:response" ||
        eventType.endsWith(":response") ||
        (eventType.includes("completed") &&
          !eventType.includes("task") &&
          !eventType.includes("pipeline"))
      ) {
        settled = true;
        clearTimeout(timer);
        unsub();

        // 從事件中萃取回應文字
        const responseText =
          event.text ||
          event.content ||
          event.response ||
          (typeof event.message === "string" ? event.message : "") ||
          JSON.stringify(event);

        resolve(responseText);
      }
    });

    // 發送 prompt 給 session 中的 Agent
    sendSessionMessage(ctx, sessionPath, { content: prompt }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        unsub();
        reject(err);
      }
    });
  });
}

/**
 * 等待管線 resume（用於 pause 狀態）
 */
function waitForResume(pipelineId) {
  return new Promise((resolve) => {
    const exec = executions.get(pipelineId);
    if (exec) {
      exec.pauseResolve = resolve;
    }
  });
}

/**
 * 執行完整的管線（非同步背景執行）
 */
async function executePipeline(pipeline, sessionPath, ctx) {
  const execCtx = executions.get(pipeline.id);
  if (!execCtx) return;

  try {
    // 按 orderIndex 排序任務
    const sortedTasks = [...pipeline.tasks].sort((a, b) => a.orderIndex - b.orderIndex);

    let i = 0;
    while (i < sortedTasks.length) {
      // 檢查終止狀態
      if (pipeline.status === "terminated") break;

      // 暫停時等待恢復
      if (pipeline.status === "paused") {
        await waitForResume(pipeline.id);
        if (pipeline.status === "terminated") break;
      }

      const task = sortedTasks[i];
      pipeline.currentTaskIndex = i;
      store.dirty = true;
      flushStore();

      // 若該任務已被跳過，直接跳過
      if (task.status === "skipped") {
        i++;
        continue;
      }

      // ── 重複執行迴圈 ──
      let runCount = 0;
      const maxRepeats = task.repeat || 1;

      while (runCount < maxRepeats) {
        if (pipeline.status === "terminated") break;
        if (pipeline.status === "paused") await waitForResume(pipeline.id);
        if (pipeline.status === "terminated") break;

        // 設為執行中
        task.status = "running";
        task.startedAt = nowISO();
        task.result = "";
        store.dirty = true;
        flushStore();

        // 廣播事件
        broadcastEvent(ctx, pipeline.id, "task_started", task.id, i,
          `開始執行任務：${task.name}`);

        try {
          // 發送 prompt 給 Agent 並等待回應
          const response = await sendAndWait(ctx, sessionPath, task.prompt, pipeline.id);

          // 如果執行已被終止（可能發生在等待期間）
          if (pipeline.status === "terminated") break;

          // 任務完成
          task.status = "completed";
          task.result = response;
          task.completedAt = nowISO();
          task.repeatCount = runCount + 1;
          store.dirty = true;
          flushStore();

          broadcastEvent(ctx, pipeline.id, "task_completed", task.id, i,
            `任務完成：${task.name}（第 ${runCount + 1}/${maxRepeats} 次）`);

          // 檢查任務條件 (on_success)
          const successCond = task.conditions.find((c) => c.type === "on_success");
          if (successCond) {
            const result = checkTaskCondition(successCond, pipeline, sortedTasks, task, i, ctx);
            if (result.action === "terminate") break;
            if (result.action === "jump") {
              i = result.targetIdx;
              break; // 跳出 while(runCount) 和 for loop，重新從 targetIdx 開始
            }
            if (result.action === "retry") {
              runCount = 0; // 重新計數
              continue;
            }
          }

          runCount++;
        } catch (err) {
          // 任務失敗
          if (pipeline.status === "terminated") break;

          task.status = "failed";
          task.completedAt = nowISO();
          task.result = err.message || String(err);
          store.dirty = true;
          flushStore();

          broadcastEvent(ctx, pipeline.id, "task_failed", task.id, i,
            `任務失敗：${task.name} - ${err.message}`);

          // 檢查任務條件 (on_failure)
          const failureCond = task.conditions.find((c) => c.type === "on_failure");
          if (failureCond) {
            const result = checkTaskCondition(failureCond, pipeline, sortedTasks, task, i, ctx);
            if (result.action === "terminate") break;
            if (result.action === "retry") {
              continue; // 重試
            }
          }

          runCount = maxRepeats; // 失敗後不繼續重複
        }

        // 檢查 repeat_until 條件
        const repeatUntilCond = task.conditions.find((c) => c.type === "repeat_until");
        if (repeatUntilCond && runCount < maxRepeats) {
          // continue the while loop
        }
      }

      // 檢查全局條件
      if (checkGlobalConditions(pipeline, ctx)) {
        // 條件觸發了 pause/terminate，跳出
        break;
      }

      i++;

      // 如果條件跳轉修改了 currentTaskIndex，更新 i
      if (pipeline.currentTaskIndex >= 0 && pipeline.currentTaskIndex !== i && pipeline.currentTaskIndex < sortedTasks.length) {
        i = pipeline.currentTaskIndex;
      }
    }

    // 若管線不是被中斷（terminated/paused），則設為 completed
    if (pipeline.status === "running") {
      pipeline.status = "completed";
      pipeline.completedAt = nowISO();
      pipeline.currentTaskIndex = -1;
      store.dirty = true;
      flushStore();
      broadcastEvent(ctx, pipeline.id, "pipeline_completed");
    }
  } catch (err) {
    console.error("[TaskLoop] 執行引擎錯誤:", err);
    pipeline.status = "terminated";
    pipeline.completedAt = nowISO();
    store.dirty = true;
    flushStore();
    broadcastEvent(ctx, pipeline.id, "pipeline_terminated", null, null, err.message);
  } finally {
    executions.delete(pipeline.id);
    flushStore();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  EventBus 處理器
// ═══════════════════════════════════════════════════════════════════════════

/** 處理器：建立管線 */
const createPipelineHandler = defineBusHandler({
  type: "taskloop:create-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.name) {
      return { ok: false, error: "缺少必要欄位：name" };
    }
    const pipeline = createPipeline(payload);
    return { ok: true, pipeline };
  },
});

/** 處理器：取得單一管線 */
const getPipelineHandler = defineBusHandler({
  type: "taskloop:get-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }
    const pipeline = getPipeline(payload.id);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }
    return { ok: true, pipeline };
  },
});

/** 處理器：列出所有管線 */
const listPipelinesHandler = defineBusHandler({
  type: "taskloop:list-pipelines",
  async handle(payload, ctx) {
    const pipelines = listPipelines();
    return { ok: true, pipelines };
  },
});

/** 處理器：更新管線 */
const updatePipelineHandler = defineBusHandler({
  type: "taskloop:update-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }
    const pipeline = updatePipeline(payload.id, payload);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }
    return { ok: true, pipeline };
  },
});

/** 處理器：刪除管線 */
const deletePipelineHandler = defineBusHandler({
  type: "taskloop:delete-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }
    const result = deletePipeline(payload.id);
    if (!result) {
      return { ok: false, error: "管線不存在" };
    }
    return { ok: true, deleted: true };
  },
});

/** 處理器：開始執行管線 */
const startPipelineHandler = defineBusHandler({
  type: "taskloop:start-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }

    const pipeline = getPipeline(payload.id);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }

    if (pipeline.status === "running") {
      return { ok: false, error: "管線正在執行中" };
    }

    // 解析 sessionPath：優先使用 payload 提供的，否則從 agentId 自動建立
    let sessionPath = payload.sessionPath;
    if (!sessionPath) {
      const agentId = payload.agentId;
      if (!agentId) {
        return { ok: false, error: "缺少必要欄位：sessionPath 或 agentId" };
      }

      // 檢查快取
      if (_sessionCache.has(agentId)) {
        sessionPath = _sessionCache.get(agentId);
      } else {
        try {
          const session = await createSession(ctx, {
            agentId,
            kind: "taskloop",
            visibility: "plugin_private",
            cwd: ctx.dataDir,
          });
          sessionPath = session.sessionPath || session.path || session.id;
          if (!sessionPath) {
            return { ok: false, error: "建立 session 成功但無法取得 path" };
          }
          _sessionCache.set(agentId, sessionPath);
        } catch (err) {
          return { ok: false, error: `無法建立執行用 session: ${err.message}` };
        }
      }
    }

    // 若已有執行記錄則先清除
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
      t.status = "pending";
      t.result = "";
      t.startedAt = null;
      t.completedAt = null;
      t.repeatCount = 0;
    }
    store.dirty = true;
    flushStore();

    // 建立執行上下文
    const execCtx = {
      pipeline,
      sessionPath,
      status: "running",
      abortCtrl: new AbortController(),
      pauseResolve: null,
    };
    executions.set(pipeline.id, execCtx);

    // 背景執行（不 await，讓 handler 立即回傳）
    executePipeline(pipeline, sessionPath, ctx).catch((err) => {
      console.error("[TaskLoop] 執行引擎異常:", err);
    });

    return {
      ok: true,
      message: "管線已開始執行",
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        status: pipeline.status,
        totalTasks: pipeline.tasks.length,
      },
    };
  },
});

/** 處理器：終止管線 */
const terminatePipelineHandler = defineBusHandler({
  type: "taskloop:terminate-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }

    const pipeline = getPipeline(payload.id);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }

    pipeline.status = "terminated";
    pipeline.completedAt = nowISO();

    // 將執行中的任務標記為 failed
    for (const t of pipeline.tasks) {
      if (t.status === "running") {
        t.status = "failed";
        t.completedAt = nowISO();
      }
    }
    store.dirty = true;
    flushStore();

    // 中斷執行引擎
    const execCtx = executions.get(pipeline.id);
    if (execCtx) {
      if (execCtx.abortCtrl) execCtx.abortCtrl.abort();
      if (execCtx.pauseResolve) {
        execCtx.pauseResolve();
      }
      executions.delete(pipeline.id);
    }

    broadcastEvent(ctx, pipeline.id, "pipeline_terminated");

    return { ok: true, message: "管線已終止" };
  },
});

/** 處理器：暫停管線 */
const pausePipelineHandler = defineBusHandler({
  type: "taskloop:pause-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }

    const pipeline = getPipeline(payload.id);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }

    if (pipeline.status !== "running") {
      return { ok: false, error: "管線不在執行中狀態" };
    }

    pipeline.status = "paused";
    store.dirty = true;
    flushStore();

    return { ok: true, message: "管線已暫停" };
  },
});

/** 處理器：繼續管線 */
const resumePipelineHandler = defineBusHandler({
  type: "taskloop:resume-pipeline",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }

    const pipeline = getPipeline(payload.id);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }

    if (pipeline.status !== "paused") {
      return { ok: false, error: "管線不在暫停狀態" };
    }

    pipeline.status = "running";
    store.dirty = true;
    flushStore();

    // 若有等待中的 pauseResolve，喚醒執行引擎
    const execCtx = executions.get(pipeline.id);
    if (execCtx && execCtx.pauseResolve) {
      const resolve = execCtx.pauseResolve;
      execCtx.pauseResolve = null;
      resolve();
    }

    return { ok: true, message: "管線已恢復執行" };
  },
});

/** 處理器：查詢管線執行狀態 */
const pipelineStatusHandler = defineBusHandler({
  type: "taskloop:pipeline-status",
  async handle(payload, ctx) {
    if (!payload || !payload.id) {
      return { ok: false, error: "缺少必要欄位：id" };
    }

    const pipeline = getPipeline(payload.id);
    if (!pipeline) {
      return { ok: false, error: "管線不存在" };
    }

    const { completed, failed } = countTaskStatuses(pipeline);
    const execCtx = executions.get(payload.id);

    return {
      ok: true,
      status: pipeline.status,
      currentTaskIndex: pipeline.currentTaskIndex,
      totalTasks: pipeline.tasks.length,
      completedTasks: completed,
      failedTasks: failed,
      tasks: pipeline.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        orderIndex: t.orderIndex,
        status: t.status,
        repeat: t.repeat,
        repeatCount: t.repeatCount,
        result: t.result ? t.result.substring(0, 500) : "",
        startedAt: t.startedAt,
        completedAt: t.completedAt,
      })),
      isRunning: execCtx ? true : false,
      startedAt: pipeline.startedAt,
      completedAt: pipeline.completedAt,
    };
  },
});

/** 處理器：通用狀態查詢（插件存活檢查） */
const statusHandler = defineBusHandler({
  type: "taskloop:status",
  async handle(payload, ctx) {
    if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
    return {
      ok: true,
      pluginId: ctx.pluginId,
      name: "TaskLoop",
      pipelinesCount: store.pipelines.length,
      activeExecutions: executions.size,
    };
  },
});

// 所有 handler 的列表，方便註冊
const handlers = [
  createPipelineHandler,
  getPipelineHandler,
  listPipelinesHandler,
  updatePipelineHandler,
  deletePipelineHandler,
  startPipelineHandler,
  terminatePipelineHandler,
  pausePipelineHandler,
  resumePipelineHandler,
  pipelineStatusHandler,
  statusHandler,
];

// ═══════════════════════════════════════════════════════════════════════════
//  插件匯出
// ═══════════════════════════════════════════════════════════════════════════

export default definePlugin({
  async onload(ctx, { register }) {
    // 初始化儲存
    const dataDir = ctx.dataDir || ctx.pluginDir;
    if (!dataDir) {
      ctx.log.error("TaskLoop: dataDir 和 pluginDir 均為空，無法初始化儲存");
      return;
    }
    const filePath = path.join(dataDir, "pipelines.json");
    loadStore(filePath);

    // 確保 dataDir 存在
    fs.mkdirSync(dataDir, { recursive: true });

    // 註冊所有 bus handler
    for (const h of handlers) {
      if (ctx.bus.handle) {
        register(ctx.bus.handle(h.type, (payload) => h.handle(payload, ctx)));
      }
    }

    ctx.log.info(`TaskLoop loaded (${store.pipelines.length} pipelines)`);
  },

  async onunload(ctx) {
    // 終止所有活躍執行
    for (const [pid, execCtx] of executions) {
      const pipeline = getPipeline(pid);
      if (pipeline) {
        pipeline.status = "terminated";
        pipeline.completedAt = nowISO();
        for (const t of pipeline.tasks) {
          if (t.status === "running") {
            t.status = "failed";
            t.completedAt = nowISO();
          }
        }
      }
      if (execCtx.abortCtrl) execCtx.abortCtrl.abort();
    }
    executions.clear();

    // 若有未寫入的變更，寫回檔案
    flushStore();

    ctx.log.info("TaskLoop unloaded");
  },
});
