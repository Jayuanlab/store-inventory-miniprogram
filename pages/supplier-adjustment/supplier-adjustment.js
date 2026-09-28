const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: {
    mode: "price",
    supplier: {},
    keyword: "",
    results: [],
    selected: null,
    scope: "inventory",
    direction: "decrease",
    kind: "cash",
    unitAmount: "",
    quantity: "",
    unitPrice: "",
    serialNos: [],
    reference: "",
    note: "",
    preview: null,
    showTargets: false,
  },
  onLoad(options) {
    this.supplierId = options.supplierId || "";
    this.setData({ mode: options.mode === "return" ? "return" : "price" });
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      this.candidates = await api.request(
        "/api/supplier-candidates?id=" + this.supplierId,
      );
      const directory = await api.request("/api/suppliers/directory");
      this.setData({
        supplier: directory.find((s) => s.id === this.supplierId) || {},
      });
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
      results: (this.candidates || [])
        .filter((p) =>
          words.every((w) =>
            (
              p.name +
              " " +
              p.purchaseId +
              " " +
              p.serials.map((s) => s.no).join(" ")
            )
              .toLowerCase()
              .includes(w),
          ),
        )
        .map((p) => ({
          ...p,
          timeText: ui.dateTime(p.createdAt),
          priceText: ui.money(p.costPrice),
        })),
    });
  },
  search(e) {
    this.setData({ keyword: e.detail.value });
    this.filter();
  },
  choose(e) {
    const p = this.candidates.find(
      (p) => p.itemId === e.currentTarget.dataset.id,
    );
    const serials = p.serials
      .filter((s) =>
        this.data.mode === "return"
          ? ["可售", "未激活"].includes(s.status)
          : s.status !== "已退供应商",
      )
      .map((s) => ({ ...s, checked: false }));
    this.setData({
      selected: { ...p, serials, timeText: ui.dateTime(p.createdAt) },
      preview: null,
      serialNos: [],
      quantity: "",
      unitPrice: "",
      error: "",
    });
  },
  clear() {
    this.setData({ selected: null, preview: null, error: "" });
  },
  field(e) {
    this.setData({
      [e.currentTarget.dataset.field]: e.detail.value,
      preview: null,
    });
    this.revision = (this.revision || 0) + 1;
  },
  selectSerial(e) {
    const serialNos = e.detail.value;
    this.setData({
      serialNos,
      quantity: serialNos.length,
      "selected.serials": this.data.selected.serials.map((s) => ({
        ...s,
        checked: serialNos.includes(s.no),
      })),
      preview: null,
    });
    this.revision = (this.revision || 0) + 1;
  },
  payload() {
    const d = this.data;
    return {
      supplierId: this.supplierId,
      purchaseId: d.selected?.purchaseId,
      itemId: d.selected?.itemId,
      scope: d.scope,
      direction: d.direction,
      kind: d.kind,
      unitAmount: d.unitAmount,
      quantity: d.quantity,
      unitPrice: d.unitPrice,
      serialNos: d.serialNos,
      reference: d.reference,
      note: d.note,
    };
  },
  async preview() {
    if (this.data.previewing || !this.data.selected) return;
    this.setData({ previewing: true, error: "" });
    const revision = this.revision || 0;
    try {
      const result = await api.post(
        this.data.mode === "price"
          ? "/api/supplier-prices/preview"
          : "/api/purchase-returns/preview",
        this.payload(),
      );
      if ((this.revision || 0) !== revision) return;
      this.setData({
        showTargets: false,
        preview: {
          ...result,
          amountText: ui.money(result.amount),
          inventoryText: ui.money(result.inventoryDelta),
          salesText: ui.money(result.salesDelta),
          profitText: ui.money(result.profitDelta),
          costText: ui.money(result.cost),
          targets: (result.targets || []).map((t, index) => ({
            ...t,
            key: index,
            amountText: ui.money(t.costDelta),
            quantityText: Number(t.quantity.toFixed(6)),
            label:
              t.destination === "inventory"
                ? "在库"
                : t.materialIndex == null
                  ? "已售"
                  : "维修耗材",
          })),
        },
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ previewing: false });
    }
  },
  async confirm() {
    if (!this.data.preview || this.data.submitting) return;
    const agreed = await new Promise((resolve) =>
      wx.showModal({
        title:
          this.data.mode === "price"
            ? "确认调价入账"
            : "确认实物已退且退货款已认可",
        content:
          this.data.supplier.name +
          "，金额 ¥" +
          this.data.preview.amountText +
          "。" +
          (this.data.direction === "increase" && this.data.mode === "price"
            ? "记为新增待付货款。"
            : this.data.kind === "credit"
              ? "记为仅抵货款额度。"
              : "记为对方应退款。"),
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!agreed) return;
    return ui.submit(
      this,
      this.data.mode === "price"
        ? "/api/supplier-prices"
        : "/api/purchase-returns",
      {
        ...this.payload(),
        confirmed: true,
        previewToken: this.data.preview.previewToken,
      },
      () => {
        this.setData({ preview: null });
        wx.showToast({ title: "已确认入账" });
        wx.navigateBack();
      },
    );
  },
  go: ui.navigate,
  toggleTargets() {
    this.setData({ showTargets: !this.data.showTargets });
  },
});
