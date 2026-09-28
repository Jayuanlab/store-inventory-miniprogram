App({
  globalData: { currentUser: null },
  onLaunch() {
    this.globalData.currentUser = wx.getStorageSync("sessionUser") || null;
  },
  setSession(result) {
    this.globalData.currentUser = result.user;
    wx.setStorageSync("sessionUser", result.user);
    wx.setStorageSync("sessionToken", result.token);
  },
  logout() {
    this.globalData.currentUser = null;
    wx.removeStorageSync("sessionUser");
    wx.removeStorageSync("sessionToken");
    wx.reLaunch({ url: "/pages/login/login" });
  },
});
