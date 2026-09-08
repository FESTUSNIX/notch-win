import { test, expect } from "@playwright/test";

test("day panel: overdue in place, nesting, and a completion that settles into the drawer", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/tasks.html");
  await page.locator("#task-rail").hover();
  await expect(page.locator("#task-panel")).toBeVisible();
  await expect(page.locator("#rail-count")).toHaveText("2/6");

  // Overdue work is in the day, badged in place. There is no tab to leave.
  await expect(page.getByText("Book a haircut",{exact:true})).toBeVisible();
  // Capped, so a task forgotten for two years cannot be the widest thing in the row.
  await expect(page.locator(".day-chip").first()).toHaveText(/^(\d{1,2}|99\+)d$/);

  // Sub-tasks open by default; a checklist is detail, one click away.
  await expect(page.getByText("Polish the task panel",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Check nested tasks",{exact:true})).toBeHidden();
  await page.getByLabel("Expand Polish the task panel").click();
  await page.getByLabel("Check nested tasks",{exact:true}).check();
  await expect(page.locator("#rail-count")).toHaveText("3/6");
  await page.getByLabel("Collapse Build a calmer workspace").click();
  await expect(page.getByText("Polish the task panel",{exact:true})).toBeHidden();
  await page.getByLabel("Expand Build a calmer workspace").click();

  // A completion answers at once, is held, then sinks into one line.
  await page.getByLabel("Complete Get outside for a walk",{exact:true}).check();
  await expect(page.locator("#rail-count")).toHaveText("4/6");
  await expect(page.getByRole("button",{name:"1 done today"})).toBeVisible();
  await expect(page.getByText("Get outside for a walk",{exact:true})).toBeHidden();
  await page.getByRole("button",{name:"1 done today"}).click();
  await expect(page.getByText("Get outside for a walk",{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({path:"test-results/task-notch.png"});
});

test("the composer is a live field: no reveal, and Enter leaves it ready for the next", async ({page}) => {
  await page.goto("/tasks.html");
  await page.locator("#task-rail").hover();
  const field = page.getByRole("textbox",{name:"Task name"});
  // Present and typeable without anything being opened first.
  await expect(field).toBeVisible();
  await field.click();
  await field.fill("Write a quiet interface");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Write a quiet interface",{exact:true})).toBeVisible();
  await expect(page.locator("#rail-count")).toHaveText("2/7");
  // Still there, still empty, still focused — the next one is typed, not clicked.
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await field.fill("And then a second");
  await page.keyboard.press("Enter");
  await expect(page.getByText("And then a second",{exact:true})).toBeVisible();
  await expect(page.locator("#rail-count")).toHaveText("2/8");
  expect(page.context().pages()).toHaveLength(1);
});

test("a draft survives the panel folding, and renaming happens in place", async ({page}) => {
  await page.goto("/tasks.html");
  await expect(page.locator("#task-panel")).toBeHidden();
  const pill = await page.locator("#rail-shape").boundingBox();
  expect(Math.min(pill!.width,pill!.height)).toBeLessThan(12);
  await page.locator("#task-rail").hover();
  await expect(page.locator("#task-panel")).toBeVisible();

  const field = page.getByRole("textbox",{name:"Task name"});
  await field.click();
  await field.fill("Half a thought");
  await page.mouse.move(0,0);
  await expect(field).toBeVisible();          // a live field holds the panel open
  await page.keyboard.press("Escape");        // releases the field, keeps the draft
  await expect(page.locator("#task-panel")).toBeHidden();
  await page.locator("#task-rail").hover();
  await expect(field).toHaveValue("Half a thought");

  // Rename without leaving the panel: click the title, type, Enter.
  await page.getByRole("button",{name:"Rename Get outside for a walk"}).click();
  const rename = page.locator(".day-field");
  await expect(rename).toBeFocused();
  await rename.fill("Get outside twice");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Get outside twice",{exact:true})).toBeVisible();
  await expect(page.getByText("Get outside for a walk",{exact:true})).toBeHidden();

  await page.getByRole("button",{name:"Collapse task panel",exact:true}).click();
  await expect(page.locator("#task-panel")).toBeHidden();
});

test("finishing the last task clears the day", async ({page}) => {
  await page.goto("/tasks.html?single");
  await page.locator("#task-rail").hover();
  await expect(page.locator("#rail-count")).toHaveText("0/1");
  await page.getByLabel("Complete Get outside for a walk",{exact:true}).check();
  await expect(page.locator("#rail-count")).toHaveText("1/1");
  await expect(page.getByRole("heading",{name:"Day clear"})).toBeVisible();
  await expect(page.getByText("1 done · nothing left")).toBeVisible();
  // The ring draws itself and the mark follows it. Both start from a full dash
  // offset, so this also catches the day the geometry and the dash lengths in
  // the stylesheet stop agreeing — the ring then never leaves its hidden state.
  for (const part of [".arc", ".mark"]) {
    await expect.poll(() => page.locator(`.clear-ring ${part}`)
      .evaluate(el => getComputedStyle(el).strokeDashoffset)).toBe("0px");
  }
  await page.screenshot({path:"test-results/task-clear.png"});
});

test("editor: safe quick add, rename, schedule and empty connection state", async ({page}) => {
  await page.setViewportSize({width:460,height:690});
  await page.goto("/task-editor.html");
  await page.getByLabel("Task",{exact:true}).fill('<img src=x onerror="alert(1)"> Review');
  await page.getByRole("button",{name:"Add task",exact:true}).click();
  await expect(page.getByText('<img src=x onerror="alert(1)"> Review',{exact:true})).toBeVisible();
  await expect(page.locator("#editor-list img")).toHaveCount(0);
  await page.getByRole("button",{name:'Rename <img src=x onerror="alert(1)"> Review',exact:true}).click();
  await page.getByLabel("Task",{exact:true}).fill("Review the release");
  await page.getByRole("button",{name:"Save name",exact:true}).click();
  await expect(page.getByText("Review the release",{exact:true})).toBeVisible();
  await page.getByText("Review the release",{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:"test-results/task-editor-list.png"});
  await page.getByRole("heading",{name:"Your tasks",exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:"test-results/task-editor.png"});
  await page.goto("/tasks.html?empty");
  await page.locator("#task-rail").hover();
  await expect(page.getByRole("button",{name:"Connect TickTick",exact:true})).toBeVisible();
  await expect(page.locator("#rail-count")).toHaveText("—");
});

test("long nested titles remain within the task panel", async ({page}) => {
  await page.goto("/tasks.html");
  await page.locator("#task-rail").hover();
  await expect(page.locator("#task-panel")).toBeVisible();
  await page.locator(".task-title").first().evaluate(label => { label.textContent = "A very long nested task title ".repeat(12); });
  const overflow = await page.locator("#task-panel").evaluate(panel => panel.scrollWidth > panel.clientWidth);
  expect(overflow).toBe(false);
});

test("all four edges keep content upright and within the surface", async ({page}) => {
  await page.setViewportSize({width:1000,height:850});
  await page.goto("/tasks.html");
  await page.locator("#task-rail").hover();
  await page.getByRole("button",{name:"Pin task panel",exact:true}).click();
  await page.getByRole("button",{name:"Notch settings",exact:true}).click();
  for(const edge of ["left","top","bottom","right"]) {
    await page.locator(`[data-task-edge="${edge}"]`).click();
    await expect(page.locator("#notch-shell")).toHaveAttribute("data-edge",edge);
    const fits=await page.locator("#notch-shell").evaluate(shell=>{
      const outer=shell.getBoundingClientRect(),panel=document.getElementById("task-panel")!.getBoundingClientRect();
      return panel.left>=outer.left-1 && panel.right<=outer.right+1 && panel.top>=outer.top-1 && panel.bottom<=outer.bottom+1;
    });
    expect(fits).toBe(true);
    await page.screenshot({path:`test-results/task-${edge}.png`});
  }
  await page.getByRole("textbox",{name:"Task name"}).fill("A small next step");
  await page.screenshot({path:"test-results/task-inline.png"});
});

test("a short daily list uses a compact panel and reduced motion still folds", async ({page}) => {
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/tasks.html?single");
  await page.locator("#task-rail").hover();
  await expect(page.locator("#rail-count")).toHaveText("0/1");
  const panel=await page.locator("#task-panel").boundingBox();
  expect(panel!.height).toBeLessThan(300);
  await page.screenshot({path:"test-results/task-compact.png"});
  await page.mouse.move(0,0);
  await expect(page.locator("#task-panel")).toBeHidden();
});
