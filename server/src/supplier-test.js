process.env.NODE_ENV = "test";
process.env.STORE_DB_PATH = ":memory:";
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("./common");
const erp = require("./erp");
const s = require("./suppliers");
const costs = require("./supplier-costs");
const repo = require("./repository");
const { createServer } = require("./application");
const owner = {
  id: "owner",
  name: "测试老板",
  roleCode: "owner",
  status: "active",
};
const staff = {
  id: "staff",
  name: "测试店员",
  roleCode: "employee",
  status: "active",
  permissions: ["sale:create"],
};
const warehouse = {
  id: "wh",
  name: "测试仓管",
  roleCode: "warehouse",
  status: "active",
  permissions: ["purchase:create"],
};
const manager = {
  id: "mgr",
  name: "测试店长",
  roleCode: "manager",
  status: "active",
};
function fixture() {
  return c.initialize({
    users: [owner, staff, warehouse, manager],
    products: [
      {
        skuId: "phone",
        name: "测试手机",
        type: "手机",
        stockManaged: true,
        trackSerial: true,
      },
      {
        skuId: "part",
        name: "测试屏幕",
        type: "配件",
        stockManaged: true,
        trackSerial: false,
      },
      { skuId: "service", name: "换屏服务", type: "维修", stockManaged: false },
    ],
    inventory: [
      { skuId: "phone", quantity: 0, costPrice: 0, stockValue: 0, serials: [] },
      { skuId: "part", quantity: 0, costPrice: 0, stockValue: 0, serials: [] },
    ],
  });
}
function buy(store, sku = "phone", qty = 10, price = 2000, extra = {}) {
  return erp.purchase(store, owner, {
    supplier: "甲供应商",
    items: [
      {
        skuId: sku,
        quantity: qty,
        costPrice: price,
        serials:
          sku === "phone"
            ? Array.from({ length: qty }, (_, i) => "IMEI-" + i)
            : [],
      },
    ],
    ...extra,
  });
}
function pricePayload(purchase, extra = {}) {
  return {
    supplierId: purchase.supplierId,
    purchaseId: purchase.id,
    itemId: purchase.items[0].id,
    reference: "PRICE-1",
    note: "双方确认本批次补差",
    scope: "all",
    direction: "decrease",
    unitAmount: 100,
    kind: "cash",
    ...extra,
  };
}
function adjust(store, purchase, extra) {
  const payload = pricePayload(purchase, extra);
  const preview = costs.preview(store, owner, payload);
  return costs.confirm(store, owner, {
    ...payload,
    previewToken: preview.previewToken,
  });
}
test("供应商默认赊购，部分付款、抵扣和退款各记一次且不混同现金", () => {
  const store = fixture();
  const p = buy(store, "phone", 10, 2000, { paidAmount: 12000 });
  assert.equal(s.balances(store, p.supplierId).payable, 8000);
  const credit = adjust(store, p);
  assert.deepEqual(s.balances(store, p.supplierId), {
    payable: 8000,
    cash: 1000,
    advance: 0,
    credit: 0,
  });
  s.offset(store, owner, {
    sourceId: credit.entryId,
    targetId: p.supplierEntryId,
    amount: 1000,
  });
  assert.equal(s.balances(store, p.supplierId).payable, 7000);
  assert.equal(store.receipts.length, 1);
  s.payment(store, owner, {
    supplierId: p.supplierId,
    amount: 8000,
    account: "银行卡",
    allocations: [{ targetId: p.supplierEntryId, amount: 7000 }],
  });
  assert.equal(s.balances(store, p.supplierId).advance, 1000);
  const advance = store.supplierEntries.at(-1);
  s.refund(store, owner, {
    sourceId: advance.id,
    amount: 400,
    account: "微信",
  });
  assert.equal(s.balances(store, p.supplierId).advance, 600);
  assert.equal(store.receipts.at(-1).amount, 400);
});
test("10台补差按6台库存4台已售分配，工资和原销售快照不覆盖", () => {
  const store = fixture(),
    p = buy(store);
  erp.sale(store, staff, {
    items: Array.from({ length: 4 }, (_, i) => ({
      skuId: "phone",
      quantity: 1,
      serialNo: "IMEI-" + i,
      salePrice: 2300,
    })),
  });
  const snapshot = structuredClone(store.sales[0]);
  const commissions = structuredClone(store.commissionEntries);
  const row = adjust(store, p);
  assert.equal(row.inventoryDelta, -600);
  assert.equal(row.salesDelta, -400);
  assert.equal(store.inventory[0].stockValue, 11400);
  assert.deepEqual(store.sales[0], snapshot);
  assert.deepEqual(store.commissionEntries, commissions);
  assert.equal(erp.report(store, owner).summary.costAdjustmentProfit, 400);
  assert.equal(erp.orders(store, owner)[0].adjustedProfit, 1600);
  assert.equal(erp.orders(store, staff)[0].costAdjustments, undefined);
  erp.returnSale(store, owner, {
    orderId: snapshot.id,
    reason: "客户退货",
    items: [{ itemId: snapshot.items[0].id, quantity: 1 }],
  });
  assert.equal(store.inventory[0].stockValue, 13300);
  assert.equal(erp.report(store, owner).summary.costAdjustmentProfit, 300);
  erp.sale(store, staff, {
    items: [
      { skuId: "phone", quantity: 1, serialNo: "IMEI-0", salePrice: 2200 },
    ],
  });
  assert.equal(store.sales[0].items[0].cost, 1900);
  const next = adjust(store, p, { reference: "PRICE-2", unitAmount: 50 });
  assert.equal(next.amount, 500);
  assert.equal(next.inventoryDelta, -300);
});
test("库存价保仅补选定串码，预览过期、重复编号、跨供应商串码和负成本均拒绝", () => {
  const store = fixture(),
    p = buy(store);
  const payload = pricePayload(p, { scope: "inventory" });
  const pre = costs.preview(store, owner, payload);
  erp.sale(store, staff, {
    items: [
      { skuId: "phone", quantity: 1, serialNo: "IMEI-0", salePrice: 2200 },
    ],
  });
  assert.throws(
    () =>
      costs.confirm(store, owner, {
        ...payload,
        previewToken: pre.previewToken,
      }),
    /重新预览/,
  );
  const row = adjust(store, p, { scope: "inventory" });
  assert.equal(row.amount, 900);
  assert.equal(row.salesDelta, 0);
  assert.throws(() => adjust(store, p), /已登记/);
  assert.throws(
    () =>
      costs.preview(
        store,
        owner,
        pricePayload(p, {
          reference: "PRICE-3",
          scope: "selected",
          serialNos: ["OTHER"],
        }),
      ),
    /串码/,
  );
  assert.throws(
    () =>
      costs.preview(
        store,
        owner,
        pricePayload(p, { reference: "PRICE-3", unitAmount: 3000 }),
      ),
    /负数/,
  );
});
test("混合批次加权成本来源支持供应商整批补差和维修耗材，客户分次退货保持成本", () => {
  const store = fixture();
  const p = buy(store, "part", 10, 200);
  buy(store, "part", 10, 100, { supplier: "乙供应商" });
  erp.sale(store, staff, {
    items: [
      { skuId: "part", quantity: 3, salePrice: 300 },
      {
        skuId: "service",
        quantity: 1,
        salePrice: 380,
        materials: [{ skuId: "part", quantity: 1 }],
      },
    ],
  });
  const order = store.sales[0];
  assert.equal(order.items[1].cost, 150);
  const row = adjust(store, p, { unitAmount: 20 });
  assert.equal(row.amount, 200);
  assert.equal(row.inventoryDelta, -160);
  assert.equal(row.salesDelta, -40);
  for (let i = 0; i < 3; i++)
    erp.returnSale(store, owner, {
      orderId: order.id,
      reason: "分次退货",
      items: [{ itemId: order.items[0].id, quantity: 1 }],
    });
  assert.equal(store.inventory[1].stockValue, 2660);
  assert.equal(erp.report(store, owner).summary.costAdjustmentProfit, 10);
  assert.throws(
    () =>
      costs.preview(
        store,
        owner,
        pricePayload(p, {
          reference: "NEW",
          scope: "inventory",
          unitAmount: 10,
        }),
      ),
    /混合/,
  );
  const next = adjust(store, p, { reference: "NEXT", unitAmount: 10 });
  assert.equal(next.inventoryDelta, -95);
  assert.equal(next.salesDelta, -5);
});
test("采购退货用已调成本出库，已付未付可抵扣，不能重复退货或退款额度", () => {
  const store = fixture(),
    p = buy(store, "phone", 2, 2000);
  adjust(store, p);
  const payload = {
    supplierId: p.supplierId,
    purchaseId: p.id,
    itemId: p.items[0].id,
    quantity: 1,
    serialNos: ["IMEI-0"],
    unitPrice: 1900,
    kind: "cash",
    reference: "RETURN-1",
    note: "退回已价保机器",
    confirmed: true,
  };
  const row = costs.returnPurchase(store, owner, {
    ...payload,
    previewToken: costs.previewReturn(store, owner, payload).previewToken,
  });
  assert.equal(row.cost, 1900);
  assert.equal(store.inventory[0].stockValue, 1900);
  s.offset(store, owner, {
    sourceId: row.entryId,
    targetId: p.supplierEntryId,
    amount: 1900,
  });
  assert.equal(s.balances(store, p.supplierId).payable, 2100);
  assert.throws(
    () =>
      s.refund(store, owner, {
        sourceId: row.entryId,
        amount: 1,
        account: "微信",
      }),
    /超过/,
  );
  assert.throws(
    () =>
      costs.returnPurchase(store, owner, {
        ...row,
        reference: "RETURN-2",
        confirmed: true,
      }),
    /串码/,
  );
  assert.equal(store.receipts.length, 0);
});
test("预付、分批到货与订货终止不虚增库存，旧账迁移不重复现金", () => {
  const store = fixture();
  const plan = s.plan(store, owner, {
    supplier: "甲",
    items: [{ skuId: "part", quantity: 10, costPrice: 100 }],
    paidAmount: 1000,
    account: "银行卡",
  });
  assert.equal(store.inventory[1].quantity, 0);
  const p = buy(store, "part", 6, 100, {
    supplierId: plan.supplierId,
    planId: plan.id,
    receiptToken: s.planRows(store, owner)[0].receiptToken,
    items: [
      {
        skuId: "part",
        planItemId: plan.items[0].id,
        quantity: 6,
        costPrice: 100,
      },
    ],
  });
  assert.deepEqual(s.balances(store, p.supplierId), {
    payable: 0,
    cash: 0,
    advance: 400,
    credit: 0,
  });
  assert.equal(plan.items[0].received, 6);
  s.closePlan(store, owner, { id: plan.id, reason: "余货取消" });
  assert.equal(store.receipts.length, 1);
  const legacy = fixture();
  legacy.purchases.push({
    id: "old-1",
    supplier: "旧供货方",
    amount: 1000,
    paidAmount: 400,
    items: [],
    createdAt: c.now(),
  });
  s.upgrade(legacy);
  s.upgrade(legacy);
  assert.equal(legacy.supplierEntries.length, 2);
  assert.equal(legacy.receipts.length, 0);
  assert.equal(s.balances(legacy, legacy.suppliers[0].id).payable, 600);
});
test("订货收货自动抵本单预付款，分批和实际进价变化不重复付款", () => {
  const store = fixture();
  const plan = s.plan(store, owner, {
    supplier: "自动抵用测试",
    items: [{ skuId: "part", quantity: 10, costPrice: 1000 }],
    paidAmount: 3000,
    account: "微信",
  });
  const other = s.plan(store, owner, {
    supplierId: plan.supplierId,
    items: [{ skuId: "part", quantity: 1, costPrice: 5000 }],
    paidAmount: 5000,
    account: "微信",
  });
  s.payment(store, owner, {
    supplierId: plan.supplierId,
    amount: 700,
    account: "现金",
  });
  const cashBefore = structuredClone(store.supplierCash);
  const receive = (quantity, price = 1000, user = warehouse) =>
    erp.purchase(store, user, {
      supplierId: plan.supplierId,
      planId: plan.id,
      receiptToken: s.planRows(store, user).find((p) => p.id === plan.id)
        .receiptToken,
      items: [
        {
          skuId: "part",
          planItemId: plan.items[0].id,
          quantity,
          costPrice: price,
        },
      ],
    });
  assert.equal(store.supplierEntries[0].planId, plan.id);
  assert.equal(s.planRows(store, warehouse)[0].prepayment, undefined);
  assert.equal(s.planRows(store, owner)[0].prepayment.availableAmount, 3000);
  const first = receive(2);
  assert.equal(
    s.purchaseRows(store, owner).find((p) => p.id === first.id).outstanding,
    0,
  );
  assert.equal(s.planRows(store, owner)[0].prepayment.availableAmount, 1000);
  const second = receive(8, 1100);
  assert.equal(
    s.purchaseRows(store, owner).find((p) => p.id === second.id).outstanding,
    7800,
  );
  assert.equal(
    s.planRows(store, owner).find((p) => p.id === other.id).prepayment
      .availableAmount,
    5000,
  );
  assert.equal(s.balances(store, plan.supplierId).advance, 5700);
  assert.deepEqual(store.supplierCash, cashBefore);
  assert.equal(store.receipts.length, 3);
  assert.equal(store.supplierSettlements.filter((r) => r.automatic).length, 2);
  s.payment(store, owner, {
    orderId: second.id,
    amount: 7800,
    account: "银行卡",
  });
  assert.equal(s.balances(store, plan.supplierId).payable, 0);
});

