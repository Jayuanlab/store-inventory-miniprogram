const { HttpError } = require("./http");
const XLSX = require("xlsx");
const {
  INVENTORY_CATEGORIES,
  INVENTORY_SUBCATEGORIES,
  INVENTORY_THIRD_CATEGORIES,
  buildCategoryHierarchy,
  buildCategoryTree
} = require("../../utils/inventory-categories");

function nowIso() {
  return new Date().toISOString();
}

function chinaDate(value = new Date()) {
  if (typeof value === "string" && (/^\d{2}:\d{2}$/.test(value) || value === "刚刚")) {
    value = new Date();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return chinaDate(new Date());
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.floor(Math.random() * 900 + 100);
  return `${prefix}${stamp}${random}`;
}

function attachProduct(stock, products) {
  const product = products.find((item) => item.skuId === stock.skuId);
  return {
    ...product,
    ...stock,
    stockKey: `${stock.skuId}-${stock.warehouseId || "default"}`,
    serials: stock.serials || []
  };
}

function listInventory(store) {
  const stockRows = store.inventory.map((stock) => attachProduct(stock, store.products));
  const stockSkuIds = new Set(store.inventory.map((stock) => stock.skuId));
  const serviceRows = store.products
    .filter((product) => !isStockManaged(product) && !stockSkuIds.has(product.skuId))
    .map((product) => ({
      ...product,
      stockKey: `${product.skuId}-service`,
      warehouseId: "",
      warehouseName: "服务项目",
      quantity: 1,
      serials: []
    }));
  return [...stockRows, ...serviceRows];
}

function getCategories(store) {
  return Array.isArray(store.categories) && store.categories.length ? store.categories : INVENTORY_CATEGORIES;
}

function getSubcategories(store) {
  return store.subcategories && typeof store.subcategories === "object" ? store.subcategories : INVENTORY_SUBCATEGORIES;
}

function getThirdCategories(store) {
  return store.thirdCategories && typeof store.thirdCategories === "object" ? store.thirdCategories : INVENTORY_THIRD_CATEGORIES;
}

function getCategoryTree(store) {
  const subcategories = getSubcategories(store);
  const categories = getCategories(store);
  if (!categories.length) return buildCategoryTree();

  return categories.map((name) => ({
    name,
    children: subcategories[name] || []
  }));
}

function getCategoryHierarchy(store) {
  const subcategories = getSubcategories(store);
  const thirdCategories = getThirdCategories(store);
  const categories = getCategories(store);
  if (!categories.length) return buildCategoryHierarchy();

  return categories.map((name) => ({
    name,
    children: (subcategories[name] || []).map((subName) => ({
      name: subName,
      children: (thirdCategories[name] || {})[subName] || []
    }))
  }));
}

function getOpeningBalanceTemplate(store) {
  return {
    requiredColumns: ["商品编号", "商品名称", "一级分类", "期初数量", "成本均价"],
    optionalColumns: ["商品简名", "二级分类", "三级分类", "规格型号", "单位", "预设售价", "仓库", "是否串码"],
    categoryMode: "excel",
    categoryModeText: "期初建账会按Excel中的一级/二级/三级分类自动生成库存目录",
    categoryHierarchy: getCategoryHierarchy(store),
    sampleRows: [
      {
        "商品编号": "OPPO-A6T-6-256",
        "商品名称": "OPPO A6T 6+256",
        "商品简名": "OPPO A6T",
        "一级分类": "智能手机",
        "二级分类": "OPPO",
        "三级分类": "欧珀公司",
        "规格型号": "6+256",
        "单位": "台",
        "期初数量": 3,
        "成本均价": 1556,
        "预设售价": 1999,
        "仓库": "销售仓",
        "是否串码": "否"
      },
      {
        "商品编号": "BS-PD-CABLE",
        "商品名称": "标闪PD快充数据线",
        "商品简名": "PD快充数据线",
        "一级分类": "配件",
        "二级分类": "数据线",
        "三级分类": "标闪",
        "规格型号": "Type-C",
        "单位": "条",
        "期初数量": 7,
        "成本均价": 15,
        "预设售价": 38,
        "仓库": "销售仓",
        "是否串码": "否"
      }
    ]
  };
}

function getOpeningBalanceStatus(store) {
  return {
    hasOpeningBalance: Boolean(store.openingBalance && store.openingBalance.status === "completed"),
    completedAt: store.openingBalance ? store.openingBalance.completedAt : "",
    productCount: store.products.length,
    stockCount: store.inventory.length,
    movementCount: store.movements.length
  };
}

function importOpeningBalance(store, payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new HttpError(400, "期初建账明细不能为空");

  const operator = payload.operatorId ? getUser(store, payload.operatorId) : store.users[0];
  if (!hasPermission(operator, "opening_balance:import")) {
    throw new HttpError(403, "只有老板可以执行期初建账");
  }

  const categories = [];
  const categorySet = new Set();
  const subcategories = {};
  const subcategorySets = {};
  const thirdCategories = {};
  const thirdCategorySets = {};
  const nextProducts = [];
  const nextInventory = [];
  const nextMovements = [];
  const seenSkuIds = new Set();
  const seenExternalCodes = new Set();

  rows.forEach((row, index) => {
    const lineNo = index + 2;
    const externalCode = requireText(row.externalCode || row["商品编号"], `第${lineNo}行商品编号`);
    const name = requireText(row.name || row["商品名称"], `第${lineNo}行商品名称`);
    const type = requireText(row.type || row["一级分类"], `第${lineNo}行一级分类`);
    const subType = row.subType || row["二级分类"] || "";
    const thirdType = row.thirdType || row["三级分类"] || "";
    const quantity = Number(row.quantity ?? row["期初数量"] ?? 0);
    const costPrice = Number(row.costPrice ?? row["成本均价"] ?? 0);
    const salePrice = Number(row.salePrice ?? row["预设售价"] ?? 0);
    const unit = row.unit || row["单位"] || "件";
    const warehouseName = row.warehouseName || row["仓库"] || "销售仓";
    const trackSerial = ["是", "true", "TRUE", true].includes(row.trackSerial ?? row["是否串码"]);
    const stockManaged = warehouseName !== "服务项目";
    const skuId = row.skuId || `sku-opening-${externalCode.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || index + 1}`;

    if (thirdType && !subType) {
      throw new HttpError(400, `第${lineNo}行填写三级分类时必须填写二级分类`);
    }
    if (quantity < 0) throw new HttpError(400, `第${lineNo}行期初数量不能小于0`);
    if (Number.isNaN(costPrice) || costPrice < 0) throw new HttpError(400, `第${lineNo}行成本均价不正确`);
    if (seenSkuIds.has(skuId)) throw new HttpError(400, `第${lineNo}行SKU重复：${skuId}`);
    if (seenExternalCodes.has(externalCode)) throw new HttpError(400, `第${lineNo}行商品编号重复：${externalCode}`);
    seenSkuIds.add(skuId);
    seenExternalCodes.add(externalCode);
    addCategoryPath(categories, categorySet, subcategories, subcategorySets, thirdCategories, thirdCategorySets, type, subType, thirdType);

    nextProducts.push({
      skuId,
      externalCode,
      name,
      shortName: row.shortName || row["商品简名"] || name,
      type,
      subType,
      thirdType,
      spec: row.spec || row["规格型号"] || "",
      unit,
      costPrice,
      salePrice,
      trackSerial,
      stockManaged,
      warningLine: Number(row.warningLine || 0)
    });

    if (stockManaged) {
      nextInventory.push({
        skuId,
        externalCode,
        warehouseId: warehouseName === "销售仓" ? "wh-sale" : "",
        warehouseName,
        quantity,
        costPrice,
        stockValue: quantity * costPrice,
        serials: []
      });
      nextMovements.unshift({
        id: makeId("OB"),
        type: "期初建账",
        skuId,
        product: name,
        quantity,
        operatorId: operator.id,
        operator: operator.name,
        sourceType: "opening_balance",
        sourceId: "opening-balance",
        createdAt: nowIso()
      });
    }
  });

  store.products = nextProducts;
  store.inventory = nextInventory;
  store.movements = nextMovements;
  store.categories = categories;
  store.subcategories = subcategories;
  store.thirdCategories = thirdCategories;
  store.sales = [];
  store.purchases = [];
  store.openingBalance = {
    status: "completed",
    completedAt: nowIso(),
    productCount: nextProducts.length,
    stockCount: nextInventory.length,
    source: payload.source || "excel"
  };
  addOperationLog(store, operator, "opening_balance:import", `期初建账导入 ${nextProducts.length} 个商品`);

  return {
    ok: true,
    productCount: nextProducts.length,
    stockCount: nextInventory.length,
    movementCount: nextMovements.length,
    openingBalance: store.openingBalance
  };
}

function addCategoryPath(categories, categorySet, subcategories, subcategorySets, thirdCategories, thirdCategorySets, type, subType, thirdType) {
  if (!categorySet.has(type)) {
    categorySet.add(type);
    categories.push(type);
    subcategories[type] = [];
    subcategorySets[type] = new Set();
    thirdCategories[type] = {};
    thirdCategorySets[type] = {};
  }

  if (subType && !subcategorySets[type].has(subType)) {
    subcategorySets[type].add(subType);
    subcategories[type].push(subType);
    thirdCategories[type][subType] = [];
    thirdCategorySets[type][subType] = new Set();
  }

  if (subType && thirdType && !thirdCategorySets[type][subType].has(thirdType)) {
    thirdCategorySets[type][subType].add(thirdType);
    thirdCategories[type][subType].push(thirdType);
  }
}

function readOpeningBalanceRowsFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new HttpError(400, "Excel中没有工作表");

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false
  }).map((row) => {
    const normalized = {};
    Object.keys(row).forEach((key) => {
      normalized[String(key).trim()] = typeof row[key] === "string" ? row[key].trim() : row[key];
    });
    return normalized;
  }).filter((row) => Object.values(row).some((value) => String(value).trim() !== ""));

  if (!rows.length) throw new HttpError(400, "Excel中没有可导入的明细");
  return rows;
}

