/**
 * TaskLoop 插件 - Blueprint 節點編輯器
 * Unreal Blueprint 風格的任務管線視覺化編輯器
 * 使用 React Flow (@xyflow/react)
 */

import { useCallback, useMemo, useRef, useState } from 'react';
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
  onTasksChange: (tasks: Task[]) => void;
  onConditionsChange: (conditions: GlobalCondition[]) => void;
  onNameChange: (name: string) => void;
  onPromptChange: (prompt: string) => void;
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
  onTasksChange, onConditionsChange,
  pipelineName, pipelinePrompt,
  onNameChange, onPromptChange,
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

  // 根據節點建立連線
  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
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
    return edges;
  }, [tasks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 同步外部變更
  useMemo(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges]);

  // 連線處理
  const onConnect: OnConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({ ...connection, type: 'smoothstep', animated: true }, eds));
  }, [setEdges]);

  // 節點選取
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

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
      conditions: fw.defaultConditions.map((condId, i) => {
        const cond = BUILT_IN_CONDITIONS.find(c => c.id === condId);
        if (!cond) return null;
        return {
          id: `${nextNodeId()}_cond_${i}`,
          type: (cond.type === 'cycle' || cond.type === 'count') ? 'on_success' as const : 'on_failure' as const,
          config: {},
          action: (cond.availableActions[0] === 'retry' ? 'retry' : cond.availableActions[0] === 'git_push' ? 'continue' : 'continue') as any,
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

  // 刪除選取的任務
  const deleteSelectedTask = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'taskNode') return;
    const taskId = selectedNode.id;
    const filtered = tasks.filter(t => t.id !== taskId).map((t, i) => ({ ...t, orderIndex: i }));
    onTasksChange(filtered);
    setSelectedNode(null);
  }, [selectedNode, tasks, onTasksChange]);

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
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
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
        <button className="bp-btn bp-btn-accent" disabled>
          ✨ AI 生成
        </button>
      </div>
    </div>
  );
}
