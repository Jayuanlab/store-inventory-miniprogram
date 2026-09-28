const XLSX = require("xlsx");
process.env.NODE_ENV = "test";
process.env.STORE_DB_PATH = ":memory:";
const assert = require("node:assert/strict");
const repository = require("../server/src/repository");
const { createServer } = require("../server/src/application");

const rows = [
  {
    商品编号: "UPLOAD-OPPO-A6T",
    商品名称: "OPPO A6T 6+256 上传测试",
    商品简名: "OPPO A6T",
    一级分类: "智能手机",
    二级分类: "OPPO",
    三级分类: "欧珀公司",
    规格型号: "6+256",
    单位: "台",
    期初数量: 3,
    成本均价: 1556,
    预设售价: 1999,
    仓库: "销售仓",
    是否串码: "否",
  },
  {
    商品编号: "UPLOAD-BS-PD-CABLE",
    商品名称: "标闪PD快充数据线 上传测试",
    商品简名: "PD快充数据线",
    一级分类: "配件",
    二级分类: "数据线",
    三级分类: "标闪",
    规格型号: "Type-C",
    单位: "条",
    期初数量: 7,
    成本均价: 15,
    预设售价: 38,
    仓库: "销售仓",
    是否串码: "否",
  },
  {
    商品编号: "UPLOAD-TAIL-PLUG",
    商品名称: "尾插维修件 上传测试",
    商品简名: "尾插",
    一级分类: "维修",
    二级分类: "尾插",
    三级分类: "尾插小板",
    规格型号: "通用",
    单位: "个",
    期初数量: 6,
    成本均价: 18,
    预设售价: 80,
    仓库: "销售仓",
    是否串码: "否",
  },
  {
    商品编号: "UPLOAD-CUSTOM-CAT",
    商品名称: "Excel自定义目录商品 上传测试",
    商品简名: "自定义商品",
    一级分类: "Excel一级分类",
    二级分类: "Excel二级分类",
    三级分类: "Excel三级分类",
    规格型号: "演示规格",
    单位: "件",
    期初数量: 5,
    成本均价: 8,
    预设售价: 18,
    仓库: "销售仓",
    是否串码: "否",
  },
];

async function main() {
  const seed = structuredClone(require("../server/data/store.json"));
  for (const key of [
    "sales",
    "purchases",
    "saleReturns",
    "purchaseReturns",
    "stocktakes",
    "payrollStatements",
    "cardEvents",
    "receipts",
    "expenses",
  ])
    seed[key] = [];
  repository.resetStore(seed);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1" }),
    }).then((r) => r.json());
    const headers = { Authorization: "Bearer " + login.token };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(rows),
      "期初建账",
    );
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

    const form = new FormData();
    form.append("operatorId", "u1");
    form.append(
      "file",
      new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "opening-balance-upload-test.xlsx",
    );

    const before = repository.readStore();
    const importResponse = await fetch(
      base + "/api/opening-balance/preview-excel",
      {
        method: "POST",
        headers,
        body: form,
      },
    );
    const importResult = await importResponse.json();
    if (!importResponse.ok) {
      throw new Error(JSON.stringify(importResult));
    }

    assert.deepEqual(
      repository.readStore(),
      before,
      "Preview must not alter inventory",
    );
    assert.equal(importResult.totalQuantity, 21);
    const commit = await fetch(base + "/api/opening-balance/import", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Idempotency-Key": "test-only-import",
      },
      body: JSON.stringify({ rows: importResult.sourceRows, confirmed: true }),
    });
    assert.equal(commit.status, 200, JSON.stringify(await commit.json()));
    const inventory = await fetch(base + "/api/inventory", { headers }).then(
      (r) => r.json(),
    );
    assert.equal(inventory.length, 4);
    assert.ok(inventory.some((p) => p.name === "尾插维修件 上传测试"));
    console.log(
      "Excel preview/import tested in isolated in-memory database. Local store untouched.",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
