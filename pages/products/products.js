const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: {
    products: [],
    filtered: [],
    keyword: "",
    editor: null,
    kinds: ["数量库存", "串码库存", "服务商品"],
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      this.setData({ products: await api.request("/api/products") });
      this.filter();
    });
  },
  search(e) {
    this.setData({ keyword: e.detail.value });
    this.filter();
  },
  filter() {
    const q = this.data.keyword.trim().toLowerCase();
    this.setData({
      filtered: this.data.products.filter((p) =>
        (p.name + " " + p.externalCode).toLowerCase().includes(q),
      ),
    });
  },
  add() {
    this.setData({
      editor: {
        name: "",
        externalCode: "",
        shortName: "",
        type: "配件",
        subType: "",
        unit: "件",
        salePrice: "",
        kindIndex: 0,
      },
      error: "",
    });
  },
  edit(e) {
    const p = this.data.products.find(
      (p) => p.skuId === e.currentTarget.dataset.id,
    );
    this.setData({
      editor: {
        ...p,
        kindIndex: p.stockManaged === false ? 2 : p.trackSerial ? 1 : 0,
      },
      error: "",
    });
  },
  field(e) {
    this.setData({
      ["editor." + e.currentTarget.dataset.field]: e.detail.value,
    });
  },
  kind(e) {
    this.setData({ "editor.kindIndex": Number(e.detail.value) });
  },
  close() {
    if (!this.data.submitting) this.setData({ editor: null, error: "" });
  },
  noop: ui.nothing,
  save() {
    const e = this.data.editor;
    ui.submit(
      this,
      "/api/products",
      {
        ...e,
        kind: e.kindIndex === 2 ? "service" : "physical",
        trackSerial: e.kindIndex === 1,
      },
      async () => {
        this.setData({ editor: null });
        wx.showToast({ title: "商品已保存" });
        await this.reload();
      },
    );
  },
});
