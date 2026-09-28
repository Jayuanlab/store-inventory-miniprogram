const assert = require("assert");
const { readStore } = require("./repository");
const { createStoreData } = require("../../utils/mock");
const {
  createSale,
  createPurchase,
  getDashboard,
  getDailyReport,
  getCategoryHierarchy,
  getCategoryTree,
  getOpeningBalanceStatus,
  getOpeningBalanceTemplate,
  importOpeningBalance,
  readOpeningBalanceRowsFromWorkbook,
  listInventory
} = require("./services");
const XLSX = require("xlsx");

function createTestStore() {
  const base = readStore();
  const mock = createStoreData();
  return {
    ...base,
    categories: mock.categories,
    subcategories: mock.subcategories,
    thirdCategories: mock.thirdCategories,
    products: mock.products,
    inventory: mock.inventory,
    sales: mock.sales,
    purchases: mock.purchases,
    movements: mock.movements,
    operationLogs: base.operationLogs || [],
    expenses: base.expenses || [],
    suppliers: base.suppliers || [],
    customers: base.customers || []
  };
}

const store = createTestStore();

const beforeCable = listInventory(store).find((item) => item.skuId === "sku-cable-c").quantity;
const purchase = createPurchase(store, {
  supplier: "测试供应商",
  operatorId: "u1",
  items: [
    {
      skuId: "sku-cable-c",
      quantity: 2,
      serials: []
    }
  ]
});

assert.ok(purchase.id.startsWith("PO"));
assert.strictEqual(listInventory(store).find((item) => item.skuId === "sku-cable-c").quantity, beforeCable + 2);

const serial = listInventory(store)
  .find((item) => item.skuId === "sku-phone-15")
  .serials.find((item) => item.status === "可售").no;

const sale = createSale(store, {
  operatorId: "u2",
  paymentMethod: "微信收款",
  items: [
    {
      skuId: "sku-phone-15",
      quantity: 1,
      serialNo: serial
    }
  ]
});

assert.ok(sale.id.startsWith("SO"));
assert.strictEqual(sale.profit, 649);
assert.ok(getDashboard(store).stockCost > 0);

const reportDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date(sale.createdAt));
const dailyReport = getDailyReport(store, "u1", reportDate);
assert.ok(dailyReport.summary.salesAmount >= sale.amount);
assert.ok(dailyReport.categoryStats.some((item) => item.category === "智能手机"));
assert.ok(dailyReport.staffStats.some((item) => item.id === "u2" && item.orderCount > 0));
const categoryTree = getCategoryTree(store);
assert.ok(categoryTree.some((item) => item.name === "智能手机" && item.children.includes("苹果")));
assert.ok(categoryTree.some((item) => item.name === "功能机" && item.children.includes("亿优")));
assert.ok(categoryTree.some((item) => item.name === "配件" && item.children.includes("钢化膜") && item.children.includes("车充")));
assert.ok(categoryTree.some((item) => item.name === "平板" && item.children.includes("小天才") && item.children.includes("OPPO")));
assert.ok(categoryTree.some((item) => item.name === "手表" && item.children.includes("清华同方") && item.children.includes("创维")));
assert.ok(categoryTree.some((item) => item.name === "维修" && item.children.includes("屏幕") && item.children.includes("镜片")));
assert.ok(categoryTree.some((item) => item.name === "号卡" && item.children.includes("号卡（1）") && item.children.includes("号卡（3）")));
assert.ok(categoryTree.some((item) => item.name === "电视" && item.children.includes("小米") && item.children.includes("红米")));
assert.ok(categoryTree.some((item) => item.name === "会员产品" && item.children.includes("延长保修") && item.children.includes("碎屏保险")));
assert.ok(categoryTree.some((item) => item.name === "小米家具" && item.children.includes("空调") && item.children.includes("电池")));
const categoryHierarchy = getCategoryHierarchy(store);
const smartPhone = categoryHierarchy.find((item) => item.name === "智能手机");
assert.ok(smartPhone.children.some((item) => item.name === "OPPO" && item.children.includes("欧珀公司")));
assert.ok(smartPhone.children.some((item) => item.name === "红米" && item.children.includes("小米演示")));
const accessories = categoryHierarchy.find((item) => item.name === "配件");
assert.ok(accessories.children.some((item) => item.name === "钢化膜" && item.children.includes("影响力")));
assert.ok(accessories.children.some((item) => item.name === "直充套装" && item.children.includes("天音移动") && item.children.includes("蜜能")));
assert.ok(accessories.children.some((item) => item.name === "数据线" && item.children.includes("混合") && item.children.includes("小米")));
assert.ok(accessories.children.some((item) => item.name === "耳机" && item.children.includes("梵之音") && item.children.includes("亿优")));
assert.ok(accessories.children.some((item) => item.name === "摄像头" && item.children.includes("TP必联") && item.children.includes("HD高清")));
assert.ok(accessories.children.some((item) => item.name === "复印" && item.children.includes("黑白复印")));
assert.ok(accessories.children.some((item) => item.name === "充电宝" && item.children.includes("讯哇雷") && item.children.includes("SKK充电宝")));
assert.ok(accessories.children.some((item) => item.name === "U盘" && item.children.includes("金士顿") && item.children.includes("朗科")));
assert.ok(accessories.children.some((item) => item.name === "指环扣" && item.children.includes("贝克")));
const repair = categoryHierarchy.find((item) => item.name === "维修");
assert.ok(repair.children.some((item) => item.name === "屏幕" && item.children.includes("内外屏") && item.children.includes("外屏")));
const openingTemplate = getOpeningBalanceTemplate(store);
assert.ok(openingTemplate.requiredColumns.includes("一级分类"));
assert.ok(openingTemplate.categoryHierarchy.some((item) => item.name === "配件"));
const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.json_to_sheet(openingTemplate.sampleRows);
XLSX.utils.book_append_sheet(workbook, worksheet, "期初建账");
const workbookRows = readOpeningBalanceRowsFromWorkbook(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
assert.strictEqual(workbookRows.length, openingTemplate.sampleRows.length);
assert.strictEqual(workbookRows[0]["一级分类"], "智能手机");
const openingStore = JSON.parse(JSON.stringify(store));
const openingResult = importOpeningBalance(openingStore, {
  operatorId: "u1",
  source: "self-test",
  rows: [
    {
      "商品编号": "TEST-OPPO-A6T",
      "商品名称": "OPPO A6T 6+256",
      "一级分类": "智能手机",
      "二级分类": "OPPO",
      "三级分类": "欧珀公司",
      "单位": "台",
      "期初数量": 3,
      "成本均价": 1556,
      "预设售价": 1999,
      "仓库": "销售仓",
      "是否串码": "否"
    },
    {
      "商品编号": "TEST-REPAIR-SCREEN",
      "商品名称": "尾插维修件",
      "一级分类": "维修",
      "二级分类": "尾插",
      "三级分类": "尾插小板",
      "单位": "个",
      "期初数量": 6,
      "成本均价": 18,
      "预设售价": 80,
      "仓库": "销售仓",
      "是否串码": "否"
    },
    {
      "商品编号": "TEST-CUSTOM-CAT",
      "商品名称": "Excel自定义目录商品",
      "一级分类": "自定义一级",
      "二级分类": "自定义二级",
      "三级分类": "自定义三级",
      "单位": "件",
      "期初数量": 5,
      "成本均价": 8,
      "预设售价": 18,
      "仓库": "销售仓",
      "是否串码": "否"
    }
  ]
});
assert.strictEqual(openingResult.productCount, 3);
assert.strictEqual(openingResult.stockCount, 3);
assert.strictEqual(getOpeningBalanceStatus(openingStore).hasOpeningBalance, true);
assert.strictEqual(openingStore.products[0].thirdType, "欧珀公司");
assert.strictEqual(openingStore.products.find((item) => item.externalCode === "TEST-REPAIR-SCREEN").stockManaged, true);
assert.ok(openingStore.categories.includes("自定义一级"));
assert.ok(openingStore.subcategories["自定义一级"].includes("自定义二级"));
assert.ok(openingStore.thirdCategories["自定义一级"]["自定义二级"].includes("自定义三级"));
assert.throws(() => importOpeningBalance(JSON.parse(JSON.stringify(store)), {
  operatorId: "u2",
  source: "self-test",
  rows: [
    {
      "商品编号": "TEST-DENIED",
      "商品名称": "员工不能导入期初",
      "一级分类": "配件",
      "二级分类": "数据线",
      "三级分类": "标闪",
      "期初数量": 1,
      "成本均价": 1
    }
  ]
}), /只有老板可以执行期初建账/);

const movementCount = store.movements.length;
const repairSale = createSale(store, {
  operatorId: "u2",
  paymentMethod: "微信收款",
  items: [
    {
      skuId: "sku-repair-screen",
      quantity: 1,
      salePrice: 380
    }
  ]
});
assert.strictEqual(repairSale.amount, 380);
assert.strictEqual(repairSale.profit, 195);
assert.strictEqual(store.movements.length, movementCount);

console.log("Server service tests passed.");
