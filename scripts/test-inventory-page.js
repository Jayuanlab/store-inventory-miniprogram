const assert = require("node:assert/strict");
const api = require("../utils/api");
let response = [];
const requests = [];
api.request = async (url) => {
  requests.push(url);
  return structuredClone(response);
};
global.getApp = () => ({
  globalData: {
    currentUser: { capabilities: { cost: true, stocktake: true } },
  },
});
global.wx = { getStorageSync: () => "isolated", stopPullDownRefresh() {} };
let config;
global.Page = (page) => {
  config = page;
};
require("../pages/inventory/inventory");
function load() {
  return {
    ...config,
    data: structuredClone(config.data),
    setData(values) {
      Object.assign(this.data, values);
    },
  };
}
function stock(id, type, subType, thirdType, overrides = {}) {
  return {
    skuId: id,
    stockKey: id + "-shop",
    name: "商品 " + id,
    type,
    subType,
    thirdType,
    warehouseName: "门店",
    quantity: 2,
    unit: "件",
    stockManaged: true,
    costPrice: 10,
    externalCode: "CODE-" + id,
    serials: [],
    ...overrides,
  };
}
function choose(page, level, value) {
  const index = page.data.categoryOptions[level].findIndex(
    (o) => o.value === value,
  );
  assert.ok(index >= 0, "Option must exist in the selected parent: " + value);
  page.category({
    currentTarget: { dataset: { level } },
    detail: { value: index },
  });
}
async function main() {
  response = [
    stock("p1", "智能手机", "OPPO", "A系列", {
      name: "A6T 手机",
      spec: "6+256",
      trackSerial: true,
      serials: [{ no: "IMEI-123", status: "可售" }],
    }),
    stock("p2", "智能手机", "OPPO", "Reno系列"),
    stock("p3", "智能手机", "荣耀", "数字系列"),
    stock("p4", "配件", "数据线", "标闪"),
    stock("p5", "配件", "充电器", "标闪", { quantity: 0 }),
    stock("p6", "配件", "OPPO", "A系列"),
    stock("p7", "维修", "尾插", ""),
    stock("p8", "", "", ""),
    stock("p9", "智能手机", "", "有下级但缺二级"),
    stock("p10", "全部分类", "字面分类名", "三级"),
    stock("service", "维修", "检测", "服务", { stockManaged: false }),
  ];
  const original = structuredClone(response);
  const page = load();
  await page.reload();
  assert.equal(page.data.items.length, 10);
  assert.equal(page.data.itemCount, 10);
  assert.equal(page.data.groupCount, 10);
  assert.equal(page.data.groups.length, 10);
  assert.equal(page.data.categoryOptions[1].length, 1);
  choose(page, 0, "智能手机");
  assert.equal(page.data.items.length, 4);
  assert.ok(!page.data.categoryOptions[1].some((o) => o.value === "数据线"));
  choose(page, 1, "OPPO");
  assert.equal(page.data.items.length, 2);
  choose(page, 2, "A系列");
  assert.deepEqual(
    page.data.items.map((p) => p.skuId),
    ["p1"],
  );
  assert.equal(page.data.groups[0].pathText, "智能手机 / OPPO / A系列");
  page.open({ currentTarget: { dataset: { key: "p1-shop" } } });
  assert.equal(page.data.detail.serials[0].no, "IMEI-123");
  assert.equal(page.data.detail.pathText, "智能手机 / OPPO / A系列");
  page.close();
  choose(page, 0, "配件");
  assert.deepEqual(page.data.categoryValues, ["配件", null, null]);
  assert.equal(page.data.categoryOptions[2].length, 1);
  assert.equal(page.data.items.length, 3);
  choose(page, 1, "数据线");
  choose(page, 2, "标闪");
  page.search({ detail: { value: "IMEI-123" } });
  assert.equal(
    page.data.items.length,
    0,
    "Search keeps the selected category scope",
  );
  page.resetCategories();
  assert.equal(page.data.keyword, "IMEI-123");
  assert.equal(page.data.items.length, 1);
  page.search({ detail: { value: "OPPO 6+256" } });
  assert.equal(page.data.items.length, 1);
  page.search({ detail: { value: "CODE-p4" } });
  assert.equal(page.data.items[0].skuId, "p4");
  page.clearSearch();
  choose(page, 0, "");
  assert.equal(page.data.items[0].skuId, "p8");
  choose(page, 0, "全部分类");
  assert.equal(
    page.data.items.length,
    1,
    "A literal category name must not mean all categories",
  );
  choose(page, 0, "智能手机");
  choose(page, 1, "");
  choose(page, 2, "有下级但缺二级");
  assert.equal(page.data.items[0].skuId, "p9");
  choose(page, 1, "OPPO");
  choose(page, 2, "A系列");
  await page.reload();
  assert.deepEqual(page.data.categoryValues, ["智能手机", "OPPO", "A系列"]);
  response = response.filter((p) => p.skuId !== "p1");
  await page.reload();
  assert.deepEqual(page.data.categoryValues, ["智能手机", "OPPO", null]);
  assert.equal(page.data.items[0].skuId, "p2");
  assert.deepEqual(
    original.find((p) => p.skuId === "p2"),
    response.find((p) => p.skuId === "p2"),
  );
  assert.ok(
    requests.every((url) => url === "/api/inventory"),
    "Browsing only reads existing stock",
  );
  response = [];
  await page.reload();
  assert.deepEqual(page.data.categoryValues, [null, null, null]);
  assert.equal(page.data.groups.length, 0);
  assert.equal(page.data.itemCount, 0);
  console.log(
    "Inventory page passed: three-level filtering, parent resets, scoped/global search, missing levels, literal names, stock details and reload. No live writes.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
