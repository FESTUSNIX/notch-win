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
  // The three screens are the new structure; check they exist and switch.
  for (const tab of ['media','calendar','today']) {
    await taskPage.locator(`[data-tab="${tab}"]`).click();
    await taskPage.locator(`.screen[data-screen="${tab}"].active`).waitFor({state:'visible'});
  }
  await taskPage.locator('#island-expanded').waitFor({state:'visible'});
  await taskPage.screenshot({path:resolve(root,'test-results/native-task-notch.png'),omitBackground:true});
  // The composer is a live field, so clicking it *is* the gesture that lifts
  // NOACTIVATE. Give the round-trip a moment: set_task_input is real IPC here.
  await taskPage.locator('#inline-title').click();
  await pause(500);
  await taskPage.locator('#inline-title').fill('Inline keyboard check');
  let entry=await diagnostics();
  assert.equal(entry.tasks.style & 0x08000000,0,'Inline entry removes NOACTIVATE');
  assert.equal(entry.tasks.style & (0x80 | 0x8),0x80 | 0x8,'Inline entry stays a topmost tool window');
  await taskPage.evaluate(()=>{window.smokeRects=[];});
  await pause(1000);
  entry=await diagnostics();
  assert.equal(entry.tasks.style & 0x08000000,0,'Hover hardening preserves inline keyboard mode');
  await taskPage.locator('#island-expanded').waitFor({state:'visible'});
  await taskPage.screenshot({path:resolve(root,'test-results/native-task-inline.png'),omitBackground:true});
  await taskPage.evaluate(()=>{window.smokeRects=[{x:-100000,y:-100000,width:200000,height:200000}];});
  // Escape releases the field without discarding the draft; the panel is pinned,
  // so it stays up and only the activation exception comes back.
  await taskPage.keyboard.press('Escape');
  await pause(500);
  const afterEntry=await diagnostics();
  assert.equal(afterEntry.tasks.style & 0x08000000,0x08000000,'Releasing the field restores NOACTIVATE');
  assert.equal(await taskPage.locator('#inline-title').inputValue(),'Inline keyboard check','Escape keeps the draft');
  await taskPage.locator('#collapse-panel').click();
  await taskPage.locator('#island-expanded').waitFor({state:'hidden'});
  // Polled, not sampled. The expanded layer hides the instant the fold starts,
  // but the shape is a spring and is still travelling for a few frames after
  // that -- measuring one frame later catches it mid-fold at some arbitrary
  // in-between size. The browser test polls here for the same reason.
  let pill;
  for (let i=0;i<60;i++) {
    pill = await taskPage.locator('#island').boundingBox();
    if (Math.min(pill.width,pill.height)<50 && Math.max(pill.width,pill.height)<400) break;
    await pause(50);
  }
  assert.ok(Math.min(pill.width,pill.height)<50,
    `Collapsed island is a thin pill, not the panel: ${pill.width}x${pill.height}`);
  // 400, not 260: the resting pill carries three slots now -- date, clock and
  // one module -- and is ~342px wide on purpose. What this still catches is the
  // panel, which is ~970.
  assert.ok(Math.max(pill.width,pill.height)<400,
    `Collapsed island is not still panel-width: ${pill.width}x${pill.height}`);
  // --- Displays -----------------------------------------------------------
  // Every part of this is Win32 that cannot be exercised in a browser: monitor
  // enumeration, the EDID name, and whether a placed window actually lands
  // inside the display it was sent to.
  const displays = await taskPage.evaluate(() => window.smokeInvoke('get_displays'));
  assert.ok(displays.screens.length >= 1, 'At least one display must enumerate');
  for (const screen of displays.screens) {
    assert.ok(screen.id.length > 0, 'A display needs an id to be addressable');
    assert.ok(screen.name.length > 0, 'A display needs a name for the picker');
    assert.ok(screen.width > 0 && screen.height > 0, 'A display needs a size');
  }
  assert.equal(displays.screens.filter(s => s.primary).length, 1, 'Exactly one primary display');
  assert.equal(new Set(displays.screens.map(s => s.id)).size, displays.screens.length,
    'Display ids must be unique, or two screens are the same setting');
  console.log('displays:', displays.screens.map(s => `${s.name} ${s.width}x${s.height}`).join(', '));

  if (displays.screens.length > 1) {
    // Whatever it was before this ran, so the smoke test does not leave the
    // island parked on a screen the user did not choose. This writes config.
    const before = displays.tasks;
    const here = (await diagnostics()).tasks.position;
    const home = displays.screens.find(s => here.x >= s.x && here.x < s.x + s.width);
    assert.ok(home, `The island must be on one of the enumerated screens, not at x=${here.x}`);
    const other = displays.screens.find(s => s.id !== home.id);

    const send = async id => {
      await taskPage.evaluate(v => window.smokeInvoke('set_display', {label:'tasks', monitor:v}), id);
      await pause(600);
      return (await diagnostics()).tasks.position;
    };

    const moved = await send(other.id);
    assert.ok(moved.x >= other.x && moved.x < other.x + other.width,
      `Island must land on ${other.name}: x=${moved.x} outside ${other.x}..${other.x + other.width}`);

    // Put it back explicitly, then restore whatever the setting was.
    // "Automatic" means "wherever it already is", so clearing after a move
    // would leave the island parked on the other screen -- correct behaviour,
    // and exactly why this restores the position first and the setting second.
    const back = await send(home.id);
    assert.equal(back.x, here.x, 'Naming the original display puts the island exactly back');
    await send(before);
    assert.equal((await diagnostics()).tasks.position.x, here.x,
      'Restoring the setting must not move the island again');
  } else {
    console.log('One display attached: the move check needs a second monitor.');
  }

  // --- The run indicator ---------------------------------------------------
  // Detection is unit-tested in Rust; what cannot be tested there is that the
  // event reaches the notch and that the pill actually shows it while shut.
  // No precondition on the resting state: this runs on a machine with Claude
  // Code open, so a real run can and does finish mid-test -- which is the
  // feature working rather than a fault. What is asserted is the transition.
  assert.match(await usagePage.locator('#pip').getAttribute('data-state'), /^(idle|working|done)$/,
    'The pip is always in one of its three states');
  await usagePage.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
    event: 'notch:finished',
    payload: {provider: 'claude', project: 'akcesfonia', seconds: 252}
  }));
  await usagePage.locator('#pip[data-state="done"]').waitFor({state:'attached'});
  assert.equal(await usagePage.locator('#pip').evaluate(el => getComputedStyle(el).opacity), '1',
    'A finished run is visible on the collapsed pill, not only on hover');
  assert.match(await usagePage.locator('#pip').getAttribute('title'), /akcesfonia finished in 4m 12s/,
    'The tooltip names the project and spells the duration the way the toast does');
  await usagePage.screenshot({path:resolve(root,'test-results/native-run-finished.png'),omitBackground:true});

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
  console.log('Native release passed: both notches, isolated masks, inline focus mode/restoration, pill collapse, demo task IPC, display enumeration and placement, the run-finished pip, editor opening and closing.');
} finally {
  // Terminate only the child created by this test; no live task writes occurred.
  if(child.exitCode === null) child.kill();
  if(browser) await browser.close().catch(()=>{});
}
