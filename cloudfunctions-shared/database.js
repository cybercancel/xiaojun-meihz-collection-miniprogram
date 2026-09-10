'use strict'
// 共享数据库访问助手（单一来源，由 scripts/sync-cloudfunction-shared.js 同步到各云函数）
// 延迟获取 db / command 实例，避免在 require 阶段早于 cloud.init() 调用导致异常。
const cloud = require('wx-server-sdk')

let _db = null
let _cmd = null

// 延迟初始化：仅在首次调用时获取，确保 cloud.init() 已执行。
function getDb() {
  if (!_db) _db = cloud.database()
  return _db
}

// 延迟获取数据库命令对象（_.inc / _.in 等），仅用于构造更新指令，不依赖事务上下文。
function getCmd() {
  if (!_cmd) _cmd = cloud.database().command
  return _cmd
}

module.exports = { getDb, getCmd }
