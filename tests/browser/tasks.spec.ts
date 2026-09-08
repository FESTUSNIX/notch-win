import { test, expect } from "@playwright/test";

test("task panel: progress, nesting, completion and overdue filter", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/tasks.html");
  await page.locator("#task-rail").hover();
  await expect(page.locator("#task-panel")).toBeVisible();
  await expect(page.locator("#rail-count")).toHaveText("2/6");
  await page.getByLabel("Check nested tasks", {exact:true}).check();
  await expect(page.locator("#rail-count")).toHaveText("3/6");
  await page.getByLabel("Collapse Build a calmer workspace").click();
  await expect(page.getByText("Polish the task panel",{exact:true})).toBeHidden();
  await page.getByLabel("Expand Build a calmer workspace").click();
  await page.getByLabel("Complete Get outside for a walk",{exact:true}).check();
  await expect(page.locator("#rail-count")).toHaveText("4/6");
  await page.getByRole("button",{name:"Hide completed"}).click();
  await expect(page.getByText("Get outside for a walk",{exact:true})).toBeHidden();
  await expect(page.locator("#rail-count")).toHaveText("4/6");
  await page.getByRole("button",{name:/Overdue/}).click();
  await expect(page.getByText("Book a haircut",{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("button",{name:"Today",exact:true}).click();
  await page.screenshot({path:"test-results/task-notch.png"});
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

test("pill hover, explicit collapse and inline capture preserve drafts", async ({page}) => {
  await page.goto("/tasks.html");
  await expect(page.locator("#task-panel")).toBeHidden();
  const pill = await page.locator("#rail-shape").boundingBox();
  expect(Math.min(pill!.width,pill!.height)).toBeLessThan(12);
  await page.locator("#task-rail").hover();
  await expect(page.locator("#task-panel")).toBeVisible();
  await page.getByRole("button",{name:"Add task",exact:true}).click();
  await page.getByRole("textbox",{name:"Task name"}).fill("Write a quiet interface");
  await page.mouse.move(0,0);
  await expect(page.getByRole("textbox",{name:"Task name"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#task-panel")).toBeHidden();
  await page.locator("#task-rail").hover();
  await page.getByRole("button",{name:"Add task",exact:true}).click();
  await expect(page.getByRole("textbox",{name:"Task name"})).toHaveValue("Write a quiet interface");
  await page.getByRole("button",{name:"Save task",exact:true}).click();
  await expect(page.locator("#inline-composer")).toBeHidden();
  await expect(page.getByText("Write a quiet interface",{exact:true})).toBeVisible();
  await expect(page.locator("#rail-count")).toHaveText("2/7");
  expect(page.context().pages()).toHaveLength(1);
  await page.getByRole("button",{name:"Collapse task panel",exact:true}).click();
  await expect(page.locator("#task-panel")).toBeHidden();
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
  await page.getByRole("button",{name:"Add task",exact:true}).click();
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
