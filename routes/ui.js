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

  // ── 管線 CRUD API（全部透過 EventBus 與 index.js 統一儲存層） ──

  /** GET /pipelines — 取得所有管線 */
  app.get("/pipelines", async (c) => {
    try {
      setCorsHeaders(c);
      const result = await ctx.bus.request("taskloop:list-pipelines", {});
      return c.json(result && result.ok ? { ok: true, pipelines: result.pipelines } : { ok: false, pipelines: [] });
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
        return c.json({ ok: false, error: "缺少必要欄位：name" }, 400);
      }
      const result = await ctx.bus.request("taskloop:create-pipeline", body);
      return result && result.ok
        ? c.json({ ok: true, pipeline: result.pipeline }, 201)
        : c.json({ ok: false, error: result?.error || "建立失敗" }, 500);
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** GET /pipelines/:id — 取得單一管線（用於輪詢，走記憶體快取） */
  app.get("/pipelines/:id", async (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const result = await ctx.bus.request("taskloop:get-pipeline", { id });
      if (result && result.ok && result.pipeline) {
        return c.json(result.pipeline);
      }
      return c.json({ ok: false, error: "管線不存在" }, 404);
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
      const result = await ctx.bus.request("taskloop:update-pipeline", { id, ...body });
      return result && result.ok
        ? c.json({ ok: true, pipeline: result.pipeline })
        : c.json({ ok: false, error: result?.error || "更新失敗" }, 500);
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  /** DELETE /pipelines/:id — 刪除管線 */
  app.delete("/pipelines/:id", async (c) => {
    try {
      setCorsHeaders(c);
      const id = c.req.param("id");
      const result = await ctx.bus.request("taskloop:delete-pipeline", { id });
      return result && result.ok
        ? c.json({ ok: true, deleted: true })
        : c.json({ ok: false, error: result?.error || "刪除失敗" }, 500);
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
      const agentId = c.get("agentId");
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

  // ── Session API ────────────────────────────────────────────────────────

  app.get("/sessions", async (c) => {
    try {
      setCorsHeaders(c);
      const result = await ctx.bus.request("taskloop:list-sessions", {});
      return c.json(result && result.ok ? { ok: true, sessions: result.sessions } : { ok: false, sessions: [] });
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, sessions: [], error: err.message });
    }
  });

  app.get("/sessions/:agentId", async (c) => {
    try {
      setCorsHeaders(c);
      const agentId = c.req.param("agentId");
      const result = await ctx.bus.request("taskloop:read-session", { agentId, limit: 100 });
      return c.json(result && result.ok ? { ok: true, ...result } : { ok: false, agentId, messages: [] });
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, messages: [], error: err.message });
    }
  });

  app.post("/sessions/ensure", async (c) => {
    try {
      setCorsHeaders(c);
      const body = await c.req.json();
      if (!body || !body.agentId) return c.json({ ok: false, error: "缺少 agentId" }, 400);
      const result = await ctx.bus.request("taskloop:ensure-session", { agentId: body.agentId });
      return c.json(result && result.ok ? { ok: true, session: result.session } : { ok: false, error: result?.error || "建立失敗" }, 500);
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  // ── AI 生成 API ────────────────────────────────────────────────────────

  /** POST /generate — AI 根據 prompt 產生管線 */
  app.post("/generate", async (c) => {
    try {
      setCorsHeaders(c);
      const body = await c.req.json();
      if (!body || !body.prompt) {
        return c.json({ ok: false, error: "缺少必要欄位：prompt" }, 400);
      }

      const result = await ctx.bus.request("taskloop:generate-pipeline", {
        prompt: body.prompt,
        frameworkIds: body.frameworkIds || [],
        agentId: body.agentId || "coder",
      });

      if (result && result.ok) {
        return c.json({
          ok: true,
          name: result.name,
          description: result.description,
          tasks: result.tasks,
          globalConditions: result.globalConditions || [],
          generatedByAI: true,
        });
      }

      return c.json({ ok: false, error: result?.error || "生成失敗", raw: result?.raw }, 500);
    } catch (err) {
      setCorsHeaders(c);
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.options("/generate", (c) => { setCorsHeaders(c); return c.body(null, 204); });
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
