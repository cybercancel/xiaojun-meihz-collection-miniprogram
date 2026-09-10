/**
 * 密码安全模块（单一来源，TASK-220）
 *
 * 设计目标：
 *  - 新密码使用 Node 内置 crypto.scrypt + 随机盐，禁止明文 / 简单 MD5 / 固定盐 SHA / 可逆加密。
 *  - 校验使用 crypto.timingSafeEqual 防止时序侧信道。
 *  - 兼容存量 bcrypt 密码（passwordVersion 缺失或 <2），登录成功路径可一次性升级为 scrypt。
 *  - 生产环境默认禁止 legacy 无盐 MD5 登录（ALLOW_LEGACY_MD5 默认 false）。
 *
 * 由 scripts/sync-cloudfunction-shared.js 同步到各需要的云函数，禁止在各云函数内维护副本。
 */

const crypto = require('crypto')
const bcrypt = require('bcryptjs')

const PASSWORD_VERSION = 2
const SCRYPT_KEYLEN = 64
const SALT_LEN = 16

// 是否允许 legacy 无盐 MD5 登录，默认关闭（生产安全）。仅用于一次性迁移存量弱密码。
const ALLOW_LEGACY_MD5 = process.env.ALLOW_LEGACY_MD5 === 'true'

/**
 * 生成 scrypt 密码存储结构
 * @param {string} plain 明文密码
 * @returns {{ passwordHash: string, passwordSalt: string, passwordVersion: number }}
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_LEN)
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN)
  return {
    passwordHash: hash.toString('base64'),
    passwordSalt: salt.toString('base64'),
    passwordVersion: PASSWORD_VERSION
  }
}

/**
 * 时序安全比较（防止长度/内容侧信道）
 */
function timingSafeEqualBuf(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a)
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * 校验密码
 * @param {string} plain 明文密码
 * @param {Object} admin admin_users 文档
 * @returns {{ valid: boolean, needsUpgrade: boolean }}
 *   valid       - 密码是否匹配
 *   needsUpgrade - 命中 legacy 格式且有效，调用方应在登录成功路径写回 scrypt 格式
 */
function verifyPassword(plain, admin) {
  if (!admin || !admin.password) return { valid: false, needsUpgrade: false }

  // 新标准：scrypt（passwordVersion === 2）
  if (
    admin.passwordVersion === PASSWORD_VERSION &&
    admin.passwordSalt &&
    admin.passwordHash
  ) {
    const salt = Buffer.from(admin.passwordSalt, 'base64')
    const expected = Buffer.from(admin.passwordHash, 'base64')
    const actual = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN)
    return { valid: timingSafeEqualBuf(actual, expected), needsUpgrade: false }
  }

  // 兼容存量 bcrypt（带内嵌盐，安全），登录成功后可升级
  if (typeof admin.password === 'string' && (admin.password.startsWith('$2a$') || admin.password.startsWith('$2b$'))) {
    const valid = bcrypt.compareSync(String(plain), admin.password)
    return { valid, needsUpgrade: valid }
  }

  // 兼容存量无盐 MD5（仅可选开启，生产默认关闭）
  if (ALLOW_LEGACY_MD5 && typeof admin.password === 'string' && /^[a-f0-9]{32}$/i.test(admin.password)) {
    const md5Hash = crypto.createHash('md5').update(String(plain)).digest('hex')
    const valid = timingSafeEqualBuf(Buffer.from(md5Hash, 'hex'), Buffer.from(admin.password, 'hex'))
    return { valid, needsUpgrade: valid }
  }

  return { valid: false, needsUpgrade: false }
}

/**
 * 密码强度校验（用于重置/修改密码）
 * @param {string} plain
 * @returns {{ ok: boolean, reason?: string }}
 */
function validatePasswordStrength(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    return { ok: false, reason: '密码长度至少 8 位' }
  }
  if (plain.length > 64) {
    return { ok: false, reason: '密码长度不能超过 64 位' }
  }
  // 至少包含两类字符
  const hasLower = /[a-z]/.test(plain)
  const hasUpper = /[A-Z]/.test(plain)
  const hasDigit = /[0-9]/.test(plain)
  const hasSpecial = /[^a-zA-Z0-9]/.test(plain)
  const categories = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length
  if (categories < 2) {
    return { ok: false, reason: '密码至少包含字母、数字或符号中的两类' }
  }
  return { ok: true }
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  timingSafeEqualBuf,
  PASSWORD_VERSION
}
