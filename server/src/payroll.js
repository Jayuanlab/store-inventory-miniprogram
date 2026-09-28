const c = require("./common");

function validateRule(payload) {
  const mode = payload.mode;
  if (!["piece", "profit", "none"].includes(mode))
    throw new c.HttpError(400, "请选择提成方式");
  const value =
    mode === "none"
      ? 0
      : c.money(payload.value, mode === "profit" ? "提成百分比" : "每件提成");
  if (mode === "profit" && value > 100)
    throw new c.HttpError(400, "提成比例不能超过100%");
  return { mode, value };
}
function currentRule(store, skuId, at = c.now()) {
  return (
    store.commissionRules
      .filter((r) => r.skuId === skuId && r.effectiveAt <= at)
      .sort((a, b) => b.sequence - a.sequence)[0] || null
  );
}
function saveRule(store, user, payload) {
  c.permit(user, "managePay");
  if (!store.products.some((p) => p.skuId === payload.skuId))
    throw new c.HttpError(404, "商品不存在");
  const rule = {
    id: c.id("RULE"),
    skuId: payload.skuId,
    ...validateRule(payload),
    effectiveAt: c.now(),
    sequence: store.commissionRules.length + 1,
    operatorId: user.id,
  };
  store.commissionRules.push(rule);
  c.audit(store, user, "commission:rule", `设置 ${payload.skuId} 提成`);
  return rule;
}
function salaryAt(store, employeeId, targetMonth) {
  return (
    store.salaryRates
      .filter(
        (r) => r.employeeId === employeeId && r.effectiveMonth <= targetMonth,
      )
      .sort(
        (a, b) =>
          b.effectiveMonth.localeCompare(a.effectiveMonth) ||
          b.sequence - a.sequence,
      )[0] || null
  );
}
function saveSalary(store, user, payload) {
  c.permit(user, "managePay");
  const employee = c.userById(store, payload.employeeId);
  const effectiveMonth = c.validMonth(payload.effectiveMonth);
  const nextMonth = store.salaryRates
    .filter(
      (r) => r.employeeId === employee.id && r.effectiveMonth > effectiveMonth,
    )
    .map((r) => r.effectiveMonth)
    .sort()[0];
  if (
    store.payrollStatements.some(
      (p) =>
        p.employeeId === employee.id &&
        p.month >= effectiveMonth &&
        (!nextMonth || p.month < nextMonth),
    )
  )
    throw new c.HttpError(
      409,
      "这次调整会影响已确认工资，请选择之后的生效月份",
    );
  const row = {
    id: c.id("SALARY"),
    employeeId: employee.id,
    effectiveMonth,
    amount: c.money(payload.amount, "基础工资"),
    sequence: store.salaryRates.length + 1,
    createdAt: c.now(),
    operatorId: user.id,
  };
  store.salaryRates.push(row);
  c.audit(
    store,
    user,
    "salary:change",
    `调整 ${employee.name} ${effectiveMonth} 底薪`,
  );
  return row;
}
function calculate(rule, item) {
  if (!rule) return null;
  if (rule.mode === "piece") return c.round(item.quantity * rule.value);
  if (rule.mode === "profit")
    return c.round((Math.max(0, item.profit) * rule.value) / 100);
  return 0;
}
function accrue(store, order, item) {
  const rule = currentRule(store, item.skuId, order.createdAt);
  const entry = {
    id: c.id("COM"),
    employeeId: order.salespersonId,
    orderId: order.id,
    itemId: item.id,
    productName: item.name,
    quantity: item.quantity,
    profit: item.profit,
    mode: rule ? rule.mode : "unconfigured",
    value: rule ? rule.value : null,
    ruleId: rule ? rule.id : null,
    amount: calculate(rule, item),
    month: c.month(order.createdAt),
    createdAt: order.createdAt,
    kind: "sale",
  };
  store.commissionEntries.push(entry);
  return entry;
}
function reverse(
  store,
  order,
  item,
  returnedQty,
  totalReturnedQty,
  returnId,
  at,
) {
  const original = store.commissionEntries.find(
    (e) => e.itemId === item.id && e.kind === "sale",
  );
  if (!original) return;
  const previous = store.commissionEntries
    .filter((e) => e.originalId === original.id)
    .reduce((n, e) => n + Number(e.amount || 0), 0);
  const amount =
    original.amount == null
      ? null
      : c.round(
          -c.round((original.amount * totalReturnedQty) / item.quantity) -
            previous,
        );
  store.commissionEntries.push({
    ...original,
    id: c.id("COM"),
    kind: "return",
    originalId: original.id,
    returnId,
    quantity: -returnedQty,
    cumulativeQuantity: totalReturnedQty,
    profit: -c.round((item.profit * returnedQty) / item.quantity),
    amount,
    month: c.month(at),
    createdAt: at,
  });
}
function resolveEntry(store, user, entryId, payload) {
  c.permit(user, "managePay");
  const entry = store.commissionEntries.find(
    (e) => e.id === entryId && e.kind === "sale",
  );
  if (!entry || entry.amount != null)
    throw new c.HttpError(409, "这笔提成已核定或不存在");
  const linked = store.commissionEntries.filter(
    (e) => e.originalId === entry.id,
  );
  if (
    [entry, ...linked].some((e) =>
      store.payrollStatements.some(
        (p) => p.employeeId === e.employeeId && p.month === e.month,
      ),
    )
  )
    throw new c.HttpError(409, "关联工资已确认");
  const rule = validateRule(payload);
  Object.assign(entry, rule, {
    amount: calculate(rule, entry),
    resolvedBy: user.id,
    resolvedAt: c.now(),
  });
  let reversed = 0;
  for (const adjustment of linked) {
    const cumulative = c.round(
      (entry.amount * adjustment.cumulativeQuantity) / entry.quantity,
    );
    Object.assign(adjustment, rule, {
      amount: c.round(-(cumulative - reversed)),
    });
    reversed = cumulative;
  }
  c.audit(store, user, "commission:resolve", `补录 ${entry.orderId} 提成`);
  return entry;
}
function wageRow(store, employee, targetMonth) {
  const saved = store.payrollStatements.find(
    (p) => p.employeeId === employee.id && p.month === targetMonth,
  );
  if (saved) return { ...saved, name: employee.name, role: employee.role };
  const salary = salaryAt(store, employee.id, targetMonth);
  const entries = store.commissionEntries.filter(
    (e) => e.employeeId === employee.id && e.month === targetMonth,
  );
  const piece = c.round(
    entries
      .filter((e) => e.kind === "sale" && e.mode === "piece")
      .reduce((s, e) => s + Number(e.amount || 0), 0),
  );
  const profit = c.round(
    entries
      .filter((e) => e.kind === "sale" && e.mode === "profit")
      .reduce((s, e) => s + Number(e.amount || 0), 0),
  );
  const adjustment = c.round(
    entries
      .filter((e) => e.kind === "return")
      .reduce((s, e) => s + Number(e.amount || 0), 0),
  );
  const pending = entries.filter((e) => e.amount == null).length;
  const commission = c.round(piece + profit + adjustment);
  return {
    employeeId: employee.id,
    name: employee.name,
    role: employee.role,
    month: targetMonth,
    baseSalary: salary ? salary.amount : null,
    pieceCommission: piece,
    profitCommission: profit,
    adjustment,
    commission,
    pending,
    total: salary && !pending ? c.round(salary.amount + commission) : null,
    status: "draft",
    entryIds: entries.map((e) => e.id),
  };
}
function getPayroll(store, user, targetMonth, employeeId) {
  c.validMonth(targetMonth);
  const caps = c.capabilities(user);
  if (employeeId && employeeId !== user.id && !caps.viewAllPay)
    throw new c.HttpError(403, "只能查看本人工资");
  const employees = caps.viewAllPay
    ? store.users.filter(
        (u) =>
          u.roleCode !== "owner" ||
          store.salaryRates.some((r) => r.employeeId === u.id),
      )
    : [user];
  const rows = employees
    .filter((u) => !employeeId || u.id === employeeId)
    .map((u) => wageRow(store, u, targetMonth));
  const selected = employeeId || (!caps.viewAllPay ? user.id : "");
  const entries = selected
    ? store.commissionEntries
        .filter((e) => e.employeeId === selected && e.month === targetMonth)
        .map(({ profit, ...e }) => e)
    : [];
  return {
    month: targetMonth,
    rows,
    entries,
    canViewAll: caps.viewAllPay,
    canManage: caps.managePay,
    canConfirm: caps.confirmPay && targetMonth < c.month(),
    totals: {
      baseSalary: c.round(
        rows.reduce((s, r) => s + Number(r.baseSalary || 0), 0),
      ),
      commission: c.round(rows.reduce((s, r) => s + r.commission, 0)),
      total: c.round(rows.reduce((s, r) => s + Number(r.total || 0), 0)),
      incomplete: rows.filter((r) => r.total == null).length,
    },
  };
}
function settings(store, user, targetMonth) {
  c.permit(user, "managePay");
  c.validMonth(targetMonth);
  return {
    month: targetMonth,
    staff: store.users
      .filter((u) => u.roleCode !== "owner")
      .map((u) => ({
        ...c.publicUser(u),
        salary: salaryAt(store, u.id, targetMonth),
      })),
    products: store.products
      .filter((p) => p.active !== false)
      .map((p) => ({
        skuId: p.skuId,
        name: p.name,
        externalCode: p.externalCode,
        type: p.type,
        unit: p.unit,
        rule: currentRule(store, p.skuId),
      })),
    pending: store.commissionEntries
      .filter((e) => e.kind === "sale" && e.amount == null)
      .map(({ profit, ...e }) => ({
        ...e,
        employeeName:
          store.users.find((u) => u.id === e.employeeId)?.name || "",
      })),
  };
}
function confirm(store, user, payload) {
  c.permit(user, "confirmPay");
  const targetMonth = c.validMonth(payload.month);
  if (targetMonth >= c.month())
    throw new c.HttpError(409, "月份结束后才能确认工资");
  const employee = store.users.find((u) => u.id === payload.employeeId);
  if (!employee) throw new c.HttpError(404, "员工不存在");
  const row = wageRow(store, employee, targetMonth);
  if (row.status !== "draft") return row;
  if (row.total == null) throw new c.HttpError(409, "请先补齐底薪和待核算提成");
  const result = {
    ...row,
    id: c.id("PAY"),
    status: "confirmed",
    confirmedAt: c.now(),
    confirmedBy: user.id,
  };
  store.payrollStatements.push(result);
  c.audit(
    store,
    user,
    "payroll:confirm",
    `确认 ${employee.name} ${targetMonth} 工资`,
  );
  return result;
}
function markPaid(store, user, payload) {
  c.permit(user, "confirmPay");
  const row = store.payrollStatements.find((p) => p.id === payload.statementId);
  if (!row) throw new c.HttpError(404, "请先确认工资");
  if (row.status === "paid") return row;
  if (row.total < 0)
    throw new c.HttpError(409, "应发金额为负，请先核对提成调整");
  const account = c.text(payload.account, "发放账户");
  Object.assign(row, {
    status: "paid",
    paidAt: c.now(),
    paidBy: user.id,
    account,
  });
  store.receipts.push({
    id: c.id("RC"),
    kind: "payroll",
    sourceId: row.id,
    amount: -row.total,
    account,
    createdAt: row.paidAt,
    operatorId: user.id,
  });
  c.audit(
    store,
    user,
    "payroll:paid",
    `记录 ${row.month} 工资发放 ${row.name}`,
  );
  return row;
}
module.exports = {
  saveRule,
  saveSalary,
  currentRule,
  accrue,
  reverse,
  resolveEntry,
  getPayroll,
  settings,
  confirm,
  markPaid,
};