function isStockManaged(product) {
  return product.stockManaged !== false;
}

function getProduct(store, skuId) {
  const product = store.products.find((item) => item.skuId === skuId);
  if (!product) throw new HttpError(404, `商品不存在：${skuId}`);
  return product;
}

function getStock(store, skuId) {
  const stock = store.inventory.find((item) => item.skuId === skuId && (!item.warehouseId || item.warehouseId === "wh-sale"));
  if (!stock) throw new HttpError(404, `库存不存在：${skuId}`);
  return stock;
}

function getUser(store, userId) {
  const user = store.users.find((item) => item.id === userId && item.status === "active");
  if (!user) throw new HttpError(404, `员工不存在或已停用：${userId}`);
  return user;
}

function getCurrentUser(store, userId) {
  if (!userId) return store.users[0];
  return getUser(store, userId);
}

function withPermissionNames(store, user) {
  return {
    ...user,
    permissionNames: user.permissions.map((code) => store.permissionLabels[code] || code)
  };
}

function hasPermission(user, permission) {
  if (permission === "report:view_self" && user.permissions.includes("report:view")) return true;
  return user.permissions.includes(permission);
}

function createProduct(store, payload) {
  const skuId = payload.skuId || `sku-${Date.now()}`;
  if (store.products.some((item) => item.skuId === skuId)) {
    throw new HttpError(409, "SKU 已存在");
  }

  const product = {
    skuId,
    name: requireText(payload.name, "商品名称"),
    type: requireText(payload.type, "商品类型"),
    subType: payload.subType || "",
    thirdType: payload.thirdType || "",
    unit: payload.unit || "件",
    costPrice: Number(payload.costPrice || 0),
    salePrice: Number(payload.salePrice || 0),
    trackSerial: Boolean(payload.trackSerial),
    stockManaged: payload.stockManaged === false ? false : payload.type !== "维修",
    warningLine: Number(payload.warningLine || 0)
  };

  store.products.push(product);
  if (isStockManaged(product)) {
    store.inventory.push({ skuId, quantity: 0, serials: [] });
  }
  return product;
}

