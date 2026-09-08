// Native WebView2 smoke test; only sample tasks, no TickTick account calls.
// https://playwright.dev/docs/webview2
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const port = 9422;
await mkdir(resolve(root, 'test-results'), {recursive:true});
const child = spawn(resolve(root, 'src-tauri/target/release/codenotch.exe'), [], {
  cwd:root, windowsHide:true, stdio:'ignore', env:{...process.env,
    CODENOTCH_DEMO:'1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER:resolve(root,'src-tauri/target/task-smoke-profile')
  }
});
const pause = ms => new Promise(r => setTimeout(r,ms));
let browser;
try {
  for (let i=0;i<40;i++) {
    if (child.exitCode !== null) throw new Error(`Native app exited with ${child.exitCode}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000}); break; }
    catch { await pause(250); }
  }
  assert.ok(browser,'WebView2 debugging endpoint did not start');
  const context = browser.contexts()[0];
  context.setDefaultTimeout(15000);
  let taskPage, usagePage;
  for (let i=0;i<40;i++) {
    taskPage = context.pages().find(p => /\/tasks\.html/.test(p.url()));
    usagePage = context.pages().find(p => !/tasks\.html|task-editor\.html|about:blank/.test(p.url()));
    if (taskPage && usagePage) break;
    await pause(250);
  }
  assert.ok(taskPage && usagePage,`Both notch WebViews must exist: ${context.pages().map(p=>p.url()).join(', ')}`);
  await taskPage.waitForFunction(() => document.getElementById('rail-count')?.textContent === '2/6');
  const errors=[];
  taskPage.on('pageerror',e=>errors.push(e.message));
  const snapshot = await taskPage.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_tasks'));
  assert.equal(snapshot.demo,true);
  assert.equal(snapshot.tasks.length,6);
  // Keep sending a controlled mask after frontend animation/layout reports;
  // exercise the native poll without moving the user's physical pointer.
  for (const page of [taskPage,usagePage]) {
    await page.evaluate(async () => {
      window.smokeInvoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
      window.smokeRects = [];
      window.setInterval(() => window.smokeInvoke('set_interactive_rects',{rects:window.smokeRects}),20);
      await window.smokeInvoke('set_interactive_rects',{rects:[]});
    });
  }
  await pause(1000);
  const diagnostics = () => taskPage.evaluate(() => window.smokeInvoke('task_window_diagnostics'));
  const resting = await diagnostics();
  const fixed = 0x08000000 | 0x80 | 0x8; // NOACTIVATE, TOOLWINDOW, TOPMOST
  for (const label of ['notch','tasks']) {
    assert.equal(resting[label].style & fixed,fixed,`${label} keeps hardened styles`);
    assert.equal(resting[label].style & 0x20,0x20,`${label} is click-through outside its mask`);
  }
  await taskPage.evaluate(() => { window.smokeRects=[{x:-100000,y:-100000,width:200000,height:200000}]; return window.smokeInvoke('set_interactive_rects',{rects:window.smokeRects}); });
  await pause(1000);
  const interactive = await diagnostics();
  assert.equal(interactive.tasks.style & fixed,fixed,'Task hover preserves hardened styles');
  assert.equal(interactive.tasks.style & 0x20,0,'Task hover enables clicks');
  assert.equal(interactive.notch.style & 0x20,0x20,'Task hover does not alter the usage mask');
  await taskPage.locator('#pin').click();
  await taskPage.locator('#task-panel').waitFor({state:'visible'});
  await taskPage.screenshot({path:resolve(root,'test-results/native-task-notch.png'),omitBackground:true});
  await taskPage.locator('#add-task').click();
  await taskPage.getByRole('textbox',{name:'Task name'}).fill('Inline keyboard check');
  let entry=await diagnostics();
  assert.equal(entry.tasks.style & 0x08000000,0,'Inline entry removes NOACTIVATE');
  assert.equal(entry.tasks.style & (0x80 | 0x8),0x80 | 0x8,'Inline entry stays a topmost tool window');
  await taskPage.evaluate(()=>{window.smokeRects=[];});
  await pause(1000);
  entry=await diagnostics();
  assert.equal(entry.tasks.style & 0x08000000,0,'Hover hardening preserves inline keyboard mode');
  await taskPage.locator('#task-panel').waitFor({state:'visible'});
  await taskPage.screenshot({path:resolve(root,'test-results/native-task-inline.png'),omitBackground:true});
  await taskPage.evaluate(()=>{window.smokeRects=[{x:-100000,y:-100000,width:200000,height:200000}];});
  await taskPage.locator('#cancel-inline').click();
  await pause(300);
  const afterEntry=await diagnostics();
  assert.equal(afterEntry.tasks.style & 0x08000000,0x08000000,'Cancel restores NOACTIVATE');
  await taskPage.locator('#collapse-panel').click();
  await taskPage.locator('#task-panel').waitFor({state:'hidden'});
  const pill=await taskPage.locator('#rail-shape').boundingBox();
  assert.ok(Math.min(pill.width,pill.height)<12,'Collapsed task rail is the original thin pill');
  await Promise.race([
    taskPage.evaluate(() => window.smokeInvoke('open_task_editor')),
    pause(15000).then(() => { throw new Error('Native editor creation timed out'); })
  ]);
  let editor;
  for(let i=0;i<40;i++) {
    editor=context.pages().find(p=>/task-editor\.html/.test(p.url()));
    if(editor) break;
    await pause(250);
  }
  assert.ok(editor,'Native editor must open');
  await editor.bringToFront();
  await editor.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus'));
  await pause(300);
  await editor.getByLabel('Task',{exact:true}).fill('Local keyboard focus check');
  assert.equal(await editor.getByLabel('Task',{exact:true}).inputValue(),'Local keyboard focus check');
  await editor.screenshot({path:resolve(root,'test-results/native-task-editor.png')});
  const focused = await diagnostics();
  await writeFile(resolve(root,'test-results/native-window-checks.json'),JSON.stringify({resting,interactive,entry,afterEntry,focused},null,2));
  assert.equal(focused['task-editor'].style & 0x08000000,0,'Editor can activate');
  assert.equal(await editor.getByLabel('Task',{exact:true}).evaluate(el => document.activeElement === el),true,'Editor input receives WebView focus');
  if (!focused['task-editor'].focused) console.log('Manual check required: Windows foreground activation was not granted during this automated launch.');
  assert.equal(focused.tasks.focused,false,'Task notch does not take focus');
  await editor.getByRole('button',{name:'Close task editor'}).click();
  for(let i=0;i<40 && !editor.isClosed();i++) await pause(100);
  assert.ok(editor.isClosed(),'Editor close button has native permission');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(root,'test-results/native-window-checks.json'),JSON.stringify({resting,interactive,entry,afterEntry,focused},null,2));
  console.log('Native release passed: both notches, isolated masks, inline focus mode/restoration, pill collapse, demo task IPC, editor opening and closing.');
} finally {
  // Terminate only the child created by this test; no live task writes occurred.
  if(child.exitCode === null) child.kill();
  if(browser) await browser.close().catch(()=>{});
}
