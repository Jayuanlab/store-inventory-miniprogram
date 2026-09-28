const api = require("./api");
function user() {
  return getApp().globalData.currentUser || {};
}
function money(value) {
  return value == null ? "待核算" : Number(value).toFixed(2);
}
function today() {
  const date = new Date(Date.now() + 8 * 3600000);
  return date.toISOString().slice(0, 10);
}
function dateTime(value) {
  return value
    ? new Date(new Date(value).getTime() + 8 * 3600000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")
    : "";
}
async function load(page, work) {
  if (!wx.getStorageSync("sessionToken")) {
    wx.reLaunch({ url: "/pages/login/login" });
    return;
  }
  page.setData({ loading: true, error: "", caps: user().capabilities || {} });
  try {
    await work();
  } catch (error) {
    page.setData({ error: error.message || "读取失败，请重试" });
  } finally {
    page.setData({ loading: false });
    if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
  }
}
async function submit(page, path, data, done) {
  if (page.data.submitting) return;
  const cacheKey = "pending:" + user().id + ":" + path;
  let serialized = JSON.stringify(data);
  let saved = wx.getStorageSync(cacheKey);
  if (saved && saved.data !== serialized) {
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: "上次提交结果待确认",
        content: "继续将核对并处理上次提交的内容，本次修改不会提交。",
        confirmText: "核对上次",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    data = JSON.parse(saved.data);
    serialized = saved.data;
  }
  if (!saved) saved = { data: serialized, key: api.key() };
  wx.setStorageSync(cacheKey, saved);
  page.setData({ submitting: true, error: "" });
  try {
    const result = await api.post(path, data, saved.key);
    wx.removeStorageSync(cacheKey);
    await done(result);
  } catch (error) {
    if (
      error.status &&
      error.status < 500 &&
      ![401, 403].includes(error.status)
    )
      wx.removeStorageSync(cacheKey);
    page.setData({ error: error.message || "提交未完成" });
  } finally {
    page.setData({ submitting: false });
  }
}
function navigate(event) {
  wx.navigateTo({ url: event.currentTarget.dataset.url });
}
function nothing() {}
module.exports = {
  user,
  money,
  today,
  dateTime,
  load,
  submit,
  navigate,
  nothing,
};
