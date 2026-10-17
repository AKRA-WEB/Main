// Executes the actual adapter functions. Layout/visibility needs the browser matrix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/unified-shell.js'), 'utf8');
const from = source.indexOf('    const EMBEDDED_HEADER_RULES =');
const to = source.indexOf('    function init(options)', from);
assert.ok(from > 0 && to > from);
const mappings = [
    ['TRD', '#trd-topbar', '.trd-topbar__actions'], ['GR', '.gr-topbar', ':scope > div > div > .space-x-2'],
    ['PR', '#app-content > nav', ':scope > div > div > div:last-child'], ['RETURN', '.returnitem-topbar', '.returnitem-topbar__actions'],
    ['BM', '.app-header', ':scope > div > div:last-child'], ['PO', '#app-shell > header', ':scope > div > div > div:last-child'],
    ['W5', '.w5-topbar', ':scope > .w5-topbar-inner'], ['DATA', '.topbar', '.topbar-actions'], ['SOP', '.top-nav', '.nav-controls']
];
function fixture(headerSelector, actionSelector) {
    const origin = 'https://fixture.invalid', styles = [], classes = new Set();
    const node = tag => ({ tag, children: [], dataset: {}, attrs: {}, hidden: false, tabIndex: 0, textContent: '', id: '', className: '',
        classList: { add() {} }, append(child) { this.children.push(child); }, prepend(child) { this.children.unshift(child); },
        setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key] || null; }, addEventListener() {},
        matches() { return false; }, querySelector() { return null; } });
    const host = node('div'), header = node('header'), home = node('button'), logout = node('button'), pageAction = node('button');
    home.attrs.onclick = 'AkraModule.home()'; home.textContent = 'กลับหน้าหลัก'; logout.id = 'logout-btn'; logout.textContent = 'ออกจากระบบ';
    pageAction.textContent = 'บันทึกร่าง'; pageAction.attrs['aria-label'] = 'บันทึกร่าง'; header.textContent = 'ชื่อหน้าทดสอบ';
    host.children = [home, logout, pageAction];
    header.querySelector = selector => selector === actionSelector ? host : null;
    header.querySelectorAll = () => host.children;
    const doc = { location: { origin }, querySelector: selector => selector === headerSelector ? header : null, querySelectorAll:()=>[],
        getElementById: id => styles.find(style => style.id === id), head: { appendChild: style => styles.push(style) },
        createElement(tag) { const element = node(tag); element.ownerDocument = doc; return element; } };
    for (const item of [header, host, home, logout, pageAction]) item.ownerDocument = doc;
    const frame = { contentDocument: doc };
    const context = vm.createContext({ window: { location: { origin } }, active: { frame }, panel: { classList: { add: value => classes.add(value) } },
        MutationObserver: class { observe() {} }, home() {}, open() {} });
    new vm.Script(source.slice(from, to), { filename: 'unified-shell.js:actual-header-adapter' }).runInContext(context);
    return { context, doc, frame, header, host, home, logout, pageAction, styles, classes };
}
for (const [app, header, action] of mappings) test(`${app} embedded header preserves page title/actions and suppresses duplicate navigation without injecting controls`, () => {
    const f = fixture(header, action);
    assert.equal(f.context.adaptEmbeddedHeader(f.frame), true);
    assert.equal(f.home.hidden, true); assert.equal(f.logout.hidden, true);
    assert.equal(f.home.attrs['aria-hidden'], 'true'); assert.equal(f.logout.tabIndex, -1);
    assert.equal(f.pageAction.hidden, false); assert.equal(f.header.textContent, 'ชื่อหน้าทดสอบ');
    assert.equal(f.host.children.length, 3, 'Main navigation is not injected into the child');
    f.context.adaptEmbeddedHeader(f.frame);
    assert.equal(f.host.children.length, 3); assert.equal(f.styles.length, 1);
    assert.equal(f.classes.has('shell-child-header'), true);
});
test('adapter leaves standalone, foreign-origin, missing-header and inactive-frame documents untouched', () => {
    for (const mode of ['standalone', 'foreign', 'missing', 'inactive']) {
        const f = fixture('.topbar', '.topbar-actions');
        if (mode === 'standalone') f.context.active = null;
        if (mode === 'foreign') f.doc.location.origin = 'https://foreign.invalid';
        if (mode === 'missing') f.doc.querySelector = () => null;
        if (mode === 'inactive') f.context.active = { frame: {} };
        assert.equal(f.context.adaptEmbeddedHeader(f.frame), false);
        assert.equal(f.home.hidden, false); assert.equal(f.logout.hidden, false); assert.equal(f.host.children.length, 3);
    }
});

test('adapter suppresses every duplicate home/logout control while keeping page actions', () => {
    const f=fixture('.topbar','.topbar-actions');
    const anotherHome={...f.home,dataset:{},attrs:{...f.home.attrs}},anotherLogout={...f.logout,dataset:{},attrs:{...f.logout.attrs}};
    f.host.children.push(anotherHome,anotherLogout);f.context.adaptEmbeddedHeader(f.frame);
    assert.equal(anotherHome.hidden,true);assert.equal(anotherLogout.hidden,true);assert.equal(f.pageAction.hidden,false);
});
test('DATA delegated home action is suppressed even without an inline onclick signature',()=>{
    const f=fixture('.workspace-bar','.workspace-location');
    delete f.home.attrs.onclick;f.home.textContent='กลับ Main';f.home.dataset.action='home';
    f.context.adaptEmbeddedHeader(f.frame);
    assert.equal(f.home.hidden,true);assert.equal(f.home.tabIndex,-1);assert.equal(f.pageAction.hidden,false);
});
test('TRD dynamic workflow header preserves local home navigation while retaining title and submit',()=>{
    const f=fixture('#trd-topbar','.trd-topbar__actions');
    const workflowHome={...f.home,dataset:{},attrs:{onclick:"setView('home')",'aria-label':'กลับหน้าหลัก'},hidden:false};
    const submit={...f.pageAction,dataset:{},attrs:{},hidden:false,textContent:'ส่งคำขอเบิก'};
    const workflowHeader={querySelectorAll:()=>[workflowHome,submit],textContent:'เบิกสินค้า'};
    f.doc.querySelectorAll=selector=>selector==='#main-view > div > header'?[workflowHeader]:[];
    f.context.adaptEmbeddedHeader(f.frame);
    assert.equal(workflowHome.hidden,false);assert.notEqual(workflowHome.tabIndex,-1);
    assert.equal(f.home.hidden,true,'the separate Main portal action remains suppressed');
    assert.equal(submit.hidden,false);assert.equal(workflowHeader.textContent,'เบิกสินค้า');
});
