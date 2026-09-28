const api = require("../../utils/api");
const ui = require("../../utils/ui");
const kindLabels = {
  payable: "我待付",
  cash: "对方应退",
  advance: "预付",
  credit: "仅抵货款",
};
const titles = {
  payment: "支付货款 / 预付",
  refund: "收回供应商退款",
  offset: "抵货款",
  opening: "登记期初往来",
  profile: "供应商资料",
  adjustment: "登记往来调整",
};
const decorated = (e) => ({
  ...e,
  amountText: ui.money(e.amount),
  remainingText: ui.money(e.remaining),
  timeText: ui.dateTime(e.createdAt),
  optionLabel:
    (e.title || e.name) +
    " · " +
    ui.dateTime(e.createdAt).slice(0, 10) +
    " · ¥" +
    ui.money(e.remaining) +
    " · " +
    e.id.slice(-6),
});
Page({
  data: {
    supplier: {},
    balances: {},
    entries: [],
    logs: [],
    purchases: [],
    returns: [],
    plans: [],
    paymentPlans: [],
    paymentPlanIndex: 0,
    tab: "open",
    editor: null,
    selectedLog: null,
    accounts: ["微信", "支付宝", "现金", "银行卡"],
    account: "微信",
    from: ui.today().slice(0, 7) + "-01",
    to: ui.today(),
    today: ui.today(),
    statement: null,
    chosenDue: [],
    allocationTotal: "0.00",
    unallocated: "0.00",
    targets: [],
    sources: [],
  },
  onLoad(options) {
    this.supplierId = options.id || "";
  },
  onShow() {
    this.reload();
  },
  onPullDownRefresh() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request(
        "/api/supplier-detail?id=" + encodeURIComponent(this.supplierId),
      );
      this.detail = data;
      const balances = {};
      Object.keys(data.balances).forEach((k) => {
        balances[k] = ui.money(data.balances[k]);
      });
      const entries = data.entries.map(decorated);
      const byId = new Map(entries.map((e) => [e.id, e]));
      const logs = [
        ...entries.map((e) => ({
          ...e,
          logType: "entry",
          label: e.title,
          subtitle:
            e.kindLabel +
            " · " +
            (e.remaining > 0 ? "未结 ¥" + e.remainingText : "已结清"),
        })),
        ...data.settlements.map((e) => ({
          ...decorated(e),
          logType: "settlement",
          label: e.reversedAt
            ? e.type === "payment"
              ? "付款分配已撤销"
              : "抵扣已撤销"
            : e.type === "refund"
              ? "收回退款"
              : e.type === "payment"
                ? "付款核销"
                : e.reversedAt
                  ? "抵扣已撤销"
                  : "抵货款",
          subtitle:
            (byId.get(e.sourceId)?.title || "原款项") +
            (e.targetId ? " → " + (byId.get(e.targetId)?.title || "货款") : ""),
          sourceText: byId.get(e.sourceId)?.optionLabel || e.sourceId,
          targetText: byId.get(e.targetId)?.optionLabel || "实际收回退款",
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.setData({
        supplier: data.supplier,
        balances,
        entries,
        openEntries: entries.filter((e) => e.remaining > 0),
        logs,
        purchases: data.purchases.map((p) => ({
          ...p,
          names: p.items.map((i) => i.name).join("、"),
          amountText: ui.money(p.amount),
          dueText: ui.money(p.outstanding),
          timeText: ui.dateTime(p.createdAt),
        })),
        returns: data.returns.map(decorated),
        plans: data.plans.map((p) => ({
          ...p,
          names: p.items.map((i) => i.name).join("、"),
          remaining: p.items.reduce((n, i) => n + i.quantity - i.received, 0),
          timeText: ui.dateTime(p.createdAt),
          statusText: {
            open: "待收货",
            received: "已收齐",
            closed: "余货终止",
          }[p.status],
        })),
      });
      if (this.data.tab === "statement") await this.loadStatement();
    });
  },
  changeTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab, error: "" });
    if (this.data.tab === "statement")
      ui.load(this, () => this.loadStatement());
  },
  showLog(e) {
    const id = e.currentTarget.dataset.id;
    const log = this.data.logs.find((l) => l.id === id);
    const matches = this.data.logs.filter(
      (l) =>
        l.logType === "settlement" && (l.sourceId === id || l.targetId === id),
    );
    const price = (this.detail?.adjustments || []).find(
      (a) => a.entryId === id && a.type === "price",
    );
    this.setData({
      selectedLog: {
        ...log,
        matches,
        price: price
          ? {
              ...price,
              inventoryText: ui.money(price.inventoryDelta),
              salesText: ui.money(price.salesDelta),
            }
          : null,
      },
      error: "",
    });
  },
  edit(e) {
    const kind = e.currentTarget.dataset.kind;
    const targets = this.data.entries
      .filter((e) => e.kind === "payable" && e.remaining > 0)
      .slice()
      .reverse();
    const sources = this.data.entries.filter(
      (e) =>
        e.kind !== "payable" &&
        e.remaining > 0 &&
        (kind !== "refund" || e.kind !== "credit"),
    );
    const editor = {
      kind,
      title: titles[kind],
      amount: "",
      note: "",
      reference: "",
      date: ui.today(),
      targetId: targets[0]?.id || "",
      sourceId: sources[0]?.id || "",
      planId: "",
    };
    if (kind === "profile") Object.assign(editor, this.data.supplier);
    if (kind === "opening")
      Object.assign(editor, { payable: "", cash: "", advance: "", credit: "" });
    if (kind === "refund")
      editor.amount = sources[0] ? sources[0].remainingText : "";
    if (kind === "offset")
      editor.amount =
        sources[0] && targets[0]
          ? ui.money(Math.min(sources[0].remaining, targets[0].remaining))
          : "";
    if (kind === "adjustment")
      Object.assign(editor, { type: "correction", entryKind: "cash" });
    this.setData({
      editor,
      sources,
      targets,
      paymentPlans: [
        { id: "", optionLabel: "不关联订货" },
        ...this.data.plans
          .filter((p) => p.status === "open" && p.remaining > 0)
          .map((p) => ({
            id: p.id,
            optionLabel: p.names + " · " + p.timeText + " · " + p.id.slice(-6),
          })),
      ],
      paymentPlanIndex: 0,
      chosenDue: [],
      sourceIndex: 0,
      targetIndex: 0,
      allocationTotal: "0.00",
      unallocated: "0.00",
      error: "",
    });
  },
  field(e) {
    this.setData({
      ["editor." + e.currentTarget.dataset.field]: e.detail.value,
    });
    if (this.data.editor.kind === "payment") this.calculate();
  },
  account(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  editorDate(e) {
    this.setData({ "editor.date": e.detail.value });
  },
  source(e) {
    const sourceIndex = Number(e.detail.value),
      source = this.data.sources[sourceIndex];
    this.setData({ sourceIndex, "editor.sourceId": source.id });
    this.suggestAmount();
  },
  target(e) {
    const targetIndex = Number(e.detail.value),
      target = this.data.targets[targetIndex];
    this.setData({ targetIndex, "editor.targetId": target.id });
    this.suggestAmount();
  },
  suggestAmount() {
    const source = this.data.sources[this.data.sourceIndex],
      target = this.data.targets[this.data.targetIndex];
    if (source)
      this.setData({
        "editor.amount": ui.money(
          this.data.editor.kind === "refund"
            ? source.remaining
            : Math.min(source.remaining, target?.remaining || 0),
        ),
      });
  },
  dueSelection(e) {
    const selected = e.detail.value;
    this.setData({
      chosenDue: selected,
      "editor.planId": "",
      paymentPlanIndex: 0,
      targets: this.data.targets.map((t) => ({
        ...t,
        checked: selected.includes(t.id),
      })),
      "editor.amount": ui.money(
        this.data.targets
          .filter((t) => selected.includes(t.id))
          .reduce((n, t) => n + t.remaining, 0),
      ),
    });
    this.calculate();
  },
  paymentPlan(e) {
    const index = Number(e.detail.value);
    this.setData({
      paymentPlanIndex: index,
      "editor.planId": this.data.paymentPlans[index].id,
      chosenDue: [],
      targets: this.data.targets.map((t) => ({ ...t, checked: false })),
    });
    this.calculate();
  },
  calculate() {
    let left = Math.max(0, Number(this.data.editor.amount) || 0);
    this.allocations = [];
    for (const target of this.data.targets.filter(
      (t) => !this.data.editor.planId && this.data.chosenDue.includes(t.id),
    )) {
      const value = Math.round(Math.min(left, target.remaining) * 100) / 100;
      if (value > 0)
        this.allocations.push({ targetId: target.id, amount: value });
      left = Math.round((left - value) * 100) / 100;
    }
    this.setData({
      allocationTotal: ui.money(
        this.allocations.reduce((n, a) => n + a.amount, 0),
      ),
      unallocated: ui.money(left),
    });
  },
  adjustmentKind(e) {
    this.setData({ "editor.entryKind": e.detail.value });
  },
  close() {
    if (!this.data.submitting)
      this.setData({ editor: null, selectedLog: null, error: "" });
  },
  noop: ui.nothing,
  async save() {
    const e = this.data.editor;
    if (!e) return;
    const paths = {
      payment: "/api/supplier-payments",
      refund: "/api/supplier-refunds",
      offset: "/api/supplier-offsets",
      opening: "/api/supplier-opening",
      profile: "/api/suppliers",
      adjustment: "/api/supplier-adjustments",
    };
    const data = {
      ...e,
      supplierId: this.supplierId,
      account: this.data.account,
    };
    if (e.kind === "payment") {
      this.calculate();
      data.allocations = this.allocations;
    }
    if (e.kind === "profile") data.id = this.supplierId;
    if (e.kind === "adjustment") data.kind = e.entryKind;
    const confirm = await new Promise((resolve) =>
      wx.showModal({
        title:
          e.kind === "payment"
            ? "确认已实际付款"
            : e.kind === "refund"
              ? "确认退款已实际到账"
              : "确认保存",
        content:
          e.kind === "payment"
            ? e.planId
              ? "本次实际预付 ¥" +
                e.amount +
                "，关联订货：" +
                this.data.paymentPlans[this.data.paymentPlanIndex].optionLabel
              : "本次付款 ¥" +
                e.amount +
                "，其中未分配 ¥" +
                this.data.unallocated +
                " 留作预付。"
            : e.kind === "offset"
              ? "抵货款 ¥" + e.amount + "，不产生现金收付。"
              : "请核对金额、主体与确认依据。",
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!confirm) return;
    return ui.submit(this, paths[e.kind], data, async () => {
      this.setData({ editor: null });
      wx.showToast({ title: "已记录" });
      await this.reload();
    });
  },
  async reverse() {
    const log = this.data.selectedLog;
    wx.showModal({
      title: log.type === "payment" ? "撤销这笔付款分配" : "撤销这笔抵扣",
      editable: true,
      placeholderText: "填写撤销原因",
      success: async (r) => {
        if (!r.confirm) return;
        await ui.submit(
          this,
          "/api/supplier-offsets/reverse",
          { id: log.id, reason: r.content },
          async () => {
            this.setData({ selectedLog: null });
            await this.reload();
          },
        );
      },
    });
  },
  adjust(e) {
    wx.navigateTo({
      url:
        "/pages/supplier-adjustment/supplier-adjustment?supplierId=" +
        this.supplierId +
        "&mode=" +
        e.currentTarget.dataset.mode,
    });
  },
  purchase(e) {
    wx.navigateTo({
      url:
        "/pages/purchase/purchase?supplierId=" +
        this.supplierId +
        (e.currentTarget.dataset.plan
          ? "&planId=" + e.currentTarget.dataset.plan
          : ""),
    });
  },
  closePlan(e) {
    wx.showModal({
      title: "终止剩余订货",
      editable: true,
      placeholderText: "填写终止原因",
      success: async (r) => {
        if (!r.confirm) return;
        await ui.submit(
          this,
          "/api/procurement-plans/close",
          { id: e.currentTarget.dataset.id, reason: r.content },
          () => this.reload(),
        );
      },
    });
  },
  dateRange(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
    ui.load(this, () => this.loadStatement());
  },
  async loadStatement() {
    const data = await api.request(
      "/api/supplier-statement?id=" +
        this.supplierId +
        "&from=" +
        this.data.from +
        "&to=" +
        this.data.to,
    );
    this.setData({
      statement: {
        ...data,
        rows: data.rows.map((r) => ({ ...r, amountText: ui.money(r.amount) })),
        balances: Object.keys(kindLabels).map((k) => ({
          key: k,
          label: kindLabels[k],
          opening: ui.money(data.opening[k]),
          closing: ui.money(data.closing[k]),
        })),
        cash: data.cash.map((r) => ({
          ...r,
          amountText: (r.type === "payment" ? "-" : "+") + ui.money(r.amount),
        })),
      },
    });
  },
  exportStatement() {
    if (this.data.exporting) return;
    this.setData({ exporting: true, error: "" });
    wx.downloadFile({
      url:
        api.API_BASE_URL +
        "/api/supplier-statement/export?id=" +
        this.supplierId +
        "&from=" +
        this.data.from +
        "&to=" +
        this.data.to,
      header: { Authorization: "Bearer " + wx.getStorageSync("sessionToken") },
      success: (res) => {
        if (res.statusCode !== 200) {
          this.setData({ error: "对账单导出失败，请重试" });
          return;
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: "xlsx",
          showMenu: true,
          fail: () =>
            this.setData({ error: "对账单已生成，当前环境无法打开Excel" }),
        });
      },
      fail: () => this.setData({ error: "网络未连接，对账单未下载" }),
      complete: () => this.setData({ exporting: false }),
    });
  },
});
