const c = require("./common");
const pay = require("./payroll");
const legacy = require("./services");
const suppliers = require("./suppliers");
const supplierCosts = require("./supplier-costs");

function product(store, skuId) {
  const p = store.products.find((p) => p.skuId === skuId);
  if (!p) throw new c.HttpError(404, "商品不存在");
  return p;
}
function stock(store, skuId, warehouseId = "wh-sale") {
  const result = store.inventory.find(
    (s) => s.skuId === skuId && (s.warehouseId || "wh-sale") === warehouseId,
  );
  if (!result) throw new c.HttpError(409, "该地点没有此商品库存");
  result.serials ||= [];
  result.costPrice ??= product(store, skuId).costPrice || 0;
  result.stockValue ??= c.round(result.quantity * result.costPrice);
  return result;
}
function move(store, user, p, s, qty, cost, type, sourceId) {
  store.movements.unshift({
    id: c.id("MV"),
    skuId: p.skuId,
    product: p.name,
    warehouseId: s.warehouseId || "wh-sale",
    warehouseName: s.warehouseName || "销售仓",
    quantity: qty,
    cost,
    type,
    sourceId,
    operatorId: user.id,
    operator: user.name,
    createdAt: c.now(),
  });
}
function receipt(store, user, kind, sourceId, amount, account) {
  if (!amount) return;
  store.receipts.push({
    id: c.id("RC"),
    kind,
    sourceId,
    amount: c.round(amount),
    account: c.text(account, "收付款方式"),
    operatorId: user.id,
    createdAt: c.now(),
  });
}
function selectedUser(store, user, userId) {
  if (!userId || userId === user.id) return user;
  if (!["owner", "manager"].includes(user.roleCode))
    throw new c.HttpError(403, "不能代其他员工开单");
  const selected = c.userById(store, userId);
  c.permit(selected, "sell");
  return selected;
}
function listProducts(store, user) {
  const caps = c.capabilities(user);
  return store.products.map((p) => {
    const result = {
      ...p,
      categoryText: [p.type, p.subType, p.thirdType]
        .filter(Boolean)
        .join(" / "),
    };
    if (!caps.cost) {
      delete result.costPrice;
      delete result.referenceCostPrice;
    }
    return result;
  });
}
function inventory(store, user) {
  const caps = c.capabilities(user);
  const result = store.inventory.map((s) => {
    const p = product(store, s.skuId);
    return {
      ...p,
      ...s,
      stockKey: `${p.skuId}-${s.warehouseId || "wh-sale"}`,
      costPrice: s.costPrice ?? p.costPrice,
      serials: s.serials || [],
      warehouseId: s.warehouseId || "wh-sale",
      warehouseName: s.warehouseName || "销售仓",
    };
  });
  store.products
    .filter((p) => p.stockManaged === false)
    .forEach((p) =>
      result.push({
        ...p,
        quantity: null,
        serials: [],
        stockKey: `${p.skuId}-service`,
        warehouseId: "",
        warehouseName: "服务项目",
      }),
    );
  return result.map((s) => {
    if (!caps.cost) {
      delete s.costPrice;
      delete s.stockValue;
      delete s.referenceCostPrice;
      delete s.costSources;
      s.serials = s.serials.map(({ costPrice, ...serial }) => serial);
    }
    return s;
  });
}
function saveProduct(store, user, payload) {
  c.permit(user, "manageProducts");
  const existing = payload.skuId ? product(store, payload.skuId) : null;
  const stockManaged = payload.kind !== "service";
  const trackSerial = stockManaged && Boolean(payload.trackSerial);
  if (
    existing &&
    ((existing.stockManaged !== false) !== stockManaged ||
      Boolean(existing.trackSerial) !== trackSerial) &&
    (store.inventory.some((s) => s.skuId === existing.skuId && s.quantity) ||
      store.movements.some((m) => m.skuId === existing.skuId))
  )
    throw new c.HttpError(409, "已有库存或出入库记录，不能改变库存管理方式");
  const externalCode = c.text(payload.externalCode, "商品编号");
  if (
    store.products.some(
      (p) => p.externalCode === externalCode && p !== existing,
    )
  )
    throw new c.HttpError(409, "商品编号已存在");
  const result = {
    ...(existing || {}),
    skuId: existing ? existing.skuId : c.id("SKU"),
    externalCode,
    name: c.text(payload.name, "商品名称"),
    shortName: payload.shortName || "",
    type: c.text(payload.type, "分类"),
    subType: payload.subType || "",
    unit: payload.unit || (stockManaged ? "件" : "项"),
    stockManaged,
    trackSerial,
    salePrice: c.money(payload.salePrice, "预设售价"),
    costPrice: existing?.costPrice || 0,
    active: payload.active !== false,
  };
  if (existing) Object.assign(existing, result);
  else store.products.push(result);
  if (stockManaged && !store.inventory.some((s) => s.skuId === result.skuId))
    store.inventory.push({
      skuId: result.skuId,
      warehouseId: "wh-sale",
      warehouseName: "销售仓",
      quantity: 0,
      costPrice: 0,
      stockValue: 0,
      serials: [],
    });
  c.audit(store, user, "product:save", `保存商品 ${result.name}`);
  return result;
}
function purchase(store, user, payload) {
  c.permit(user, "purchase");
  if (!Array.isArray(payload.items) || !payload.items.length)
    throw new c.HttpError(400, "请选择入库商品");
  const orderId = c.id("PO");
  const supplier = suppliers.resolve(store, user, payload);
  suppliers.validatePlanReceipt(store, supplier, payload);
  if (Number(payload.paidAmount) > 0 || Number(payload.advanceAmount) > 0)
    c.permit(user, "supplierSettle");
  const items = payload.items.map((input) => {
    const p = product(store, input.skuId);
    if (p.stockManaged === false)
      throw new c.HttpError(400, "服务商品不采购入库");
    const s = stock(store, p.skuId);
    const qty = c.quantity(input.quantity);
    const itemId = c.id("PI");
    const costPrice = c.money(input.costPrice, "实际进价");
    const serials = (input.serials || []).map((x) => c.text(x, "串码"));
    if (p.trackSerial && serials.length !== qty)
      throw new c.HttpError(400, "串码数量必须与入库数量一致");
    if (
      new Set(serials).size !== serials.length ||
      serials.some((no) =>
        store.inventory.some((row) =>
          (row.serials || []).some((x) => x.no === no),
        ),
      )
    )
      throw new c.HttpError(409, "串码重复，请核对");
    if (!p.trackSerial) supplierCosts.receive(s, itemId, qty);
    const value = c.round(s.stockValue + qty * costPrice);
    s.quantity += qty;
    s.stockValue = value;
    s.costPrice = Number((value / s.quantity).toFixed(6));
    serials.forEach((no) =>
      s.serials.push({
        no,
        status: "可售",
        costPrice,
        purchaseId: orderId,
        purchaseItemId: itemId,
      }),
    );
    move(store, user, p, s, qty, qty * costPrice, "采购入库", orderId);
    return {
      id: itemId,
      skuId: p.skuId,
      name: p.name,
      quantity: qty,
      costPrice,
      serials,
    };
  });
  const amount = c.round(
    items.reduce((n, i) => n + i.quantity * i.costPrice, 0),
  );
  const order = {
    id: orderId,
    supplier: supplier.name,
    supplierId: supplier.id,
    items,
    amount,
    paidAmount: 0,
    operatorId: user.id,
    operator: user.name,
    createdAt: c.now(),
  };
  store.purchases.unshift(order);
  suppliers.receivePlan(store, order, payload);
  suppliers.registerPurchase(store, user, order, {
    ...payload,
    account: payload.account || "微信",
  });
  c.audit(store, user, "purchase:create", order.id);
  return order;
}
function deduct(store, user, p, input, orderId, type) {
  const s = stock(store, p.skuId);
  const qty = c.quantity(input.quantity);
  if (s.quantity < qty) throw new c.HttpError(409, `${p.name} 库存不足`);
  let costPrice = s.costPrice;
  let serialNo = "";
  let costSources = [];
  if (p.trackSerial) {
    if (qty !== 1) throw new c.HttpError(400, "串码商品请逐件添加");
    serialNo = c.text(input.serialNo, "串码");
    const serial = s.serials.find(
      (x) => x.no === serialNo && ["可售", "未激活"].includes(x.status),
    );
    if (!serial) throw new c.HttpError(409, "该串码已售或不在可售库存");
    costPrice = serial.costPrice ?? s.costPrice;
    serial.status = "已售";
  } else {
    costSources = supplierCosts.take(s, qty);
  }
  const cost = qty === s.quantity ? s.stockValue : c.round(costPrice * qty);
  s.quantity -= qty;
  s.stockValue = s.quantity ? c.round(s.stockValue - cost) : 0;
  if (s.quantity) s.costPrice = Number((s.stockValue / s.quantity).toFixed(6));
  move(store, user, p, s, -qty, -cost, type, orderId);
  return {
    skuId: p.skuId,
    name: p.name,
    quantity: qty,
    costPrice,
    cost,
    serialNo,
    costSources,
  };
}
function sale(store, user, payload) {
  c.permit(user, "sell");
  const salesperson = selectedUser(store, user, payload.salespersonId);
  if (!Array.isArray(payload.items) || !payload.items.length)
    throw new c.HttpError(400, "请选择销售商品");
  const order = {
    id: c.id("SO"),
    createdAt: c.now(),
    operatorId: user.id,
    operator: user.name,
    salespersonId: salesperson.id,
    salesperson: salesperson.name,
    status: "completed",
    paymentMethod: payload.account || "微信",
  };
  order.items = payload.items.map((input) => {
    const p = product(store, input.skuId);
    if (p.active === false) throw new c.HttpError(409, "该商品已停用");
    const qty = c.quantity(input.quantity);
    const salePrice = c.money(input.salePrice, "售价");
    let cost = 0;
    let serialNo = "";
    let materials = [];
    let costSources = [];
    if (p.stockManaged !== false) {
      const taken = deduct(store, user, p, input, order.id, "销售出库");
      cost = taken.cost;
      serialNo = taken.serialNo;
      costSources = taken.costSources;
    } else {
      materials = (input.materials || []).map((m) => {
        const material = product(store, m.skuId);
        if (material.stockManaged === false)
          throw new c.HttpError(400, "耗材必须是实物商品");
        return deduct(store, user, material, m, order.id, "维修耗材");
      });
      if (p.type === "维修" && !materials.length && !input.noMaterials)
        throw new c.HttpError(400, "请选择本次耗材，或确认无耗材");
      cost = c.round(materials.reduce((n, m) => n + m.cost, 0));
    }
    const amount = c.round(qty * salePrice);
    return {
      id: c.id("SI"),
      skuId: p.skuId,
      name: p.name,
      externalCode: p.externalCode || "",
      type: p.type,
      subType: p.subType || "",
      quantity: qty,
      returnedQuantity: 0,
      stockManaged: p.stockManaged !== false,
      trackSerial: p.trackSerial,
      serialNo,
      salePrice,
      amount,
      cost,
      costPrice: cost / qty,
      profit: c.round(amount - cost),
      materials,
      costSources,
      note: input.note || "",
    };
  });
  order.amount = c.round(order.items.reduce((s, i) => s + i.amount, 0));
  order.profit = c.round(order.items.reduce((s, i) => s + i.profit, 0));
  order.receivedAmount = order.amount;
  store.sales.unshift(order);
  receipt(store, user, "sale", order.id, order.amount, order.paymentMethod);
  order.items.forEach((item, index) => {
    if (
      salesperson.roleCode !== "owner" ||
      store.salaryRates.some((r) => r.employeeId === salesperson.id)
    )
      pay.accrue(store, order, item);
    if (item.type === "号卡") {
      const data = payload.items[index].card || {};
      store.cardBusinesses.unshift({
        id: c.id("CARD"),
        orderId: order.id,
        itemId: item.id,
        productName: item.name,
        employeeId: salesperson.id,
        employeeName: salesperson.name,
        carrier: data.carrier || "",
        packageName: data.packageName || item.name,
        cardNo: data.cardNo || item.serialNo,
        expected: c.money(data.expected || 0, "预计佣金"),
        confirmed: 0,
        received: 0,
        createdAt: order.createdAt,
      });
    }
  });
  c.audit(store, user, "sale:create", order.id);
  return visibleOrder(order, user);
}
function visibleOrder(order, user) {
  const result = JSON.parse(JSON.stringify(order));
  if (!c.capabilities(user).profit) {
    delete result.profit;
    (result.items || []).forEach((i) => {
      delete i.profit;
      delete i.cost;
      delete i.costPrice;
      delete i.costSources;
      (i.materials || []).forEach((m) => {
        delete m.cost;
        delete m.costPrice;
        delete m.costSources;
      });
    });
  }
  return result;
}
function orders(store, user, query = "") {
  return store.sales
    .filter(
      (o) =>
        c.capabilities(user).allSales ||
        (o.salespersonId || o.operatorId) === user.id,
    )
    .filter((o) =>
      `${o.id} ${o.salesperson || o.operator} ${o.items.map((i) => `${i.name} ${i.serialNo || ""}`).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .map((o) => {
      const result = visibleOrder(o, user);
      if (c.capabilities(user).profit) {
        result.costAdjustments = store.costAdjustments.filter(
          (a) => a.orderId === o.id,
        );
        result.costAdjustment = c.round(
          result.costAdjustments.reduce((n, a) => n + a.costDelta, 0),
        );
        result.adjustedProfit = c.round(o.profit - result.costAdjustment);
      }
      return result;
    });
}
function returnSale(store, user, payload) {
  c.permit(user, "returnSale");
  const order = store.sales.find((o) => o.id === payload.orderId);
  if (!order) throw new c.HttpError(404, "原销售单不存在");
  if (!Array.isArray(payload.items) || !payload.items.length)
    throw new c.HttpError(400, "请选择退货明细");
  const row = {
    id: c.id("SR"),
    orderId: order.id,
    createdAt: c.now(),
    operatorId: user.id,
    operator: user.name,
    salespersonId: order.salespersonId || order.operatorId,
    reason: c.text(payload.reason, "退货原因"),
    items: [],
  };
  row.items = payload.items.map((input) => {
    const item = order.items.find((i) => i.id === input.itemId);
    if (!item) throw new c.HttpError(404, "退货商品不存在");
    const qty = c.quantity(input.quantity);
    const previouslyReturned = item.returnedQuantity || 0;
    const totalReturned = previouslyReturned + qty;
    if (totalReturned > item.quantity)
      throw new c.HttpError(409, "退货数量超过可退数量");
    item.returnedQuantity = totalReturned;
    const amount = c.round(item.salePrice * qty);
    const cost = item.stockManaged
      ? c.round(
          c.round((item.cost * totalReturned) / item.quantity) -
            c.round((item.cost * previouslyReturned) / item.quantity),
        )
      : 0;
    if (item.stockManaged) {
      const p = product(store, item.skuId);
      const s = stock(store, item.skuId);
      const previousValue = s.stockValue;
      const costDelta = supplierCosts.restoreSaleCost(
        store,
        user,
        order,
        item,
        qty,
        previouslyReturned,
        row.id,
      );
      if (!item.serialNo)
        supplierCosts.restore(s, item.costSources, qty / item.quantity, qty);
      s.quantity += qty;
      s.stockValue = c.round(previousValue + cost + costDelta);
      s.costPrice = Number((s.stockValue / s.quantity).toFixed(6));
      if (item.serialNo) {
        const serial = s.serials.find((x) => x.no === item.serialNo);
        if (!serial || serial.status !== "已售")
          throw new c.HttpError(409, "串码状态与退货不一致");
        serial.status = "可售";
      }
      move(store, user, p, s, qty, cost + costDelta, "销售退货", row.id);
    }
    pay.reverse(store, order, item, qty, totalReturned, row.id, row.createdAt);
    return {
      itemId: item.id,
      skuId: item.skuId,
      name: item.name,
      type: item.type,
      quantity: qty,
      amount,
      cost,
      profit: c.round(amount - cost),
    };
  });
  row.amount = c.round(row.items.reduce((s, i) => s + i.amount, 0));
  row.profit = c.round(row.items.reduce((s, i) => s + i.profit, 0));
  store.saleReturns.unshift(row);
  order.status = order.items.every((i) => i.returnedQuantity === i.quantity)
    ? "returned"
    : "partial_return";
  receipt(
    store,
    user,
    "refund",
    row.id,
    -row.amount,
    payload.account || order.paymentMethod,
  );
  c.audit(store, user, "sale:return", `${order.id} 退货 ${row.amount}`);
  return row;
}
function cardEvent(store, user, payload) {
  c.permit(user, "finance");
  const business = store.cardBusinesses.find(
    (b) => b.id === payload.businessId,
  );
  if (!business) throw new c.HttpError(404, "号卡业务不存在");
  const amount = c.money(payload.amount);
  const event = {
    id: c.id("CE"),
    businessId: business.id,
    type: payload.type,
    amount,
    note: payload.note || "",
    createdAt: c.now(),
    operatorId: user.id,
  };
  if (event.type === "confirm")
    business.confirmed = c.round(business.confirmed + amount);
  else if (event.type === "receive") {
    if (business.received + amount > business.confirmed + 0.001)
      throw new c.HttpError(409, "到账金额超过已确认的待收佣金");
    business.received = c.round(business.received + amount);
    receipt(
      store,
      user,
      "carrier",
      event.id,
      amount,
      payload.account || "银行卡",
    );
  } else if (event.type === "adjust") {
    if (amount > business.confirmed - business.received + 0.001)
      throw new c.HttpError(409, "调整不能超过未到账佣金");
    business.confirmed = c.round(business.confirmed - amount);
  } else if (event.type === "clawback") {
    if (amount > business.received)
      throw new c.HttpError(409, "扣回不能超过已到账佣金");
    business.received = c.round(business.received - amount);
    business.confirmed = c.round(business.confirmed - amount);
    receipt(
      store,
      user,
      "carrier_clawback",
      event.id,
      -amount,
      payload.account || "银行卡",
    );
  } else throw new c.HttpError(400, "佣金操作不正确");
  store.cardEvents.push(event);
  c.audit(
    store,
    user,
    "carrier:event",
    `${business.productName} ${event.type} ${amount}`,
  );
  return business;
}
function cards(store, user) {
  const rows = store.cardBusinesses.filter(
    (b) => c.capabilities(user).finance || b.employeeId === user.id,
  );
  return {
    canManage: c.capabilities(user).finance,
    rows: rows.map((b) => ({
      ...b,
      outstanding: c.round(b.confirmed - b.received),
      events: store.cardEvents.filter((e) => e.businessId === b.id),
    })),
  };
}
function stocktake(store, user, payload) {
  c.permit(user, "stocktake");
  const p = product(store, payload.skuId);
  if (p.stockManaged === false || p.trackSerial)
    throw new c.HttpError(400, "此入口适用于按数量管理的实物商品");
  const s = stock(store, p.skuId);
  const actual = c.number(payload.actual, "实盘数量");
  if (!Number.isSafeInteger(actual))
    throw new c.HttpError(400, "实盘数量必须为整数");
  if (s.quantity !== Number(payload.expected))
    throw new c.HttpError(409, "盘点期间库存有变化，请刷新后重新核对");
  const delta = actual - s.quantity;
  const result = {
    id: c.id("ST"),
    skuId: p.skuId,
    product: p.name,
    expected: s.quantity,
    actual,
    delta,
    reason: c.text(payload.reason, "盘点说明"),
    createdAt: c.now(),
    operatorId: user.id,
  };
  s.quantity = actual;
  if (delta)
    s.costSources = actual ? [{ sourceId: "untraced", quantity: actual }] : [];
  s.stockValue = c.round(s.quantity * s.costPrice);
  store.stocktakes.unshift(result);
  move(
    store,
    user,
    p,
    s,
    delta,
    c.round(delta * s.costPrice),
    "盘点调整",
    result.id,
  );
  c.audit(store, user, "stock:count", `${p.name} ${delta}`);
  return result;
}
function expense(store, user, payload) {
  c.permit(user, "finance");
  const row = {
    id: c.id("EX"),
    type: c.text(payload.type, "费用名称"),
    amount: c.money(payload.amount),
    operatorId: user.id,
    operator: user.name,
    createdAt: c.now(),
  };
  store.expenses.push(row);
  receipt(
    store,
    user,
    "expense",
    row.id,
    -row.amount,
    payload.account || "现金",
  );
  c.audit(store, user, "expense:create", row.type);
  return row;
}
function finance(store, user) {
  c.permit(user, "finance");
  const supplierData = c.capabilities(user).supplierView
    ? suppliers.list(store, user)
    : { rows: [], totals: {} };
  return {
    receipts: store.receipts.slice().reverse(),
    expenses: store.expenses.slice().reverse(),
    suppliers: supplierData.rows,
    supplierTotals: supplierData.totals,
    purchases: [],
    payable: supplierData.totals.payable || 0,
  };
}
function paySupplier(store, user, payload) {
  return suppliers.payment(store, user, {
    ...payload,
    account: payload.account || "微信",
  });
}
function report(store, user, date = c.day()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new c.HttpError(400, "日期不正确");
  const caps = c.capabilities(user);
  const owned = (o) =>
    caps.allSales || (o.salespersonId || o.operatorId) === user.id;
  const sales = store.sales.filter(
    (o) => owned(o) && c.day(o.createdAt) === date,
  );
  const returns = store.saleReturns.filter(
    (o) => owned(o) && c.day(o.createdAt) === date,
  );
  const dayReceipts = store.receipts.filter(
    (r) =>
      (r.transactionDate || c.day(r.createdAt)) === date &&
      (caps.finance ||
        sales.some((o) => o.id === r.sourceId) ||
        returns.some((o) => o.id === r.sourceId)),
  );
  const salesAmount = c.round(sales.reduce((s, o) => s + o.amount, 0));
  const returnAmount = c.round(returns.reduce((s, o) => s + o.amount, 0));
  const grossProfit = c.round(
    sales.reduce((s, o) => s + o.profit, 0) -
      returns.reduce((s, o) => s + o.profit, 0),
  );
  const sumReceipts = (kind) =>
    c.round(
      dayReceipts
        .filter((r) => r.kind === kind)
        .reduce((s, r) => s + r.amount, 0),
    );
  const expenseAmount = -sumReceipts("expense");
  const costAdjustmentProfit = -c.round(
    store.costAdjustments
      .filter((a) => a.orderId && c.day(a.createdAt) === date)
      .reduce((n, a) => n + a.costDelta, 0),
  );
  const categoryMap = new Map();
  for (const [source, sign] of [
    [sales, 1],
    [returns, -1],
  ])
    for (const order of source)
      for (const item of order.items) {
        const name = item.type || "其他";
        const row = categoryMap.get(name) || {
          category: name,
          quantity: 0,
          salesAmount: 0,
          grossProfit: 0,
        };
        row.quantity += sign * item.quantity;
        row.salesAmount = c.round(
          row.salesAmount +
            sign * (item.amount ?? item.quantity * item.salePrice),
        );
        row.grossProfit = caps.profit
          ? c.round(
              row.grossProfit +
                sign *
                  (item.profit ??
                    item.quantity * (item.salePrice - item.costPrice)),
            )
          : null;
        categoryMap.set(name, row);
      }
  const paymentMap = new Map();
  dayReceipts
    .filter((r) => ["sale", "refund"].includes(r.kind))
    .forEach((r) =>
      paymentMap.set(
        r.account,
        c.round((paymentMap.get(r.account) || 0) + r.amount),
      ),
    );
  const staffStats = store.users
    .filter((u) => caps.allSales || u.id === user.id)
    .map((u) => {
      const ownedSales = sales.filter(
        (o) => (o.salespersonId || o.operatorId) === u.id,
      );
      const ownedReturns = returns.filter((o) => o.salespersonId === u.id);
      return {
        id: u.id,
        name: u.name,
        orderCount: ownedSales.length,
        salesAmount: c.round(
          ownedSales.reduce((s, o) => s + o.amount, 0) -
            ownedReturns.reduce((s, o) => s + o.amount, 0),
        ),
      };
    });
  return {
    date,
    canViewProfit: caps.profit,
    summary: {
      salesAmount,
      returnAmount,
      netSales: c.round(salesAmount - returnAmount),
      grossProfit: caps.profit ? grossProfit : null,
      costAdjustmentProfit: caps.profit ? costAdjustmentProfit : null,
      adjustedGrossProfit: caps.profit
        ? c.round(grossProfit + costAdjustmentProfit)
        : null,
      supplierPaid: caps.supplierView
        ? -sumReceipts("supplier_payment") - sumReceipts("purchase")
        : null,
      supplierRefund: caps.supplierView ? sumReceipts("supplier_refund") : null,
      purchaseReturnDifference: caps.profit
        ? c.round(
            store.purchaseReturns
              .filter((r) => c.day(r.createdAt) === date)
              .reduce((n, r) => n + (r.amount - r.cost || 0), 0),
          )
        : null,
      receivedAmount: sumReceipts("sale"),
      refundAmount: -sumReceipts("refund"),
      expenseAmount,
      carrierReceived: c.round(
        sumReceipts("carrier") + sumReceipts("carrier_clawback"),
      ),
      orderCount: sales.length,
    },
    categoryStats: Array.from(categoryMap.values()),
    paymentStats: Array.from(paymentMap, ([paymentMethod, amount]) => ({
      paymentMethod,
      amount,
    })),
    staffStats,
    recentOrders: sales.slice(0, 12).map((o) => visibleOrder(o, user)),
    expenses: caps.finance
      ? store.expenses.filter((e) => c.day(e.createdAt) === date)
      : [],
  };
}
function openingLocked(store) {
  return [
    "sales",
    "purchases",
    "saleReturns",
    "purchaseReturns",
    "stocktakes",
    "payrollStatements",
    "cardEvents",
    "receipts",
    "expenses",
    "procurementPlans",
  ].some((key) => store[key].length > 0);
}
function openingRows(rows) {
  if (!Array.isArray(rows) || !rows.length)
    throw new c.HttpError(400, "期初建账明细不能为空");
  return rows.map((row, index) => {
    const label = "第" + (index + 2) + "行";
    const quantity = c.number(
      row.quantity ?? row["期初数量"],
      label + "期初数量",
    );
    if (!Number.isSafeInteger(quantity))
      throw new c.HttpError(400, label + "期初数量必须为整数");
    const costPrice = c.number(
      row.costPrice ?? row["成本均价"],
      label + "成本均价",
    );
    const salePrice = c.money(
      row.salePrice ?? row["预设售价"] ?? 0,
      label + "预设售价",
    );
    const warehouseName = row.warehouseName || row["仓库"] || "销售仓";
    if (!["销售仓", "服务项目"].includes(warehouseName))
      throw new c.HttpError(
        400,
        label + "仓库未映射到店内库存，请先核对仓库名称",
      );
    if (warehouseName === "服务项目" && quantity !== 0)
      throw new c.HttpError(400, label + "服务商品不能有期初库存数量");
    return { ...row, quantity, costPrice, salePrice, warehouseName };
  });
}
function openingPreview(store, user, rows) {
  c.permit(user, "opening");
  const copy = JSON.parse(JSON.stringify(store));
  if (openingLocked(store))
    throw new c.HttpError(
      409,
      "已有业务单据，不能重新期初建账；请使用商品维护或盘点",
    );
  const result = legacy.importOpeningBalance(copy, {
    rows: openingRows(rows),
    operatorId: user.id,
    source: "preview",
  });
  if (
    copy.products.some(
      (p) =>
        p.trackSerial &&
        copy.inventory.some((s) => s.skuId === p.skuId && s.quantity > 0),
    )
  )
    throw new c.HttpError(
      400,
      "期初表不含串码明细，请先按数量导入，串码商品通过入库逐件登记",
    );
  if (
    copy.inventory.some(
      (s) =>
        !Number.isSafeInteger(s.quantity) ||
        !Number.isFinite(s.costPrice) ||
        !Number.isFinite(s.stockValue),
    )
  )
    throw new c.HttpError(400, "库存数量或成本格式不正确");
  return {
    ...result,
    rows: copy.products.map((p) => ({
      ...p,
      quantity: copy.inventory.find((s) => s.skuId === p.skuId)?.quantity || 0,
    })),
    totalQuantity: copy.inventory.reduce((n, s) => n + s.quantity, 0),
    stockValue: c.round(copy.inventory.reduce((n, s) => n + s.stockValue, 0)),
    replacedProducts: store.products.length,
    replacedRules: store.commissionRules.length,
  };
}
function openingCommit(store, user, payload) {
  openingPreview(store, user, payload.rows);
  if (!payload.confirmed) throw new c.HttpError(400, "请先核对导入预览");
  const result = legacy.importOpeningBalance(store, {
    rows: openingRows(payload.rows),
    operatorId: user.id,
    source: payload.source || "excel",
  });
  store.commissionRules = [];
  return result;
}
module.exports = {
  listProducts,
  inventory,
  saveProduct,
  purchase,
  sale,
  orders,
  returnSale,
  cards,
  cardEvent,
  stocktake,
  expense,
  finance,
  paySupplier,
  report,
  openingPreview,
  openingLocked,
  openingCommit,
  visibleOrder,
};
