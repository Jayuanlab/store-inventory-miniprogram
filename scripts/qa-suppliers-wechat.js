const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const automator = require("miniprogram-automator");
const output = path.join(os.tmpdir(), "store-supplier-qa");
const fixture = JSON.parse(
  fs.readFileSync(path.join(output, "fixture.json"), "utf8"),
);
async function main() {
  const mini = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  const results = [],
    exceptions = [];
  mini.on("exception", (e) => exceptions.push(e));
  async function route(url) {
    const navigation = mini.callWxMethod("reLaunch", { url }).catch(() => {});
    await Promise.race([navigation, new Promise((resolve) => setTimeout(resolve, 3000))]);
    const expected = url.replace(/^\//, "").split("?")[0];
    await new Promise((resolve) => setTimeout(resolve, 2600));
    let page = await mini.currentPage();
    for (let i = 0; page.path !== expected && i < 15; i++) {
      if (i === 4) mini.callWxMethod("reLaunch", { url }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
      page = await mini.currentPage();
    }
    assert.equal(page.path, expected);
    await page.waitFor(600);
    return page;
  }
  async function capture(page, name, fixtureOnly = false) {
    await page.waitFor(350);
    assert.equal((await page.data("error")) || "", "", name);
    const info = await mini.systemInfo();
    for (const selector of [
      ".page-head",
      ".command-row",
      ".search",
      ".sheet",
      ".date-range",
    ]) {
      const elements = await page.$$(selector);
      for (const el of elements) {
        const size = await el.size();
        assert.ok(
          Number(size.width) <= info.windowWidth + 1,
          selector + " fits viewport",
        );
      }
    }
    try {
      await mini.screenshot({ path: path.join(output, name + ".png") });
    } catch {
      await page.waitFor(1000);
      await mini.screenshot({ path: path.join(output, name + ".png") });
    }
    results.push({
      name,
      page: page.path,
      width: info.windowWidth,
      fixtureOnly,
    });
    console.log("Captured", name);
  }
  try {
    for (const name of ["purchase", "finance", "daily-report"]) {
      const related = await route("/pages/" + name + "/" + name);
      await capture(related, "related-" + name);
    }
    let page = await route("/pages/suppliers/suppliers");
    await capture(page, "01-suppliers-live");
    const rows = await page.data("rows");
    if (rows.length) {
      page = await route(
        "/pages/supplier-detail/supplier-detail?id=" + rows[0].id,
      );
      await capture(page, "02-detail-live");
      await page.callMethod("edit", {
        currentTarget: { dataset: { kind: "payment" } },
      });
      await capture(page, "03-payment-live");
      await page.callMethod("close");
    }
    // Only replace the rendered page data. No mock request or business mutation reaches the live database.
    page = await route(
      "/pages/supplier-detail/supplier-detail?id=" +
        (rows[0]?.id || "fixture-only"),
    );
    await page.setData({
      ...fixture.offsetEditorData,
      editor: null,
      error: "",
      loading: false,
      tab: "open",
    });
    await capture(page, "04-detail-fixture", true);
    await page.setData({ editor: fixture.offsetEditorData.editor });
    await capture(page, "05-offset-fixture", true);
    await page.callMethod("close");
    await page.callMethod("edit", {
      currentTarget: { dataset: { kind: "payment" } },
    });
    await capture(page, "06-payment-fixture", true);
    page = await route(
      "/pages/supplier-adjustment/supplier-adjustment?supplierId=" +
        (rows[0]?.id || "fixture-only"),
    );
    await page.setData({
      ...fixture.pricePreviewData,
      error: "",
      loading: false,
      previewing: false,
    });
    await capture(page, "07-price-form-fixture", true);
    await mini.pageScrollTo(780);
    await capture(page, "08-price-preview-fixture", true);
    await page.callMethod("toggleTargets");
    await mini.pageScrollTo(2000);
    await capture(page, "09-price-lines-fixture", true);
    assert.deepEqual(exceptions, []);
  } finally {
    try {
      await route("/pages/dashboard/dashboard");
    } finally {
      mini.disconnect();
    }
    fs.writeFileSync(
      path.join(output, "wechat-result.json"),
      JSON.stringify({ results, exceptions }, null, 2),
      "utf8",
    );
  }
  console.log(
    "Supplier WeChat visual QA passed. All test balances were rendered in memory only.",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