function createPurchase(store, payload) {
  const operator = getUser(store, requireText(payload.operatorId, "经办员工"));
  const items = requireItems(payload.items).map((item) => {
    const product = getProduct(store, item.skuId);
    if (!isStockManaged(product)) {
      throw new HttpError(400, `${product.name} 是服务商品，不需要采购入库`);
    }
    const stock = getStock(store, item.skuId);
    const quantity = Number(item.quantity || 0);
    if (quantity <= 0) throw new HttpError(400, "入库数量必须大于 0");

    const serials = item.serials || [];
    if (product.trackSerial && serials.length !== quantity) {
      throw new HttpError(400, `${product.name} 的串码数量必须等于入库数量`);
    }
    ensureUniqueSerials(store, serials);

    stock.quantity += quantity;
    serials.forEach((serialNo) => {
      stock.serials.push({ no: serialNo, status: "可售" });
    });

    return {
      skuId: product.skuId,
      name: product.name,
      quantity,
      costPrice: Number(item.costPrice ?? product.costPrice),
      serials
    };
  });

  const order = {
    id: makeId("PO"),
    supplier: requireText(payload.supplier, "供应商"),
    operatorId: operator.id,
    operator: operator.name,
    items,
    createdAt: nowIso()
  };

  store.purchases.unshift(order);
  items.forEach((item) => addMovement(store, {
    type: "采购入库",
    skuId: item.skuId,
    product: item.name,
    quantity: item.quantity,
    operator,
    sourceType: "purchase_order",
    sourceId: order.id
  }));

  addOperationLog(store, operator, "purchase:create", `采购入库 ${order.id}`);
  return order;
}

