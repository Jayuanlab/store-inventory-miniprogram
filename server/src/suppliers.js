const { createHash } = require("crypto");
const c = require("./common");
const cents = (n) => Math.round(c.money(n) * 100);
const amount = (n) => n / 100;
const kinds = {
  payable: "我待付",
  cash: "对方应退",
  advance: "预付货款",
  credit: "仅抵货款",
};
function positive(value) {
  const n = cents(value);
  if (n <= 0) throw new c.HttpError(400, "金额必须大于零");
  return n;
}
function stamp(user) {
  return { createdAt: c.now(), operatorId: user.id, operator: user.name };
}
function validDate(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value || "") ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new c.HttpError(400, "日期不正确");
  return value;
}
function get(store, id) {
  const row = store.suppliers.find((s) => s.id === id);
  if (!row) throw new c.HttpError(404, "供应商不存在，请重新选择");
  return row;
}
function entry(store, data) {
  const row = { id: c.id("SE"), ...data };
  if (!kinds[row.kind] || !Number.isSafeInteger(row.cents) || row.cents < 0)
    throw new c.HttpError(400, "往来金额或类型不正确");
  store.supplierEntries.push(row);
  return row;
}
function remaining(store, row) {
  return (
    row.cents -
    store.supplierSettlements
      .filter(
        (s) =>
          !s.reversedAt && (s.sourceId === row.id || s.targetId === row.id),
      )
      .reduce((n, s) => n + s.cents, 0)
  );
}
function upgrade(store) {
  c.initialize(store);
  const linkLegacyPlans = (store.supplierModelVersion || 0) < 2;
  // Legacy purchases keep their source amounts; migration never creates cash a second time.
  for (const p of store.purchases) {
    if (p.supplierEntryId) continue;
    const name = p.supplier || "未命名历史供应商";
    const id =
      p.supplierId ||
      "legacy-" + createHash("sha256").update(name).digest("hex").slice(0, 20);
    if (!store.suppliers.some((s) => s.id === id))
      store.suppliers.push({
        id,
        name,
        contact: "",
        note: "历史采购生成，结算主体待核对",
        legacy: true,
        createdAt: p.createdAt || c.now(),
      });
    p.supplierId = id;
    const meta = {
      supplierId: id,
      sourceId: p.id,
      sourceType: "purchase",
      createdAt: p.createdAt || c.now(),
      operator: p.operator || "历史记录",
    };
    const due = entry(store, {
      ...meta,
      id: "legacy-due-" + p.id,
      kind: "payable",
      cents: cents(p.amount || 0),
      title: "历史采购货款",
    });
    p.supplierEntryId = due.id;
    if (p.paidAmount > 0) {
      const paid = entry(store, {
        ...meta,
        id: "legacy-paid-" + p.id,
        kind: "advance",
        cents: cents(p.paidAmount),
        title: "历史已付货款",
      });
      store.supplierSettlements.push({
        ...meta,
        id: "legacy-match-" + p.id,
        sourceId: paid.id,
        targetId: due.id,
        cents: Math.min(paid.cents, due.cents),
        type: "offset",
        legacy: true,
      });
    }
  }
  if (linkLegacyPlans) {
    // The old ordering flow stored an exact plan reference on both sides of its payment.
    for (const plan of store.procurementPlans) {
      const note = "订货预付款 " + plan.id;
      const candidates = store.supplierEntries.filter(
        (e) =>
          !e.planId &&
          e.kind === "advance" &&
          e.sourceType === "payment" &&
          e.supplierId === plan.supplierId &&
          e.note === note &&
          e.operatorId === plan.operatorId &&
          Date.parse(e.createdAt) >= Date.parse(plan.createdAt) &&
          Date.parse(e.createdAt) - Date.parse(plan.createdAt) < 1000,
      );
      if (candidates.length !== 1) continue;
      const paid = candidates[0];
      const cash = store.supplierCash.filter(
        (r) =>
          !r.planId &&
          r.id === paid.sourceId &&
          r.sourceId === paid.id &&
          r.type === "payment" &&
          r.supplierId === plan.supplierId &&
          r.note === note &&
          r.operatorId === plan.operatorId &&
          cents(r.amount) === paid.cents,
      );
      if (cash.length !== 1) continue;
      paid.planId = plan.id;
      cash[0].planId = plan.id;
    }
  }
  store.supplierModelVersion = 2;
  return store;
}
function resolve(store, user, payload) {
  upgrade(store);
  if (payload.supplierId) return get(store, payload.supplierId);
  const name = c.text(payload.supplier, "供应商");
  const matches = store.suppliers.filter((s) => s.name === name);
  if (matches.length > 1)
    throw new c.HttpError(409, "存在同名供应商，请从档案选择");
  if (matches.length) return matches[0];
  return save(store, user, { name });
}
function save(store, user, payload) {
  c.permit(user, "purchase");
  upgrade(store);
  const name = c.text(payload.name, "供应商名称");
  if (name.length > 100) throw new c.HttpError(400, "供应商名称过长");
  const row = payload.id
    ? get(store, payload.id)
    : { id: c.id("SUP"), ...stamp(user) };
  if (store.suppliers.some((s) => s.id !== row.id && s.name === name))
    throw new c.HttpError(
      409,
      "供应商名称已存在，请选择已有档案或补充主体名称",
    );
  Object.assign(row, {
    name,
    contact: String(payload.contact || "").slice(0, 200),
    note: String(payload.note || "").slice(0, 1000),
    legacy: false,
  });
  if (!payload.id) store.suppliers.push(row);
  c.audit(store, user, "supplier:save", name);
  return row;
}
function directory(store, user) {
  c.permit(user, "purchase");
  upgrade(store);
  return store.suppliers.map(({ id, name, contact }) => ({
    id,
    name,
    contact,
  }));
}
function balances(store, supplierId, cutoff) {
  const view = cutoff ? asOf(store, cutoff) : store;
  const result = { payable: 0, cash: 0, advance: 0, credit: 0 };
  view.supplierEntries
    .filter((e) => e.supplierId === supplierId)
    .forEach((e) => (result[e.kind] += remaining(view, e)));
  return Object.fromEntries(
    Object.entries(result).map(([key, n]) => [key, amount(n)]),
  );
}
function list(store, user, query = "") {
  c.permit(user, "supplierView");
  upgrade(store);
  const rows = store.suppliers
    .filter((s) =>
      (s.name + " " + s.contact)
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .map((s) => ({ ...s, ...balances(store, s.id) }));
  const totals = { payable: 0, cash: 0, advance: 0, credit: 0 };
  for (const row of rows)
    for (const k of Object.keys(totals))
      totals[k] = c.round(totals[k] + row[k]);
  return { rows, totals };
}
function cashRecord(store, user, supplierId, type, n, payload, sourceId) {
  const date = validDate(payload.date || c.day());
  if (date > c.day()) throw new c.HttpError(400, "实际收付日期不能在未来");
  const account = c.text(payload.account, "收付款账户");
  if (!["微信", "支付宝", "现金", "银行卡"].includes(account))
    throw new c.HttpError(400, "请选择门店实际收付款账户");
  const row = {
    id: c.id("SC"),
    supplierId,
    type,
    amount: amount(n),
    date,
    account,
    note: String(payload.note || ""),
    reference: String(payload.reference || ""),
    sourceId,
    ...stamp(user),
  };
  store.supplierCash.push(row);
  store.receipts.push({
    id: c.id("RC"),
    kind: type === "payment" ? "supplier_payment" : "supplier_refund",
    supplierId,
    sourceId: row.id,
    amount: type === "payment" ? -row.amount : row.amount,
    account,
    transactionDate: date,
    ...stamp(user),
  });
  return row;
}
function match(store, user, source, target, n, note, type = "offset") {
  if (
    source.supplierId !== target.supplierId ||
    source.id === target.id ||
    source.kind === "payable" ||
    target.kind !== "payable"
  )
    throw new c.HttpError(
      400,
      "抵扣必须属于同一供应商，且对应可用款项和待付货款",
    );
  if (n <= 0 || n > remaining(store, source) || n > remaining(store, target))
    throw new c.HttpError(409, "抵扣超过可用余额或待付货款，请刷新后重试");
  if (source.expiresOn && source.expiresOn < c.day())
    throw new c.HttpError(409, "该额度已超过约定有效期");
  if (source.purchaseId && target.sourceId !== source.purchaseId)
    throw new c.HttpError(409, "该额度只能抵指定进货单");
  const row = {
    id: c.id("SS"),
    supplierId: source.supplierId,
    sourceId: source.id,
    targetId: target.id,
    cents: n,
    note,
    type,
    ...stamp(user),
  };
  store.supplierSettlements.push(row);
  return row;
}
function findEntry(store, id) {
  const row = store.supplierEntries.find((e) => e.id === id);
  if (!row) throw new c.HttpError(404, "往来款项不存在");
  return row;
}
function payment(store, user, payload) {
  c.permit(user, "supplierSettle");
  upgrade(store);
  let supplierId = payload.supplierId;
  let allocations = payload.allocations || [];
  if (payload.orderId) {
    const order = store.purchases.find((p) => p.id === payload.orderId);
    if (!order) throw new c.HttpError(404, "采购单不存在");
    supplierId = order.supplierId;
    allocations = [{ targetId: order.supplierEntryId, amount: payload.amount }];
  }
  get(store, supplierId);
  if (payload.planId) {
    const plan = store.procurementPlans.find((p) => p.id === payload.planId);
    if (!plan || plan.supplierId !== supplierId || plan.status !== "open")
      throw new c.HttpError(400, "预付款必须对应当前供应商的待收货订货单");
    if (payload.orderId || allocations.length)
      throw new c.HttpError(400, "订货预付款不能同时分配到其他进货单");
  }
  const n = positive(payload.amount);
  if (!Array.isArray(allocations)) throw new c.HttpError(400, "付款分配不正确");
  const paid = entry(store, {
    supplierId,
    kind: "advance",
    cents: n,
    title: payload.title || "支付货款",
    sourceType: "payment",
    note: String(payload.note || ""),
    ...stamp(user),
    ...(payload.planId ? { planId: payload.planId } : {}),
  });
  for (const a of allocations)
    match(
      store,
      user,
      paid,
      findEntry(store, a.targetId),
      positive(a.amount),
      "付款核销",
      "payment",
    );
  const cash = cashRecord(
    store,
    user,
    supplierId,
    "payment",
    n,
    payload,
    paid.id,
  );
  paid.sourceId = cash.id;
  if (payload.planId) cash.planId = payload.planId;
  c.audit(
    store,
    user,
    "supplier:payment",
    `${get(store, supplierId).name} ${amount(n)}`,
  );
  return {
    cash,
    entryId: paid.id,
    unallocated: amount(remaining(store, paid)),
  };
}
function refund(store, user, payload) {
  c.permit(user, "supplierSettle");
  upgrade(store);
  const source = findEntry(store, payload.sourceId);
  if (payload.supplierId && source.supplierId !== payload.supplierId)
    throw new c.HttpError(400, "退款来源不属于当前供应商");
  if (!["cash", "advance"].includes(source.kind))
    throw new c.HttpError(400, "仅抵货款额度不能登记现金退款");
  const n = positive(payload.amount);
  if (n > remaining(store, source))
    throw new c.HttpError(409, "退款超过该笔未结余额");
  const row = cashRecord(
    store,
    user,
    source.supplierId,
    "refund",
    n,
    payload,
    source.id,
  );
  store.supplierSettlements.push({
    id: c.id("SS"),
    supplierId: source.supplierId,
    sourceId: source.id,
    targetId: null,
    cents: n,
    type: "refund",
    cashId: row.id,
    note: payload.note || "",
    ...stamp(user),
  });
  c.audit(
    store,
    user,
    "supplier:refund",
    `${get(store, source.supplierId).name} ${amount(n)}`,
  );
  return row;
}
function offset(store, user, payload) {
  c.permit(user, "supplierSettle");
  upgrade(store);
  const row = match(
    store,
    user,
    findEntry(store, payload.sourceId),
    findEntry(store, payload.targetId),
    positive(payload.amount),
    String(payload.note || ""),
  );
  c.audit(store, user, "supplier:offset", row.id);
  return row;
}
function reverseOffset(store, user, payload) {
  c.permit(user, "supplierSettle");
  const row = store.supplierSettlements.find((s) => s.id === payload.id);
  if (!row || !["offset", "payment"].includes(row.type) || row.legacy)
    throw new c.HttpError(400, "此记录不能撤销核销");
  if (row.reversedAt) throw new c.HttpError(409, "该抵扣已撤销");
  row.reverseReason = c.text(payload.reason, "撤销原因");
  row.reversedAt = c.now();
  row.reversedBy = user.id;
  c.audit(store, user, "supplier:reverse-offset", row.id);
  return row;
}
function opening(store, user, payload) {
  c.permit(user, "opening");
  upgrade(store);
  const supplier = get(store, payload.supplierId);
  if (supplier.openingRecorded)
    throw new c.HttpError(
      409,
      "该供应商已登记期初，请通过有依据的往来调整更正",
    );
  const note = c.text(payload.note, "期初核对依据");
  const date = validDate(payload.date);
  if (date > c.day()) throw new c.HttpError(400, "期初日期不能在未来");
  if (store.supplierEntries.some((e) => e.supplierId === supplier.id))
    throw new c.HttpError(
      409,
      "已有往来记录，不能追加期初造成重复；请核对后登记往来调整",
    );
  for (const kind of Object.keys(kinds)) {
    const n = cents(payload[kind] || 0);
    if (n)
      entry(store, {
        supplierId: supplier.id,
        kind,
        cents: n,
        title: "期初" + kinds[kind],
        sourceType: "opening",
        note,
        date,
        ...stamp(user),
      });
  }
  supplier.openingRecorded = true;
  c.audit(store, user, "supplier:opening", supplier.name);
  return balances(store, supplier.id);
}
function creditKind(payload) {
  if (!["cash", "credit"].includes(payload.kind))
    throw new c.HttpError(400, "请选择可退现金或仅抵货款");
  return payload.kind;
}
function adjustment(store, user, payload) {
  c.permit(user, "supplierAdjust");
  upgrade(store);
  get(store, payload.supplierId);
  if (
    !["rebate", "reimbursement", "charge", "correction"].includes(payload.type)
  )
    throw new c.HttpError(400, "往来调整类型不正确");
  if (payload.type === "rebate" && payload.nature !== "non_purchase")
    throw new c.HttpError(400, "购货折让请从调价补差关联原进货成本");
  const row = {
    id: c.id("SA"),
    supplierId: payload.supplierId,
    type: payload.type,
    amount: amount(positive(payload.amount)),
    note: c.text(payload.note, "双方确认依据"),
    reference: c.text(payload.reference, "供应商确认单号或约定编号"),
    ...stamp(user),
  };
  if (
    store.supplierAdjustments.some(
      (a) => a.supplierId === row.supplierId && a.reference === row.reference,
    )
  )
    throw new c.HttpError(409, "该确认编号已登记，请核对原记录");
  const kind =
    payload.type === "charge"
      ? "payable"
      : payload.type === "correction"
        ? payload.kind
        : creditKind(payload);
  if (!kinds[kind]) throw new c.HttpError(400, "调整方向不正确");
  const titles = {
    rebate: "非购货返利",
    reimbursement: "费用补偿",
    charge: "追加应付",
    correction: "往来更正",
  };
  row.entryId = entry(store, {
    supplierId: row.supplierId,
    kind,
    cents: cents(row.amount),
    title: titles[row.type],
    sourceId: row.id,
    sourceType: row.type,
    note: row.note,
    ...stamp(user),
  }).id;
  store.supplierAdjustments.push(row);
  c.audit(store, user, "supplier:adjustment", row.id);
  return row;
}
function registerPurchase(store, user, order, payload) {
  order.supplierEntryId = entry(store, {
    supplierId: order.supplierId,
    kind: "payable",
    cents: cents(order.amount),
    title: "采购货款",
    sourceId: order.id,
    sourceType: "purchase",
    dueDate: payload.dueDate ? validDate(payload.dueDate) : "",
    ...stamp(user),
  }).id;
  order.paidAmount = 0;
  if (order.planId) {
    const plan = store.procurementPlans.find((p) => p.id === order.planId);
    const target = findEntry(store, order.supplierEntryId);
    for (const source of planAdvances(store, plan)) {
      const n = Math.min(remaining(store, source), remaining(store, target));
      if (n <= 0) continue;
      const row = match(
        store,
        user,
        source,
        target,
        n,
        "订货预付款自动抵用",
        "offset",
      );
      row.automatic = true;
      row.planId = plan.id;
      c.audit(store, user, "supplier:plan-offset", row.id);
    }
    return;
  }
  const paid = c.money(payload.paidAmount || 0, "本次付款");
  if (paid > 0) {
    const result = payment(store, user, {
      supplierId: order.supplierId,
      amount: paid,
      account: payload.account,
      allocations: [
        {
          targetId: order.supplierEntryId,
          amount: Math.min(paid, order.amount),
        },
      ].filter((a) => a.amount > 0),
    });
    order.paidAmount = Math.min(paid, order.amount);
    order.cashId = result.cash.id;
  }
  if (payload.advanceId || payload.advanceAmount != null) {
    if (!payload.advanceId) throw new c.HttpError(400, "请选择抵用款项来源");
    positive(payload.advanceAmount);
    offset(store, user, {
      sourceId: payload.advanceId,
      targetId: order.supplierEntryId,
      amount: payload.advanceAmount,
      note: "收货抵用已有款项",
    });
  }
}
function purchaseRows(store, user, fromSupplierView = false) {
  c.permit(user, fromSupplierView ? "supplierView" : "purchase");
  upgrade(store);
  return store.purchases.map((p) => {
    if (!c.capabilities(user).supplierView) {
      const { paidAmount, supplierEntryId, cashId, ...receipt } = p;
      return receipt;
    }
    return {
      ...p,
      outstanding: amount(
        remaining(store, findEntry(store, p.supplierEntryId)),
      ),
      settledAmount: c.round(
        p.amount -
          amount(remaining(store, findEntry(store, p.supplierEntryId))),
      ),
    };
  });
}
function asOf(store, date) {
  return {
    ...store,
    supplierEntries: store.supplierEntries.filter(
      (e) => (e.sourceType === "opening" ? e.date : c.day(e.createdAt)) <= date,
    ),
    supplierSettlements: store.supplierSettlements
      .filter((s) => c.day(s.createdAt) <= date)
      .map((s) => ({
        ...s,
        reversedAt:
          s.reversedAt && c.day(s.reversedAt) <= date ? s.reversedAt : null,
      })),
  };
}
function statement(store, user, id, from, to) {
  c.permit(user, "supplierView");
  upgrade(store);
  get(store, id);
  validDate(from);
  validDate(to);
  if (from > to) throw new c.HttpError(400, "起始日期不能晚于结束日期");
  const before = new Date(Date.parse(from) - 86400000)
    .toISOString()
    .slice(0, 10);
  const events = [];
  for (const e of store.supplierEntries.filter((e) => e.supplierId === id))
    events.push({
      id: e.id,
      date: e.sourceType === "opening" ? e.date : c.day(e.createdAt),
      type: e.title,
      kind: kinds[e.kind],
      amount: amount(e.cents),
      sourceId: e.sourceId || "",
      note: e.note || "",
      order: e.createdAt,
    });
  for (const s of store.supplierSettlements.filter(
    (s) => s.supplierId === id,
  )) {
    events.push({
      id: s.id,
      date: c.day(s.createdAt),
      type:
        s.type === "refund"
          ? "收回退款核销"
          : s.type === "payment"
            ? "付款核销"
            : "抵货款",
      amount: amount(s.cents),
      sourceId: s.sourceId,
      targetId: s.targetId,
      note: s.note || "",
      order: s.createdAt,
    });
    if (s.reversedAt)
      events.push({
        id: s.id + "-reverse",
        date: c.day(s.reversedAt),
        type: s.type === "payment" ? "撤销付款分配" : "撤销抵扣",
        amount: -amount(s.cents),
        sourceId: s.sourceId,
        targetId: s.targetId,
        note: s.reverseReason,
        order: s.reversedAt,
      });
  }
  return {
    supplier: get(store, id),
    from,
    to,
    opening: balances(store, id, before),
    closing: balances(store, id, to),
    rows: events
      .filter((e) => e.date >= from && e.date <= to)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.order.localeCompare(b.order),
      ),
    cash: store.supplierCash.filter(
      (r) => r.supplierId === id && r.date >= from && r.date <= to,
    ),
  };
}
function detail(store, user, id) {
  c.permit(user, "supplierView");
  upgrade(store);
  return {
    supplier: get(store, id),
    balances: balances(store, id),
    entries: store.supplierEntries
      .filter((e) => e.supplierId === id)
      .map((e) => ({
        ...e,
        amount: amount(e.cents),
        remaining: amount(remaining(store, e)),
        kindLabel: kinds[e.kind],
      }))
      .reverse(),
    settlements: store.supplierSettlements
      .filter((e) => e.supplierId === id)
      .map((e) => ({ ...e, amount: amount(e.cents) }))
      .reverse(),
    cash: store.supplierCash.filter((e) => e.supplierId === id).reverse(),
    purchases: purchaseRows(store, user, true).filter(
      (p) => p.supplierId === id,
    ),
    adjustments: store.supplierAdjustments
      .filter((a) => a.supplierId === id)
      .reverse(),
    returns: store.purchaseReturns.filter((a) => a.supplierId === id).reverse(),
    plans: planRows(store, user, true)
      .filter((a) => a.supplierId === id)
      .reverse(),
  };
}
function planAdvances(store, plan) {
  return store.supplierEntries.filter(
    (e) =>
      e.planId === plan.id &&
      e.supplierId === plan.supplierId &&
      e.kind === "advance" &&
      e.sourceType === "payment" &&
      !e.purchaseId &&
      (!e.expiresOn || e.expiresOn >= c.day()) &&
      remaining(store, e) > 0,
  );
}
function planReceiptToken(store, plan) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: plan.id,
        supplierId: plan.supplierId,
        status: plan.status,
        items: plan.items,
        advances: planAdvances(store, plan).map((e) => [
          e.id,
          remaining(store, e),
        ]),
      }),
    )
    .digest("hex");
}
function planRows(store, user, fromSupplierView = false) {
  c.permit(user, fromSupplierView ? "supplierView" : "purchase");
  upgrade(store);
  return store.procurementPlans.map((plan) => ({
    ...plan,
    receiptToken: planReceiptToken(store, plan),
    ...(c.capabilities(user).supplierView
      ? {
          prepayment: {
            availableAmount: amount(
              planAdvances(store, plan).reduce(
                (n, e) => n + remaining(store, e),
                0,
              ),
            ),
          },
        }
      : {}),
  }));
}
function validatePlanReceipt(store, supplier, payload) {
  if (!payload.planId) return;
  const plan = store.procurementPlans.find((p) => p.id === payload.planId);
  if (!plan || plan.status !== "open" || plan.supplierId !== supplier.id)
    throw new c.HttpError(409, "订货单不存在、已结束或供应商不一致");
  if (
    Number(payload.paidAmount || 0) !== 0 ||
    payload.advanceId ||
    payload.advanceAmount != null
  )
    throw new c.HttpError(
      400,
      "订货收货不登记付款或手动抵款，请在供应商往来中办理",
    );
  if (payload.receiptToken !== planReceiptToken(store, plan))
    throw new c.HttpError(409, "订货或预付款余额已变化，请刷新收货信息后确认");
}
function plan(store, user, payload) {
  c.permit(user, "purchase");
  const supplier = resolve(store, user, payload);
  if (!Array.isArray(payload.items) || !payload.items.length)
    throw new c.HttpError(400, "请选择订货商品");
  const row = {
    id: c.id("PLAN"),
    supplierId: supplier.id,
    supplier: supplier.name,
    note: String(payload.note || ""),
    status: "open",
    ...stamp(user),
  };
  row.items = payload.items.map((i) => {
    const p = store.products.find(
      (p) => p.skuId === i.skuId && p.stockManaged !== false,
    );
    if (!p) throw new c.HttpError(400, "订货商品不存在或不管理库存");
    return {
      id: c.id("PLI"),
      skuId: p.skuId,
      name: p.name,
      quantity: c.quantity(i.quantity),
      costPrice: c.money(i.costPrice),
      received: 0,
    };
  });
  store.procurementPlans.push(row);
  if (c.money(payload.paidAmount || 0, "订货预付款") > 0)
    payment(store, user, {
      supplierId: supplier.id,
      planId: row.id,
      amount: payload.paidAmount,
      account: payload.account,
      note: "订货预付款 " + row.id,
    });
  c.audit(store, user, "supplier:plan", row.id);
  return row;
}
function closePlan(store, user, payload) {
  c.permit(user, "purchase");
  const row = store.procurementPlans.find((p) => p.id === payload.id);
  if (!row || row.status !== "open")
    throw new c.HttpError(409, "该订货单已经结束或不存在");
  row.closeReason = c.text(payload.reason, "终止原因");
  row.status = "closed";
  row.closedAt = c.now();
  c.audit(store, user, "supplier:close-plan", row.id);
  return row;
}
function receivePlan(store, order, payload) {
  if (!payload.planId) return;
  const plan = store.procurementPlans.find(
    (p) => p.id === payload.planId && p.status === "open",
  );
  if (!plan || plan.supplierId !== order.supplierId)
    throw new c.HttpError(409, "订货单不存在、已结束或供应商不一致");
  order.items.forEach((item, index) => {
    const line = plan.items.find(
      (i) => i.id === payload.items[index].planItemId && i.skuId === item.skuId,
    );
    if (!line || line.received + item.quantity > line.quantity)
      throw new c.HttpError(409, "收货超过该订货明细的待收数量");
    line.received += item.quantity;
  });
  order.planId = plan.id;
  if (plan.items.every((i) => i.received === i.quantity))
    plan.status = "received";
}
module.exports = {
  upgrade,
  get,
  save,
  resolve,
  directory,
  list,
  detail,
  balances,
  payment,
  refund,
  offset,
  reverseOffset,
  opening,
  adjustment,
  registerPurchase,
  purchaseRows,
  statement,
  entry,
  cents,
  amount,
  stamp,
  positive,
  creditKind,
  plan,
  planRows,
  validatePlanReceipt,
  closePlan,
  receivePlan,
};
