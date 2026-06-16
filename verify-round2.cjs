const fs = require('fs');

const panel = fs.readFileSync('ui/Panel.tsx', 'utf-8');
const bp = fs.readFileSync('ui/BlueprintEditor.tsx', 'utf-8');

let passed = 0, failed = 0;

function check(name, cond, detail) {
  if (cond) { console.log('  OK', name); passed++; }
  else { console.log('  FAIL', name, '-', detail || ''); failed++; }
}

console.log('\n=== Round 2 Verification ===');

console.log('\nPanel.tsx:');
check('handleSave sends prompt', panel.includes('prompt: formData.prompt'));
check('handleSave sends frameworkIds', panel.includes('frameworkIds: formData.frameworkIds'));
check('handleSave clears execError', panel.includes("setSaveStatus('success');\n      setExecError(null);"));

console.log('\nBlueprintEditor.tsx:');
check('useEffect replaces useMemo for sync', !bp.includes('useMemo(() => {\n    setNodes(initialNodes);') && bp.includes('useEffect(() => {'));
check('useEffect imported', bp.includes('useEffect'));
check('deleteSelectedTask clears edges', bp.includes("setEdges(eds => eds.filter"));
check('deleteSelectedTask clears dependsOn', bp.includes("dependsOn: (t.dependsOn || []).filter(d => d !== deletedId)"));
check('addTaskFromFramework has proper config mapping', bp.includes("condConfig[field.key]"));
check('addTaskFromFramework uses availableActions[0]', bp.includes("cond.availableActions[0] || 'continue'"));

console.log('\nResult:', passed, '/', (passed + failed));
if (failed === 0) console.log('ALL PASSED');
else process.exit(1);