function createSale(store, payload) {
  const operator = getUser(store, requireText(payload.operatorId, "经办员工"));
  const items = requireItems(payload.items).map((item) => {
    const product = getProduct(store, item.skuId);
    const stockManaged = isStockManaged(product);
    const stock = stockManaged ? getStock(store, item.skuId) : null;
    const quantity = Number(item.quantity || 0);
    if (quantity <= 0) throw new HttpError(400, "销售数量必须大于 0");
    if (stockManaged && stock.quantity < quantity) throw new HttpError(409, `${product.name} 库存不足`);

    const serialNo = item.serialNo || "";
    if (product.trackSerial) {
      if (!serialNo) throw new HttpError(400, `${product.name} 必须选择串码`);
      const serial = stock.serials.find((entry) => entry.no === serialNo);
      if (!serial) throw new HttpError(404, `串码不存在：${serialNo}`);
      if (!["可售", "未激活"].includes(serial.status)) throw new HttpError(409, `串码不可售：${serialNo}`);
      serial.status = product.type === "号卡" ? "已售未激活" : "已售";
    }

    if (stockManaged) {
      stock.quantity -= quantity;
    }
    const salePrice = Number(item.salePrice ?? product.salePrice);
    const costPrice = Number(item.costPrice ?? product.costPrice);
    return {
      skuId: product.skuId,
      name: product.name,
      type: product.type,
      subType: product.subType || "",
      thirdType: product.thirdType || "",
      stockManaged,
      quantity,
      salePrice,
      costPrice,
      serialNo
    };
  });

  const amount = items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0);
  const cost = items.reduce((sum, item) => sum + item.costPrice * item.quantity, 0);
  const order = {
    id: makeId("SO"),
    operatorId: operator.id,
    operator: operator.name,
    paymentMethod: payload.paymentMethod || "微信收款",
    amount,
    profit: amount - cost,
    createdAt: nowIso(),
    items
  };

  store.sales.unshift(order);
  items.filter((item) => item.stockManaged).forEach((item) => addMovement(store, {
    type: "销售出库",
    skuId: item.skuId,
    product: item.name,
    quantity: -item.quantity,
    operator,
    sourceType: "sale_order",
    sourceId: order.id
  }));

  addOperationLog(store, operator, "sale:create", `销售出库 ${order.id}`);
  return order;
}

