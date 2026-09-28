const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const automator = require("miniprogram-automator");

async function main() {
  const output = path.join(require("node:os").tmpdir(), "store-erp-wechat-qa");
  fs.mkdirSync(output, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  console.log("Connected to WeChat automator");
  const exceptions = [];
  mini.on("exception", (error) => exceptions.push(error));
  const results = [];
  const navigationWarnings = [];
  let status = "running";
  const startedAt = new Date().toISOString();
  function report() {
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(
        { startedAt, status, results, exceptions, navigationWarnings },
        null,
        2,
      ),
    );
  }
  report();
  async function dispatch(action, expected) {
    action().catch((error) => navigationWarnings.push(error.message));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let page = await mini.currentPage();
    for (let i = 0; expected && page.path !== expected && i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      page = await mini.currentPage();
    }
    if (expected) assert.equal(page.path, expected, "Navigation completed");
    return page;
  }
  async function route(method, url) {
    const stack = await mini.pageStack();
    const expected = url
      ? url.replace(/^\//, "").split("?")[0]
      : stack[stack.length - 2].path;
    mini
      .evaluate(
        (kind, target) => {
          setTimeout(() => {
            if (kind === "reLaunch") wx.reLaunch({ url: target });
            if (kind === "navigateTo") wx.navigateTo({ url: target });
            if (kind === "navigateBack") wx.navigateBack();
            if (kind === "switchTab") wx.switchTab({ url: target });
          }, 100);
          return true;
        },
        method,
        url || "",
      )
      .catch((error) => navigationWarnings.push(error.message));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let page = await mini.currentPage();
    const deadline = Date.now() + 45000;
    let attempts = 0;
    while (page.path !== expected && Date.now() < deadline) {
      if (++attempts === 4) {
        mini.callWxMethod(method, url ? { url } : {}).catch((error) => navigationWarnings.push(error.message));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      page = await mini.currentPage();
    }
    assert.equal(
      page.path,
      expected,
      "Navigation must reach its target before capturing",
    );
    console.log("route", page.path);
    return page;
  }
  async function select(page, id) {
    return dispatch(
      () =>
        page.callMethod("selectUser", { currentTarget: { dataset: { id } } }),
      "pages/dashboard/dashboard",
    );
  }
  async function capture(page, name) {
    await page.waitFor(650);
    const data = await page.data();
    console.log("data", name);
    assert.equal(data.error || "", "", name + ": " + data.error);
    try {
      await mini.screenshot({ path: path.join(output, name + ".png") });
    } catch (error) {
      console.log("Screenshot retry:", name);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await mini.screenshot({ path: path.join(output, name + ".png") });
    }
    results.push({ page: page.path, name });
    report();
    console.log(name, page.path);
  }
  try {
    console.log("Opening login");
    let page = await route("reLaunch", "/pages/login/login");
    await page.waitFor(500);
    await capture(page, "01-login");
    assert.equal(
      await page.data("localExperience"),
      true,
      "QA only supports local identities",
    );
    page = await select(page, "u1");
    await capture(page, "02-owner-dashboard");
    for (const name of [
      "payroll",
      "pay-settings",
      "products",
      "cards",
      "purchase",
      "finance",
      "suppliers",
      "daily-report",
      "opening-balance",
      "orders",
    ]) {
      page = await route("navigateTo", "/pages/" + name + "/" + name);
      await capture(page, "owner-" + name);
      if (name === "pay-settings") {
        await page.callMethod("changeTab", {
          currentTarget: { dataset: { tab: "salary" } },
        });
        await capture(page, "owner-base-salary");
        await page.callMethod("editSalary", {
          currentTarget: { dataset: { id: "u2" } },
        });
        await capture(page, "owner-salary-editor");
      }
      await route("navigateBack");
    }
    for (const name of ["sales", "inventory", "profile"]) {
      page = await route("switchTab", "/pages/" + name + "/" + name);
      await capture(page, "owner-" + name);
      if (name === "sales") {
        const inventory = await page.data("inventory");
        if (inventory.length) {
          const first = inventory[0];
          await page.callMethod("changeKeyword", {
            detail: { value: first.externalCode || first.name },
          });
          const matches = await page.data("results");
          assert.ok(
            matches.some((item) => item.stockKey === first.stockKey),
            "Live inventory search finds the selected product",
          );
          await page.callMethod("choose", {
            currentTarget: { dataset: { key: first.stockKey } },
          });
          assert.equal(await page.data("editor.skuId"), first.skuId);
          await capture(page, "owner-sales-product");
          await page.callMethod("close");
          await page.callMethod("changeKeyword", { detail: { value: "" } });
        }
      }
    }
    page = await route("reLaunch", "/pages/login/login");
    await page.waitFor(300);
    page = await select(page, "u2");
    page = await route("switchTab", "/pages/profile/profile");
    await capture(page, "employee-profile");
    assert.equal(await page.data("caps.managePay"), false);
    page = await route("navigateTo", "/pages/payroll/payroll");
    await capture(page, "employee-payroll");
    assert.equal(await page.data("canViewAll"), false);
    page = await route("reLaunch", "/pages/login/login");
    await page.waitFor(300);
    page = await select(page, "u1");
    assert.deepEqual(exceptions, []);
    status = "passed";
    console.log("WeChat read-only QA passed");
  } finally {
    if (status !== "passed") status = "failed";
    report();
    mini.disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
