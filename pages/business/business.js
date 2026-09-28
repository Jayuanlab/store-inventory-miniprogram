const api = require("../../utils/api");

const icons = {
  资料: "资",
  进货: "进",
  销售: "销",
  库存: "库",
  财务: "财",
  报表: "表",
};

function decorateModules(modules) {
  return modules.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      icon: icons[group.group] || "业",
      statusClass: item.status === "已接入" ? "" : "warn",
    })),
  }));
}

Page({
  data: {
    modules: [],
  },
  onShow() {
    api
      .getModules(getApp().globalData.currentUser.id)
      .then((modules) => {
        this.setData({ modules: decorateModules(modules) });
      })
      .catch(() => {
        this.setData({
          modules: decorateModules([
            {
              group: "进货",
              items: [
                {
                  name: "采购入库",
                  desc: "录供应商、数量、串码",
                  path: "/pages/purchase/purchase",
                  status: "已接入",
                },
              ],
            },
            {
              group: "销售",
              items: [
                {
                  name: "销售开单",
                  desc: "扣库存并记员工业绩",
                  path: "/pages/sales/sales",
                  status: "已接入",
                },
              ],
            },
            {
              group: "库存",
              items: [
                {
                  name: "期初建账",
                  desc: "按三级目录导入Excel",
                  path: "/pages/opening-balance/opening-balance",
                  status: "已接入",
                },
                {
                  name: "库存查询",
                  desc: "查数量和串码状态",
                  path: "/pages/inventory/inventory",
                  status: "已接入",
                },
              ],
            },
          ]),
        });
      });
  },
  openFeature(event) {
    const path = event.currentTarget.dataset.path;
    const name = event.currentTarget.dataset.name;
    if (!path) {
      wx.showToast({ title: `${name} 待接入`, icon: "none" });
      return;
    }
    const tabPages = [
      "/pages/dashboard/dashboard",
      "/pages/sales/sales",
      "/pages/inventory/inventory",
      "/pages/profile/profile",
    ];
    if (tabPages.includes(path)) {
      wx.switchTab({ url: path });
      return;
    }
    wx.navigateTo({ url: path });
  },
});
