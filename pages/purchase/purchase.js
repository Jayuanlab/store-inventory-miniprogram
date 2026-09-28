const api = require("../../utils/api");
const ui = require("../../utils/ui");
Page({
  data: {
    mode: "receive",
    keyword: "",
    results: [],
    selected: null,
    supplier: "",
    supplierId: "",
    suppliers: [],
    newSupplier: false,
    supplierIndex: -1,
    quantity: 1,
    costPrice: "",
    serialText: "",
    paidAmount: "",
    payMode: "unpaid",
    account: "微信",
    accounts: ["微信", "支付宝", "现金", "银行卡"],
    purchases: [],
    pendingPlans: [],
    showAllPlans: false,
    plan: null,
    planSettlement: null,
    planId: "",
    planItemIndex: 0,
    advances: [],
    advanceIndex: 0,
    advanceAmount: "",
    totalText: "0.00",
    dueDate: "",
  },
  onLoad(options) {
    this.requestedSupplierId = options.supplierId || "";
    this.planId = options.planId || "";
    this.setData({ planId: this.planId });
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      this.products = (await api.request("/api/products")).filter(
        (p) => p.stockManaged !== false && p.active !== false,
      );
      const directory = await api.request("/api/suppliers/directory");
      const orders = await api.request("/api/purchase-orders");
      const plans = await api.request("/api/procurement-plans");
      this.setData({
        suppliers: directory,
        pendingPlans: plans
          .filter(
            (p) =>
              p.status === "open" &&
              p.items.some((i) => i.quantity > i.received),
          )
          .slice()
          .reverse()
          .map((p) => ({
            ...p,
            statusText: p.items.some((i) => i.received > 0)
              ? "部分收货"
              : "未收货",
            timeText: ui.dateTime(p.createdAt),
            receiptUrl:
              "/pages/purchase/purchase?planId=" + encodeURIComponent(p.id),
            items: p.items.map((i) => ({
              ...i,
              remaining: i.quantity - i.received,
              unit:
                this.products.find((product) => product.skuId === i.skuId)
                  ?.unit || "件",
            })),
          })),
        purchases: orders.slice(0, 10).map((o) => ({
          ...o,
          names: o.items.map((i) => i.name).join("、"),
          amountText: ui.money(o.amount),
          dueText: ui.money(o.outstanding),
          timeText: ui.dateTime(o.createdAt),
        })),
      });
      if (this.requestedSupplierId && !this.data.supplierId)
        this.setSupplier(this.requestedSupplierId);
      if (this.planId) {
        const plan = plans.find(
          (p) =>
            p.id === this.planId &&
            p.status === "open" &&
            p.items.some((i) => i.quantity > i.received),
        );
        if (!plan) {
          this.setData({
            plan: null,
            planSettlement: null,
            selected: null,
            mode: "receive",
          });
          throw new Error("订货单已收货完成、已结束或不存在，请返回核对");
        }
        const items = plan.items
          .filter((i) => i.quantity > i.received)
          .map((i) => ({
            ...i,
            optionLabel: i.name + " · 待收 " + (i.quantity - i.received),
          }));
        const previous = this.data.plan?.items[this.data.planItemIndex];
        const index = Math.max(
          0,
          items.findIndex((i) => i.id === previous?.id),
        );
        this.setData({
          plan: { ...plan, items },
          planItemIndex: index,
          mode: "receive",
          payMode: "unpaid",
          paidAmount: "",
          advanceAmount: "",
        });
        this.setSupplier(plan.supplierId);
        if (
          !previous ||
          previous.id !== items[index].id ||
          previous.received !== items[index].received ||
          previous.costPrice !== items[index].costPrice
        )
          this.selectPlanLine(index);
      }
      await this.loadAdvances();
      this.calculate();
    });
  },
  setSupplier(id) {
    const index = this.data.suppliers.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.setData({
      supplierId: id,
      supplierIndex: index,
      supplier: this.data.suppliers[index].name,
      newSupplier: false,
    });
  },
  async supplierChange(e) {
    this.setSupplier(this.data.suppliers[Number(e.detail.value)].id);
    this.setData({ payMode: "unpaid", advanceAmount: "" });
    await ui.load(this, () => this.loadAdvances());
  },
  addSupplier() {
    this.setData({
      newSupplier: true,
      supplier: "",
      supplierId: "",
      supplierIndex: -1,
      advances: [],
      payMode: "unpaid",
    });
  },
  async loadAdvances() {
    if (
      this.data.planId ||
      !this.data.supplierId ||
      !this.data.caps.supplierSettle
    ) {
      this.setData({ advances: [] });
      return;
    }
    const data = await api.request(
      "/api/supplier-detail?id=" + this.data.supplierId,
    );
    this.setData({
      advances: data.entries
        .filter((e) => e.kind !== "payable" && e.remaining > 0)
        .map((e) => ({
          ...e,
          optionLabel: e.title + " · 可用 ¥" + ui.money(e.remaining),
        })),
      advanceIndex: 0,
    });
  },
  mode(e) {
    this.setData({
      mode: e.currentTarget.dataset.mode,
      payMode: "unpaid",
      error: "",
    });
  },
  togglePlans() {
    this.setData({ showAllPlans: !this.data.showAllPlans });
  },
  search(e) {
    const keyword = e.detail.value;
    const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    this.setData({
      keyword,
      results: words.length
        ? (this.products || []).filter((p) =>
            words.every((w) =>
              (
                p.name +
                " " +
                (p.externalCode || "") +
                " " +
                (p.shortName || "")
              )
                .toLowerCase()
                .includes(w),
            ),
          )
        : [],
    });
  },
  choose(e) {
    this.chooseProduct(
      this.products.find((p) => p.skuId === e.currentTarget.dataset.id),
    );
  },
  chooseProduct(p) {
    this.setData({
      selected: p,
      keyword: "",
      results: [],
      costPrice: p.costPrice ?? "",
      serialText: "",
    });
    this.calculate();
  },
  planLine(e) {
    this.selectPlanLine(Number(e.detail.value));
  },
  selectPlanLine(index) {
    const line = this.data.plan.items[index];
    const product = this.products.find((p) => p.skuId === line.skuId);
    if (!product) throw new Error("订货商品已停用，请联系老板核对");
    this.chooseProduct(product);
    this.setData({
      planItemIndex: index,
      quantity: line.quantity - line.received,
      costPrice: line.costPrice,
    });
    this.calculate();
  },
  field(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
    this.calculate();
  },
  calculate() {
    const total = Math.max(
      0,
      Math.round(
        (Number(this.data.quantity) || 0) *
          (Number(this.data.costPrice) || 0) *
          100,
      ),
    );
    const prepayment = this.data.plan?.prepayment;
    let planSettlement = null;
    if (prepayment && this.data.caps?.supplierView) {
      const available = Math.round(prepayment.availableAmount * 100);
      const applied = Math.min(available, total);
      planSettlement = {
        availableText: ui.money(available / 100),
        appliedText: ui.money(applied / 100),
        dueText: ui.money((total - applied) / 100),
        remainingText: ui.money((available - applied) / 100),
        hasRemainder: available > applied,
      };
    }
    this.setData({
      totalText: ui.money(total / 100),
      planSettlement,
    });
  },
  payMode(e) {
    this.setData({
      payMode: e.detail.value,
      paidAmount: this.data.totalText,
      advanceAmount: ui.money(
        Math.min(
          Number(this.data.totalText),
          this.data.advances[this.data.advanceIndex]?.remaining || 0,
        ),
      ),
    });
  },
  advance(e) {
    const index = Number(e.detail.value);
    this.setData({
      advanceIndex: index,
      advanceAmount: ui.money(
        Math.min(
          Number(this.data.totalText),
          this.data.advances[index].remaining,
        ),
      ),
    });
  },
  account(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  dueDate(e) {
    this.setData({ dueDate: e.detail.value });
  },
  async submit() {
    if (this.data.planId && !this.data.plan) {
      this.setData({ error: "请刷新订货收货信息后确认" });
      return;
    }
    if (!this.data.selected) {
      this.setData({ error: "请先选择商品" });
      return;
    }
    if (!this.data.supplierId && !this.data.supplier.trim()) {
      this.setData({ error: "请选择或填写供应商" });
      return;
    }
    const d = this.data;
    const data = {
      supplierId: d.supplierId || undefined,
      supplier: d.supplier,
      items: [
        {
          skuId: d.selected.skuId,
          quantity: Number(d.quantity),
          costPrice: d.costPrice,
          serials: d.serialText.split(/[\s,，]+/).filter(Boolean),
        },
      ],
    };
    if (d.plan) {
      data.planId = d.plan.id;
      data.receiptToken = d.plan.receiptToken;
      data.items[0].planItemId = d.plan.items[d.planItemIndex].id;
    } else {
      data.account = d.account;
      data.paidAmount = d.payMode === "paid" ? d.paidAmount : 0;
      data.dueDate = d.dueDate;
    }
    if (!d.plan && d.payMode === "advance" && d.mode === "receive") {
      data.advanceId = d.advances[d.advanceIndex]?.id;
      data.advanceAmount = d.advanceAmount;
    }
    return ui.submit(
      this,
      d.mode === "plan" ? "/api/procurement-plans" : "/api/purchase-orders",
      data,
      async () => {
        this.setData({
          selected: null,
          quantity: 1,
          costPrice: "",
          serialText: "",
          paidAmount: "",
          payMode: "unpaid",
          advanceAmount: "",
          dueDate: "",
          plan: null,
          planSettlement: null,
        });
        wx.showToast({
          title: d.mode === "plan" ? "已订货，待收货" : "已采购入库",
        });
        if (this.planId) {
          wx.navigateBack();
          return;
        }
        await this.reload();
      },
    );
  },
  scan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (r) =>
        this.setData({
          serialText: (this.data.serialText + "\n" + r.result).trim(),
        }),
    });
  },
  go: ui.navigate,
});
