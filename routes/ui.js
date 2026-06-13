/**
 * TaskLoop 插件 - UI 路由與管線 API
 *
 * 提供：
 * 1. iframe shell 頁面（page / widget）
 * 2. 靜態資產服務
 * 3. 管線 CRUD API（給前端 iframe 使用）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export default function registerPluginUiRoutes(app, ctx) {
  // ── UI 頁面 ──────────────────────────────────────────────────────────
  app.get("/taskloop", (c) => c.html(renderShell(c, ctx, "page")));
  app.get("/widget", (c) => c.html(renderShell(c, ctx, "widget")));
  app.get("/test", (c) => {
    const testPath = path.join(ctx.pluginDir || "", "assets", "test.html");
    if (fs.existsSync(testPath)) {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(fs.readFileSync(testPath));
    }
    return c.text("Not found", 404);
  });
  app.get("/assets/*", (c) => serveAsset(c, ctx));

  // ── CORS 支援（獨立瀏覽器模式） ──────────────────────────────────────
  function setCorsHeaders(c) {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
  }

  app.options("/pipelines", (c) => { setCorsHeaders(c); return c.body(null, 204); });
  app.options("/api/pipelines", (c) => { setCorsHeaders(c); return c.body(null, 204); });
  app.options("/pipelines/:id", (c) => { setCorsHeaders(c); return c.body(null, 204); });
  app.options("/pipelines/:id/execute", (c) => { setCorsHeaders(c); return c.body(null, 204); });
  app.options("/pipelines/:id/terminate", (c) => { setCorsHeaders(c); return c.body(null, 204); });

  // ── 管線 CRUD API ────────────────────────────────────────────────────

  /** 讀取 pipelines.json 的 helpers */
  function getStorePath() {
    const dataDir = ctx.dataDir || ctx.pluginDir;
    if (!dataDir) throw new Error("dataDir and pluginDir are both null");
    return path.join(dataDir, "pipelines.json");
  }

  function readPipelines() {
    const storePath = getStorePath();
    try {
      if (!fs.existsSync(storePath)) return [];
      const raw = fs.readFileSync(storePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  function writePipelines(data) {
    const storePath = getStorePath();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** GET /pipelines — 取得所有管線 */
  app.get("/pipelines", (c) => {
    try {
      setCorsHeaders(c);
      const pipelines = readPipelines();
      return c.json({ ok: true, pipelines });
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** POST /api/pipelines — 建立新管線 */
  app.post("/pipelines", async (c) => {
    try {
      setCorsHeaders(c);
      const body = await c.req.json();
      if (!body || !body.name) {
        setCorsHeaders(c);
        return c.json({ ok: false, error: "缺少必要欄位：name" }, 400);
      }

      const now = new Date().toISOString();
      const pipeline = {
        id: crypto.randomUUID(),
        name: body.name,
        description: body.description || "",
        createdAt: now,
        updatedAt: now,
        tasks: (body.tasks || []).map((t, i) => ({
          id: crypto.randomUUID(),
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
        globalConditions: body.globalConditions || [],
        status: "idle",
        currentTaskIndex: -1,
        startedAt: null,
        completedAt: null,
      };

      const pipelines = readPipelines();
      pipelines.push(pipeline);
      writePipelines(pipelines);

      return c.json({ ok: true, pipeline }, 201);
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** GET /pipelines/:id — 取得單一管線（用於輪詢） */
  app.get("/pipelines/:id", (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const pipelines = readPipelines();
      const pipeline = pipelines.find((p) => p.id === id);
      if (!pipeline) {
        setCorsHeaders(c);
        return c.json({ ok: false, error: "管線不存在" }, 404);
      }
      setCorsHeaders(c);
      return c.json(pipeline);
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** PUT /pipelines/:id — 更新管線 */
  app.put("/pipelines/:id", async (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const body = await c.req.json();

      const pipelines = readPipelines();
      const idx = pipelines.findIndex((p) => p.id === id);
      if (idx === -1) {
        setCorsHeaders(c);
        return c.json({ ok: false, error: "管線不存在" }, 404);
      }

      const pipeline = pipelines[idx];

      if (body.name !== undefined) pipeline.name = body.name;
      if (body.description !== undefined) pipeline.description = body.description;

      if (body.tasks !== undefined) {
        pipeline.tasks = body.tasks.map((t, i) => ({
          id: t.id || crypto.randomUUID(),
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

      if (body.globalConditions !== undefined) {
        pipeline.globalConditions = body.globalConditions;
      }

      pipeline.updatedAt = new Date().toISOString();
      writePipelines(pipelines);

      return c.json({ ok: true, pipeline });
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** DELETE /pipelines/:id — 刪除管線 */
  app.delete("/pipelines/:id", (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const pipelines = readPipelines();
      const idx = pipelines.findIndex((p) => p.id === id);
      if (idx === -1) {
        setCorsHeaders(c);
        return c.json({ ok: false, error: "管線不存在" }, 404);
      }

      pipelines.splice(idx, 1);
      writePipelines(pipelines);

      setCorsHeaders(c);
      return c.json({ ok: true, deleted: true });
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** POST /pipelines/:id/execute — 開始執行管線 */
  app.post("/pipelines/:id/execute", async (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const pipelines = readPipelines();
      const pipeline = pipelines.find((p) => p.id === id);
      if (!pipeline) {
        setCorsHeaders(c);
        return c.json({ ok: false, error: "管線不存在" }, 404);
      }

      if (pipeline.status === "running" || pipeline.status === "paused") {
        setCorsHeaders(c);
        return c.json({ ok: false, error: "管線已在執行中" }, 409);
      }

      // 取得請求中的 agentId（iframe 所在 session 的 Agent）
      const agentId = c.get("agentId");

      // 透過 EventBus 啟動執行引擎
      const result = await ctx.bus.request("taskloop:start-pipeline", {
        id,
        agentId: agentId || undefined,
      });

      if (result && result.ok) {
        return c.json({ ok: true, message: "管線已開始執行", pipeline: result.pipeline });
      }
      return c.json({ ok: false, error: result?.error || "啟動失敗" }, 500);
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** POST /pipelines/:id/terminate — 終止管線執行 */
  app.post("/pipelines/:id/terminate", async (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const result = await ctx.bus.request("taskloop:terminate-pipeline", { id });

      if (result && result.ok) {
        setCorsHeaders(c);
        return c.json({ ok: true, message: "管線已終止" });
      }
      setCorsHeaders(c);
      return c.json({ ok: false, error: result?.error || "終止失敗" }, 500);
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, error: err.message }, 500);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  UI Shell 渲染
// ═══════════════════════════════════════════════════════════════════════════

function renderShell(c, ctx, surface) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const token = c.req.query("token") || "";
  const base = `/api/plugins/${ctx.pluginId}`;
  const title = "TaskLoop";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${base}/assets/panel.css?token=${escapeAttr(token)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="${surface}">
  <div id="root" data-surface="${surface}"></div>
  <script src="${base}/assets/panel.js?token=${escapeAttr(token)}" defer></script>
</body>
</html>`;
}

function serveAsset(c, ctx) {
  const rawName = c.req.path.split("/assets/")[1] || "";
  const fileName = path.basename(decodeURIComponent(rawName));
  if (!fileName) return c.text("Not found", 404);

  const assetsDir = path.join(ctx.pluginDir, "assets");
  const filePath = path.join(assetsDir, fileName);
  if (!filePath.startsWith(assetsDir + path.sep) || !fs.existsSync(filePath)) {
    return c.text("Not found", 404);
  }

  c.header("Content-Type", contentType(fileName));
  c.header("Cache-Control", "no-cache");
  return c.body(fs.readFileSync(filePath));
}

function contentType(fileName) {
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
