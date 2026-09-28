const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: { keyword: "", rows: [], totals: {}, editor: null },
  onShow() {
    this.reload();
  },
  onPullDownRefresh() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request("/api/suppliers");
      this.rows = data.rows.map((s) => ({
        ...s,
        payableText: ui.money(s.payable),
        cashText: ui.money(s.cash),
        advanceText: ui.money(s.advance),
        creditText: ui.money(s.credit),
      }));
      const totals = {};
      Object.keys(data.totals).forEach((k) => {
        totals[k] = ui.money(data.totals[k]);
      });
      this.setData({ totals });
      this.filter();
    });
  },
  filter() {
    const words = this.data.keyword
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    this.setData({
      rows: (this.rows || []).filter((s) =>
        words.every((w) =>
          (s.name + " " + s.contact).toLowerCase().includes(w),
        ),
      ),
    });
  },
  search(e) {
    this.setData({ keyword: e.detail.value });
    this.filter();
  },
  open(e) {
    wx.navigateTo({
      url:
        "/pages/supplier-detail/supplier-detail?id=" +
        e.currentTarget.dataset.id,
    });
  },
  add() {
    this.setData({ editor: { name: "", contact: "", note: "" }, error: "" });
  },
  field(e) {
    this.setData({
      ["editor." + e.currentTarget.dataset.field]: e.detail.value,
    });
  },
  close() {
    if (!this.data.submitting) this.setData({ editor: null, error: "" });
  },
  noop: ui.nothing,
  save() {
    return ui.submit(this, "/api/suppliers", this.data.editor, async (row) => {
      this.setData({ editor: null });
      await this.reload();
      wx.navigateTo({
        url: "/pages/supplier-detail/supplier-detail?id=" + row.id,
      });
    });
  },
});
