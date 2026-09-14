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
  await taskPage.evaluate(()=>localStorage.removeItem("codenotch.focus.v1"));
  await taskPage.reload();
  // The pill shows whatever is most live, which on a real machine may be music,
  // so wait on the task list itself rather than on the day's tally.
  await taskPage.waitForFunction(() => !!document.querySelector('[aria-label="Complete Get outside for a walk"]'));
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
  /* Polled, not slept. ⚠️ Click-through is turned off by hover.rs's OWN poll
     loop, on its own 100ms clock, from a mask this page pushes on a 20ms
     interval -- so the delay between asking and the style changing is however
     long those two take to line up, plus whatever else the machine is doing.
     A fixed wait passes on an idle machine and fails right after another smoke
     run has just torn a WebView2 down, which is exactly when this runs. */
  let interactive;
  for (let i=0;i<40;i++) {
    interactive = await diagnostics();
    if ((interactive.tasks.style & 0x20) === 0) break;
    await pause(100);
  }
  assert.equal(interactive.tasks.style & fixed,fixed,'Task hover preserves hardened styles');
  assert.equal(interactive.tasks.style & 0x20,0,'Task hover enables clicks');
  assert.equal(interactive.notch.style & 0x20,0x20,'Task hover does not alter the usage mask');
  await taskPage.locator('#pin').click();
  await taskPage.locator('#island-expanded').waitFor({state:'visible'});
  // The island opens on Home; the focus controls live on the day screen.
  await taskPage.locator('[data-tab="today"]').click();
  await taskPage.locator('#inline-composer').waitFor({state:'visible'});
  await taskPage.screenshot({path:resolve(root,'test-results/native-task-notch.png'),omitBackground:true});
  await taskPage.getByRole('button',{name:'Focus Get outside for a walk',exact:true}).click();
  await taskPage.locator('#focus-session').waitFor({state:'visible'});
  await taskPage.waitForFunction(()=>document.getElementById('focus-elapsed').textContent!=='00:00');
  await taskPage.screenshot({path:resolve(root,'test-results/native-focus-panel.png'),omitBackground:true});
  await taskPage.getByRole('button',{name:'Pause focus timer',exact:true}).click();
  const stopped=await taskPage.locator('#focus-elapsed').textContent();
  await pause(1200);
  assert.equal(await taskPage.locator('#focus-elapsed').textContent(),stopped);
  await taskPage.locator('#collapse-panel').click();
  await taskPage.locator('#island-expanded').waitFor({state:'hidden'});
  // Collapsed, a running timer owns the pill: no separate control, just the
  // island saying what it is timing.
  await taskPage.locator('#island-collapsed .pill-label').waitFor({state:'visible'});
  assert.equal(await taskPage.locator('.pill-label').textContent(),'Get outside for a walk');
  // The timer is paused at this point, and the pill says so.
  assert.match(await taskPage.locator('.pill-value').textContent(),/^\d+:\d{2}( paused)?$/);
  const checked=await diagnostics();
  assert.equal(checked.tasks.style & fixed,fixed,'Timer keeps hardened notch styles');
  const pill=await taskPage.locator('#island').boundingBox();
  assert.ok(Math.min(pill.width,pill.height)<50,'Collapsed island is a pill, not the panel');
  await taskPage.screenshot({path:resolve(root,'test-results/native-focus-pill.png'),omitBackground:true});
  await taskPage.locator('#island-collapsed').dispatchEvent('click');
  await taskPage.locator('#island-expanded').waitFor({state:'visible'});
  await taskPage.locator('[data-tab="today"]').click();
  await taskPage.getByRole('button',{name:'End focus session',exact:true}).click();
  assert.deepEqual(errors,[]);
  console.log('Native focus passed: start, elapsed time, pause, collapsed timer, unchanged hardened styles, end.');
} finally {
  if(child.exitCode === null) child.kill();
  if(browser) await browser.close().catch(()=>{});
}
