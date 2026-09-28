const { createHash } = require("crypto");
const c = require("./common");
const suppliers = require("./suppliers");
const precision = (n) => Number(n.toFixed(12));
function trace(stock) {
  if (!stock.costSources)
    stock.costSources = stock.quantity
      ? [{ sourceId: "untraced", quantity: stock.quantity }]
      : [];
  return stock.costSources;
}
function receive(stock, sourceId, quantity) {
  trace(stock).push({ sourceId, quantity });
}
function take(stock, quantity) {
  const sources = trace(stock);
  const result = sources.map((s) => ({
    sourceId: s.sourceId,
    quantity: precision((s.quantity * quantity) / stock.quantity),
  }));
  sources.forEach((s, i) => {
    s.quantity = precision(s.quantity - result[i].quantity);
  });
  stock.costSources = sources.filter((s) => s.quantity > 1e-9);
  return result;
}
function restore(stock, sources, fraction, quantity) {
  const existing = trace(stock);
  for (const source of sources || []) {
    const qty = precision(source.quantity * fraction);
    const found = existing.find((s) => s.sourceId === source.sourceId);
    if (found) found.quantity = precision(found.quantity + qty);
    else existing.push({ sourceId: source.sourceId, quantity: qty });
  }
  if (!sources?.length) existing.push({ sourceId: "untraced", quantity });
}
function currentSaleDelta(store, orderId, itemId) {
  return c.round(
    store.costAdjustments
      .filter((a) => a.orderId === orderId && a.itemId === itemId)
      .reduce((n, a) => n + a.costDelta, 0),
  );
}
function restoreSaleCost(
  store,
  user,
  order,
  item,
  qty,
  previousReturned,
  returnId,
) {
  const delta = c.round(
    (currentSaleDelta(store, order.id, item.id) * qty) /
      (item.quantity - previousReturned),
  );
  if (delta)
    store.costAdjustments.push({
      id: c.id("CA"),
      kind: "sale_return",
      orderId: order.id,
      itemId: item.id,
      costDelta: -delta,
      sourceId: returnId,
      ...suppliers.stamp(user),
    });
  return delta;
}
function lineFor(store, payload) {
  suppliers.upgrade(store);
  const order = store.purchases.find(
    (p) => p.id === payload.purchaseId && p.supplierId === payload.supplierId,
  );
  const line = order?.items.find((i) => i.id === payload.itemId);
  if (!line) throw new c.HttpError(404, "原采购明细不存在或不属于此供应商");
  const product = store.products.find((p) => p.skuId === line.skuId);
  const stock = store.inventory.find(
    (s) => s.skuId === line.skuId && (s.warehouseId || "wh-sale") === "wh-sale",
  );
  if (!stock || !product) throw new c.HttpError(409, "商品库存资料不完整");
  return { order, line, product, stock };
}
function candidates(store, user, supplierId) {
  c.permit(user, "supplierAdjust");
  suppliers.upgrade(store);
  return store.purchases
    .filter((p) => p.supplierId === supplierId)
    .flatMap((p) =>
      p.items.map((i) => {
        const product = store.products.find((x) => x.skuId === i.skuId);
        const stock = store.inventory.find((s) => s.skuId === i.skuId);
        return {
          purchaseId: p.id,
          itemId: i.id,
          skuId: i.skuId,
          name: i.name,
          quantity: i.quantity,
          costPrice: i.costPrice,
          createdAt: p.createdAt,
          trackSerial: !!product?.trackSerial,
          serials: (stock?.serials || [])
            .filter(
              (s) => s.purchaseId === p.id && (i.serials || []).includes(s.no),
            )
            .map((s) => ({
              no: s.no,
              status: s.status,
              costPrice: s.costPrice,
            })),
          returnedQuantity: store.purchaseReturns
            .filter((r) => r.purchaseId === p.id && r.itemId === i.id)
            .reduce((n, r) => n + r.quantity, 0),
        };
      }),
    );
}
function saleExposures(store, line, serialNo) {
  const rows = [];
  for (const order of store.sales)
    for (const item of order.items) {
      const add = (part, materialIndex, factor) => {
        const quantity = serialNo
          ? part.serialNo === serialNo
            ? factor
            : 0
          : (part.costSources || [])
              .filter((s) => s.sourceId === line.id)
              .reduce((n, s) => n + s.quantity * factor, 0);
        if (quantity > 1e-9)
          rows.push({
            destination: "sale",
            orderId: order.id,
            itemId: item.id,
            materialIndex,
            quantity,
            name: item.name,
          });
      };
      if (item.stockManaged)
        add(
          item,
          null,
          (item.quantity - (item.returnedQuantity || 0)) / item.quantity,
        );
      (item.materials || []).forEach((m, index) => add(m, index, 1));
    }
  return rows;
}
function preview(store, user, payload) {
  c.permit(user, "supplierAdjust");
  const { order, line, product, stock } = lineFor(store, payload);
  const reference = c.text(payload.reference, "供应商确认编号");
  if (
    store.supplierAdjustments.some(
      (a) => a.supplierId === order.supplierId && a.reference === reference,
    )
  )
    throw new c.HttpError(409, "该确认编号已登记，请勿重复补差");
  const unitAmount = c.money(payload.unitAmount, "每件调整金额");
  if (!unitAmount) throw new c.HttpError(400, "每件调整金额必须大于零");
  if (!["decrease", "increase"].includes(payload.direction))
    throw new c.HttpError(400, "请选择降价补差或追加进价");
  if (!["all", "inventory", "selected"].includes(payload.scope))
    throw new c.HttpError(400, "请选择调价范围");
  if (payload.direction === "decrease") suppliers.creditKind(payload);
  const unitDelta = payload.direction === "decrease" ? -unitAmount : unitAmount;
  const targets = [];
  if (product.trackSerial) {
    const serials = (stock.serials || []).filter(
      (s) => s.purchaseId === order.id && line.serials.includes(s.no),
    );
    let chosen = serials.filter((s) =>
      payload.scope === "inventory"
        ? ["可售", "未激活"].includes(s.status)
        : payload.scope === "selected"
          ? (payload.serialNos || []).includes(s.no)
          : s.status !== "已退供应商",
    );
    if (
      payload.scope === "selected" &&
      (!Array.isArray(payload.serialNos) ||
        new Set(payload.serialNos).size !== payload.serialNos.length ||
        chosen.length !== payload.serialNos.length)
    )
      throw new c.HttpError(400, "选中的串码不存在、重复或不属于该批次");
    if (payload.scope === "all" && chosen.length !== line.quantity)
      throw new c.HttpError(
        409,
        "该批次已有采购退货或缺少串码，请按指定串码核对调价",
      );
    for (const serial of chosen) {
      if (c.round(serial.costPrice + unitDelta) < 0)
        throw new c.HttpError(400, "调整后单件成本不能为负数");
      const base = { serialNo: serial.no, currentUnitCost: serial.costPrice };
      if (["可售", "未激活"].includes(serial.status))
        targets.push({
          ...base,
          destination: "inventory",
          quantity: 1,
          name: line.name,
        });
      else if (serial.status === "已售") {
        const exposures = saleExposures(store, line, serial.no);
        if (exposures.length !== 1)
          throw new c.HttpError(409, "串码销售来源无法唯一追溯，不能自动调整");
        targets.push({ ...base, ...exposures[0] });
      } else throw new c.HttpError(409, "该串码已退供应商或状态不支持调价");
    }
  } else {
    if (payload.scope === "selected")
      throw new c.HttpError(400, "普通商品请选择整批或当前库存");
    const conservativeUnitCost = store.supplierAdjustments
      .filter((a) => a.type === "price" && a.itemId === line.id)
      .reduce(
        (n, a) =>
          n +
          (a.direction === "decrease"
            ? -a.unitAmount
            : a.scope === "all"
              ? a.unitAmount
              : 0),
        line.costPrice,
      );
    if (c.round(conservativeUnitCost + unitDelta) < 0)
      throw new c.HttpError(400, "补差超过该批次可追溯成本，请核对历史调价");
    const quantity = trace(stock)
      .filter((s) => s.sourceId === line.id)
      .reduce((n, s) => n + s.quantity, 0);
    if (
      payload.scope === "inventory" &&
      Math.abs(quantity - stock.quantity) > 1e-7
    )
      throw new c.HttpError(
        409,
        "当前库存混合了其他批次，无法判断库存价保归属；可按整批协议调整",
      );
    if (quantity > 1e-9)
      targets.push({
        destination: "inventory",
        quantity,
        name: line.name,
        stockQuantity: stock.quantity,
        stockValue:
          stock.stockValue ?? c.round(stock.quantity * stock.costPrice),
      });
    if (payload.scope === "all") {
      targets.push(...saleExposures(store, line));
      if (
        Math.abs(targets.reduce((n, t) => n + t.quantity, 0) - line.quantity) >
        1e-7
      )
        throw new c.HttpError(
          409,
          "该批次含历史未追溯、盘点或采购退货数量，暂不能自动分配成本差额",
        );
    }
  }
  if (!targets.length) throw new c.HttpError(400, "该范围没有符合条件的商品");
  // Cumulative rounding preserves the exact total across weighted-average exposures.
  let quantitySum = 0,
    allocated = 0;
  for (const target of targets) {
    quantitySum += target.quantity;
    const cumulative = c.round(quantitySum * unitDelta);
    target.costDelta = c.round(cumulative - allocated);
    allocated = cumulative;
    if (target.destination === "sale") {
      const item = store.sales
        .find((o) => o.id === target.orderId)
        .items.find((i) => i.id === target.itemId);
      target.currentCost = c.round(
        item.cost *
          (item.stockManaged
            ? (item.quantity - (item.returnedQuantity || 0)) / item.quantity
            : 1) +
          currentSaleDelta(store, target.orderId, target.itemId),
      );
    }
  }
  const inventoryDelta = c.round(
    targets
      .filter((t) => t.destination === "inventory")
      .reduce((n, t) => n + t.costDelta, 0),
  );
  const salesDelta = c.round(allocated - inventoryDelta);
  if (
    c.round(
      (stock.stockValue ?? stock.quantity * stock.costPrice) + inventoryDelta,
    ) < 0
  )
    throw new c.HttpError(400, "调整后库存成本不能为负数");
  const grouped = new Map();
  for (const t of targets.filter((t) => t.destination === "sale"))
    grouped.set(t.itemId, (grouped.get(t.itemId) || 0) + t.costDelta);
  for (const [id, delta] of grouped)
    if (c.round(targets.find((t) => t.itemId === id).currentCost + delta) < 0)
      throw new c.HttpError(400, "调整后已售商品成本不能为负数");
  const result = {
    supplierId: order.supplierId,
    purchaseId: order.id,
    itemId: line.id,
    skuId: line.skuId,
    name: line.name,
    reference,
    note: c.text(payload.note, "双方确认依据"),
    direction: payload.direction,
    kind: payload.direction === "increase" ? "payable" : payload.kind,
    scope: payload.scope,
    unitAmount,
    quantity: precision(quantitySum),
    amount: Math.abs(allocated),
    inventoryDelta,
    salesDelta,
    profitDelta: -salesDelta,
    targets,
  };
  result.previewToken = createHash("sha256")
    .update(JSON.stringify(result))
    .digest("hex");
  return result;
}
function confirm(store, user, payload) {
  const result = preview(store, user, payload);
  if (payload.previewToken !== result.previewToken)
    throw new c.HttpError(409, "库存、销售或调整内容已变化，请重新预览");
  const { stock } = lineFor(store, payload);
  const row = {
    ...result,
    id: c.id("SA"),
    type: "price",
    ...suppliers.stamp(user),
  };
  row.entryId = suppliers.entry(store, {
    supplierId: row.supplierId,
    kind: row.kind,
    cents: suppliers.cents(row.amount),
    title: row.direction === "decrease" ? "调价补差" : "追加进价",
    sourceType: "price",
    sourceId: row.id,
    note: row.note,
    ...suppliers.stamp(user),
  }).id;
  stock.stockValue = c.round(
    (stock.stockValue ?? stock.quantity * stock.costPrice) + row.inventoryDelta,
  );
  stock.costPrice = stock.quantity
    ? Number((stock.stockValue / stock.quantity).toFixed(6))
    : 0;
  for (const target of row.targets) {
    if (target.serialNo) {
      const serial = stock.serials.find((s) => s.no === target.serialNo);
      serial.costPrice = c.round(serial.costPrice + target.costDelta);
    }
    store.costAdjustments.push({
      id: c.id("CA"),
      kind: target.destination,
      sourceId: row.id,
      skuId: row.skuId,
      ...target,
      ...suppliers.stamp(user),
    });
  }
  if (row.inventoryDelta)
    store.movements.unshift({
      id: c.id("MV"),
      skuId: row.skuId,
      product: row.name,
      quantity: 0,
      cost: row.inventoryDelta,
      type: "采购调价",
      warehouseId: stock.warehouseId || "wh-sale",
      warehouseName: stock.warehouseName || "销售仓",
      sourceId: row.id,
      ...suppliers.stamp(user),
    });
  store.supplierAdjustments.push(row);
  c.audit(
    store,
    user,
    "supplier:price",
    `${row.name} ${row.direction} ${row.amount}`,
  );
  return row;
}
function previewReturn(store, user, payload) {
  const row = returnPurchase(
    structuredClone(store),
    user,
    { ...payload, confirmed: true },
    true,
  );
  const result = {
    supplierId: row.supplierId,
    purchaseId: row.purchaseId,
    itemId: row.itemId,
    skuId: row.skuId,
    name: row.name,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    amount: row.amount,
    cost: row.cost,
    kind: row.kind,
    reference: row.reference,
    note: row.note,
    serialNos: row.serialNos || [],
    costSources: row.costSources || [],
  };
  result.previewToken = createHash("sha256")
    .update(JSON.stringify(result))
    .digest("hex");
  return result;
}
function returnPurchase(store, user, payload, previewOnly = false) {
  c.permit(user, "supplierAdjust");
  if (
    !previewOnly &&
    previewReturn(store, user, payload).previewToken !== payload.previewToken
  )
    throw new c.HttpError(409, "退货数量或成本已变化，请重新预览");
  const { order, line, product, stock } = lineFor(store, payload);
  if (payload.confirmed !== true)
    throw new c.HttpError(400, "请确认实物退货和供应商认可的退货款");
  const reference = c.text(payload.reference, "供应商退货确认编号");
  if (
    store.purchaseReturns.some(
      (r) => r.supplierId === order.supplierId && r.reference === reference,
    )
  )
    throw new c.HttpError(409, "该退货确认编号已登记");
  const quantity = c.quantity(payload.quantity);
  const returned = store.purchaseReturns
    .filter((r) => r.purchaseId === order.id && r.itemId === line.id)
    .reduce((n, r) => n + r.quantity, 0);
  if (quantity + returned > line.quantity || quantity > stock.quantity)
    throw new c.HttpError(409, "退货数量超过原进货可退数量或可用库存");
  const unitPrice = c.money(payload.unitPrice, "供应商认可退款单价");
  const kind = suppliers.creditKind(payload);
  const row = {
    id: c.id("PR"),
    supplierId: order.supplierId,
    purchaseId: order.id,
    itemId: line.id,
    skuId: line.skuId,
    name: line.name,
    quantity,
    unitPrice,
    amount: c.round(quantity * unitPrice),
    kind,
    reference,
    note: c.text(payload.note, "退货及退款约定"),
    ...suppliers.stamp(user),
  };
  if (!row.amount) throw new c.HttpError(400, "退货款必须大于零");
  if (product.trackSerial) {
    const nos = payload.serialNos;
    if (
      !Array.isArray(nos) ||
      nos.length !== quantity ||
      new Set(nos).size !== quantity
    )
      throw new c.HttpError(400, "请逐件选择退货串码");
    const serials = nos.map((no) =>
      stock.serials.find(
        (s) =>
          s.no === no &&
          s.purchaseId === order.id &&
          line.serials.includes(no) &&
          ["可售", "未激活"].includes(s.status),
      ),
    );
    if (serials.some((s) => !s))
      throw new c.HttpError(409, "退货串码不在该批次可售库存");
    row.cost = c.round(serials.reduce((n, s) => n + s.costPrice, 0));
    row.serialNos = nos;
    serials.forEach((s) => {
      s.status = "已退供应商";
    });
  } else {
    row.cost =
      quantity === stock.quantity
        ? c.round(stock.stockValue ?? stock.quantity * stock.costPrice)
        : c.round(stock.costPrice * quantity);
    row.costSources = take(stock, quantity);
  }
  stock.stockValue = c.round(
    (stock.stockValue ?? stock.quantity * stock.costPrice) - row.cost,
  );
  stock.quantity -= quantity;
  if (!stock.quantity) stock.stockValue = 0;
  stock.costPrice = stock.quantity
    ? Number((stock.stockValue / stock.quantity).toFixed(6))
    : 0;
  row.entryId = suppliers.entry(store, {
    supplierId: row.supplierId,
    kind,
    cents: suppliers.cents(row.amount),
    title: "采购退货款",
    sourceType: "purchase_return",
    sourceId: row.id,
    note: row.note,
    ...suppliers.stamp(user),
  }).id;
  store.purchaseReturns.push(row);
  store.movements.unshift({
    id: c.id("MV"),
    skuId: row.skuId,
    product: row.name,
    quantity: -quantity,
    cost: -row.cost,
    type: "采购退货",
    warehouseId: stock.warehouseId || "wh-sale",
    warehouseName: stock.warehouseName || "销售仓",
    sourceId: row.id,
    ...suppliers.stamp(user),
  });
  c.audit(store, user, "supplier:return", `${row.name} ${quantity}`);
  return row;
}
module.exports = {
  trace,
  receive,
  take,
  restore,
  currentSaleDelta,
  restoreSaleCost,
  candidates,
  preview,
  confirm,
  returnPurchase,
  previewReturn,
};
