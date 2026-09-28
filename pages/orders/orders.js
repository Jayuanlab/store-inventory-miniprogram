const api = require("../../utils/api");
const ui = require("../../utils/ui");
function decorate(o) {
  return {
    ...o,
    amountText: ui.money(o.amount),
    profitText: ui.money(o.profit),
    adjustmentText: ui.money(-(o.costAdjustment || 0)),
    adjustedProfitText: ui.money(o.adjustedProfit),
    timeText: ui.dateTime(o.createdAt),
    names: o.items.map((i) => i.name).join("、"),
    statusText:
      { completed: "已完成", partial_return: "部分退货", returned: "已退货" }[
        o.status
      ] || "已完成",
    items: o.items.map((i) => ({
      ...i,
      amountText: ui.money(i.amount ?? i.salePrice * i.quantity),
      costText: ui.money(i.cost),
      remaining: i.quantity - (i.returnedQuantity || 0),
    })),
  };
}
Page({
  data: {
    orders: [],
    selected: null,
    keyword: "",
    returning: false,
    returnItems: [],
    reason: "",
    account: "微信",
    accounts: ["微信", "支付宝", "现金", "银行卡"],
  },
  onLoad(options) {
    this.orderId = options.id || "";
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const orders = (
        await api.request(
          "/api/sale-orders?q=" + encodeURIComponent(this.data.keyword),
        )
      ).map(decorate);
      this.setData({
        orders,
        selected: this.orderId
          ? orders.find((o) => o.id === this.orderId) || null
          : null,
      });
    });
  },
  search(e) {
    this.setData({ keyword: e.detail.value });
  },
  find() {
    this.orderId = "";
    this.reload();
  },
  select(e) {
    this.orderId = e.currentTarget.dataset.id;
    this.setData({
      selected: this.data.orders.find((o) => o.id === this.orderId),
    });
  },
  back() {
    this.orderId = "";
    this.setData({ selected: null });
  },
  returnOpen() {
    this.setData({
      returning: true,
      reason: "",
      error: "",
      returnItems: this.data.selected.items
        .filter((i) => i.remaining > 0)
        .map((i) => ({ ...i, returnQty: 0 })),
      account: this.data.selected.paymentMethod,
    });
  },
  qty(e) {
    const i = Number(e.currentTarget.dataset.index);
    this.setData({ ["returnItems[" + i + "].returnQty"]: e.detail.value });
  },
  reason(e) {
    this.setData({ reason: e.detail.value });
  },
  account(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  close() {
    if (!this.data.submitting) this.setData({ returning: false, error: "" });
  },
  noop: ui.nothing,
  submitReturn() {
    const items = this.data.returnItems
      .filter((i) => Number(i.returnQty) > 0)
      .map((i) => ({ itemId: i.id, quantity: Number(i.returnQty) }));
    ui.submit(
      this,
      "/api/sale-returns",
      {
        orderId: this.data.selected.id,
        items,
        reason: this.data.reason,
        account: this.data.account,
      },
      async () => {
        this.setData({ returning: false });
        wx.showToast({ title: "已记录退货退款" });
        await this.reload();
      },
    );
  },
});