function getDashboard(store, userId) {
  const currentUser = getCurrentUser(store, userId);
  const today = new Date().toISOString().slice(0, 10);
  const allTodaySales = store.sales.filter((order) => order.createdAt.slice(0, 10) === today);
  const todaySales = hasPermission(currentUser, "report:view_self") && !hasPermission(currentUser, "report:view")
    ? allTodaySales.filter((order) => order.operatorId === currentUser.id)
    : allTodaySales;
  const inventory = listInventory(store);
  const staffSource = hasPermission(currentUser, "report:view_self") && !hasPermission(currentUser, "report:view")
    ? [currentUser]
    : store.users;
  const staffSales = staffSource.map((user) => {
    const amount = todaySales
      .filter((order) => order.operatorId === user.id)
      .reduce((sum, order) => sum + order.amount, 0);
    return { id: user.id, name: user.name, role: user.role, todaySales: amount };
  });

  return {
    salesAmount: todaySales.reduce((sum, order) => sum + order.amount, 0),
    profit: hasPermission(currentUser, "finance:view_profit")
      ? todaySales.reduce((sum, order) => sum + order.profit, 0)
      : 0,
    orderCount: todaySales.length,
    stockCost: inventory.filter((item) => isStockManaged(item)).reduce((sum, item) => sum + item.quantity * item.costPrice, 0),
    warningItems: inventory.filter((item) => isStockManaged(item) && item.quantity <= item.warningLine),
    staffSales,
    canViewProfit: hasPermission(currentUser, "finance:view_profit")
  };
}

function getModules(store, userId) {
  const currentUser = getCurrentUser(store, userId);
  const inventory = listInventory(store);
  const warningCount = inventory.filter((item) => isStockManaged(item) && item.quantity <= item.warningLine).length;
  const groups = [
    {
      group: "资料",
      items: [
        { name: "商品资料", permission: "product:view", desc: `${store.products.length} 个 SKU`, path: "/pages/inventory/inventory", status: "已接入" },
        { name: "往来单位", permission: "finance:view", desc: `${store.suppliers.length} 个供应商 / ${store.customers.length} 个客户`, path: "", status: "待深化" },
        { name: "员工权限", permission: "employee:manage", desc: `${store.users.length} 个账号`, path: "/pages/profile/profile", status: "已接入" }
      ]
    },
    {
      group: "进货",
      items: [
        { name: "采购入库", permission: "purchase:create", desc: "录供应商、数量、串码", path: "/pages/purchase/purchase", status: "已接入" },
        { name: "采购退货", permission: "purchase:return", desc: "退回供应商并冲库存", path: "", status: "待接入" },
        { name: "进货查询", permission: "purchase:create", desc: `${store.purchases.length} 张采购单`, path: "/pages/purchase/purchase", status: "已接入" }
      ]
    },
    {
      group: "销售",
      items: [
        { name: "销售开单", permission: "sale:create", desc: "扣库存并记员工业绩", path: "/pages/sales/sales", status: "已接入" },
        { name: "销售退货", permission: "sale:return", desc: "关联原单退货入库", path: "", status: "待接入" },
        { name: "销售查询", permission: "report:view_self", desc: `${store.sales.length} 张销售单`, path: "/pages/reports/reports", status: "已接入" }
      ]
    },
    {
      group: "库存",
      items: [
        { name: "期初建账", permission: "opening_balance:import", desc: "按三级目录导入Excel", path: "/pages/opening-balance/opening-balance", status: "已接入" },
        { name: "库存查询", permission: "stock:view", desc: `${inventory.length} 类商品`, path: "/pages/inventory/inventory", status: "已接入" },
        { name: "库存盘点", permission: "stock:adjust", desc: "盘盈盘亏留痕", path: "", status: "待接入" },
        { name: "库存报警", permission: "stock:view", desc: `${warningCount} 个预警`, path: "/pages/inventory/inventory", status: "已接入" },
        { name: "串码跟踪", permission: "stock:view", desc: "IMEI / ICCID 状态", path: "/pages/inventory/inventory", status: "已接入" }
      ]
    },
    {
      group: "财务",
      items: [
        { name: "应收应付", permission: "finance:view", desc: "客户欠款和供应商欠款", path: "/pages/finance/finance", status: "已接入" },
        { name: "收款付款", permission: "finance:view", desc: "微信、现金、银行卡账户", path: "/pages/finance/finance", status: "已接入" },
        { name: "费用支出", permission: "finance:view", desc: `${store.expenses.length} 条费用`, path: "/pages/finance/finance", status: "已接入" }
      ]
    },
    {
      group: "报表",
      items: [
        { name: "销售报表", permission: "report:view_self", desc: "销售额、毛利、客单", path: "/pages/reports/reports", status: "已接入" },
        { name: "商品报表", permission: "report:view", desc: "热销和滞销", path: "/pages/reports/reports", status: "已接入" },
        { name: "员工业绩", permission: "report:view", desc: "按员工汇总", path: "/pages/reports/reports", status: "已接入" }
      ]
    }
  ];

  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => hasPermission(currentUser, item.permission))
    }))
    .filter((group) => group.items.length > 0);
}

