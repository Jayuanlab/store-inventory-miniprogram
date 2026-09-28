const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: { summary: {}, orders: [], user: {}, loading: true, error: "" },
  onShow() {
    this.reload();
  },
  onPullDownRefresh() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const user = await api.request("/api/me");
      getApp().globalData.currentUser = user;
      wx.setStorageSync("sessionUser", user);
      const report = await api.request("/api/dashboard");
      const summary = {};
      Object.keys(report.summary).forEach(
        (k) =>
          (summary[k] =
            k === "orderCount"
              ? report.summary[k]
              : ui.money(report.summary[k])),
      );
      this.setData({
        user,
        caps: user.capabilities,
        date: report.date,
        summary,
        orders: report.recentOrders.map((o) => ({
          ...o,
          amountText: ui.money(o.amount),
          timeText: ui.dateTime(o.createdAt).slice(11),
          names: o.items.map((i) => i.name).join("、"),
        })),
      });
    });
  },
  go: ui.navigate,
  sales() {
    wx.switchTab({ url: "/pages/sales/sales" });
  },
  inventory() {
    wx.switchTab({ url: "/pages/inventory/inventory" });
  },
});
