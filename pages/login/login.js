const api = require("../../utils/api");
Page({
  data: { loading: true, localExperience: false, users: [], error: "" },
  onShow() {
    api
      .request("/api/auth/mode")
      .then((data) => this.setData({ ...data, loading: false }))
      .catch((e) => this.setData({ error: e.message, loading: false }));
  },
  async selectUser(event) {
    if (this.data.submitting) return;
    this.setData({ submitting: true, error: "" });
    try {
      const result = await api.post("/api/auth/login", {
        userId: event.currentTarget.dataset.id,
      });
      getApp().setSession(result);
      wx.switchTab({ url: "/pages/dashboard/dashboard" });
    } catch (e) {
      this.setData({ error: e.message });
    }
    this.setData({ submitting: false });
  },
  wechatLogin() {
    if (this.data.submitting) return;
    this.setData({ submitting: true, error: "" });
    wx.login({
      success: ({ code }) =>
        api
          .post("/api/auth/login", { code })
          .then((result) => {
            getApp().setSession(result);
            wx.switchTab({ url: "/pages/dashboard/dashboard" });
          })
          .catch((e) => this.setData({ error: e.message }))
          .finally(() => this.setData({ submitting: false })),
      fail: () =>
        this.setData({ submitting: false, error: "微信登录未完成，请重试" }),
    });
  },
});
