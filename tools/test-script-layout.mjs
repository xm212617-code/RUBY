import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import '../src/scripts/sex-combat.js';
import { getCardScript } from '../src/script-registry.js';
import { h } from '../src/env.js';

const browser = [process.env.RUBY_TEST_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((path) => path && existsSync(path));
assert.ok(browser, 'set RUBY_TEST_BROWSER to a Chromium browser for layout verification');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
const shell = panelSource.match(/function buildShellHtml\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(shell, 'actual RUBY shell markup is available');
const markup = vm.runInNewContext(shell + '\nbuildShellHtml()');
const scriptUi = readFileSync(new URL('../src/scripts/sex-combat.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
const character = { avatar: 'layout.png', data: { extensions: { regex_scripts: [] } } };
globalThis.window = { SillyTavern: { getContext: () => ({ characterId: 0, characters: [character], extensionSettings: { character_allowed_regex: [] } }) } };
const noop = () => {};
const control = { value: '', addEventListener: noop, classList: { toggle: noop } };
const root = { innerHTML: '', querySelector: () => control, querySelectorAll: () => [] };
getCardScript('sex-combat').render(root, {
    data: { cardScripts: { 'sex-combat': { characters: Array.from({ length: 40 }, (_, i) => ({ name: `角色${i}`, experience: i })) } } },
    save: noop,
});
const temp = mkdtempSync('C:/Users/ADMINI~1/AppData/Local/Temp/kilo/ruby-layout-');
try {
    for (const [width, height] of [[1280, 800], [390, 844]]) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="ra_panel" style="display:flex">${markup}</div><pre id="layout-results"></pre><script>
const form=${JSON.stringify(root.innerHTML)};
document.querySelectorAll('#ra_panel .panel-content').forEach(node=>node.classList.toggle('active',node.dataset.panel==='scripts'));
const card={avatar:'layout.png',data:{extensions:{regex_scripts:[]}}};
window.SillyTavern={getContext:()=>({characterId:0,characters:[card],extensionSettings:{character_allowed_regex:[]}})};
let registration;const registerCardScript=value=>{registration=value};
const ctx=()=>window.SillyTavern.getContext();const h=${h.toString()};
${scriptUi}
let saved=null,saves=0;
registration.render(document.querySelector('#ra_script_detail'),{data:{cardScripts:{'sex-combat':{characters:Array.from({length:40},(_,i)=>({name:'角色'+i,experience:i}))}}},async save(mutator){const draft={};mutator(draft);saved=draft;saves++;return {ok:true}}});
for(let i=40;i<43;i++){document.querySelector('#sc-character-name').value='角色'+i;document.querySelector('#sc-character-exp').value=String(i);document.querySelector('#sc-character-add').click()}
const rowsBeforeDelete=document.querySelectorAll('#sc-character-list [data-character]').length;
document.querySelector('#sc-character-list [data-character="1"] .sc-del').click();
document.querySelector('#sc-save').click();
setTimeout(()=>{
  function visible(selector){
    const node=document.querySelector(selector);node.scrollIntoView({block:'center',inline:'nearest'});
    const box=node.getBoundingClientRect();let top=Math.max(box.top,0),bottom=Math.min(box.bottom,innerHeight),left=Math.max(box.left,0),right=Math.min(box.right,innerWidth);
    for(let parent=node.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom)}if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right)}}
    return {visible:bottom-top>=Math.min(box.height,20)&&right-left>=Math.min(box.width,30),height:box.height,width:box.width};
  }
  const list=document.querySelector('#sc-character-list');
  const result={width:innerWidth,rowsBeforeDelete,saves,savedCount:saved?.characters?.length,rows:list.querySelectorAll('[data-character]').length,listHeight:list.clientHeight,listContent:list.scrollHeight,first:visible('#sc-character-list .sc-name'),last:visible('#sc-character-list [data-character="41"] .sc-name'),name:visible('#sc-character-name'),experience:visible('#sc-character-exp'),add:visible('#sc-character-add'),save:visible('#sc-save'),install:visible('#sc-install-regex')};
  document.querySelector('#layout-results').textContent=JSON.stringify(result);
},80);</script></body></html>`;
        const file = join(temp, `layout-${width}.html`);
        writeFileSync(file, html);
        const output = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--disable-extensions', `--user-data-dir=${join(temp, `profile-${width}`)}`, `--window-size=${width},${height}`, '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
        assert.ifError(output.error);
        assert.equal(output.status, 0, output.stderr);
        const raw = output.stdout.match(/<pre id="layout-results">([^<]+)<\/pre>/)?.[1];
        assert.ok(raw, `browser produced measurements at ${width}px`);
        const result = JSON.parse(raw);
        assert.equal(result.rowsBeforeDelete, 43, 'real browser can add three more rows to an already long roster');
        assert.equal(result.rows, 42);
        assert.equal(result.savedCount, 42, 'real browser saves all remaining rows');
        assert.equal(result.saves, 1);
        assert.ok(result.listContent > result.listHeight && result.listHeight <= 280, 'long roster has a bounded scroll area');
        for (const key of ['first', 'last', 'name', 'experience', 'add', 'save', 'install']) assert.ok(result[key].visible, `${key} must be reachable and visible at ${width}px: ${raw}`);
        console.log(`layout ${width}x${height}: 43 rows added, 42 saved; last row, new inputs, add and save controls reachable`);
    }
} finally {
    delete globalThis.window;
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* Chromium may still be releasing its profile files. */ }
}
