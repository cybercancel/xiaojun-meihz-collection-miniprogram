/**
 * 共享管理员鉴权模块（单一来源，TASK-210 / TASK-220 强化）。
 * 所有 admin 云函数统一使用此模块验证 token。
 * 由 scripts/sync-cloudfunction-shared.js 同步到各 admin 云函数，禁止在各云函数内联副本。
 *
 * TASK-220 强化：
 *  - token 按哈希（sha256）查询，数据库不存明文 token
 *  - fail-close：status / 过期 / 吊销任一不满足即拒绝（不再条件式跳过）
 *  - 支持 roles 权限守卫（运维函数仅 super 可调）
 *  - 兼容存量明文 token 记录（迁移期）
 */

const crypto = require('crypto')
const { getEffectivePermissions, hasPermissions } = require('./roles')

const TOKEN_HASH_ALGO = 'sha256'

function sha256Hex(s) {
  return crypto.createHash(TOKEN_HASH_ALGO).update(String(s)).digest('hex')
}

/**
 * 将 token 过期字段统一归一为毫秒时间戳。
 * 支持：number(ms) / Date / ISO 字符串；无法解析时返回 NaN（调用方据此 fail-close）。
 */
function toEpochMs(v) {
  if (v == null) return NaN
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? NaN : t
  }
  // CloudBase serverDate / 其他包装对象
  if (typeof v === 'object' && typeof v.getTime === 'function') {
    const t = v.getTime()
    return Number.isFinite(t) ? t : NaN
  }
  return NaN
}

/**
 * 验证管理员 token
 * @param {Object} event - 云函数事件对象，需包含 token 字段
 * @param {Object} db - 数据库实例
 * @param {Object} [options] - { roles: string[], permissions: string[] }（TASK-230 用 permissions）
 * @returns {Promise<Object|null>} 返回 null 表示验证通过，返回对象表示错误（{ success:false, error }）
 */
async function verifyAdmin(event, db, options = {}) {
  const { token } = event || {}
  if (!token || typeof token !== 'string') {
    return { success: false, error: '请先登录' }
  }

  const now = Date.now()
  const tokenHash = sha256Hex(token)

  // 优先按 tokenHash 查询（新格式），兼容旧明文 token 记录
  let tokenRes = await db.collection('admin_tokens')
    .where({ tokenHash: tokenHash, status: 1 })
    .limit(1)
    .get()

  if (tokenRes.data.length === 0) {
    tokenRes = await db.collection('admin_tokens')
      .where({ token: token, status: 1 })
      .limit(1)
      .get()
  }

  if (tokenRes.data.length === 0) {
    return { success: false, error: '登录已过期，请重新登录' }
  }

  const tokenData = tokenRes.data[0]

  // 主动吊销（登出 / 改密 / 风控）
  if (tokenData.revoked === true) {
    return { success: false, error: '登录已失效，请重新登录' }
  }

  // 过期检查（真 fail-close：字段缺失 / 不可解析 / 已过期，一律拒绝）
  // 注意：旧版本签发的 token 无 expireAt/expireTime 字段，此前因 `expireAt &&` 短路
  // 被当作"永不过期"放行，等同永久凭据。此处不得回退为宽松判断。
  const expireMs = toEpochMs(tokenData.expireAt) || toEpochMs(tokenData.expireTime)
  if (!Number.isFinite(expireMs) || expireMs <= now) {
    return { success: false, error: '登录已过期，请重新登录' }
  }

  // 账号状态与权限
  if (tokenData.adminId || tokenData.username) {
    const adminQuery = tokenData.adminId
      ? { _id: tokenData.adminId }
      : { username: tokenData.username }
    const adminRes = await db.collection('admin_users')
      .where(adminQuery)
      .limit(1)
      .get()

    if (adminRes.data.length === 0) {
      return { success: false, error: '账号已被禁用' }
    }
    const admin = adminRes.data[0]
    if (admin.status !== 1) {
      return { success: false, error: '账号已被禁用' }
    }

    // 角色权限校验（仅 super 可调运维函数等，兼容旧调用）
    if (Array.isArray(options.roles) && options.roles.length > 0) {
      if (!admin.role || !options.roles.includes(admin.role)) {
        return { success: false, error: '权限不足，需要更高权限' }
      }
    }

    // 权限点校验（TASK-230：不得仅验证“已登录”）
    // options.permissions 为所需权限点数组；'*' 通配放行。
    if (Array.isArray(options.permissions) && options.permissions.length > 0) {
      if (!hasPermissions(admin, options.permissions)) {
        return {
          success: false,
          error: '权限不足，缺少所需权限：' + options.permissions.join('、')
        }
      }
    }

    // TASK-240：验证通过后，将 admin 上下文注入 event.__admin，
    // 供审计模块（audit.logAudit）取用 adminId / role，不破坏现有 null 返回契约。
    if (event && typeof event === 'object') {
      event.__admin = {
        adminId: tokenData.adminId || admin._id || '',
        role: admin.role || '',
        permissions: admin.permissions || []
      }
    }
  }

  return null // 验证通过
}

/**
 * 转义正则表达式特殊字符，防止 ReDoS 攻击
 * @param {string} string - 需要转义的字符串
 * @returns {string} 转义后的字符串
 */
function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = { verifyAdmin, escapeRegExp }
