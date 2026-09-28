const api = require("../../utils/api");
const ui = require("../../utils/ui");
function searchText(p) {
  return [
    p.name,
    p.shortName,
    p.externalCode,
    p.spec,
    p.brand,
    p.model,
    p.type,
    p.subType,
    p.thirdType,
    (p.serials || []).map((s) => s.no).join(" "),
    /iphone/i.test(p.name) ? "苹果" : "",
  ]
    .join(" ")
    .toLowerCase();
}
Page({
  data: {
    keyword: "",
    results: [],
    inventory: [],
    cart: [],
    totalText: "0.00",
    editor: null,
    accounts: ["微信", "支付宝", "现金", "银行卡"],
    account: "微信",
    staff: [],
    salespersonId: "",
    salespersonName: "",
    materialIndex: 0,
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const [inventory, staff] = await Promise.all([
        api.request("/api/inventory"),
        api.request("/api/users"),
      ]);
      const current = ui.user();
      const sellers = staff.filter((u) => u.capabilities.sell);
      this.setData({
        inventory: inventory.filter(
          (p) =>
            p.active !== false &&
            (p.stockManaged === false ||
              (p.warehouseId === "wh-sale" && p.quantity > 0)),
        ),
        staff: sellers,
        staffNames: sellers.map((u) => u.name),
        salespersonId: this.data.salespersonId || current.id,
        salespersonName: this.data.salespersonName || current.name,
      });
      this.materials = inventory.filter(
        (p) =>
          p.stockManaged !== false &&
          !p.trackSerial &&
          p.warehouseId === "wh-sale" &&
          p.quantity > 0,
      );
      this.setData({ materialNames: this.materials.map((p) => p.name) });
      if (!this.data.cart.length)
        this.setData({ cart: wx.getStorageSync("cart:" + current.id) || [] });
      this.totals();
      this.search();
    });
  },
  changeKeyword(e) {
    this.setData({ keyword: e.detail.value });
    this.search();
  },
  search() {
    const terms = this.data.keyword
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    this.setData({
      results: terms.length
        ? this.data.inventory.filter((p) =>
            terms.every((term) => searchText(p).includes(term)),
          )
        : [],
    });
  },
  scan() {
    wx.scanCode({
      success: (r) => {
        this.setData({ keyword: r.result });
        this.search();
        if (this.data.results.length === 1)
          this.openProduct(this.data.results[0], r.result);
      },
      fail: () => {},
    });
  },
  choose(e) {
    this.openProduct(
      this.data.inventory.find(
        (p) => p.stockKey === e.currentTarget.dataset.key,
      ),
    );
  },
  openProduct(p, scanned) {
    const serialOptions = (p.serials || [])
      .filter((s) => ["可售", "未激活"].includes(s.status))
      .map((s) => s.no);
    this.setData({
      error: "",
      editor: {
        localKey: api.key(),
        skuId: p.skuId,
        name: p.name,
        type: p.type,
        quantity: 1,
        salePrice: p.salePrice || "",
        stockManaged: p.stockManaged !== false,
        trackSerial: Boolean(p.trackSerial),
        serialOptions,
        serialNo: scanned && serialOptions.includes(scanned) ? scanned : "",
        materials: [],
        noMaterials: false,
        carrier: "",
        packageName: p.name,
        cardNo: "",
        expected: "",
        note: "",
      },
    });
  },
  field(e) {
    this.setData({
      ["editor." + e.currentTarget.dataset.field]: e.detail.value,
    });
  },
  serial(e) {
    this.setData({
      "editor.serialNo": this.data.editor.serialOptions[Number(e.detail.value)],
    });
  },
  material(e) {
    this.setData({ materialIndex: Number(e.detail.value) });
  },
  addMaterial() {
    const p = this.materials[this.data.materialIndex];
    if (!p) return;
    const materials = this.data.editor.materials.slice();
    const found = materials.find((m) => m.skuId === p.skuId);
    if (found) found.quantity++;
    else materials.push({ skuId: p.skuId, name: p.name, quantity: 1 });
    this.setData({
      "editor.materials": materials,
      "editor.noMaterials": false,
    });
  },
  removeMaterial(e) {
    this.setData({
      "editor.materials": this.data.editor.materials.filter(
        (m) => m.skuId !== e.currentTarget.dataset.id,
      ),
    });
  },
  noMaterials(e) {
    this.setData({ "editor.noMaterials": e.detail.value });
  },
  add() {
    const e = this.data.editor;
    if (
      e.salePrice === "" ||
      !Number.isFinite(Number(e.salePrice)) ||
      Number(e.salePrice) < 0 ||
      !Number.isSafeInteger(Number(e.quantity)) ||
      Number(e.quantity) < 1
    ) {
      this.setData({ error: "请填写有效售价和数量" });
      return;
    }
    if (e.trackSerial && !e.serialNo) {
      this.setData({ error: "请选择本件商品的串码" });
      return;
    }
    if (
      !e.stockManaged &&
      e.type === "维修" &&
      !e.materials.length &&
      !e.noMaterials
    ) {
      this.setData({ error: "请选择本次耗材，或确认无耗材" });
      return;
    }
    const item = {
      ...e,
      quantity: Number(e.quantity),
      salePrice: Number(e.salePrice),
      amountText: ui.money(Number(e.quantity) * Number(e.salePrice)),
    };
    const cart = this.data.cart.filter((i) => i.localKey !== e.localKey);
    cart.push(item);
    this.setData({ cart, editor: null, keyword: "", results: [], error: "" });
    this.totals();
  },
  edit(e) {
    const item = this.data.cart.find(
      (i) => i.localKey === e.currentTarget.dataset.key,
    );
    this.setData({ editor: JSON.parse(JSON.stringify(item)), error: "" });
  },
  remove(e) {
    this.setData({
      cart: this.data.cart.filter(
        (i) => i.localKey !== e.currentTarget.dataset.key,
      ),
    });
    this.totals();
  },
  totals() {
    this.setData({
      totalText: ui.money(
        this.data.cart.reduce((n, i) => n + i.salePrice * i.quantity, 0),
      ),
    });
    wx.setStorageSync("cart:" + ui.user().id, this.data.cart);
  },
  account(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  seller(e) {
    const user = this.data.staff[Number(e.detail.value)];
    this.setData({ salespersonId: user.id, salespersonName: user.name });
  },
  close() {
    this.setData({ editor: null, error: "" });
  },
  noop: ui.nothing,
  go: ui.navigate,
  submit() {
    if (!this.data.cart.length) return;
    ui.submit(
      this,
      "/api/sale-orders",
      {
        salespersonId: this.data.salespersonId,
        account: this.data.account,
        items: this.data.cart.map((i) => ({
          skuId: i.skuId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          serialNo: i.serialNo,
          materials: i.materials,
          noMaterials: i.noMaterials,
          note: i.note,
          card: {
            carrier: i.carrier,
            packageName: i.packageName,
            cardNo: i.cardNo,
            expected: i.expected || 0,
          },
        })),
      },
      async (order) => {
        this.setData({ cart: [] });
        this.totals();
        await this.reload();
        wx.navigateTo({ url: "/pages/orders/orders?id=" + order.id });
      },
    );
  },
});
