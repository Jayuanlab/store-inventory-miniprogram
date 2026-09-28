const automator = require("miniprogram-automator");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const output = path.join(os.tmpdir(), "store-inventory-qa");
  fs.mkdirSync(output, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  const results = [],
    exceptions = [];
  mini.on("exception", (error) => exceptions.push(error));
  let page;
  async function capture(name) {
    await pause(350);
    assert.equal((await page.data("error")) || "", "");
    const rows = await page.data("items");
    assert.equal(await page.data("itemCount"), rows.length);
    assert.equal(
      (await page.$$(".empty")).length,
      rows.length ? 0 : 1,
      name + ": empty state matches visible rows",
    );
    const info = await mini.systemInfo();
    for (const selector of [
      ".category-filter",
      ".category-value",
      ".classification-heading",
      ".stock-row",
      ".sheet",
    ]) {
      for (const element of await page.$$(selector))
        assert.ok(
          (await element.size()).width <= info.windowWidth + 1,
          selector + " fits viewport",
        );
    }
    await mini.screenshot({ path: path.join(output, name + ".png") });
    results.push({ name, width: info.windowWidth });
    console.log("Captured " + name);
  }
  async function choose(level, value) {
    const options = await page.data("categoryOptions");
    const index = options[level].findIndex((option) => option.value === value);
    assert.ok(index >= 0);
    await page.callMethod("category", {
      currentTarget: { dataset: { level } },
      detail: { value: index },
    });
  }
  try {
    const url = "/pages/inventory/inventory";
    const navigation = mini.callWxMethod("switchTab", { url }).catch(() => {});
    await Promise.race([navigation, pause(3000)]);
    await pause(1200);
    page = await mini.currentPage();
    for (let i = 0; page.path !== "pages/inventory/inventory" && i < 15; i++) {
      if (i === 3) mini.callWxMethod("switchTab", { url }).catch(() => {});
      await pause(1000);
      page = await mini.currentPage();
    }
    assert.equal(page.path, "pages/inventory/inventory");
    await page.callMethod("reload");
    await page.callMethod("resetCategories");
    await page.callMethod("clearSearch");
    const items = await page.data("items");
    assert.ok(items.length > 0);
    await capture("01-inventory-all");
    const target = items.find((p) => p.type && p.subType && p.thirdType);
    assert.ok(target);
    await choose(0, target.type);
    await choose(1, target.subType);
    await choose(2, target.thirdType);
    assert.ok(
      (await page.data("items")).every(
        (p) =>
          p.type === target.type &&
          p.subType === target.subType &&
          p.thirdType === target.thirdType,
      ),
    );
    await capture("02-inventory-three-levels");
    await (await page.$(".stock-row")).tap();
    await pause(600);
    assert.equal((await page.data("detail")).stockKey, target.stockKey);
    await capture("03-inventory-detail");
    await page.callMethod("close");
    await page.callMethod("search", {
      detail: { value: "NO-MATCH-ONLY-FOR-QA" },
    });
    assert.equal((await page.data("items")).length, 0);
    await capture("04-inventory-empty");
    await page.callMethod("resetCategories");
    await page.callMethod("search", { detail: { value: target.externalCode } });
    assert.ok(
      (await page.data("items")).some((p) => p.stockKey === target.stockKey),
    );
    await capture("05-inventory-code-search");
    const sample = {
      ...target,
      name: "布局验收：超长名称手机保护配件与维修材料组合规格",
      type: "布局验收一级分类名称较长",
      subType: "布局验收二级分类名称较长",
      thirdType: "布局验收三级分类名称较长",
      spec: "TYPE-C-LongUnbrokenProductSpecification0123456789",
      serials: [],
    };
    // Render-only stress data. Always reload real inventory before leaving.
    await mini.evaluate((row) => {
      const current = getCurrentPages().slice(-1)[0];
      current.source = [row];
      current.resetCategories();
      current.clearSearch();
    }, sample);
    await choose(0, sample.type);
    await choose(1, sample.subType);
    await choose(2, sample.thirdType);
    await capture("06-inventory-long-labels-fixture");
    assert.deepEqual(exceptions, []);
  } finally {
    if (page?.path === "pages/inventory/inventory") {
      await page.callMethod("close");
      await page.callMethod("resetCategories");
      await page.callMethod("clearSearch");
      await page.callMethod("reload");
    }
    mini.disconnect();
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify({ results, exceptions }, null, 2),
      "utf8",
    );
  }
  console.log(
    "Inventory native QA passed: hierarchy, detail, empty state and search. Read-only; no stock count or business submission.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
