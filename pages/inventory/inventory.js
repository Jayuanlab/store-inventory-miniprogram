const api = require("../../utils/api");
const ui = require("../../utils/ui");
const categoryFields = ["type", "subType", "thirdType"];
const categoryTitles = ["一级分类", "二级分类", "三级分类"];
const categoryValue = (item, field) => String(item[field] ?? "");
function pathText(item) {
  const path = categoryFields.map((field) => categoryValue(item, field));
  while (path.length > 1 && !path[path.length - 1]) path.pop();
  return path.map((value) => value || "未分类").join(" / ");
}
Page({
  data: {
    items: [],
    itemCount: 0,
    groupCount: 0,
    keyword: "",
    groups: [],
    categoryTitles,
    categoryValues: [null, null, null],
    categoryIndices: [0, 0, 0],
    categoryOptions: categoryTitles.map((title) => [
      { value: null, label: "全部" + title },
    ]),
    hasCategoryFilter: false,
    detail: null,
    actual: "",
    reason: "",
  },
  onShow() {
    this.reload();
  },
  onPullDownRefresh() {
    this.reload();
  },
  reload() {
    return ui.load(this, async () => {
      this.source = (await api.request("/api/inventory")).filter(
        (p) => p.stockManaged !== false,
      );
      this.rebuildCategories();
      this.filter();
    });
  },
  search(e) {
    this.setData({ keyword: e.detail.value });
    this.filter();
  },
  category(e) {
    const level = Number(e.currentTarget.dataset.level);
    const option = this.data.categoryOptions[level]?.[Number(e.detail.value)];
    if (!option || (level > 0 && this.data.categoryValues[level - 1] === null))
      return;
    this.setData({
      categoryValues: this.data.categoryValues.map((value, index) =>
        index === level ? option.value : index > level ? null : value,
      ),
    });
    this.rebuildCategories();
    this.filter();
  },
  rebuildCategories() {
    const values = this.data.categoryValues.slice();
    const options = categoryFields.map((field, level) => {
      const result = [{ value: null, label: "全部" + categoryTitles[level] }];
      if (level === 0 || values[level - 1] !== null) {
        const rows = (this.source || []).filter((item) =>
          categoryFields
            .slice(0, level)
            .every(
              (parent, index) => categoryValue(item, parent) === values[index],
            ),
        );
        const names = [
          ...new Set(rows.map((item) => categoryValue(item, field))),
        ];
        names.sort((a, b) => a.localeCompare(b, "zh-CN"));
        result.push(
          ...names.map((name) => ({
            value: name,
            label: name || "未设置" + categoryTitles[level],
          })),
        );
      }
      if (!result.some((option) => option.value === values[level]))
        values[level] = null;
      return result;
    });
    this.setData({
      categoryValues: values,
      categoryOptions: options,
      categoryIndices: options.map((rows, index) =>
        rows.findIndex((row) => row.value === values[index]),
      ),
      hasCategoryFilter: values.some((value) => value !== null),
    });
  },
  resetCategories() {
    this.setData({ categoryValues: [null, null, null] });
    this.rebuildCategories();
    this.filter();
  },
  clearSearch() {
    this.setData({ keyword: "" });
    this.filter();
  },
  filter() {
    const terms = this.data.keyword
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const items = (this.source || [])
      .filter(
        (p) =>
          categoryFields.every(
            (field, index) =>
              this.data.categoryValues[index] === null ||
              categoryValue(p, field) === this.data.categoryValues[index],
          ) &&
          terms.every((q) =>
            [
              p.name,
              p.shortName,
              p.externalCode,
              p.spec,
              p.type,
              p.subType,
              p.thirdType,
              (p.serials || []).map((s) => s.no).join(" "),
            ]
              .join(" ")
              .toLowerCase()
              .includes(q),
          ),
      )
      .map((p) => ({
        stockKey: p.stockKey,
        skuId: p.skuId,
        name: p.name,
        spec: p.spec || "",
        externalCode: p.externalCode || "",
        warehouseName: p.warehouseName || "",
        quantity: p.quantity,
        unit: p.unit || "件",
        trackSerial: Boolean(p.trackSerial),
        type: categoryValue(p, "type"),
        subType: categoryValue(p, "subType"),
        thirdType: categoryValue(p, "thirdType"),
        costText: ui.money(p.costPrice),
        pathText: pathText(p),
      }));
    const grouped = new Map();
    for (const item of items) {
      const key = JSON.stringify(
        categoryFields.map((field) => categoryValue(item, field)),
      );
      if (!grouped.has(key))
        grouped.set(key, { key, pathText: item.pathText, items: [] });
      grouped.get(key).items.push(item);
    }
    const groups = [...grouped.values()].sort((a, b) =>
      a.pathText.localeCompare(b.pathText, "zh-CN"),
    );
    this.setData({
      items,
      groups,
      itemCount: items.length,
      groupCount: groups.length,
    });
  },
  open(e) {
    const p = (this.source || []).find(
      (p) => p.stockKey === e.currentTarget.dataset.key,
    );
    if (!p) return;
    this.setData({
      detail: { ...p, pathText: pathText(p), costText: ui.money(p.costPrice) },
      actual: p.quantity,
      reason: "",
      error: "",
    });
  },
  actual(e) {
    this.setData({ actual: e.detail.value });
  },
  reason(e) {
    this.setData({ reason: e.detail.value });
  },
  count() {
    ui.submit(
      this,
      "/api/stocktakes",
      {
        skuId: this.data.detail.skuId,
        expected: this.data.detail.quantity,
        actual: this.data.actual,
        reason: this.data.reason,
      },
      async () => {
        this.setData({ detail: null });
        wx.showToast({ title: "盘点已保存" });
        await this.reload();
      },
    );
  },
  close() {
    if (!this.data.submitting) this.setData({ detail: null, error: "" });
  },
  noop: ui.nothing,
  go: ui.navigate,
});
