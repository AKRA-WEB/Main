const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const start = html.indexOf('const AKRA_SSO = {');
const end = html.indexOf('\n        };',start)+'\n        };'.length;
let pending = true;
const opened = [], popups = [], logs = [], decisions = [];
const context = vm.createContext({
    state:{sessionToken:'fixture',currentUser:'Fixture',currentRoles:['WAREHOUSE'],appConfig:[{id:'app-tracking',url:'https://akra-web.github.io/TrackingPO/',roles:['WAREHOUSE']}]},
    App:{handleLogout(){},queueNavigationIfRefreshing:()=>pending,openChangePasswordModal(){}},
    UI:{showToast(){}},API:{sendLog:(...args)=>logs.push(args)},safeAppUrl:value=>value,
    window:{AkraShell:{open:(id,options)=>{opened.push(id);decisions.push(options.onOpened);return false;}},open:value=>popups.push(value)}
});
vm.runInContext(html.slice(start,end)+';this.sso=AKRA_SSO;',context);
context.sso.openApp('https://akra-web.github.io/TrackingPO/','app-tracking');
assert.equal(opened.length,0);
pending=false;
context.sso.openApp('https://akra-web.github.io/TrackingPO/','app-tracking');
assert.deepEqual(opened,['app-tracking']);
assert.deepEqual(logs,[], 'an outstanding leave decision does not log an opened app');
decisions[0]();
assert.deepEqual(logs,[['Open App','app-tracking','Fixture เปิดแอป']], 'the actual accepted launch logs the original app and actor');
assert.deepEqual(popups,[],'normal and pending navigation never opens a popup');
context.state.currentRoles=[];
context.sso.openApp('https://akra-web.github.io/TrackingPO/','app-tracking');
assert.equal(opened.length,1,'removed app grant cannot launch');
console.log('PASS Main PO navigation: refresh gate, accepted-launch log callback, no popup, revoked grant denied');
