const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: {
    date: ui.today(),
    summary: {},
    categoryStats: [],
    paymentStats: [],
    staffStats: [],
  },
  onShow() {
    this.reload();
  },
  changeDate(e) {
    this.setData({ date: e.detail.value });
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request(
        "/api/daily-report?date=" + this.data.date,
      );
      const summary = {};
      Object.keys(data.summary).forEach(
        (k) =>
          (summary[k] =
            k === "orderCount" ? data.summary[k] : ui.money(data.summary[k])),
      );
      this.setData({
        ...data,
        summary,
        categoryStats: data.categoryStats.map((r) => ({
          ...r,
          salesText: ui.money(r.salesAmount),
          profitText: ui.money(r.grossProfit),
        })),
        paymentStats: data.paymentStats.map((r) => ({
          ...r,
          amountText: ui.money(r.amount),
        })),
        staffStats: data.staffStats.map((r) => ({
          ...r,
          salesText: ui.money(r.salesAmount),
        })),
      });
    });
  },
});