test("旧订货预付款只补可核对的原关联，退款后收货不使用过期余额", () => {
  const store = fixture();
  const plan = s.plan(store, owner, {
    supplier: "历史预付测试",
    items: [{ skuId: "part", quantity: 1, costPrice: 1556 }],
    paidAmount: 1556,
    account: "微信",
  });
  const paid = store.supplierEntries[0];
  delete paid.planId;
  delete store.supplierCash[0].planId;
  store.supplierModelVersion = 1;
  s.upgrade(store);
  s.upgrade(store);
  assert.equal(paid.planId, plan.id);
  assert.equal(store.supplierEntries.length, 1);
  assert.equal(store.supplierCash.length, 1);
  const data = {
    supplierId: plan.supplierId,
    planId: plan.id,
    receiptToken: s.planRows(store, owner)[0].receiptToken,
    items: [
      {
        skuId: "part",
        planItemId: plan.items[0].id,
        quantity: 1,
        costPrice: 1556,
      },
    ],
  };
  s.refund(store, owner, { sourceId: paid.id, amount: 556, account: "微信" });
  assert.throws(() => erp.purchase(store, owner, data), /刷新/);
  assert.equal(store.purchases.length, 0);
  assert.equal(store.inventory[1].quantity, 0);
  data.receiptToken = s.planRows(store, owner)[0].receiptToken;
  erp.purchase(store, owner, data);
  assert.equal(s.balances(store, plan.supplierId).payable, 556);
  assert.equal(s.balances(store, plan.supplierId).advance, 0);
  assert.equal(store.receipts.length, 2);

  const unrelated = fixture();
  const pending = s.plan(unrelated, owner, {
    supplier: "不可猜测归属",
    items: [{ skuId: "part", quantity: 1, costPrice: 100 }],
  });
  s.payment(unrelated, owner, {
    supplierId: pending.supplierId,
    amount: 100,
    account: "微信",
    note: "订货预付款",
  });
  s.upgrade(unrelated);
  assert.equal(unrelated.supplierEntries[0].planId, undefined);
  assert.equal(s.planRows(unrelated, owner)[0].prepayment.availableAmount, 0);
});

