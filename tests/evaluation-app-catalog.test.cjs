const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const shell=fs.readFileSync(path.join(__dirname,'..','js','unified-shell.js'),'utf8');
const permissionCatalog=fs.readFileSync(path.join(__dirname,'..','js','permission-catalog.js'),'utf8');
const permissionEditor=fs.readFileSync(path.join(__dirname,'..','js','user-permission-editor.js'),'utf8');

const modules={
  'app-w5':'/AKRA/',
  'app-trd':'/TRDAKRA/',
  'app-gr':'/GR/',
  'app-pr':'/PR/',
  'app-pick':'/Picking/',
  'app-tracking':'/TrackingPO/',
  'app-damage':'/Returnitem/',
  'app-kpi':'/KPITRACKER/',
  'app-manual':'/SOP/',
  'app-evaluation':'/Evaluation/'
};

function keysFor(constName, text=source){
  const block=text.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\s*\\};`));
  assert.ok(block,`${constName} must remain declared`);
  return [...block[1].matchAll(/"(app-[a-z0-9-]+)"\s*:/g)].map(match=>match[1]);
}

test('Main fallback catalog includes the selected Evaluation Pages target',()=>{
  const match=source.match(/\{ id: "app-evaluation",[\s\S]*?\n\s*\}/);
  assert.ok(match,'Evaluation must remain available when the authoritative snapshot is temporarily unavailable');
  assert.match(match[0],/name: "แบบประเมินพนักงาน"/);
  assert.match(match[0],/url: "https:\/\/akra-web\.github\.io\/Evaluation\/"/);
  assert.match(match[0],/roles: \["ADMIN", "SUPERVISOR"\]/);
});

test('Evaluation has complete Main dashboard presentation metadata',()=>{
  assert.match(source, /"app-evaluation": "People evaluation"/);
  assert.match(source, /"app-evaluation": "analytics"/);
  assert.match(source, /"app-evaluation": "#ea580c"/);
  assert.match(source, /"app-evaluation": '<svg[\s\S]*?\/svg>'/);
});

test('Main canonical catalog, aliases and shell paths cover every module exactly once',()=>{
  const expected=Object.keys(modules);
  const ids=[...source.matchAll(/\{ id: "(app-[a-z0-9-]+)",/g)].map(match=>match[1]);
  assert.deepEqual(ids,expected,'fallback catalog must contain the ten canonical modules in launch order');
  for(const [id,route] of Object.entries(modules)){
    assert.match(source,new RegExp(`id: "${id}"[\\s\\S]*?url: "https://akra-web\\.github\\.io${route.replaceAll('/','\\/') }"`),`${id} fallback URL`);
    assert.match(shell,new RegExp(`['"]${id}['"]\\s*:\\s*['"]${route}['"]`),`${id} shell path`);
  }
  for(const map of ['MAIN_APP_LABELS','MAIN_APP_TYPES','MAIN_APP_CATEGORIES','MAIN_APP_COLORS','MAIN_APP_LOGOS']){
    assert.deepEqual([...new Set(keysFor(map))].sort(),expected.slice().sort(),`${map} must cover every canonical module`);
  }
});

test('Main permission aliases resolve in both display and backend catalog directions',()=>{
  for(const [legacy,canonical] of Object.entries({
    'app-po':'app-tracking',
    'app-akra':'app-w5',
    'app-ret':'app-damage'
  })){
    assert.match(source,new RegExp(`"${legacy}"\\s*:\\s*"${canonical}"`),`${legacy} must resolve to ${canonical} in Main`);
    assert.match(permissionEditor,new RegExp(`['"]${legacy}['"]\\s*:\\s*['"]${canonical}['"]`),`${legacy} must resolve in individual permission editor`);
    assert.match(permissionCatalog,new RegExp(`['"]${canonical}['"]\\s*:\\s*['"]${legacy}['"]`),`${canonical} must resolve in permission catalog`);
  }
});
