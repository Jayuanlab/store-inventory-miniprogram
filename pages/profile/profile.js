const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: { user: {}, staff: [] },
  onShow() {
    ui.load(this, async () => {
      const user = await api.request("/api/me");
      getApp().globalData.currentUser = user;
      this.setData({
        user,
        caps: user.capabilities,
        staff: await api.request("/api/users"),
      });
    });
  },
  go: ui.navigate,
  logout() {
    getApp().logout();
  },
});