test("订货未预付、已付清和多预付均可收货，剩余预付款不自动退款", () => {
  for (const [prepaid, due, left] of [
    [0, 1556, 0],
    [1556, 0, 0],
    [2000, 0, 444],
  ]) {
    const store = fixture();
    const plan = s.plan(store, owner, {
      supplier: "收货结款测试",
      items: [{ skuId: "part", quantity: 1, costPrice: 1556 }],
      paidAmount: prepaid,
      account: "微信",
    });
    erp.purchase(store, warehouse, {
      supplierId: plan.supplierId,
      planId: plan.id,
      receiptToken: s.planRows(store, warehouse)[0].receiptToken,
      items: [
        {
          skuId: "part",
          planItemId: plan.items[0].id,
          quantity: 1,
          costPrice: 1556,
        },
      ],
    });
    assert.equal(store.inventory[1].quantity, 1);
    assert.equal(s.balances(store, plan.supplierId).payable, due);
    assert.equal(s.balances(store, plan.supplierId).advance, left);
    assert.equal(store.receipts.length, prepaid ? 1 : 0);
  }
});
test("四类期初、仅抵额度、不同主体限制及撤销抵扣保留对账历史", () => {
  const store = fixture();
  const sup = s.save(store, owner, { name: "甲" });
  s.opening(store, owner, {
    supplierId: sup.id,
    date: "2025-01-01",
    note: "双方期初确认",
    payable: 4000,
    cash: 6000,
    advance: 500,
    credit: 200,
  });
  const due = store.supplierEntries.find((e) => e.kind === "payable");
  const cash = store.supplierEntries.find((e) => e.kind === "cash");
  const credit = store.supplierEntries.find((e) => e.kind === "credit");
  const match = s.offset(store, owner, {
    sourceId: cash.id,
    targetId: due.id,
    amount: 4000,
  });
  assert.equal(s.balances(store, sup.id).cash, 2000);
  assert.throws(
    () =>
      s.refund(store, owner, {
        sourceId: credit.id,
        amount: 100,
        account: "微信",
      }),
    /不能/,
  );
  const p = buy(store, "part", 1, 100, { supplier: "乙" });
  assert.throws(
    () =>
      s.offset(store, owner, {
        sourceId: credit.id,
        targetId: p.supplierEntryId,
        amount: 100,
      }),
    /同一/,
  );
  s.reverseOffset(store, owner, {
    id: match.id,
    reason: "双方重新选择抵扣款项",
  });
  assert.equal(s.balances(store, sup.id).payable, 4000);
  const statement = s.statement(store, owner, sup.id, "2025-01-01", c.day());
  assert.equal(statement.rows.filter((r) => r.type === "撤销抵扣").length, 1);
  assert.deepEqual(statement.closing, s.balances(store, sup.id));
  assert.equal(store.receipts.length, 0);
  assert.throws(
    () => s.opening(store, owner, { supplierId: sup.id }),
    /已登记/,
  );
});
test("HTTP供应商鉴权、重试幂等、过量付款分配事务回滚", async () => {
  repo.resetStore(fixture());
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  async function req(path, data, token, key) {
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
    const token = (await req("/api/auth/login", { userId: "owner" })).body
      .token;
    const staffToken = (await req("/api/auth/login", { userId: "staff" })).body
      .token;
    const mgrToken = (await req("/api/auth/login", { userId: "mgr" })).body
      .token;
    const whToken = (await req("/api/auth/login", { userId: "wh" })).body.token;
    assert.equal((await req("/api/suppliers", null, staffToken)).status, 403);
    assert.equal((await req("/api/suppliers", null, whToken)).status, 403);
    assert.equal(
      (await req("/api/supplier-payments", { amount: 1 }, mgrToken, "deny"))
        .status,
      403,
    );
    const payload = {
      supplier: "隔离测试",
      items: [{ skuId: "part", quantity: 2, costPrice: 10 }],
    };
    const p = (await req("/api/purchase-orders", payload, whToken, "buy")).body;
    const data = {
      supplierId: p.supplierId,
      amount: 20,
      account: "微信",
      allocations: [{ targetId: p.supplierEntryId, amount: 20 }],
    };
    assert.equal(
      (await req("/api/supplier-payments", data, token, "pay")).status,
      200,
    );
    assert.equal(
      (await req("/api/supplier-payments", data, token, "pay")).status,
      200,
    );
    assert.equal(repo.readStore().supplierCash.length, 1);
    const before = JSON.stringify(repo.readStore());
    assert.equal(
      (
        await req(
          "/api/supplier-payments",
          { ...data, amount: 30 },
          token,
          "bad",
        )
      ).status,
      409,
    );
    assert.equal(JSON.stringify(repo.readStore()), before);
    assert.equal(
      (
        await req(
          "/api/purchase-orders",
          { ...payload, paidAmount: 20 },
          whToken,
          "wh-deny",
        )
      ).status,
      403,
    );
    const plan = (
      await req(
        "/api/procurement-plans",
        {
          supplierId: p.supplierId,
          paidAmount: 30,
          account: "微信",
          items: [{ skuId: "part", quantity: 2, costPrice: 10 }],
        },
        token,
        "plan-prepay",
      )
    ).body;
    const whPlan = (
      await req("/api/procurement-plans", null, whToken)
    ).body.find((r) => r.id === plan.id);
    assert.equal(whPlan.prepayment, undefined);
    assert.equal(
      (await req("/api/procurement-plans", null, mgrToken)).body[0].prepayment
        .availableAmount,
      30,
    );
    const receiving = {
      supplierId: p.supplierId,
      planId: plan.id,
      receiptToken: whPlan.receiptToken,
      items: [
        {
          skuId: "part",
          planItemId: plan.items[0].id,
          quantity: 2,
          costPrice: 10,
        },
      ],
    };
    for (const bad of [
      { paidAmount: 20 },
      { advanceAmount: 20 },
      { advanceId: "manual-source" },
      { receiptToken: "old" },
    ]) {
      const snapshot = JSON.stringify(repo.readStore());
      const result = await req(
        "/api/purchase-orders",
        { ...receiving, ...bad },
        token,
        "bad-receive-" + Object.keys(bad)[0],
      );
      assert.ok([400, 409].includes(result.status));
      assert.equal(JSON.stringify(repo.readStore()), snapshot);
    }
    const beforeOverReceipt = JSON.stringify(repo.readStore());
    assert.equal(
      (
        await req(
          "/api/purchase-orders",
          { ...receiving, items: [{ ...receiving.items[0], quantity: 3 }] },
          whToken,
          "too-many",
        )
      ).status,
      409,
    );
    assert.equal(JSON.stringify(repo.readStore()), beforeOverReceipt);
    const cashSnapshot = structuredClone(repo.readStore().supplierCash);
    const received = await req(
      "/api/purchase-orders",
      receiving,
      whToken,
      "receive-plan",
    );
    assert.equal(received.status, 200);
    assert.deepEqual(
      (await req("/api/purchase-orders", receiving, whToken, "receive-plan"))
        .body,
      received.body,
    );
    assert.deepEqual(repo.readStore().supplierCash, cashSnapshot);
    assert.equal(
      repo.readStore().supplierSettlements.filter((r) => r.automatic).length,
      1,
    );
    assert.equal(s.balances(repo.readStore(), p.supplierId).advance, 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("付款分配可撤销而不伪造退款；仓管看不到结款余额；混合库存不能掩盖单批负成本", () => {
  const store = fixture();
  const p = buy(store, "part", 10, 100, { paidAmount: 500 });
  const allocation = store.supplierSettlements.find(
    (a) => a.type === "payment",
  );
  s.reverseOffset(store, owner, {
    id: allocation.id,
    reason: "款项改抵另一张单",
  });
  assert.equal(s.balances(store, p.supplierId).advance, 500);
  assert.equal(s.balances(store, p.supplierId).payable, 1000);
  assert.equal(store.receipts.length, 1);
  assert.equal(s.purchaseRows(store, warehouse)[0].paidAmount, undefined);
  assert.equal(s.purchaseRows(store, warehouse)[0].outstanding, undefined);
  buy(store, "part", 10, 500, { supplier: "乙" });
  assert.throws(
    () => costs.preview(store, owner, pricePayload(p, { unitAmount: 110 })),
    /超过该批次/,
  );
  assert.throws(
    () =>
      s.plan(store, owner, {
        supplier: "甲供应商",
        paidAmount: -1,
        items: [{ skuId: "part", quantity: 1, costPrice: 10 }],
      }),
    /不正确/,
  );
  const row = s.statement(store, owner, p.supplierId, c.day(), c.day());
  assert.ok(row.rows.some((r) => r.type === "撤销付款分配"));
});
