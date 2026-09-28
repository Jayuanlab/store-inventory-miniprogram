const assert = require("node:assert/strict");
const storage = new Map();
const calls = [];
const app = { globalData: { currentUser: null } };
let respond;
let navigated;
let modalCount = 0;
global.getApp = () => app;
global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
  removeStorageSync: (key) => storage.delete(key),
  reLaunch: ({ url }) => {
    navigated = url;
  },
  navigateTo: ({ url }) => {
    navigated = url;
  },
  stopPullDownRefresh() {},
  showToast() {},
  showModal: (options) => {
    modalCount++;
    options.success({ confirm: true });
  },
  request(options) {
    calls.push(options);
    Promise.resolve()
      .then(() => respond(options))
      .then(
        (data) => options.success({ statusCode: 200, data }),
        () => options.fail({ errMsg: "offline" }),
      );
  },
};
function loadPage(name) {
  let page;
  global.Page = (config) => {
    page = {
      ...config,
      data: structuredClone(config.data || {}),
      setData(patch) {
        for (const [key, value] of Object.entries(patch)) {
          const parts = key.split(".");
          let target = this.data;
          for (const part of parts.slice(0, -1)) target = target[part];
          target[parts.at(-1)] = value;
        }
      },
    };
  };
  const file = require.resolve("../pages/" + name + "/" + name);
  delete require.cache[file];
  require(file);
  return page;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));
async function main() {
  const inventory = loadPage("inventory");
  await inventory.reload();
  assert.equal(navigated, "/pages/login/login");
  assert.equal(calls.length, 0, "No anonymous business request");
  const employee = {
    id: "u2",
    name: "示例员工甲",
    role: "员工",
    capabilities: { sell: true, managePay: false },
  };
  app.globalData.currentUser = employee;
  storage.set("sessionToken", "isolated-test-token");
  respond = () => {
    throw new Error("offline");
  };
  for (const route of require("../app.json").pages) {
    const page = loadPage(route.split("/")[1]);
    if (page.onLoad) page.onLoad({});
    if (page.onShow) page.onShow();
    await flush();
    assert.match(
      page.data.error,
      /连接/,
      route + ": unavailable API must not become fake data",
    );
  }
  assert.deepEqual(inventory.data.items, []);
  const goods = Array.from({ length: 30 }, (_, i) => ({
    skuId: "sku" + i,
    stockKey: "sku" + i + "-wh-sale",
    warehouseId: "wh-sale",
    name: "iPhone 16 Pro " + i,
    externalCode: "P" + i,
    quantity: 2,
    salePrice: 100,
    unit: "台",
    type: "智能手机",
    trackSerial: true,
    stockManaged: true,
    serials: [{ no: "IMEI-" + i, status: "可售" }],
  }));
  respond = ({ url }) => (url.includes("/inventory") ? goods : [employee]);
  const sales = loadPage("sales");
  await sales.reload();
  assert.equal(sales.data.salespersonId, "u2");
  sales.changeKeyword({ detail: { value: "苹果 16 Pro" } });
  assert.equal(sales.data.results.length, 30, "No arbitrary result cap");
  sales.changeKeyword({ detail: { value: "苹果 99" } });
  assert.equal(
    sales.data.results.length,
    0,
    "Model numbers must not be discarded",
  );
  sales.changeKeyword({ detail: { value: "IMEI-29" } });
  assert.equal(sales.data.results.length, 1);
  sales.openProduct(goods[29], "IMEI-29");
  sales.add();
  assert.equal(sales.data.cart[0].serialNo, "IMEI-29");
  const draft = storage.get("cart:u2");
  const ui = require("../utils/ui");
  const page = loadPage("products");
  respond = () => {
    throw new Error("offline");
  };
  let completed = 0;
  await ui.submit(
    page,
    "/api/sale-orders",
    { items: [{ salePrice: 100 }] },
    () => {
      completed++;
    },
  );
  const original = calls.at(-1);
  assert.equal(completed, 0);
  assert.deepEqual(
    storage.get("cart:u2"),
    draft,
    "Failed submit preserves draft",
  );
  respond = () => ({ id: "test-only-order" });
  await ui.submit(
    page,
    "/api/sale-orders",
    { items: [{ salePrice: 200 }] },
    () => {
      completed++;
    },
  );
  const retry = calls.at(-1);
  assert.equal(
    modalCount,
    1,
    "Changed content must explicitly reconcile uncertain prior request",
  );
  assert.deepEqual(retry.data, original.data);
  assert.equal(
    retry.header["Idempotency-Key"],
    original.header["Idempotency-Key"],
  );
  assert.equal(completed, 1);
  assert.equal(storage.get("pending:u2:/api/sale-orders"), undefined);
  console.log(
    "Page tests passed: login, all-page offline states, model/serial search, attribution, draft preservation and retry deduplication.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
