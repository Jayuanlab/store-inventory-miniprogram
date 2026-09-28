# 门店进销存后端

当前运行 Node.js 原生 HTTP 服务和 SQLite 事务存储，数据库为 `server/data/store.sqlite`。原 JSON 只用于首次初始化，不再作为实时账套。启动及正式微信配置见根目录 README。

## 运行与验证

```sh
npm run server
npm run server:test
npm run suppliers:test
npm run backup
```

默认地址 http://127.0.0.1:3100，`GET /health` 为公开健康检查。本机体验登录只在开发模式、未配置微信密钥且请求来自回环地址时开放。

## 认证与提交

```http
POST /api/auth/login
Content-Type: application/json

{"userId":"u1"}
```

以上仅为本机体验。正式登录提交 `{"code":"wx.login返回的code"}`，由服务端调用微信接口并匹配已绑定员工。

所有业务接口使用 `Authorization: Bearer <token>`。除只读预览外，业务 POST 还需要唯一的 `Idempotency-Key`。相同用户、路径和编号重试同一内容返回原结果；同编号不同内容拒绝。后端以登录身份校验权限，不信任请求体里的操作者 ID。

## 供应商接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | /api/suppliers | 往来列表 / 创建或更新档案 |
| GET | /api/suppliers/directory | 采购可用的供应商基本资料，不含余额 |
| GET | /api/supplier-detail?id=... | 四类余额、未结项、核销、进退货 |
| POST | /api/supplier-opening | 老板确认四类期初，已有往来时不可叠加 |
| POST | /api/supplier-payments | 付款，可传 allocations 分配到多张待付 |
| POST | /api/supplier-refunds | 从现金应退或预付款中记录真实到账 |
| POST | /api/supplier-offsets | 可用款项抵一笔待付，不产生现金 |
| POST | /api/supplier-offsets/reverse | 撤销本版本抵扣或付款分配，保留资金记录 |
| POST | /api/supplier-adjustments | 有依据的往来调整，不自动修改库存成本 |
| GET | /api/supplier-candidates?id=... | 原采购明细及可追溯串码 |
| POST | /api/supplier-prices/preview | 只读计算调价和成本去向，返回 previewToken |
| POST | /api/supplier-prices | 校验同一份 previewToken 后原子确认 |
| POST | /api/purchase-returns/preview | 只读预览采购退货款和出库成本 |
| POST | /api/purchase-returns | 校验预览，确认实物退回及供应商认可款项 |
| GET / POST | /api/procurement-plans | 查看 / 登记订货，可预付、不入可售库存 |
| POST | /api/procurement-plans/close | 注明原因终止余货，不自动退款 |
| GET / POST | /api/purchase-orders | 查看收货记录 / 实收到货，可关联 planId |
| GET | /api/supplier-statement?id=...&from=YYYY-MM-DD&to=YYYY-MM-DD | 期间对账明细 |
| GET | /api/supplier-statement/export?id=...&from=YYYY-MM-DD&to=YYYY-MM-DD | Excel 对账单 |

付款示例，ID 必须来自当前账套：

```json
{
  "supplierId": "<供应商ID>",
  "amount": 1500,
  "account": "银行卡",
  "date": "2026-09-06",
  "allocations": [
    {"targetId": "<待付往来项ID>", "amount": 1000}
  ],
  "note": "剩余500留作预付款"
}
```

订货收货先从 `GET /api/procurement-plans` 读取 `receiptToken`。有往来查看权限时同时返回 `prepayment.availableAmount`；仓管只获得不含金额的确认标识。收货提交示例：

```json
{
  "supplierId": "<供应商ID>",
  "planId": "<订货单ID>",
  "receiptToken": "<订货列表返回的确认标识>",
  "items": [{ "planItemId": "<订货明细ID>", "skuId": "<商品ID>", "quantity": 1, "costPrice": 1556, "serials": ["<实收串码>"] }]
}
```

关联订货的收货接口不接受新增付款或手动抵款参数；服务端在入库事务中自动抵用该单可用预付款。进度或余额变化返回 409，刷新标识后再确认；重试使用原 `Idempotency-Key`。直接进货（无 `planId`）仍可记录本次付款或手动抵用。

`POST /api/supplier-payments` 可传 `planId`，将本次实际付款明确关联到同供应商的待收货订货单，不能同时传 `orderId` 或非空 `allocations`。补已收货单的尾款继续使用 `allocations`。

调价示例：确认时增加预览返回的 `previewToken`，其余内容保持一致。

```json
{
  "supplierId": "<供应商ID>",
  "purchaseId": "<进货单ID>",
  "itemId": "<原进货明细ID>",
  "scope": "all",
  "direction": "decrease",
  "unitAmount": 100,
  "kind": "credit",
  "reference": "双方约定编号-明细01",
  "note": "本批全部商品每件补100，只抵货款"
}
```

`scope` 可为 `inventory`（当前库存）、`all`（整批含已售）、`selected`（指定串码，另传 serialNos）。`kind` 为 `cash`（可退现金及抵货款）或 `credit`（仅抵货款）；追加进价自动形成 payable。原单、原提成与工资快照不被覆盖。

默认只有老板能确认供应商资金和成本变化；店长可看往来、建档、订货与收货；仓管只在有采购权限时登记实际进货，不返回结款余额。详细业务规则与限制见 `docs/supplier-current-account-implementation.md`。

## 其他业务

商品、库存、销售、原单退货、号卡佣金、工资、日报、期初导入接口由 `src/application.js` 路由。对应业务模块为 `erp.js`、`payroll.js`、`suppliers.js` 和 `supplier-costs.js`。旧 `services.js` 仅保留分类与 Excel 期初等兼容能力，不作为当前销售或供应商接口的入口。

预览不修改业务数据；确认在同一 SQLite 写事务中验证并写入库存、成本、往来和操作日志。金额、主体、串码状态不符或预览已过期时返回 4xx，整笔回滚。
