const http = require("http");
const { randomBytes, createHash } = require("crypto");
const { readStore, transaction } = require("./repository");
const { sendJson, readJsonBody, readMultipartForm } = require("./http");
const c = require("./common");
const erp = require("./erp");
const payroll = require("./payroll");
const legacy = require("./services");
const suppliers = require("./suppliers");
const supplierCosts = require("./supplier-costs");
const sessions = new Map();
const loopback = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const developmentLogin = (req) =>
  process.env.NODE_ENV !== "production" &&
  !process.env.WECHAT_APP_SECRET &&
  loopback(req);

async function login(req, body) {
  const store = readStore();
  let user;
  if (body.code) {
    if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET)
      throw new c.HttpError(503, "微信登录尚未配置，请联系老板");
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({
      appid: process.env.WECHAT_APP_ID,
      secret: process.env.WECHAT_APP_SECRET,
      js_code: body.code,
      grant_type: "authorization_code",
    }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!result.openid || result.errcode)
      throw new c.HttpError(401, "微信登录未成功，请重试");
    user = store.users.find(
      (u) => u.openid === result.openid && u.status === "active",
    );
    if (!user) throw new c.HttpError(403, "此微信尚未绑定员工账号，请联系老板");
  } else {
    if (!developmentLogin(req)) throw new c.HttpError(403, "请使用微信登录");
    user = c.userById(store, body.userId);
  }
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  return { token, user: c.publicUser(user), localExperience: !body.code };
}
function authenticate(req, store) {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now())
    throw new c.HttpError(401, "登录已失效，请重新登录");
  return c.userById(store, session.userId);
}
function getResult(path, query, store, user) {
  switch (path) {
    case "/api/me":
      return c.publicUser(user);
    case "/api/users":
      return store.users.map(c.publicUser);
    case "/api/products":
      return erp.listProducts(store, user);
    case "/api/inventory":
      return erp.inventory(store, user);
    case "/api/categories":
      return [...new Set(store.products.map((p) => p.type))];
    case "/api/category-hierarchy":
      return legacy.getCategoryHierarchy(store);
    case "/api/stock-movements":
      return store.movements.slice(0, 200).map((m) => {
        const { cost, ...row } = m;
        return c.capabilities(user).cost ? m : row;
      });
    case "/api/purchase-orders":
      return suppliers.purchaseRows(store, user);
    case "/api/suppliers/directory":
      return suppliers.directory(store, user);
    case "/api/suppliers":
      return suppliers.list(store, user, query.get("q") || "");
    case "/api/supplier-detail":
      return suppliers.detail(store, user, query.get("id"));
    case "/api/supplier-candidates":
      return supplierCosts.candidates(store, user, query.get("id"));
    case "/api/supplier-statement":
      return suppliers.statement(
        store,
        user,
        query.get("id"),
        query.get("from"),
        query.get("to"),
      );
    case "/api/procurement-plans":
      return suppliers.planRows(store, user);
    case "/api/sale-orders":
      return erp.orders(store, user, query.get("q") || "");
    case "/api/dashboard":
    case "/api/reports":
    case "/api/daily-report":
      return erp.report(store, user, query.get("date") || c.day());
    case "/api/finance":
      return erp.finance(store, user);
    case "/api/payroll":
      return payroll.getPayroll(
        store,
        user,
        query.get("month") || c.month(),
        query.get("employeeId"),
      );
    case "/api/payroll/settings":
      return payroll.settings(store, user, query.get("month") || c.month());
    case "/api/card-businesses":
      return erp.cards(store, user);
    case "/api/opening-balance/template":
      c.permit(user, "opening");
      return legacy.getOpeningBalanceTemplate(store);
    case "/api/opening-balance/status":
      c.permit(user, "opening");
      return {
        ...legacy.getOpeningBalanceStatus(store),
        locked: erp.openingLocked(store),
        stockValue: c.round(
          store.inventory.reduce(
            (n, s) => n + s.quantity * (s.costPrice || 0),
            0,
          ),
        ),
      };
    case "/api/operation-logs":
      c.permit(user, "manageUsers");
      return store.operationLogs;
    default:
      throw new c.HttpError(404, "接口不存在");
  }
}
const actions = {
  "/api/products": ["manageProducts", erp.saveProduct],
  "/api/purchase-orders": ["purchase", erp.purchase],
  "/api/sale-orders": ["sell", erp.sale],
  "/api/sale-returns": ["returnSale", erp.returnSale],
  "/api/stocktakes": ["stocktake", erp.stocktake],
  "/api/expenses": ["finance", erp.expense],
  "/api/suppliers": ["purchase", suppliers.save],
  "/api/supplier-payments": ["supplierSettle", erp.paySupplier],
  "/api/supplier-refunds": ["supplierSettle", suppliers.refund],
  "/api/supplier-offsets": ["supplierSettle", suppliers.offset],
  "/api/supplier-offsets/reverse": ["supplierSettle", suppliers.reverseOffset],
  "/api/supplier-opening": ["opening", suppliers.opening],
  "/api/supplier-adjustments": ["supplierAdjust", suppliers.adjustment],
  "/api/supplier-prices": ["supplierAdjust", supplierCosts.confirm],
  "/api/purchase-returns": ["supplierAdjust", supplierCosts.returnPurchase],
  "/api/procurement-plans": ["purchase", suppliers.plan],
  "/api/procurement-plans/close": ["purchase", suppliers.closePlan],
  "/api/card-events": ["finance", erp.cardEvent],
  "/api/payroll/rules": ["managePay", payroll.saveRule],
  "/api/payroll/salaries": ["managePay", payroll.saveSalary],
  "/api/payroll/resolve": [
    "managePay",
    (store, user, data) =>
      payroll.resolveEntry(store, user, data.entryId, data),
  ],
  "/api/payroll/confirm": ["confirmPay", payroll.confirm],
  "/api/payroll/pay": ["confirmPay", payroll.markPaid],
  "/api/opening-balance/import": ["opening", erp.openingCommit],
  "/api/users/bind": [
    "manageUsers",
    (store, user, data) => {
      const employee = c.userById(store, data.employeeId);
      const openid = c.text(data.openid, "微信标识");
      if (store.users.some((u) => u.id !== employee.id && u.openid === openid))
        throw new c.HttpError(409, "微信已绑定其他员工");
      employee.openid = openid;
      c.audit(store, user, "user:bind", employee.name);
      return c.publicUser(employee);
    },
  ],
};
function mutate(req, path, body) {
  const action = actions[path];
  if (!action) throw new c.HttpError(404, "接口不存在");
  const key = c.text(req.headers["idempotency-key"], "请求编号");
  if (key.length > 160) throw new c.HttpError(400, "请求编号过长");
  const digest = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return transaction((store) => {
    const user = authenticate(req, store);
    c.permit(user, action[0]);
    const previous = store.requestRecords.find(
      (r) => r.key === key && r.userId === user.id && r.path === path,
    );
    if (previous) {
      if (previous.digest !== digest)
        throw new c.HttpError(409, "请求内容已变化，请重新提交");
      return previous.result;
    }
    const result = action[1](store, user, body);
    store.requestRecords.push({
      key,
      userId: user.id,
      path,
      digest,
      result,
      createdAt: c.now(),
    });
    return result;
  });
}
async function handle(req, res) {
  try {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      throw new c.HttpError(403, "不允许的请求来源");
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && ["/", "/health"].includes(path)) {
      sendJson(res, 200, {
        ok: true,
        name: "聚友通信城进销存",
        storage: "sqlite",
        message: "请在微信开发者工具中打开小程序",
      });
      return;
    }
    if (req.method === "GET" && path === "/api/auth/mode") {
      sendJson(res, 200, {
        localExperience: developmentLogin(req),
        users: developmentLogin(req) ? readStore().users.map(c.publicUser) : [],
      });
      return;
    }
    if (req.method === "POST" && path === "/api/auth/login") {
      sendJson(res, 200, await login(req, await readJsonBody(req)));
      return;
    }
    if (
      req.method === "POST" &&
      path === "/api/opening-balance/preview-excel"
    ) {
      const user = authenticate(req, readStore());
      c.permit(user, "opening");
      const form = await readMultipartForm(req);
      const file = form.files[0];
      if (!file) throw new c.HttpError(400, "请选择Excel文件");
      const rows = legacy.readOpeningBalanceRowsFromWorkbook(file.buffer);
      const preview = erp.openingPreview(readStore(), user, rows);
      sendJson(res, 200, {
        ...preview,
        sourceRows: rows,
        source: file.fileName,
      });
      return;
    }
    if (req.method === "GET") {
      const store = readStore();
      if (path === "/api/supplier-statement/export") {
        const user = authenticate(req, store);
        const report = suppliers.statement(
          store,
          user,
          url.searchParams.get("id"),
          url.searchParams.get("from"),
          url.searchParams.get("to"),
        );
        const XLSX = require("xlsx");
        const workbook = XLSX.utils.book_new();
        const labels = {
          payable: "我待付",
          cash: "对方应退",
          advance: "预付货款",
          credit: "仅抵货款",
        };
        const sheets = [
          [
            "往来余额",
            [
              ["供应商", report.supplier.name],
              ["期间", report.from, report.to],
              ["类别", "期初", "期末"],
              ...Object.keys(labels).map((k) => [
                labels[k],
                report.opening[k],
                report.closing[k],
              ]),
            ],
          ],
          [
            "往来明细",
            [
              [
                "日期",
                "业务",
                "往来类型",
                "金额",
                "原款项",
                "对应款项",
                "备注",
              ],
              ...report.rows.map((r) => [
                r.date,
                r.type,
                r.kind || "",
                r.amount,
                r.sourceId || "",
                r.targetId || "",
                r.note,
              ]),
            ],
          ],
          [
            "实际收付",
            [
              ["日期", "类型", "金额", "账户", "交易备注"],
              ...report.cash.map((r) => [
                r.date,
                r.type === "payment" ? "付款" : "收退款",
                r.type === "payment" ? -r.amount : r.amount,
                r.account,
                r.note,
              ]),
            ],
          ],
        ];
        for (const [name, rows] of sheets) {
          const sheet = XLSX.utils.aoa_to_sheet(rows);
          sheet["!cols"] = rows[0].map(() => ({ wch: 24 }));
          XLSX.utils.book_append_sheet(workbook, sheet, name);
        }
        const buffer = XLSX.write(workbook, {
          bookType: "xlsx",
          type: "buffer",
        });
        res.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition":
            'attachment; filename="supplier-statement.xlsx"',
          "Cache-Control": "no-store",
          "Content-Length": buffer.length,
        });
        res.end(buffer);
        return;
      }
      sendJson(
        res,
        200,
        getResult(path, url.searchParams, store, authenticate(req, store)),
      );
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (path === "/api/supplier-prices/preview") {
        const store = readStore();
        sendJson(
          res,
          200,
          supplierCosts.preview(store, authenticate(req, store), body),
        );
        return;
      }
      if (path === "/api/purchase-returns/preview") {
        const store = readStore();
        sendJson(
          res,
          200,
          supplierCosts.previewReturn(store, authenticate(req, store), body),
        );
        return;
      }
      sendJson(res, 200, mutate(req, path, body));
      return;
    }
    throw new c.HttpError(405, "请求方式不支持");
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: {
        message: error.statusCode
          ? error.message
          : "服务器处理失败，请稍后重试",
      },
    });
    if (!error.statusCode) console.error(error);
  }
}
function createServer() {
  return http.createServer(handle);
}
module.exports = { createServer };