function getFinance(store, userId) {
  const currentUser = getCurrentUser(store, userId);
  if (!hasPermission(currentUser, "finance:view")) {
    throw new HttpError(403, "当前角色无权查看财务");
  }
  const receivable = store.customers.reduce((sum, item) => sum + item.receivable, 0);
  const payable = store.suppliers.reduce((sum, item) => sum + item.payable, 0);
  const accountBalance = store.accounts.reduce((sum, item) => sum + item.balance, 0);
  const expenseAmount = store.expenses.reduce((sum, item) => sum + item.amount, 0);
  return {
    receivable,
    payable,
    accountBalance,
    expenseAmount,
    customers: store.customers,
    suppliers: store.suppliers,
    accounts: store.accounts,
    expenses: store.expenses
  };
}

function getReports(store, userId) {
  const currentUser = getCurrentUser(store, userId);
  if (!hasPermission(currentUser, "report:view") && !hasPermission(currentUser, "report:view_self")) {
    throw new HttpError(403, "当前角色无权查看报表");
  }
  const visibleSales = hasPermission(currentUser, "report:view")
    ? store.sales
    : store.sales.filter((order) => order.operatorId === currentUser.id);
  const productRows = store.products.map((product) => {
    const soldQuantity = visibleSales.reduce((sum, order) => {
      return sum + order.items
        .filter((item) => item.skuId === product.skuId)
        .reduce((itemSum, item) => itemSum + item.quantity, 0);
    }, 0);
    const salesAmount = visibleSales.reduce((sum, order) => {
      return sum + order.items
        .filter((item) => item.skuId === product.skuId)
        .reduce((itemSum, item) => itemSum + item.quantity * item.salePrice, 0);
    }, 0);
    return {
      skuId: product.skuId,
      name: product.name,
      type: product.type,
      subType: product.subType || "",
      thirdType: product.thirdType || "",
      soldQuantity,
      salesAmount
    };
  });

  const staffRows = store.users.map((user) => {
    const orders = visibleSales.filter((order) => order.operatorId === user.id);
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      orderCount: orders.length,
      salesAmount: orders.reduce((sum, order) => sum + order.amount, 0),
      profit: hasPermission(currentUser, "finance:view_profit")
        ? orders.reduce((sum, order) => sum + order.profit, 0)
        : 0
    };
  });

  const totalSales = visibleSales.reduce((sum, order) => sum + order.amount, 0);
  const totalProfit = hasPermission(currentUser, "finance:view_profit")
    ? visibleSales.reduce((sum, order) => sum + order.profit, 0)
    : 0;
  return {
    totalSales,
    totalProfit,
    orderCount: visibleSales.length,
    avgOrderAmount: visibleSales.length ? Math.round(totalSales / visibleSales.length) : 0,
    canViewProfit: hasPermission(currentUser, "finance:view_profit"),
    productRows: productRows.sort((a, b) => b.salesAmount - a.salesAmount),
    staffRows: staffRows.sort((a, b) => b.salesAmount - a.salesAmount),
    recentSales: visibleSales.slice(0, 8)
  };
}

