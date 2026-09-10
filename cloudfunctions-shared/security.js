// 安全工具（TASK-200）：XSS 转义与地址对象净化
// 作为 shared/security/ 模块的统一来源，供各云函数复制使用（TASK-210 自动化同步）。

'use strict'

// HTML 特殊字符转义，防止存储型 XSS
function escapeHtml(text) {
  if (!text || typeof text !== 'string') return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 安全处理地址对象，防止 XSS 与注入
function sanitizeAddress(address) {
  if (!address || typeof address !== 'object') return null
  const safe = {}
  if (address.name) safe.name = escapeHtml(String(address.name).substring(0, 50))
  if (address.phone) safe.phone = String(address.phone).substring(0, 20).replace(/[^0-9\-+]/g, '')
  if (address.province) safe.province = escapeHtml(String(address.province).substring(0, 50))
  if (address.city) safe.city = escapeHtml(String(address.city).substring(0, 50))
  if (address.district) safe.district = escapeHtml(String(address.district).substring(0, 50))
  if (address.detail) safe.detail = escapeHtml(String(address.detail).substring(0, 200))
  if (address.fullAddress) {
    safe.fullAddress = escapeHtml(String(address.fullAddress).substring(0, 300))
  } else if (address.address) {
    // 兜底：兼容仅提供完整字符串（address）的旧数据
    safe.fullAddress = escapeHtml(String(address.address).substring(0, 300))
  }
  return safe
}

module.exports = {
  escapeHtml,
  sanitizeAddress
}
