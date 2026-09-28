const api = require("../../utils/api");
const ui = require("../../utils/ui");
const modes = ["按件提成", "按毛利比例", "不提成"];
const codes = ["piece", "profit", "none"];
Page({
  data: {
    tab: "rules",
    month: ui.today().slice(0, 7),
    products: [],
    filtered: [],
    staff: [],
    pending: [],
    keyword: "",
    editor: null,
    modes,
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request(
        "/api/payroll/settings?month=" + this.data.month,
      );
      const products = data.products.map((p) => ({
        ...p,
        ruleText: !p.rule
          ? "未设置"
          : p.rule.mode === "piece"
            ? "每" + (p.unit || "件") + " ¥" + ui.money(p.rule.value)
            : p.rule.mode === "profit"
              ? "毛利 × " + p.rule.value + "%"
              : "不提成",
      }));
      this.setData({
        ...data,
        products,
        staff: data.staff.map((u) => ({
          ...u,
          salaryText: u.salary ? "¥" + ui.money(u.salary.amount) : "未设置",
        })),
      });
      this.filter();
    });
  },
  changeTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
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
  monthChange(e) {
    this.setData({ month: e.detail.value.slice(0, 7) });
    this.reload();
  },
  editRule(e) {
    const p = this.data.products.find(
      (p) => p.skuId === e.currentTarget.dataset.id,
    );
    this.setData({
      error: "",
      editor: {
        kind: "rule",
        title: p.name,
        skuId: p.skuId,
        modeIndex: p.rule ? codes.indexOf(p.rule.mode) : 0,
        value: p.rule ? p.rule.value : "",
      },
    });
  },
  editSalary(e) {
    const u = this.data.staff.find((u) => u.id === e.currentTarget.dataset.id);
    this.setData({
      error: "",
      editor: {
        kind: "salary",
        title: u.name + "的底薪",
        employeeId: u.id,
        value: u.salary ? u.salary.amount : "",
        effectiveMonth: this.data.month,
      },
    });
  },
  resolve(e) {
    const entry = this.data.pending.find(
      (p) => p.id === e.currentTarget.dataset.id,
    );
    this.setData({
      error: "",
      editor: {
        kind: "resolve",
        title: entry.employeeName + " · " + entry.productName,
        entryId: entry.id,
        modeIndex: 0,
        value: "",
      },
    });
  },
  changeValue(e) {
    this.setData({ "editor.value": e.detail.value });
  },
  changeMode(e) {
    this.setData({ "editor.modeIndex": Number(e.detail.value) });
  },
  effectiveMonth(e) {
    this.setData({ "editor.effectiveMonth": e.detail.value.slice(0, 7) });
  },
  close() {
    if (!this.data.submitting) this.setData({ editor: null, error: "" });
  },
  noop: ui.nothing,
  save() {
    const e = this.data.editor;
    let path, data;
    if (e.kind === "salary") {
      path = "/api/payroll/salaries";
      data = {
        employeeId: e.employeeId,
        effectiveMonth: e.effectiveMonth,
        amount: e.value,
      };
    } else {
      path = e.kind === "rule" ? "/api/payroll/rules" : "/api/payroll/resolve";
      data = {
        skuId: e.skuId,
        entryId: e.entryId,
        mode: codes[e.modeIndex],
        value: e.value,
      };
    }
    ui.submit(this, path, data, async () => {
      this.setData({ editor: null });
      wx.showToast({ title: "已保存" });
      await this.reload();
    });
  },
});
