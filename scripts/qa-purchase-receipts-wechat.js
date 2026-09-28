const automator = require("miniprogram-automator");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

async function main() {
  const output = path.join(os.tmpdir(), "store-supplier-qa");
  fs.mkdirSync(output, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  try {
    const url = "/pages/purchase/purchase";
    const navigation = mini.callWxMethod("reLaunch", { url }).catch(() => {});
    await Promise.race([
      navigation,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    let page = await mini.currentPage();
    for (let i = 0; page.path !== "pages/purchase/purchase" && i < 10; i++) {
      if (i === 3) mini.callWxMethod("reLaunch", { url }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
      page = await mini.currentPage();
    }
    await page.waitFor(1500);
    assert.equal(page.path, "pages/purchase/purchase");
    assert.equal((await page.data("error")) || "", "");
    const rows = await page.data("pendingPlans");
    assert.ok(
      rows.length > 0,
      "This read-only check needs an existing pending order",
    );
    const info = await mini.systemInfo();
    for (const element of await page.$$(".pending-order")) {
      assert.ok((await element.size()).width <= info.windowWidth);
    }
    console.log(
      JSON.stringify({
        pending: rows,
        purchases: await page.data("purchases"),
        width: info.windowWidth,
      }),
    );
    await mini.screenshot({
      path: path.join(output, "purchase-pending-live.png"),
    });
    await (await page.$(".receive-plan")).tap().catch((error) => {
      // Navigation can replace the SDK's page before its tap response returns.
      if (!error.message.includes("page is not on top of page stack"))
        throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    page = await mini.currentPage();
    await page.waitFor(1200);
    assert.equal(await page.data("planId"), rows[0].id);
    assert.equal((await page.data("error")) || "", "");
    assert.equal(
      await page.data("quantity"),
      rows[0].items.find((item) => item.remaining > 0).remaining,
    );
    assert.equal(
      (await page.$$(".pay-options")).length,
      0,
      "Linked receipts have no payment controls",
    );
    const settlement = await page.data("planSettlement");
    assert.equal(
      settlement.availableText,
      Number(rows[0].prepayment.availableAmount).toFixed(2),
    );
    assert.ok(
      (await (await page.$(".plan-settlement")).size()).width <=
        info.windowWidth,
    );
    await mini.screenshot({
      path: path.join(output, "purchase-receive-live.png"),
    });
    console.log(
      JSON.stringify({
        formPlanId: await page.data("planId"),
        quantity: await page.data("quantity"),
        settlement,
        output,
      }),
    );
    await (await page.$(".settlement-link .text-btn")).tap().catch((error) => {
      if (!error.message.includes("page is not on top of page stack"))
        throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    page = await mini.currentPage();
    assert.equal(page.path, "pages/supplier-detail/supplier-detail");
    await page.callMethod("edit", {
      currentTarget: { dataset: { kind: "payment" } },
    });
    const options = await page.data("paymentPlans");
    const index = options.findIndex((p) => p.id === rows[0].id);
    assert.ok(index > 0);
    await page.callMethod("paymentPlan", { detail: { value: index } });
    assert.equal(await page.data("editor.planId"), rows[0].id);
    await mini.screenshot({
      path: path.join(output, "purchase-linked-prepay-payment-live.png"),
    });
    await page.callMethod("close");
    await mini.callWxMethod("navigateBack");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Stop before confirmation: the live order and stock must stay unchanged.
    await mini.callWxMethod("navigateBack");
  } finally {
    mini.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