function getDailyReport(store, userId, date) {
  const currentUser = getCurrentUser(store, userId);
  if (!hasPermission(currentUser, "report:view") && !hasPermission(currentUser, "report:view_self")) {
    throw new HttpError(403, "当前角色无权查看每日报表");
  }

  const reportDate = date || chinaDate();
  const allDaySales = store.sales.filter((order) => chinaDate(order.createdAt) === reportDate);
  const visibleSales = hasPermission(currentUser, "report:view")
    ? allDaySales
    : allDaySales.filter((order) => order.operatorId === currentUser.id);
  const dayExpenses = hasPermission(currentUser, "finance:view")
    ? store.expenses.filter((expense) => chinaDate(expense.createdAt) === reportDate)
    : [];
  const canViewProfit = hasPermission(currentUser, "finance:view_profit");

  const summary = visibleSales.reduce((result, order) => {
    result.salesAmount += Number(order.amount || 0);
    result.grossProfit += canViewProfit ? Number(order.profit || 0) : 0;
    result.orderCount += 1;
    result.receivedAmount += Number(order.receivedAmount ?? order.amount ?? 0);
    return result;
  }, {
    salesAmount: 0,
    grossProfit: 0,
    orderCount: 0,
    receivedAmount: 0,
    returnAmount: 0,
    expenseAmount: dayExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    netAmount: 0
  });
  summary.netAmount = canViewProfit ? summary.grossProfit - summary.expenseAmount : 0;

  const categoryMap = new Map();
  visibleSales.forEach((order) => {
    order.items.forEach((item) => {
      const product = store.products.find((entry) => entry.skuId === item.skuId) || {};
      const category = product.type || item.type || "其他";
      const row = categoryMap.get(category) || {
        category,
        salesAmount: 0,
        grossProfit: 0,
        quantity: 0,
        orderCount: 0
      };
      row.salesAmount += Number(item.salePrice || 0) * Number(item.quantity || 0);
      row.grossProfit += canViewProfit ? (Number(item.salePrice || 0) - Number(item.costPrice || 0)) * Number(item.quantity || 0) : 0;
      row.quantity += Number(item.quantity || 0);
      row.orderCount += 1;
      categoryMap.set(category, row);
    });
  });

  const paymentMap = new Map();
  visibleSales.forEach((order) => {
    const name = order.paymentMethod || "未填写";
    const row = paymentMap.get(name) || { paymentMethod: name, amount: 0, orderCount: 0 };
    row.amount += Number(order.receivedAmount ?? order.amount ?? 0);
    row.orderCount += 1;
    paymentMap.set(name, row);
  });

  const staffRows = store.users.map((user) => {
    const orders = visibleSales.filter((order) => order.operatorId === user.id);
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      salesAmount: orders.reduce((sum, order) => sum + Number(order.amount || 0), 0),
      grossProfit: canViewProfit ? orders.reduce((sum, order) => sum + Number(order.profit || 0), 0) : 0,
      orderCount: orders.length
    };
  }).filter((row) => row.orderCount > 0 || hasPermission(currentUser, "report:view"));

  return {
    date: reportDate,
    canViewProfit,
    summary,
    categoryStats: Array.from(categoryMap.values()).sort((a, b) => b.salesAmount - a.salesAmount),
    paymentStats: Array.from(paymentMap.values()).sort((a, b) => b.amount - a.amount),
    staffStats: staffRows.sort((a, b) => b.salesAmount - a.salesAmount),
    recentOrders: visibleSales.slice(0, 10),
    expenses: dayExpenses
  };
}

function addMovement(store, payload) {
  store.movements.unshift({
    id: makeId("MV"),
    type: payload.type,
    skuId: payload.skuId,
    product: payload.product,
    quantity: payload.quantity,
    operatorId: payload.operator.id,
    operator: payload.operator.name,
    sourceType: payload.sourceType,
    sourceId: payload.sourceId,
    createdAt: nowIso()
  });
}

function addOperationLog(store, operator, action, detail) {
  store.operationLogs.unshift({
    id: makeId("LOG"),
    operatorId: operator.id,
    operator: operator.name,
    action,
    detail,
    createdAt: nowIso()
  });
}

function requireText(value, label) {
  if (!value || typeof value !== "string") throw new HttpError(400, `${label}不能为空`);
  return value.trim();
}

function requireItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, "明细不能为空");
  }
  return items;
}

function ensureUniqueSerials(store, serials) {
  const seen = new Set();
  serials.forEach((serialNo) => {
    if (seen.has(serialNo)) throw new HttpError(409, `本次入库串码重复：${serialNo}`);
    seen.add(serialNo);
    const exists = store.inventory.some((stock) => stock.serials.some((serial) => serial.no === serialNo));
    if (exists) throw new HttpError(409, `串码已存在：${serialNo}`);
  });
}

module.exports = {
  listInventory,
  getCategories,
  getSubcategories,
  getThirdCategories,
  getCategoryHierarchy,
  getCategoryTree,
  getOpeningBalanceTemplate,
  getOpeningBalanceStatus,
  importOpeningBalance,
  readOpeningBalanceRowsFromWorkbook,
  withPermissionNames,
  createProduct,
  createPurchase,
  createSale,
  getDashboard,
  getModules,
  getFinance,
  getReports,
  getDailyReport
};
