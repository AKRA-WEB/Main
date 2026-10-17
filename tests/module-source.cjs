// Read candidates when present; otherwise use the workspace's selected read reference.
// No application/network writes. Root refreshes reference hashes before the suite.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const siblings=path.resolve(__dirname,'../..');
function repoPath(repo) {
  const candidate=path.join(siblings,repo);
  if(fs.existsSync(path.join(candidate,'index.html')))return candidate;
  let workspace=siblings;
  while(!fs.existsSync(path.join(workspace,'conductor/workspace-reference.json'))) {
    const parent=path.dirname(workspace);if(parent===workspace)throw Error('workspace reference missing');workspace=parent;
  }
  const row=JSON.parse(fs.readFileSync(path.join(workspace,'conductor/workspace-reference.json'),'utf8')).repositories.find(r=>r.repo===repo);
  if(!row)throw Error('selected reference missing: '+repo);
  const selected=path.resolve(workspace,row.sourcePath);
  if(!selected.startsWith(workspace+path.sep))throw Error('reference outside workspace');
  return selected;
}
function functionCode(source,name) {
  const start=new RegExp('^([ \\t]*)(?:async )?function '+name+'\\(', 'm').exec(source);
  if(!start) return '';
  const tail=source.slice(start.index),end=new RegExp('^'+start[1]+'\\}', 'm').exec(tail);
  if(!end)throw Error('function boundary missing: '+name);
  return tail.slice(0,end.index+end[0].length);
}
function loadAuthSupport(source,context) {
  // The actual startup attempt state and storage listener now fence cold retries.
  const startup=source.match(/    var (?:gr|po)AuthAttempt = [\s\S]*?(?=    var AuthGuard =)/);
  if(startup)vm.runInContext(startup[0],context);
  for(const name of ['uiReadErrorState','grErrorState','trdReadFailure','trdMainSessionStamp','poReadFailure','grReadFailure','showPoAuthFailure','showGRAuthFailure','showReturnAuthFailure','showTrdAuthFailure']) {
    const code=functionCode(source,name);if(code)vm.runInContext(code,context);
  }
}
module.exports={repoPath,functionCode,loadAuthSupport};
