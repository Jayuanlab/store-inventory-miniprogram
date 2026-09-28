process.env.NODE_ENV = "test";
process.env.STORE_DB_PATH = ":memory:";
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("./common");
const erp = require("./erp");
const pay = require("./payroll");
const repository = require("./repository");
const { createServer } = require("./application");
function fixture() {
  const base = JSON.parse(JSON.stringify(require("../data/store.json")));
  base.users.push({
    id: "manager-test",
    name: "测试店长",
    role: "店长",
    roleCode: "manager",
    status: "active",
    permissions: [],
  });
  Object.assign(base, {
    products: [
      {
        skuId: "phone",
        externalCode: "P1",
        name: "测试手机",
        type: "智能手机",
        stockManaged: true,
        trackSerial: true,
        costPrice: 100,
        salePrice: 200,
        unit: "台",
      },
      {
        skuId: "cable",
        externalCode: "C1",
        name: "数据线",
        type: "配件",
        stockManaged: true,
        costPrice: 10,
        salePrice: 30,
        unit: "条",
      },
      {
        skuId: "screen",
        externalCode: "M1",
        name: "屏幕材料",
        type: "维修",
        stockManaged: true,
        costPrice: 185,
        salePrice: 300,
        unit: "块",
      },
      {
        skuId: "repair",
        externalCode: "R1",
        name: "更换屏幕",
        type: "维修",
        stockManaged: false,
        costPrice: 999,
        salePrice: 380,
        unit: "项",
      },
      {
        skuId: "card",
        externalCode: "K1",
        name: "套餐号卡",
        type: "号卡",
        stockManaged: true,
        costPrice: 1,
        salePrice: 50,
        unit: "张",
      },
    ],
    inventory: [
      {
        skuId: "phone",
        quantity: 1,
        costPrice: 100,
        serials: [{ no: "IMEI-1", status: "可售", costPrice: 100 }],
      },
      { skuId: "cable", quantity: 10, costPrice: 10, serials: [] },
      { skuId: "screen", quantity: 3, costPrice: 185, serials: [] },
      { skuId: "card", quantity: 2, costPrice: 1, serials: [] },
    ],
    sales: [],
    purchases: [],
    receipts: [],
    saleReturns: [],
    movements: [],
    expenses: [],
    commissionRules: [],
    salaryRates: [],
    commissionEntries: [],
    payrollStatements: [],
    cardBusinesses: [],
    cardEvents: [],
    requestRecords: [],
  });
  return c.initialize(base);
}
function actors(s) {
  return ["u1", "u2", "u5", "manager-test"].map((id) => c.userById(s, id));
}

