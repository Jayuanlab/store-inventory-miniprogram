const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: { status: {}, preview: null },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      this.setData({
        status: await api.request("/api/opening-balance/status"),
      });
    });
  },
  chooseExcel() {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["xlsx", "xls"],
      success: async (r) => {
        this.setData({ loading: true, error: "" });
        try {
          const preview = await api.upload(r.tempFiles[0].path);
          this.setData({
            preview: {
              ...preview,
              stockValueText: ui.money(preview.stockValue),
            },
          });
        } catch (e) {
          this.setData({ error: e.message });
        } finally {
          this.setData({ loading: false });
        }
      },
    });
  },
  commit() {
    wx.showModal({
      title: "确认期初建账",
      content:
        "将替换当前 " +
        this.data.preview.replacedProducts +
        " 个商品，导入 " +
        this.data.preview.productCount +
        " 个商品，并清除原商品的 " +
        (this.data.preview.replacedRules || 0) +
        " 条提成规则。请确认已核对数量及成本。",
      success: (r) => {
        if (r.confirm)
          ui.submit(
            this,
            "/api/opening-balance/import",
            {
              rows: this.data.preview.sourceRows,
              source: this.data.preview.source,
              confirmed: true,
            },
            async () => {
              this.setData({ preview: null });
              wx.showToast({ title: "建账完成" });
              await this.reload();
            },
          );
      },
    });
  },
});
