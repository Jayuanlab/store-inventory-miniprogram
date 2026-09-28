const API_BASE_URL = "http://127.0.0.1:3100";
function key() {
  return "req-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync("sessionToken");
    wx.request({
      url: API_BASE_URL + path,
      method: options.method || "GET",
      data: options.data || {},
      timeout: 15000,
      header: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300)
          return resolve(response.data);
        const error = new Error(
          response.data && response.data.error
            ? response.data.error.message
            : "请求未完成",
        );
        error.status = response.statusCode;
        if (response.statusCode === 401) {
          wx.removeStorageSync("sessionToken");
          wx.removeStorageSync("sessionUser");
          getApp().globalData.currentUser = null;
          wx.reLaunch({ url: "/pages/login/login" });
        }
        reject(error);
      },
      fail() {
        const error = new Error(
          options.method === "POST"
            ? "尚未确认提交结果，请保留页面并重试"
            : "无法连接服务，请检查网络后重试",
        );
        error.uncertain = true;
        reject(error);
      },
    });
  });
}
function post(path, data, requestKey) {
  return request(path, { method: "POST", data, key: requestKey || key() });
}
function upload(filePath) {
  return new Promise((resolve, reject) =>
    wx.uploadFile({
      url: API_BASE_URL + "/api/opening-balance/preview-excel",
      name: "file",
      filePath,
      header: { Authorization: "Bearer " + wx.getStorageSync("sessionToken") },
      success(response) {
        try {
          const body = JSON.parse(response.data);
          if (response.statusCode !== 200) throw new Error(body.error.message);
          resolve(body);
        } catch (error) {
          reject(error);
        }
      },
      fail() {
        reject(new Error("Excel上传未完成，请重试"));
      },
    }),
  );
}
module.exports = { API_BASE_URL, request, post, upload, key };