test("期初预览不写库存，禁止无效数字、未映射地点及有业务后重建", () => {
  const s = fixture();
  const [owner] = actors(s);
  const row = {
    externalCode: "OPEN1",
    name: "期初商品",
    type: "配件",
    quantity: 3,
    costPrice: 5,
    salePrice: 10,
  };
  const original = JSON.stringify(s);
  assert.equal(erp.openingPreview(s, owner, [row]).totalQuantity, 3);
  assert.equal(JSON.stringify(s), original);
  for (const invalid of [
    { quantity: " " },
    { quantity: 1.5 },
    { costPrice: Infinity },
    { salePrice: -1 },
    { warehouseName: "未映射地点" },
    { warehouseName: "服务项目" },
  ]) {
    assert.throws(() => erp.openingPreview(s, owner, [{ ...row, ...invalid }]));
  }
  assert.throws(
    () => erp.openingPreview(s, owner, [{ ...row, trackSerial: true }]),
    /串码/,
  );
  assert.equal(
    erp.openingPreview(s, owner, [{ ...row, trackSerial: true, quantity: 0 }])
      .totalQuantity,
    0,
  );
  erp.expense(s, owner, { type: "门店费用", amount: 10 });
  assert.equal(erp.openingLocked(s), true);
  assert.throws(
    () => erp.openingCommit(s, owner, { rows: [row], confirmed: true }),
    /业务单据/,
  );
});
test("按件、毛利、实际耗材成本、归属人和规则快照", () => {
  const s = fixture();
  const [owner, employee, , manager] = actors(s);
  pay.saveRule(s, manager, { skuId: "phone", mode: "piece", value: 30 });
  pay.saveRule(s, manager, { skuId: "repair", mode: "profit", value: 20 });
  const order = erp.sale(s, owner, {
    salespersonId: employee.id,
    items: [
      {
        skuId: "phone",
        quantity: 1,
        salePrice: 200,
        serialNo: "IMEI-1",
        costPrice: 0,
      },
      {
        skuId: "repair",
        quantity: 1,
        salePrice: 380,
        materials: [{ skuId: "screen", quantity: 1 }],
      },
    ],
  });
  assert.equal(order.profit, 295);
  assert.equal(s.commissionEntries[0].amount, 30);
  assert.equal(s.commissionEntries[1].amount, 39);
  assert.equal(s.inventory.find((i) => i.skuId === "screen").quantity, 2);
  assert.equal(s.commissionEntries[0].employeeId, employee.id);
  pay.saveRule(s, owner, { skuId: "phone", mode: "piece", value: 99 });
  assert.equal(s.commissionEntries[0].amount, 30);
});
test("采购实际进价进入库存均价，销售不接受客户端成本", () => {
  const s = fixture();
  const [owner, employee, warehouse] = actors(s);
  erp.purchase(s, warehouse, {
    supplier: "测试渠道",
    items: [{ skuId: "cable", quantity: 10, costPrice: 20 }],
  });
  const order = erp.sale(s, employee, {
    items: [{ skuId: "cable", quantity: 1, salePrice: 30, costPrice: 1 }],
  });
  assert.equal(s.sales[0].items[0].costPrice, 15);
  assert.equal(order.profit, undefined);
  assert.equal(erp.orders(s, employee)[0].items[0].costPrice, undefined);
  assert.equal(
    erp.inventory(s, employee).find((x) => x.skuId === "phone").serials[0]
      .costPrice,
    undefined,
  );
  assert.throws(() => erp.purchase(s, employee, {}), /权限/);
  assert.throws(() => erp.sale(s, warehouse, {}), /权限/);
  assert.ok(
    erp.inventory(s, owner).find((x) => x.skuId === "cable").costPrice > 0,
  );
});
test("跨月部分退货保留原规则，已确认工资锁定，所有店长可维护底薪", () => {
  const s = fixture();
  const [owner, employee, , manager] = actors(s);
  pay.saveRule(s, manager, { skuId: "cable", mode: "piece", value: 0.03 });
  erp.sale(s, employee, {
    items: [{ skuId: "cable", quantity: 3, salePrice: 30 }],
  });
  const order = s.sales[0];
  const entry = s.commissionEntries[0];
  const previous = "2025-09";
  entry.month = previous;
  pay.saveSalary(s, manager, {
    employeeId: employee.id,
    effectiveMonth: previous,
    amount: 3000,
  });
  const statement = pay.confirm(s, owner, {
    employeeId: employee.id,
    month: previous,
  });
  assert.equal(statement.total, 3000.09);
  assert.throws(
    () =>
      pay.saveSalary(s, manager, {
        employeeId: employee.id,
        effectiveMonth: previous,
        amount: 5000,
      }),
    /已确认/,
  );
  for (let i = 0; i < 3; i++)
    erp.returnSale(s, owner, {
      orderId: order.id,
      reason: "退货",
      items: [{ itemId: order.items[0].id, quantity: 1 }],
    });
  assert.equal(
    c.round(
      s.commissionEntries
        .filter((e) => e.kind === "return")
        .reduce((n, e) => n + e.amount, 0),
    ),
    -0.09,
  );
  assert.ok(
    s.commissionEntries
      .filter((e) => e.kind === "return")
      .every((e) => e.month === c.month()),
  );
  assert.equal(
    pay.getPayroll(s, owner, previous, employee.id).rows[0].total,
    3000.09,
  );
  assert.throws(
    () =>
      erp.returnSale(s, owner, {
        orderId: order.id,
        reason: "重复",
        items: [{ itemId: order.items[0].id, quantity: 1 }],
      }),
    /超过/,
  );
  assert.throws(() => pay.getPayroll(s, employee, previous, "u3"), /本人/);
});
test("未设底薪和规则不冒充零工资，补录同时解决关联退货", () => {
  const s = fixture();
  const [owner, employee] = actors(s);
  erp.sale(s, employee, {
    items: [{ skuId: "cable", quantity: 2, salePrice: 30 }],
  });
  const order = s.sales[0];
  erp.returnSale(s, owner, {
    orderId: order.id,
    reason: "退一条",
    items: [{ itemId: order.items[0].id, quantity: 1 }],
  });
  assert.equal(pay.getPayroll(s, employee, c.month()).rows[0].total, null);
  pay.resolveEntry(s, owner, s.commissionEntries[0].id, {
    mode: "piece",
    value: 5,
  });
  pay.saveSalary(s, owner, {
    employeeId: employee.id,
    effectiveMonth: c.month(),
    amount: 3000,
  });
  assert.equal(pay.getPayroll(s, employee, c.month()).rows[0].total, 3005);
});
test("号卡预计、确认、分次到账和扣回与销售分离", () => {
  const s = fixture();
  const [owner, employee] = actors(s);
  erp.sale(s, employee, {
    items: [
      { skuId: "card", quantity: 1, salePrice: 50, card: { expected: 100 } },
    ],
  });
  const business = s.cardBusinesses[0];
  erp.cardEvent(s, owner, {
    businessId: business.id,
    type: "confirm",
    amount: 100,
  });
  erp.cardEvent(s, owner, {
    businessId: business.id,
    type: "receive",
    amount: 40,
  });
  erp.cardEvent(s, owner, {
    businessId: business.id,
    type: "receive",
    amount: 60,
  });
  erp.cardEvent(s, owner, {
    businessId: business.id,
    type: "clawback",
    amount: 20,
  });
  assert.equal(s.sales.length, 1);
  assert.equal(business.received, 80);
  const report = erp.report(s, owner);
  assert.equal(report.summary.salesAmount, 50);
  assert.equal(report.summary.receivedAmount, 50);
  assert.equal(report.summary.carrierReceived, 80);
});
test("HTTP身份隔离、幂等、并发最后一台、事务失败回滚", async () => {
  repository.resetStore(fixture());
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(path, data, token, key) {
    const res = await fetch(base + path, {
      method: data ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: res.status, body: await res.json() };
  }
  try {
    assert.equal((await request("/api/payroll")).status, 401);
    const token = (await request("/api/auth/login", { userId: "u2" })).body
      .token;
    const token2 = (await request("/api/auth/login", { userId: "u3" })).body
      .token;
    assert.equal(
      (await request("/api/payroll?employeeId=u3&userId=u1", null, token))
        .status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/payroll/rules",
          { operatorId: "u1", skuId: "phone", mode: "piece", value: 30 },
          token,
          "forged",
        )
      ).status,
      403,
    );
    const payload = {
      items: [
        { skuId: "phone", quantity: 1, salePrice: 200, serialNo: "IMEI-1" },
      ],
    };
    const results = await Promise.all([
      request("/api/sale-orders", payload, token, "race-a"),
      request("/api/sale-orders", payload, token2, "race-b"),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner =
      results[0].status === 200 ? [token, "race-a"] : [token2, "race-b"];
    const replay = await request("/api/sale-orders", payload, ...winner);
    assert.equal(replay.status, 200);
    assert.equal(repository.readStore().sales.length, 1);
    const before = repository
      .readStore()
      .inventory.find((i) => i.skuId === "cable").quantity;
    const bad = await request(
      "/api/sale-orders",
      {
        items: [
          { skuId: "cable", quantity: 1, salePrice: 10 },
          { skuId: "phone", quantity: 1, salePrice: 200, serialNo: "IMEI-1" },
        ],
      },
      token,
      "rollback",
    );
    assert.equal(bad.status, 409);
    assert.equal(
      repository.readStore().inventory.find((i) => i.skuId === "cable")
        .quantity,
      before,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("分次退货成本不丢分币，员工日报包含本人退款", () => {
  const s = fixture();
  const [owner, employee] = actors(s);
  const stock = s.inventory.find((i) => i.skuId === "cable");
  stock.quantity = 3;
  stock.costPrice = 13.333333;
  erp.sale(s, employee, {
    items: [{ skuId: "cable", quantity: 3, salePrice: 30 }],
  });
  const order = s.sales[0];
  for (let i = 0; i < 3; i++)
    erp.returnSale(s, owner, {
      orderId: order.id,
      reason: "分次退款",
      items: [{ itemId: order.items[0].id, quantity: 1 }],
    });
  assert.equal(stock.stockValue, 40);
  assert.equal(
    c.round(s.saleReturns.reduce((sum, row) => sum + row.items[0].cost, 0)),
    order.items[0].cost,
  );
  assert.equal(erp.report(s, employee).summary.refundAmount, 90);
  assert.equal(erp.report(s, owner).summary.grossProfit, 0);
});

test("工资发放只记一次，店长无权查看全员工资、员工无权改规则", () => {
  const s = fixture();
  const [owner, employee, warehouse, manager] = actors(s);
  pay.saveSalary(s, manager, {
    employeeId: warehouse.id,
    effectiveMonth: "2025-09",
    amount: 2800,
  });
  const row = pay.confirm(s, owner, {
    employeeId: warehouse.id,
    month: "2025-09",
  });
  assert.equal(row.total, 2800);
  pay.markPaid(s, owner, { statementId: row.id, account: "银行卡" });
  pay.markPaid(s, owner, { statementId: row.id, account: "银行卡" });
  assert.equal(s.receipts.filter((r) => r.kind === "payroll").length, 1);
  assert.throws(
    () => pay.getPayroll(s, manager, "2025-09", warehouse.id),
    /本人/,
  );
  assert.throws(
    () =>
      pay.saveRule(s, employee, { skuId: "cable", mode: "piece", value: 10 }),
    /权限/,
  );
  assert.throws(
    () =>
      pay.confirm(s, manager, { employeeId: warehouse.id, month: "2025-08" }),
    /权限/,
  );
  assert.throws(
    () =>
      pay.saveRule(s, owner, { skuId: "cable", mode: "profit", value: 101 }),
    /100/,
  );
  for (const bad of [" ", [], {}, true, "Infinity", -1])
    assert.throws(() => c.money(bad));
});
