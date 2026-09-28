const api = require("../../utils/api");
const ui = require("../../utils/ui");
function wage(row) {
  return {
    ...row,
    baseText: ui.money(row.baseSalary),
    pieceText: ui.money(row.pieceCommission),
    profitText: ui.money(row.profitCommission),
    adjustmentText: ui.money(row.adjustment),
    commissionText: ui.money(row.commission),
    totalText: row.total == null ? "待核算" : "¥" + ui.money(row.total),
    statusText:
      row.total == null
        ? "待核算"
        : { draft: "待确认", confirmed: "已确认", paid: "已发放" }[row.status],
  };
}
Page({
  data: {
    month: ui.today().slice(0, 7),
    rows: [],
    entries: [],
    selected: null,
    employeeId: "",
    totals: {},
    account: "银行卡",
    accounts: ["银行卡", "微信", "支付宝", "现金"],
  },
  onLoad(options) {
    if (options.employeeId) this.setData({ employeeId: options.employeeId });
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request(
        "/api/payroll?month=" +
          this.data.month +
          (this.data.employeeId ? "&employeeId=" + this.data.employeeId : ""),
      );
      const rows = data.rows.map(wage);
      this.setData({
        ...data,
        rows,
        selected: this.data.employeeId || !data.canViewAll ? rows[0] : null,
        totals: {
          ...data.totals,
          totalText: ui.money(data.totals.total),
          baseText: ui.money(data.totals.baseSalary),
          commissionText: ui.money(data.totals.commission),
        },
        entries: data.entries.map((e) => ({
          ...e,
          amountText:
            e.amount == null
              ? "待核算"
              : (e.amount >= 0 ? "+" : "") + ui.money(e.amount),
          timeText: ui.dateTime(e.createdAt),
          modeText: {
            piece: "按件",
            profit: "按毛利",
            none: "不提成",
            unconfigured: "待补录",
          }[e.mode],
        })),
      });
    });
  },
  changeMonth(e) {
    this.setData({ month: e.detail.value.slice(0, 7) });
    this.reload();
  },
  chooseEmployee(e) {
    this.setData({ employeeId: e.currentTarget.dataset.id });
    this.reload();
  },
  allEmployees() {
    this.setData({ employeeId: "" });
    this.reload();
  },
  accountChange(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  confirm() {
    wx.showModal({
      title: "确认月工资",
      content:
        this.data.selected.name +
        " " +
        this.data.month +
        " 应发 " +
        this.data.selected.totalText,
      success: (r) => {
        if (r.confirm)
          ui.submit(
            this,
            "/api/payroll/confirm",
            {
              employeeId: this.data.selected.employeeId,
              month: this.data.month,
            },
            () => this.reload(),
          );
      },
    });
  },
  paid() {
    wx.showModal({
      title: "记录已发放",
      content:
        "确认已通过" +
        this.data.account +
        "发放 " +
        this.data.selected.totalText,
      success: (r) => {
        if (r.confirm)
          ui.submit(
            this,
            "/api/payroll/pay",
            { statementId: this.data.selected.id, account: this.data.account },
            () => this.reload(),
          );
      },
    });
  },
  go: ui.navigate,
});
