/* Does a drag OUT of the shelf terminate?
 *
 * ⚠️ The question that matters is not whether the drop lands — it is whether
 * `DoDragDrop` ever RETURNS. A drag loop that does not holds the mouse capture
 * and breaks dragging everywhere on the desktop until the app is killed, which
 * is what the first version of this feature did. It cannot be checked by hand
 * without risking exactly that, so it is checked here.
 *
 * Launches the app, shelves a real file, then presses the button, starts the
 * drag through the app's own command, wiggles, and releases — and reads the
 * log for a completion line.
 *
 *   node tools/drag-out-check.mjs
 *
 * `returned HRESULT(0x00040100)` is DRAGDROP_S_DROP: the loop ended and the
 * capture was given back.
 */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const port = 9481;
const log = resolve(process.env.APPDATA, 'codenotch-win', 'log.txt');
const probe = resolve('test-results/dragout-probe.txt');
writeFileSync(probe, 'drag me out');
const before = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
const child = spawn(resolve('src-tauri/target/release/codenotch.exe'), [], {
  windowsHide:true, stdio:'ignore', env:{...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER:resolve('src-tauri/target/dragout-profile')}});
const pause = ms => new Promise(r => setTimeout(r, ms));
let browser;
for (let i=0;i<50;i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000}); break; } catch { await pause(300); } }
const ctx = browser.contexts()[0];
let page;
for (let i=0;i<60;i++) { page = ctx.pages().find(p=>/tasks\.html/.test(p.url())); if (page) break; await pause(300); }
await pause(2500);
const inv = (c,a) => page.evaluate(([c,a]) => window.__TAURI_INTERNALS__.invoke(c,a), [c,a]);
await inv('shelf_add_paths', {paths:[probe]});
const shelf = await inv('get_shelf');
const item = shelf.find(i => i.name === 'dragout-probe.txt');
console.log('shelved:', item.name);

// Hold the button, start the drag, wiggle, release — the sequence that has to
// make DoDragDrop return.
const ps = (body) => execFileSync('powershell', ['-NoProfile','-Command', body], {encoding:'utf8'});
const SEND = `
Add-Type -Namespace W -Name I -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
'@
`;
ps(`${SEND}; [W.I]::SetCursorPos(1300,60); [W.I]::mouse_event(0x0002,0,0,0,0)`);
await pause(150);
inv('shelf_drag', {id:item.id}).catch(()=>{});
await pause(200);
for (let i=1;i<=8;i++) { ps(`${SEND}; [W.I]::SetCursorPos(${1300+i*14},${60+i*8})`); await pause(45); }
ps(`${SEND}; [W.I]::mouse_event(0x0004,0,0,0,0)`);
await pause(2000);
const tail = readFileSync(log,'utf8').slice(before);
const lines = tail.split('\n').filter(l => /drag out|shelf:/.test(l));
console.log('LOG:\n' + lines.join('\n'));
const started = lines.some(l => l.includes('drag out'));
const ended = lines.some(l => l.includes('returned') || l.includes('no data object'));
console.log(started ? (ended ? 'RESULT: drag returned cleanly' : 'RESULT: STUCK — never returned') : 'RESULT: drag never started');
await inv('shelf_remove', {id:''}).catch(()=>{});
child.kill();
await browser.close();
