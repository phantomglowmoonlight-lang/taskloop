/**
 * TaskLoop 插件 - Blueprint 節點編輯器
 * Unreal Blueprint 風格的任務管線視覺化編輯器
 * 使用 React Flow (@xyflow/react)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './blueprint-editor.css';

import type { Task, GlobalCondition } from './types';
import { BUILT_IN_FRAMEWORKS, BUILT_IN_CONDITIONS } from './templates';

// ─── Props ───────────────────────────────────────────────

interface BlueprintEditorProps {
  tasks: Task[];
  globalConditions: GlobalCondition[];
  pipelineName: string;
  pipelinePrompt: string;
  frameworkIds?: string[];
  onTasksChange: (tasks: Task[]) => void;
  onConditionsChange: (conditions: GlobalCondition[]) => void;
  onNameChange: (name: string) => void;
  onPromptChange: (prompt: string) => void;
  onFrameworkIdsChange?: (ids: string[]) => void;
  onGenerate?: (prompt: string) => void;
  generating?: boolean;
}

let nodeIdCounter = 100;

function nextNodeId(): string {
  return `node_${++nodeIdCounter}`;
}

// ─── 自訂節點：開始 ──────────────────────────────────────

function StartNode({ data }: NodeProps) {
  return (
    <div className="bp-node bp-node--start">
      <Handle type="source" position={Position.Right} />
      <div className="bp-node-icon">▶</div>
      <div className="bp-node-label">{data.label || '開始'}</div>
    </div>
  );
}

// ─── 自訂節點：結束 ──────────────────────────────────────

function EndNode({ data }: NodeProps) {
  return (
    <div className="bp-node bp-node--end">
      <Handle type="target" position={Position.Left} />
      <div className="bp-node-icon">⏹</div>
      <div className="bp-node-label">{data.label || '結束'}</div>
    </div>
  );
}

// ─── 自訂節點：任務 ──────────────────────────────────────

function TaskNode({ data, selected }: NodeProps) {
  const task = data.task as Task;
  return (
    <div className={`bp-node bp-node--task ${selected ? 'bp-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="bp-node-header">
        <span className="bp-node-header-index">{task.orderIndex + 1}</span>
        <span className="bp-node-header-name">{task.name || '未命名'}</span>
        {task.agentId && (
          <span className="bp-node-agent-badge">{task.agentId}</span>
        )}
      </div>
      <div className="bp-node-body">
        <div className="bp-node-prompt-preview">
          {task.prompt ? task.prompt.slice(0, 80) + (task.prompt.length > 80 ? '...' : '') : '無 prompt'}
        </div>
      </div>
      {task.conditions.length > 0 && (
        <div className="bp-node-footer">
          <span className="bp-node-cond-badge">{task.conditions.length} 條件</span>
        </div>
      )}
    </div>
  );
}

// ─── 自訂節點類型映射 ────────────────────────────────────

const nodeTypes = {
  startNode: StartNode,
  endNode: EndNode,
  taskNode: TaskNode,
};

// ─── 主編輯器元件 ────────────────────────────────────────

export default function BlueprintEditor({
  tasks, globalConditions,
  frameworkIds = [],
  onTasksChange, onConditionsChange,
  pipelineName, pipelinePrompt,
  onNameChange, onPromptChange,
  onFrameworkIdsChange,
  onGenerate, generating,
}: BlueprintEditorProps) {
  const flowWrapper = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // 顯示模板面板
  const [showTemplates, setShowTemplates] = useState(false);

  // 將 tasks 轉換為 React Flow 節點
  const initialNodes: Node[] = useMemo(() => {
    const nodes: Node[] = [];
    // 起點
    nodes.push({
      id: 'start',
      type: 'startNode',
      position: { x: 50, y: 100 },
      data: { label: '開始' },
      deletable: false,
    });

    // 任務節點
    const sorted = [...tasks].sort((a, b) => a.orderIndex - b.orderIndex);
    sorted.forEach((task, i) => {
      nodes.push({
        id: task.id,
        type: 'taskNode',
        position: { x: 280 + i * 280, y: 80 },
        data: { task },
      });
    });

    // 終點
    nodes.push({
      id: 'end',
      type: 'endNode',
      position: { x: 280 + sorted.length * 280, y: 100 },
      data: { label: '結束' },
      deletable: false,
    });

    return nodes;
  }, [tasks]);

  // 從 tasks[].dependsOn 建立連線，若無 dependsOn 則用 orderIndex 線性連線
  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const hasAnyDep = tasks.some(t => t.dependsOn && t.dependsOn.length > 0);

    if (hasAnyDep) {
      // 使用 dependsOn 建立連線
      for (const t of tasks) {
        if (t.dependsOn && t.dependsOn.length > 0) {
          for (const dep of t.dependsOn) {
            const sourceId = dep; // dependsOn 存的是來源任務的 ID 或名稱
            if (sourceId && taskMap.has(sourceId)) {
              edges.push({
                id: `e-${sourceId}-${t.id}`,
                source: sourceId,
                target: t.id,
                type: 'smoothstep',
                animated: true,
              });
            }
          }
        }
      }
      // 找出沒有被任何任務 dependsOn 的任務（entry），從 start 連到它們
      const targeted = new Set(tasks.flatMap(t => t.dependsOn || []));
      const entryTasks = tasks.filter(t => !(t.dependsOn && t.dependsOn.length > 0));
      for (const t of entryTasks) {
        edges.push({ id: `e-start-${t.id}`, source: 'start', target: t.id, type: 'smoothstep', animated: true });
      }
      // 找出沒有出現在任何 dependsOn 參照中的任務（leaf），連到 end
      const leafTasks = tasks.filter(t => !targeted.has(t.id) && !targeted.has(t.name));
      for (const t of leafTasks) {
        edges.push({ id: `e-${t.id}-end`, source: t.id, target: 'end', type: 'smoothstep', animated: true });
      }
    } else {
      // 無 dependsOn：按 orderIndex 線性連線
      const nodeIds = ['start', ...tasks.sort((a, b) => a.orderIndex - b.orderIndex).map(t => t.id), 'end'];
      for (let i = 0; i < nodeIds.length - 1; i++) {
        edges.push({
          id: `e-${nodeIds[i]}-${nodeIds[i + 1]}`,
          source: nodeIds[i],
          target: nodeIds[i + 1],
          type: 'smoothstep',
          animated: true,
        });
      }
    }
    return edges;
  }, [tasks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // handleEdgesChange 需要透過 ref 存取當前 edges，避免 stale closure
  const handleEdgesChange = useCallback((changes: any[]) => {
    const currentEdges = edgesRef.current;
    for (const change of changes) {
      if (change.type === 'remove') {
        const removedEdge = currentEdges.find((e: any) => e.id === change.id);
        if (removedEdge) {
          const sourceId = removedEdge.source;
          const targetId = removedEdge.target;
          if (sourceId && targetId && sourceId !== 'start' && targetId !== 'end') {
            const currentTasks = tasksRef.current;
            const targetExists = currentTasks.some(t => t.id === targetId);
            if (targetExists) {
              onTasksChange(currentTasks.map(t =>
                t.id === targetId
                  ? { ...t, dependsOn: (t.dependsOn || []).filter(d => d !== sourceId) }
                  : t,
              ));
            }
          }
        }
      }
    }
    onEdgesChange(changes);
  }, [tasks, onTasksChange, onEdgesChange]);

  // 同步外部 tasks 變更到 React Flow 內部狀態（useEffect 而非 useMemo）
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // 連線處理：更新目標任務的 dependsOn
  const onConnect: OnConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === 'start' || connection.target === 'end' || connection.source === connection.target) return;
    if (connection.source === 'end' || connection.target === 'start') return;

    const targetTask = tasks.find(t => t.id === connection.target);
    if (!targetTask) return;

    const newDependsOn = [...(targetTask.dependsOn || [])];
    if (!newDependsOn.includes(connection.source)) {
      newDependsOn.push(connection.source);
      onTasksChange(tasks.map(t =>
        t.id === targetTask.id ? { ...t, dependsOn: newDependsOn } : t
      ));
    }

    setEdges((eds) => addEdge({ ...connection, type: 'smoothstep', animated: true }, eds));
  }, [tasks, onTasksChange, setEdges]);

  // 節點選取
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // 鍵盤刪除節點 → 實際刪除任務 + 清理相關邊線與依賴
  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    const deletedIds = new Set(deletedNodes.map(n => n.id));
    const remaining = tasks.filter(t => !deletedIds.has(t.id)).map((t, i) => ({
      ...t,
      orderIndex: i,
      // 移除對已刪除任務的 dependsOn 參照
      dependsOn: (t.dependsOn || []).filter(d => !deletedIds.has(d)),
    }));
    onTasksChange(remaining);
    setEdges(eds => eds.filter(e => !deletedIds.has(e.source) && !deletedIds.has(e.target)));
    if (selectedNode && deletedIds.has(selectedNode.id)) {
      setSelectedNode(null);
    }
  }, [tasks, onTasksChange, selectedNode, setEdges]);

  // 新增任務
  const addNewTask = useCallback(() => {
    const newTask: Task = {
      id: nextNodeId(),
      orderIndex: tasks.length,
      name: `任務 ${tasks.length + 1}`,
      prompt: '',
      repeat: 1,
      repeatCount: 0,
      conditions: [],
      status: 'pending',
      result: '',
      startedAt: null,
      completedAt: null,
    };
    onTasksChange([...tasks, newTask]);
  }, [tasks, onTasksChange]);

  // 從框架模板新增任務
  const addTaskFromFramework = useCallback((fwId: string) => {
    const fw = BUILT_IN_FRAMEWORKS.find(f => f.id === fwId);
    if (!fw) return;

    const newTask: Task = {
      id: nextNodeId(),
      orderIndex: tasks.length,
      name: fw.name,
      prompt: fw.promptTemplate,
      repeat: 1,
      repeatCount: 0,
      conditions: (fw.defaultConditions || []).map((condId, i) => {
        const cond = BUILT_IN_CONDITIONS.find(c => c.id === condId);
        if (!cond) return null;
        // 正確映射 conditions：根據模板的 configFields 建立預設 config
        const condConfig: Record<string, unknown> = {};
        for (const field of (cond.configFields || [])) {
          if (field.defaultValue !== undefined) condConfig[field.key] = field.defaultValue;
        }
        // 將 ConditionTemplate.type 映射為 TaskConditionType
        const condTypeMap: Record<string, string> = {
          cycle: 'repeat_until',
          time: 'on_failure',
          count: 'on_failure',
          result: 'on_success',
          custom: 'custom',
        };
        return {
          id: `${nextNodeId()}_cond_${i}`,
          type: (condTypeMap[cond.type] || 'on_success') as any,
          config: condConfig,
          action: cond.availableActions[0] || 'continue',
          actionTarget: null,
        };
      }).filter(Boolean) as any[],
      status: 'pending',
      result: '',
      startedAt: null,
      completedAt: null,
    };
    onTasksChange([...tasks, newTask]);
    setShowTemplates(false);
  }, [tasks, onTasksChange]);

  // 刪除選取的任務（含清理 edges + dependsOn）
  const deleteSelectedTask = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'taskNode') return;
    const deletedId = selectedNode.id;
    const filtered = tasks.filter(t => t.id !== deletedId).map((t, i) => ({
      ...t,
      orderIndex: i,
      dependsOn: (t.dependsOn || []).filter(d => d !== deletedId),
    }));
    onTasksChange(filtered);
    setEdges(eds => eds.filter(e => e.source !== deletedId && e.target !== deletedId));
    setSelectedNode(null);
  }, [selectedNode, tasks, onTasksChange, setEdges]);

  // ─── 側邊選取任務的屬性編輯器 ──────────────────────────

  const selectedTask = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'taskNode') return null;
    return tasks.find(t => t.id === selectedNode.id) || null;
  }, [selectedNode, tasks]);

  function updateSelectedTask(field: string, value: unknown) {
    if (!selectedTask) return;
    onTasksChange(tasks.map(t => t.id === selectedTask.id ? { ...t, [field]: value } : t));
  }

  // ─── 渲染 ──────────────────────────────────────────────

  return (
    <div className="bp-wrapper">
      {/* 頂部工具列 */}
      <div className="bp-toolbar">
        <input
          className="bp-name-input"
          value={pipelineName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="管線名稱"
        />
        <div className="bp-toolbar-actions">
          <button className="bp-btn bp-btn-primary" onClick={addNewTask}>
            + 任務
          </button>
          <button className="bp-btn" onClick={() => setShowTemplates(!showTemplates)}>
            📦 框架
          </button>
          {selectedNode && selectedNode.type === 'taskNode' && (
            <button className="bp-btn bp-btn-danger" onClick={deleteSelectedTask}>
              🗑 刪除
            </button>
          )}
        </div>
      </div>

      <div className="bp-body">
        {/* 模板面板（左側彈出） */}
        {showTemplates && (
          <div className="bp-template-panel">
            <h3 className="bp-template-title">框架模板</h3>
            <p className="bp-template-hint">點擊加入管線</p>
            {BUILT_IN_FRAMEWORKS.map(fw => (
              <button
                key={fw.id}
                className="bp-template-item"
                onClick={() => addTaskFromFramework(fw.id)}
              >
                <span className="bp-template-icon">{fw.icon}</span>
                <div className="bp-template-info">
                  <strong>{fw.name}</strong>
                  <span className="bp-template-desc">{fw.description}</span>
                </div>
              </button>
            ))}
            <h3 className="bp-template-title" style={{ marginTop: 16 }}>條件模板</h3>
            {BUILT_IN_CONDITIONS.map(cond => (
              <div key={cond.id} className="bp-template-item bp-template-item--cond">
                <span className="bp-template-icon">{cond.icon}</span>
                <div className="bp-template-info">
                  <strong>{cond.name}</strong>
                  <span className="bp-template-desc">{cond.description}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* React Flow 節點圖 */}
        <div className="bp-flow-area" ref={flowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodesDelete={onNodesDelete}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            deleteKeyCode={['Backspace', 'Delete']}
            selectionOnDrag
            panOnDrag={[1, 2]}
          >
            <Background color="#ccc" gap={20} />
            <Controls showInteractive={false} />
            <MiniMap
              nodeStrokeColor="#537d96"
              nodeColor={(n) => {
                if (n.type === 'startNode') return '#27ae60';
                if (n.type === 'endNode') return '#e74c3c';
                return '#537d96';
              }}
              maskColor="rgba(0,0,0,0.1)"
              style={{ border: '1px solid #e0dcd4', borderRadius: 8 }}
            />
          </ReactFlow>
        </div>

        {/* 屬性面板（右側） */}
        {selectedTask && (
          <div className="bp-properties-panel">
            <h3 className="bp-props-title">任務屬性</h3>
            <div className="bp-props-field">
              <label>名稱</label>
              <input
                value={selectedTask.name}
                onChange={(e) => updateSelectedTask('name', e.target.value)}
              />
            </div>
            <div className="bp-props-field">
              <label>Agent</label>
              <select
                value={selectedTask.agentId || ''}
                onChange={(e) => updateSelectedTask('agentId', e.target.value || undefined)}
              >
                <option value="">繼承管線</option>
                <option value="coder">coder</option>
                <option value="hanako">hanako</option>
                <option value="hi">hi</option>
                <option value="pm">pm</option>
              </select>
            </div>
            <div className="bp-props-field">
              <label>重複次數</label>
              <input
                type="number"
                min={1}
                value={selectedTask.repeat}
                onChange={(e) => updateSelectedTask('repeat', Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </div>
            <div className="bp-props-field bp-props-field--prompt">
              <label>Prompt</label>
              <textarea
                value={selectedTask.prompt}
                onChange={(e) => updateSelectedTask('prompt', e.target.value)}
                rows={6}
                placeholder="輸入 AI 任務指示..."
              />
            </div>
            {selectedTask.conditions.length > 0 && (
              <div className="bp-props-field">
                <label>條件 ({selectedTask.conditions.length})</label>
                <div className="bp-props-conditions">
                  {selectedTask.conditions.map((c, i) => (
                    <div key={c.id} className="bp-props-cond-item">
                      {c.type}: {c.action}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部 Prompt 輸入區 */}
      <div className="bp-prompt-bar">
        <div className="bp-prompt-frameworks">
          <span className="bp-prompt-label">框架模板</span>
          <div className="bp-prompt-fw-list">
            {BUILT_IN_FRAMEWORKS.map(fw => {
              const selected = frameworkIds.includes(fw.id);
              return (
                <button
                  key={fw.id}
                  className={`bp-fw-tag ${selected ? 'bp-fw-tag--on' : ''}`}
                  onClick={() => {
                    const next = selected
                      ? frameworkIds.filter(id => id !== fw.id)
                      : [...frameworkIds, fw.id];
                    onFrameworkIdsChange?.(next);
                  }}
                  title={fw.description}
                >
                  {fw.icon} {fw.name}
                </button>
              );
            })}
          </div>
        </div>
        <div className="bp-prompt-input-wrapper">
          <span className="bp-prompt-icon">💬</span>
          <textarea
            className="bp-prompt-input"
            value={pipelinePrompt}
            onChange={(e) => onPromptChange(e.target.value)}
            placeholder="輸入高層級目標，AI 將自動產生對應的任務管線... 例如：持續進行程式碼審查、修 bug 和優化，每 3 次循環確認 bug 處理完後推 git"
            rows={2}
          />
        </div>
        <button
          className="bp-btn bp-btn-accent"
          onClick={() => onGenerate?.(pipelinePrompt)}
          disabled={generating || !pipelinePrompt.trim()}
        >
          {generating ? '⏳ 生成中...' : '✨ AI 生成'}
        </button>
      </div>
    </div>
  );
}
