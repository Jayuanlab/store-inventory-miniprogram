const api = require("../../utils/api");

function money(value) {
  return Math.round(value || 0).toLocaleString();
}

function dateText(value) {
  if (!value) return "";
  return value.slice(5, 16).replace("T", " ");
}

Page({
  data: {
    summary: {},
    productRows: [],
    staffRows: [],
    recentSales: [],
  },
  onShow() {
    api
      .getReports(getApp().globalData.currentUser.id)
      .then((reports) => {
        this.setData({
          summary: {
            totalSales: money(reports.totalSales),
            totalProfit: money(reports.totalProfit),
            orderCount: reports.orderCount,
            avgOrderAmount: money(reports.avgOrderAmount),
          },
          productRows: reports.productRows.map((item) => ({
            ...item,
            salesAmount: money(item.salesAmount),
          })),
          staffRows: reports.staffRows.map((item) => ({
            ...item,
            salesAmount: money(item.salesAmount),
            profit: money(item.profit),
          })),
          recentSales: reports.recentSales.map((item) => ({
            ...item,
            amount: money(item.amount),
            createdAtText: dateText(item.createdAt),
          })),
        });
      })
      .catch(() => {
        wx.showToast({ title: "报表接口未连接", icon: "none" });
      });
  },
});
