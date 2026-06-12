/**
 * TaskLoop 插件 - Agent 工具：執行管線
 *
 * 讓 Agent 可以直接呼叫此工具來啟動指定的任務管線。
 * 管線內的任務會依序透過 sendSessionMessage 注入 Agent 上下文。
 */
import { defineTool, requestBus } from "@hana/plugin-runtime";

const tool = defineTool({
  name: "taskloop_run_pipeline",
  description: "執行指定的任務管線，按照管線中定義的任務順序自動依序執行。每個任務的 prompt 會被做為指令傳遞給 AI，完成後自動推進到下一個任務。支援條件判斷、重複執行、暫停與終止。",
  parameters: {
    type: "object",
    properties: {
      pipelineId: {
        type: "string",
        description: "要執行的管線 ID",
      },
    },
    required: ["pipelineId"],
  },

  async execute(input, toolCtx) {
    const pipelineId =
      typeof input.pipelineId === "string" && input.pipelineId.trim()
        ? input.pipelineId.trim()
        : null;

    if (!pipelineId) {
      throw new Error("缺少必要參數：pipelineId");
    }

    if (!toolCtx.sessionPath) {
      throw new Error("taskloop_run_pipeline 需要 sessionPath");
    }

    // 透過 EventBus 啟動管線執行
    const result = await requestBus(toolCtx, "taskloop:start-pipeline", {
      id: pipelineId,
      sessionPath: toolCtx.sessionPath,
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || "啟動管線失敗");
    }

    const { name, status, totalTasks } = result.pipeline || {};

    return {
      content: [
        {
          type: "text",
          text: `管線「${name || pipelineId}」已開始執行（${status}），共 ${totalTasks || 0} 個任務`,
        },
      ],
      details: {
        pipelineId,
        status,
        totalTasks,
      },
    };
  },
});

export const { name, description, parameters, execute } = tool;
