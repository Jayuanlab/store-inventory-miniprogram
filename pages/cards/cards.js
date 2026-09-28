const api = require("../../utils/api");
const ui = require("../../utils/ui");
const types = ["confirm", "receive", "adjust", "clawback"];
const names = ["确认佣金", "记录到账", "调减未收佣金", "记录已到账扣回"];
Page({
  data: {
    rows: [],
    selected: null,
    actionIndex: 0,
    actions: names,
    amount: "",
    note: "",
    account: "银行卡",
    accounts: ["银行卡", "微信", "支付宝", "现金"],
  },
  onShow() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      const data = await api.request("/api/card-businesses");
      this.setData({
        ...data,
        rows: data.rows.map((b) => ({
          ...b,
          expectedText: ui.money(b.expected),
          confirmedText: ui.money(b.confirmed),
          receivedText: ui.money(b.received),
          outstandingText: ui.money(b.outstanding),
          timeText: ui.dateTime(b.createdAt),
          events: b.events.map((e) => ({
            ...e,
            label: names[types.indexOf(e.type)],
            amountText: ui.money(e.amount),
            timeText: ui.dateTime(e.createdAt),
          })),
        })),
      });
    });
  },
  open(e) {
    this.setData({
      selected: this.data.rows.find((b) => b.id === e.currentTarget.dataset.id),
      amount: "",
      note: "",
      actionIndex: 0,
      error: "",
    });
  },
  action(e) {
    this.setData({ actionIndex: Number(e.detail.value) });
  },
  field(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  account(e) {
    this.setData({ account: this.data.accounts[Number(e.detail.value)] });
  },
  close() {
    if (!this.data.submitting) this.setData({ selected: null, error: "" });
  },
  noop: ui.nothing,
  save() {
    ui.submit(
      this,
      "/api/card-events",
      {
        businessId: this.data.selected.id,
        type: types[this.data.actionIndex],
        amount: this.data.amount,
        note: this.data.note,
        account: this.data.account,
      },
      async () => {
        this.setData({ selected: null });
        wx.showToast({ title: "佣金已记录" });
        await this.reload();
      },
    );
  },
});
