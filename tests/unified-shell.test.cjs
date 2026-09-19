const test = require('node:test');
const assert = require('node:assert/strict');
const { moduleUrl, routeId, canLaunch, acceptsMessage } = require('../js/unified-shell.js');

const origin = 'https://akra-web.github.io';
const app = {id:'app-tracking', url: origin + '/TrackingPO/', roles:['WAREHOUSE']};
const session = {sessionToken:'fixture-token', currentRoles:['WAREHOUSE'], appConfig:[app]};
test('only a configured module path on the current trusted origin is loadable', () => {
  assert.equal(moduleUrl(app, origin), origin + '/TrackingPO/?shell=1');
  for (const url of [origin+'/Main/', origin+'/TrackingPO/evil.html', 'https://evil.test/TrackingPO/', 'javascript:alert(1)', origin+'/TrackingPO/?sso=secret']) {
    assert.equal(moduleUrl({...app,url}, origin), '', url);
  }
  assert.equal(moduleUrl({...app,url:origin+'/TrackingPO/#sso=secret'},origin),'');
});
test('IDs only in routes; reject arbitrary URLs, malformed encodings and path traversal', () => {
  assert.equal(routeId('#/app/app-tracking'),'app-tracking');
  assert.equal(routeId(''),'');
  assert.equal(routeId('#/'), '');
  for (const value of ['#/app/https://evil.test', '#/app/%', '#/app/../Main', '#/app/app-tracking?sso=x']) assert.equal(routeId(value),null);
});
test('app access fails closed for stale/mandatory/absent session and removed assignment, including ADMIN', () => {
  assert.equal(canLaunch(app.id,session),true);
  for (const override of [{sessionToken:''},{sessionRefreshPending:true},{sessionRefreshFailed:true},{mustChangePassword:true},{currentRoles:['ADMIN']},{appConfig:[]}]) {
    assert.equal(canLaunch(app.id,{...session,...override}),false);
  }
});
test('bridge messages require both the active frame source and exact origin/protocol', () => {
  const source = {};
  const event = {origin,source,data:{channel:'akra-shell',version:1,type:'ready'}};
  assert.equal(acceptsMessage(event,source,origin),true);
  assert.equal(acceptsMessage({...event,source:{}},source,origin),false);
  assert.equal(acceptsMessage({...event,origin:'https://evil.test'},source,origin),false);
  assert.equal(acceptsMessage({...event,data:{...event.data,version:2}},source,origin),false);
});
