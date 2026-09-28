const { INVENTORY_CATEGORIES, INVENTORY_SUBCATEGORIES, INVENTORY_THIRD_CATEGORIES } = require("./inventory-categories");

function createStoreData() {
  return {
    currentUser: {
      id: "u1",
      name: "示例老板",
      role: "老板",
      roleCode: "owner",
      permissions: ["看成本", "看利润", "管理员工", "作废单据", "opening_balance:import"]
    },
    staff: [
      { id: "u1", name: "示例老板", role: "老板", todaySales: 0 },
      { id: "u2", name: "示例员工甲", role: "员工", todaySales: 5699 },
      { id: "u3", name: "示例员工乙", role: "员工", todaySales: 1398 },
      { id: "u5", name: "示例仓管", role: "仓库员", todaySales: 0 }
    ],
    categories: INVENTORY_CATEGORIES,
    subcategories: INVENTORY_SUBCATEGORIES,
    thirdCategories: INVENTORY_THIRD_CATEGORIES,
    products: [
      {
        skuId: "sku-phone-15",
        name: "iPhone 15 128G 黑色",
        type: "智能手机",
        subType: "苹果",
        thirdType: "终端公司",
        unit: "台",
        costPrice: 4650,
        salePrice: 5299,
        trackSerial: true
      },
      {
        skuId: "sku-card-29",
        name: "移动 29 元套餐卡",
        type: "号卡",
        unit: "张",
        costPrice: 35,
        salePrice: 99,
        trackSerial: true
      },
      {
        skuId: "sku-cable-c",
        name: "Type-C 快充数据线",
        type: "配件",
        unit: "条",
        costPrice: 9,
        salePrice: 29,
        trackSerial: false
      },
      {
        skuId: "sku-repair-screen",
        name: "维修服务-更换屏幕",
        type: "维修",
        unit: "项",
        costPrice: 185,
        salePrice: 380,
        trackSerial: false,
        stockManaged: false
      },
      {
        skuId: "sku-repair-battery",
        name: "维修服务-更换电池",
        type: "维修",
        unit: "项",
        costPrice: 65,
        salePrice: 180,
        trackSerial: false,
        stockManaged: false
      }
    ],
    inventory: [
      {
        skuId: "sku-phone-15",
        name: "iPhone 15 128G 黑色",
        type: "智能手机",
        subType: "苹果",
        thirdType: "终端公司",
        quantity: 3,
        warningLine: 2,
        costPrice: 4650,
        salePrice: 5299,
        serials: [
          { no: "IMEI 356789100023451", status: "可售" },
          { no: "IMEI 356789100023452", status: "可售" },
          { no: "IMEI 356789100023453", status: "退货待检" }
        ]
      },
      {
        skuId: "sku-card-29",
        name: "移动 29 元套餐卡",
        type: "号卡",
        quantity: 8,
        warningLine: 5,
        costPrice: 35,
        salePrice: 99,
        serials: [
          { no: "ICCID 898600221900001", status: "可售" },
          { no: "ICCID 898600221900002", status: "已预留" },
          { no: "ICCID 898600221900003", status: "可售" }
        ]
      },
      {
        skuId: "sku-cable-c",
        name: "Type-C 快充数据线",
        type: "配件",
        quantity: 42,
        warningLine: 10,
        costPrice: 9,
        salePrice: 29,
        serials: []
      },
      {
        skuId: "sku-repair-screen",
        name: "维修服务-更换屏幕",
        type: "维修",
        unit: "项",
        quantity: 1,
        warningLine: 0,
        costPrice: 185,
        salePrice: 380,
        stockManaged: false,
        serials: []
      },
      {
        skuId: "sku-repair-battery",
        name: "维修服务-更换电池",
        type: "维修",
        unit: "项",
        quantity: 1,
        warningLine: 0,
        costPrice: 65,
        salePrice: 180,
        stockManaged: false,
        serials: []
      }
    ],
    sales: [
      {
        id: "SO20260829001",
        operator: "示例员工甲",
        amount: 5299,
        profit: 649,
        createdAt: "10:42",
        items: [
          {
            skuId: "sku-phone-15",
            name: "iPhone 15 128G 黑色",
            quantity: 1,
            salePrice: 5299,
            costPrice: 4650,
            serialNo: "IMEI 356789100023450"
          }
        ]
      },
      {
        id: "SO20260829002",
        operator: "示例员工乙",
        amount: 128,
        profit: 84,
        createdAt: "11:18",
        items: [
          {
            skuId: "sku-card-29",
            name: "移动 29 元套餐卡",
            quantity: 1,
            salePrice: 99,
            costPrice: 35,
            serialNo: "ICCID 898600221900000"
          },
          {
            skuId: "sku-cable-c",
            name: "Type-C 快充数据线",
            quantity: 1,
            salePrice: 29,
            costPrice: 9
          }
        ]
      }
    ],
    purchases: [
      {
        id: "PO20260828001",
        supplier: "华强北渠道 A",
        operator: "示例老板",
        createdAt: "昨天",
        items: [
          {
            skuId: "sku-phone-15",
            name: "iPhone 15 128G 黑色",
            quantity: 3,
            serials: ["IMEI 356789100023451", "IMEI 356789100023452", "IMEI 356789100023453"]
          }
        ]
      }
    ],
    movements: [
      {
        id: "MV001",
        type: "销售出库",
        product: "iPhone 15 128G 黑色",
        quantity: -1,
        operator: "示例员工甲",
        createdAt: "10:42"
      },
      {
        id: "MV002",
        type: "采购入库",
        product: "iPhone 15 128G 黑色",
        quantity: 3,
        operator: "示例老板",
        createdAt: "昨天"
      },
      {
        id: "MV003",
        type: "盘点调整",
        product: "Type-C 快充数据线",
        quantity: -2,
        operator: "示例老板",
        createdAt: "周四"
      }
    ]
  };
}

module.exports = {
  createStoreData
};
