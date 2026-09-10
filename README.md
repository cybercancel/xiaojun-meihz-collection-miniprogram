# 晓军商贸美妆集合仓 · 微信小程序（毕设源码验证包）

> 版本：v17.92（已发布生产）  |  导出日期：2026-09-10
> 本仓库为**论文实现核实用精简源码包**：已剔除全部密钥、不含 `node_modules`、不含历史冗余。

## 一、这份包能核什么
- 前端：`pages/`（用户端 + 管理端 `admin*`）、`utils/`、`app.json`
- 后端：`cloudfunctions/`（80 个云函数）、`cloudfunctions-shared/`（18 个共享模块）
- 质量：`tests/`（113 项）、`scripts/`（predeploy-check 17 项门禁）
- 数据：`database/`（集合结构 + 索引规范）
- 文档：`docs/交付文档/`（技术总结报告等）

## 二、目录
```
app.json  project.config.json  package.json  sitemap.json
pages/  utils/  cloudfunctions/  cloudfunctions-shared/  tests/  scripts/  database/  docs/
```

## 三、本地复验
```bash
npm install
npm run test:all
node scripts/predeploy-check.js
# 真机预览：微信开发者工具打开本目录 → 导入生产 AppID → 预览/上传
```
> 云函数运行需 CloudBase 环境与生产密钥；**密钥未随包提供**（安全边界），
> 联调见 `docs/交付文档/交接手册.md`。

## 四、安全红线（务必遵守）
- 已剔除、禁止重新提交：`private-key-test.pem`、`cloudfunctions/wxpay/apiclient_cert.pem`、`apiclient_key.pem`。
- `.gitignore` 已屏蔽 `*.pem / *.p12 / *.key / private-key*`，提交前 `git status` 二次确认。

## 五、论文章节映射
见 `论文素材/` 与 `交接文档/技术总结报告`，或本地 `F:\中转站\毕设\Ai毕设\论文素材\00_素材总览与论文映射.md`。
