/**
 * 角色与权限目录（单一来源，TASK-230）
 *
 * 设计目标：
 *  - 细粒度权限点（PERMISSIONS）描述“能做什么”，与角色解耦。
 *  - 角色（ROLE_PERMISSIONS）是权限点的集合；'*' 表示全部权限。
 *  - 兼容存量：legacy 角色 'super' 等同 'super_admin'；admin_users.permissions 含 '*' 视为全权限。
 *  - 最终有效权限 = 角色权限 ∪ admin_users.permissions（额外授予）。
 *
 * 由 scripts/sync-cloudfunction-shared.js 同步到各 admin 云函数，禁止在各云函数内维护副本。
 */

// 细粒度权限点（字符串常量，便于全局搜索与审计）
const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  PRODUCT_VIEW: 'product.view',
  PRODUCT_MANAGE: 'product.manage',
  BANNER_MANAGE: 'banner.manage',
  COUPON_MANAGE: 'coupon.manage',
  COUPON_SEND: 'coupon.send',
  MEMBERLEVEL_MANAGE: 'memberlevel.manage',
  ORDER_VIEW: 'order.view',
  ORDER_SHIP: 'order.ship',
  ORDER_REFUND: 'order.refund',
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  USER_SENSITIVE_VIEW: 'user.sensitive', // TASK-350：查看用户敏感信息（真实手机号/地址详情）的二次授权

  SHOPSETTINGS_VIEW: 'shopsettings.view',
  SHOPSETTINGS_MANAGE: 'shopsettings.manage',
  FINANCE_VIEW: 'finance.view',
  ADMIN_RESET_PASSWORD: 'admin.resetPassword',
  SYSTEM_INIT: 'system.init',
  AUDIT_VIEW: 'audit.view' // TASK-240：查看管理员操作审计日志
}

/**
 * 角色 → 权限集合。
 *  - '*' 表示全部权限（超管）。
 *  - legacy 'super' 兼容存量种子账号（role:'super', permissions:['*']）。
 *  - operator 为“门店运营”宽权限，但不含 admin.resetPassword / system.init（避免所有人都能重置密码/运维）。
 */
const ROLE_PERMISSIONS = {
  super_admin: '*',
  super: '*', // 兼容存量

  operator: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.PRODUCT_VIEW,
    PERMISSIONS.PRODUCT_MANAGE,
    PERMISSIONS.BANNER_MANAGE,
    PERMISSIONS.COUPON_MANAGE,
    PERMISSIONS.COUPON_SEND,
    PERMISSIONS.MEMBERLEVEL_MANAGE,
    PERMISSIONS.ORDER_VIEW,
    PERMISSIONS.ORDER_SHIP,
    PERMISSIONS.ORDER_REFUND,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.USER_SENSITIVE_VIEW,
    PERMISSIONS.SHOPSETTINGS_VIEW,
    PERMISSIONS.SHOPSETTINGS_MANAGE,
    PERMISSIONS.FINANCE_VIEW,
    PERMISSIONS.AUDIT_VIEW
  ],

  finance: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.FINANCE_VIEW,
    PERMISSIONS.ORDER_VIEW,
    PERMISSIONS.ORDER_REFUND
  ],

  product_manager: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.PRODUCT_VIEW,
    PERMISSIONS.PRODUCT_MANAGE,
    PERMISSIONS.BANNER_MANAGE
  ],

  order_manager: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.ORDER_VIEW,
    PERMISSIONS.ORDER_SHIP
  ],

  customer_service: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.ORDER_VIEW,
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.USER_SENSITIVE_VIEW
  ],

  viewer: [
    PERMISSIONS.DASHBOARD_VIEW
  ]
}

/**
 * 计算管理员的有效权限集合。
 * @param {Object} admin admin_users 文档（需含 role 与可选 permissions）
 * @returns {string[]} 权限点数组；含 '*' 表示全部权限。
 */
function getEffectivePermissions(admin) {
  if (!admin || typeof admin !== 'object') return []

  // admin_users.permissions 显式含 '*' → 全权限
  if (Array.isArray(admin.permissions) && admin.permissions.includes('*')) {
    return ['*']
  }

  const perms = new Set()

  const rolePerms = ROLE_PERMISSIONS[admin.role]
  if (rolePerms === '*') return ['*']
  if (Array.isArray(rolePerms)) {
    rolePerms.forEach((p) => perms.add(p))
  }

  // 额外授予（叠加在角色之上）
  if (Array.isArray(admin.permissions)) {
    admin.permissions.forEach((p) => perms.add(p))
  }

  return Array.from(perms)
}

/**
 * 校验管理员是否拥有所需的全部权限点。
 * @param {Object} admin admin_users 文档
 * @param {string[]} required 所需权限点
 * @returns {boolean}
 */
function hasPermissions(admin, required) {
  if (!Array.isArray(required) || required.length === 0) return true
  const eff = getEffectivePermissions(admin)
  if (eff.includes('*')) return true
  return required.every((p) => eff.includes(p))
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  getEffectivePermissions,
  hasPermissions
}
