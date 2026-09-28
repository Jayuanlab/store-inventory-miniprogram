process.env.NODE_ENV = "test";
process.env.STORE_DB_PATH = ":memory:";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const c = require("../server/src/common");
const repo = require("../server/src/repository");
const { createServer } = require("../server/src/application");
const api = require("../utils/api");
const owner = {
  id: "qa-owner",
  name: "测试老板",
  roleCode: "owner",
  status: "active",
};
const staff = {
  id: "qa-staff",
  name: "测试店员",
  roleCode: "employee",
  status: "active",
  permissions: ["sale:create"],
};
const initial = c.initialize({
  users: [owner, staff],
  products: [
    {
      skuId: "qa-phone",
      externalCode: "QA-PHONE",
      name: "测试手机 256G",
      type: "手机",
      unit: "台",
      stockManaged: true,
      trackSerial: true,
      costPrice: 2000,
      salePrice: 2300,
    },
  ],
  inventory: [
    {
      skuId: "qa-phone",
      quantity: 0,
      costPrice: 0,
      stockValue: 0,
      serials: [],
    },
  ],
});
const app = { globalData: { currentUser: c.publicUser(owner) } };
const storage = new Map();
const captures = {};
const navigations = [];
let base;
global.getApp = () => app;
global.wx = {
  getStorageSync: (k) => storage.get(k),
  setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
  removeStorageSync: (k) => storage.delete(k),
  showToast() {},
  navigateTo(options) {
    navigations.push(options.url);
  },
  navigateBack() {},
  reLaunch() {},
  stopPullDownRefresh() {},
  showModal(options) {
    options.success({ confirm: true, content: "测试确认" });
  },
  request(options) {
    const endpoint =
      new URL(options.url).pathname + new URL(options.url).search;
    fetch(base + endpoint, {
      method: options.method,
      headers: options.header,
      ...(options.method === "POST"
        ? { body: JSON.stringify(options.data) }
        : {}),
    })
      .then(async (res) => {
        const data = await res.json();
        if (options.method === "GET") captures[endpoint] = data;
        options.success({ statusCode: res.status, data });
      })
      .catch((error) => options.fail(error));
  },
};
function load(name, options = {}) {
  let page;
  global.Page = (config) => {
    page = {
      ...config,
      data: structuredClone(config.data),
      setData(values) {
        for (const [key, value] of Object.entries(values)) {
          const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
          let target = this.data;
          for (const part of parts.slice(0, -1)) target = target[part];
          target[parts.at(-1)] = value;
        }
      },
    };
  };
  const filename = require.resolve("../pages/" + name + "/" + name);
  delete require.cache[filename];
  require(filename);
  page.onLoad?.(options);
  return page;
}
const tap = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
async function testPlanReceiptFlow() {
  repo.resetStore(initial);
  const supplier = await api.post("/api/suppliers", {
    name: "订货流程测试供货方",
  });
  const purchase = load("purchase", { supplierId: supplier.id });
  await purchase.reload();
  purchase.mode(tap("mode", "plan"));
  purchase.choose(tap("id", "qa-phone"));
  purchase.setData({
    quantity: 2,
    costPrice: 2000,
    payMode: "paid",
    paidAmount: "3000",
  });
  await purchase.submit();
  assert.equal(purchase.data.error, "");
  const plan = repo.readStore().procurementPlans[0];
  assert.equal(
    repo.readStore().inventory[0].quantity,
    0,
    "Ordering must not receive stock",
  );
  assert.equal(purchase.data.purchases.length, 0);
  assert.equal(
    purchase.data.pendingPlans?.length,
    1,
    "A saved order must appear in the purchase page's pending receipts",
  );
  assert.equal(purchase.data.pendingPlans[0].items[0].remaining, 2);
  assert.equal(purchase.data.pendingPlans[0].statusText, "未收货");
  purchase.go(tap("url", purchase.data.pendingPlans[0].receiptUrl));
  assert.ok(navigations.at(-1).includes("planId=" + plan.id));
  const receiving = load("purchase", {
    supplierId: supplier.id,
    planId: plan.id,
  });
  await receiving.reload();
  assert.equal(receiving.data.selected.skuId, "qa-phone");
  assert.equal(receiving.data.quantity, 2);
  assert.equal(receiving.data.costPrice, 2000);
  assert.equal(receiving.data.planSettlement.availableText, "3000.00");
  assert.equal(receiving.data.planSettlement.appliedText, "3000.00");
  assert.equal(receiving.data.planSettlement.dueText, "1000.00");
  receiving.setData({ quantity: 1, serialText: "QA-PLAN-1" });
  receiving.calculate();
  assert.equal(receiving.data.planSettlement.appliedText, "2000.00");
  assert.equal(receiving.data.planSettlement.dueText, "0.00");
  // Hidden values left by an older form must never become another payment.
  receiving.setData({ payMode: "paid", paidAmount: "2000" });
  await receiving.submit();
  assert.equal(receiving.data.error, "");
  await purchase.reload();
  assert.equal(purchase.data.pendingPlans[0].statusText, "部分收货");
  assert.equal(purchase.data.pendingPlans[0].items[0].remaining, 1);
  assert.equal(purchase.data.purchases.length, 1);
  assert.equal(purchase.data.purchases[0].planId, plan.id);
  assert.equal(repo.readStore().inventory[0].quantity, 1);
  assert.equal(repo.readStore().supplierCash.length, 1);
  assert.equal(purchase.data.purchases[0].dueText, "0.00");
  const finalReceipt = load("purchase", { planId: plan.id });
  await finalReceipt.reload();
  assert.equal(finalReceipt.data.quantity, 1);
  assert.equal(finalReceipt.data.planSettlement.availableText, "1000.00");
  assert.equal(finalReceipt.data.planSettlement.dueText, "1000.00");
  const staleReceipt = load("purchase", { planId: plan.id });
  await staleReceipt.reload();
  finalReceipt.setData({ serialText: "QA-PLAN-2" });
  await finalReceipt.submit();
  assert.equal(finalReceipt.data.error, "");
  await purchase.reload();
  assert.equal(purchase.data.pendingPlans.length, 0);
  assert.equal(purchase.data.purchases.length, 2);
  assert.equal(repo.readStore().inventory[0].quantity, 2);
  assert.equal(repo.readStore().supplierCash.length, 1);
  assert.equal(purchase.data.purchases[0].dueText, "1000.00");
  await staleReceipt.reload();
  assert.equal(
    staleReceipt.data.plan,
    null,
    "Refreshing a finished order must clear its stale receipt form",
  );
  assert.match(staleReceipt.data.error, /结束|收货完成/);
  const cancelled = await api.post("/api/procurement-plans", {
    supplierId: supplier.id,
    items: [{ skuId: "qa-phone", quantity: 1, costPrice: 2000 }],
  });
  const supplierDetail = load("supplier-detail", { id: supplier.id });
  await supplierDetail.reload();
  supplierDetail.edit(tap("kind", "payment"));
  supplierDetail.dueSelection({
    detail: { value: [supplierDetail.data.targets[0].id] },
  });
  supplierDetail.paymentPlan({ detail: { value: 1 } });
  assert.equal(supplierDetail.data.editor.planId, cancelled.id);
  assert.equal(supplierDetail.data.chosenDue.length, 0);
  supplierDetail.setData({ "editor.amount": "1000" });
  await supplierDetail.save();
  assert.equal(supplierDetail.data.error, "");
  assert.equal(repo.readStore().supplierCash.length, 2);
  const latePaymentReceipt = load("purchase", { planId: cancelled.id });
  await latePaymentReceipt.reload();
  assert.equal(latePaymentReceipt.data.planSettlement.availableText, "1000.00");
  assert.equal(latePaymentReceipt.data.planSettlement.dueText, "1000.00");
  latePaymentReceipt.setData({ serialText: "QA-KEEP-DRAFT" });
  await api.post("/api/supplier-refunds", {
    supplierId: supplier.id,
    sourceId: repo
      .readStore()
      .supplierEntries.find((e) => e.planId === cancelled.id).id,
    amount: 100,
    account: "微信",
  });
  await latePaymentReceipt.submit();
  assert.match(latePaymentReceipt.data.error, /刷新/);
  assert.equal(repo.readStore().purchases.length, 2);
  await latePaymentReceipt.reload();
  assert.equal(latePaymentReceipt.data.serialText, "QA-KEEP-DRAFT");
  assert.equal(latePaymentReceipt.data.planSettlement.availableText, "900.00");
  await api.post("/api/procurement-plans/close", {
    id: cancelled.id,
    reason: "取消订货",
  });
  await purchase.reload();
  assert.equal(purchase.data.pendingPlans.length, 0);
  console.log(
    "Purchase flow passed: visible pending order, linked partial receipts, refreshed state and completed/cancelled orders hidden. Isolated database only.",
  );
}
async function main() {
  repo.resetStore(initial);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  try {
    const login = await api.post("/api/auth/login", { userId: owner.id });
    storage.set("sessionToken", login.token);
    const list = load("suppliers");
    await list.reload();
    list.add();
    list.setData({
      editor: {
        name: "验收专用供应商（隔离账套）",
        contact: "测试联系人",
        note: "仅用于自动化验收，不写入门店账套",
      },
    });
    await list.save();
    assert.equal(list.data.error, "");
    const supplierId = repo.readStore().suppliers[0].id;
    list.search({ detail: { value: "验收" } });
    assert.equal(list.data.rows.length, 1);
    list.search({ detail: { value: "没有此供应商" } });
    assert.equal(list.data.rows.length, 0);
    const detail = load("supplier-detail", { id: supplierId });
    await detail.reload();
    detail.edit(tap("kind", "opening"));
    detail.setData({
      "editor.cash": "2000",
      "editor.note": "期初退款确认",
      "editor.date": "2026-01-01",
    });
    await detail.save();
    assert.equal(detail.data.error, "");
    detail.edit(tap("kind", "payment"));
    detail.setData({ "editor.amount": "500" });
    await detail.save();
    assert.equal(detail.data.balances.advance, "500.00");
    const purchase = load("purchase", { supplierId });
    await purchase.reload();
    purchase.search({ detail: { value: "QA-PHONE" } });
    assert.equal(purchase.data.results.length, 1);
    purchase.choose(tap("id", "qa-phone"));
    purchase.setData({
      quantity: 10,
      costPrice: 2000,
      serialText: Array.from({ length: 10 }, (_, i) => "QA-IMEI-" + i).join(
        "\n",
      ),
      payMode: "paid",
      paidAmount: "12000",
    });
    await purchase.submit();
    assert.equal(purchase.data.error, "");
    assert.equal(purchase.data.purchases[0].dueText, "8000.00");
    await api.post("/api/sale-orders", {
      items: Array.from({ length: 4 }, (_, i) => ({
        skuId: "qa-phone",
        quantity: 1,
        salePrice: 2300,
        serialNo: "QA-IMEI-" + i,
      })),
    });
    const adjustment = load("supplier-adjustment", { supplierId });
    await adjustment.reload();
    adjustment.choose(tap("id", adjustment.candidates[0].itemId));
    adjustment.setData({
      scope: "all",
      unitAmount: 100,
      kind: "credit",
      reference: "QA-PRICE-1",
      note: "本批十台，每台补差100，仅抵货款",
    });
    await adjustment.preview();
    assert.equal(adjustment.data.error, "");
    assert.equal(adjustment.data.preview.inventoryText, "-600.00");
    assert.equal(adjustment.data.preview.salesText, "-400.00");
    const pricePreviewData = structuredClone(adjustment.data);
    await adjustment.confirm();
    assert.equal(adjustment.data.error, "");
    await detail.reload();
    assert.equal(detail.data.balances.credit, "1000.00");
    detail.edit(tap("kind", "offset"));
    const offsetEditorData = structuredClone(detail.data);
    const fixtureDetail = structuredClone(detail.detail);
    await detail.save();
    assert.equal(detail.data.balances.payable, "7000.00");
    assert.equal(detail.data.balances.credit, "0.00");
    detail.edit(tap("kind", "payment"));
    detail.dueSelection({ detail: { value: [detail.data.targets[0].id] } });
    detail.setData({ "editor.amount": "1000" });
    detail.calculate();
    assert.equal(detail.data.allocationTotal, "1000.00");
    await detail.save();
    assert.equal(detail.data.balances.payable, "6000.00");
    detail.edit(tap("kind", "refund"));
    const sourceIndex = detail.data.sources.findIndex((e) => e.kind === "cash");
    detail.source({ detail: { value: sourceIndex } });
    detail.setData({ "editor.amount": "1000" });
    await detail.save();
    assert.equal(detail.data.balances.cash, "1000.00");
    const returned = load("supplier-adjustment", {
      supplierId,
      mode: "return",
    });
    await returned.reload();
    returned.choose(tap("id", returned.candidates[0].itemId));
    returned.selectSerial({ detail: { value: ["QA-IMEI-9"] } });
    returned.setData({
      unitPrice: 1900,
      reference: "QA-RETURN-1",
      note: "已补差机器按1900退回",
    });
    await returned.preview();
    assert.equal(returned.data.preview.costText, "1900.00");
    await returned.confirm();
    assert.equal(returned.data.error, "");
    await detail.reload();
    await detail.loadStatement();
    assert.ok(detail.data.statement.rows.length > 5);
    const res = await fetch(
      base +
        "/api/supplier-statement/export?id=" +
        supplierId +
        "&from=2026-01-01&to=" +
        c.day(),
      { headers: { Authorization: "Bearer " + login.token } },
    );
    assert.equal(res.status, 200);
    const workbook = require("xlsx").read(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(workbook.SheetNames, ["往来余额", "往来明细", "实际收付"]);
    const output = path.join(os.tmpdir(), "store-supplier-qa");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "fixture.json"),
      JSON.stringify({
        supplierId,
        detail: fixtureDetail,
        offsetEditorData,
        pricePreviewData,
        captures,
      }),
      "utf8",
    );
    await testPlanReceiptFlow();
    console.log(
      "Supplier pages passed: directory search, opening, prepayment, purchase, price preview, offset, partial payment, refund, return and Excel export. Isolated database only.",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
