const api = require("../../utils/api");
const ui = require("../../utils/ui");
const kinds = {
  sale: "销售收款",
  refund: "销售退款",
  purchase: "采购付款",
  supplier_payment: "供应商付款",
  supplier_refund: "供应商退款",
  expense: "费用",
  carrier: "佣金到账",
  carrier_clawback: "佣金扣回",
  payroll: "工资发放",
};
Page({
  data: {
    receipts: [],
    purchases: [],
    payableText: "0.00",
    editor: null,
    accounts: ["微信", "支付宝", "现金", "银行卡"],
    account: "微信",
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request("/api/finance");
      this.setData({
        ...data,
        payableText: ui.money(data.payable),
        supplierCashText: ui.money(data.supplierTotals.cash || 0),
        supplierAdvanceText: ui.money(data.supplierTotals.advance || 0),
        supplierCreditText: ui.money(data.supplierTotals.credit || 0),
        receipts: data.receipts.map((r) => ({
          ...r,
          label:
            (kinds[r.kind] || r.kind) +
            (r.supplierId
              ? " · " +
                (data.suppliers.find((s) => s.id === r.supplierId)?.name || "")
              : ""),
          timeText: r.transactionDate || ui.dateTime(r.createdAt),
          amountText: (r.amount >= 0 ? "+" : "") + ui.money(r.amount),
        })),
        purchases: data.purchases
          .filter((p) => p.amount > p.paidAmount)
          .map((p) => ({ ...p, dueText: ui.money(p.amount - p.paidAmount) })),
      });
    });
  },
  expense() {
    this.setData({
      editor: { kind: "expense", type: "", amount: "" },
      error: "",
    });
  },
  supplier(e) {
    const p = this.data.purchases.find(
      (p) => p.id === e.currentTarget.dataset.id,
    );
    this.setData({
      editor: {
        kind: "supplier",
        orderId: p.id,
        type: p.supplier,
        amount: p.dueText,
      },
      error: "",
    });
  },
  field(e) {
    this.setData({
      ["editor." + e.currentTarget.dataset.field]: e.detail.value,
    });
  },
  account(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  close() {
    if (!this.data.submitting) this.setData({ editor: null, error: "" });
  },
  noop: ui.nothing,
  go: ui.navigate,
  save() {
    const e = this.data.editor;
    ui.submit(
      this,
      e.kind === "expense" ? "/api/expenses" : "/api/supplier-payments",
      { ...e, account: this.data.account },
      async () => {
        this.setData({ editor: null });
        wx.showToast({ title: "已记录" });
        await this.reload();
      },
    );
  },
});
