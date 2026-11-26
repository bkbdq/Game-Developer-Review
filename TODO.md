# 开发清单

> 依据 [docs/技术方案.md](docs/技术方案.md) 的里程碑拆分。完成项需同时通过 `npm run data:validate`。
> 2026-11-24 对照 [docs/需求文档](docs/需求文档/00-总览.md) 逐模块核对覆盖与完成度，结论见文末「需求文档覆盖核对」。

## M0 数据契约

- [x] `schema/review.schema.json`、`company.schema.json`、`taxonomy.schema.json`
- [x] `data/taxonomy.json` 枚举字典
- [x] 样例数据迁移与拆分：正式 `data/` 与 `data-test/` 的测试数据已全部清空（2026-11-26），等待真实审核数据；正式构建只读 `data/`
- [x] `scripts/validate.mjs`：结构、枚举、引用完整性、敏感字段与正则扫描
- [x] `scripts/aggregate.mjs`：生成 `index.json`、`manifest.json`、`taxonomy.json`、`companies/{id}.json`
- [x] 用 ajv 替换手写校验（`npm run data:validate`，其余语义检查保留）
- [x] 生成 TypeScript 类型并与 `site/src/lib/data.ts` 对齐（`npm run data:types` → `site/src/lib/schema-types.ts`）

## M1 展示站（需求 M1 / M2）

- [x] 全站写评价入口：顶栏、公司页、项目页、各空状态
- [x] 公司目录：搜索（名称 / 别名参与匹配，页面不展示别名）、默认按评价等级排序（评分过少置底）、评价数量、最近更新
- [x] 公司卡：等级徽标、公司名、项目数 / 评价数、综合分、最近更新
- [x] 公司详情：评级区（等级 + 好评率 + 好评 / 中评 / 差评条数 + 样本数）、项目概览、评分分布、评价筛选
- [x] 项目页：等级、好评率、样本数、写评价入口
- [x] 评级规则：5 篇起评；4–5 星好评、3 星中评、1–2 星差评；好评率 = 好评 ÷（好评 + 差评）；等级门槛与展示一致，规则可展开
- [x] 小样本保护：评价 <5 条显示「评分过少」，评价卡不显示在职时长与项目信息，不提供筛选
- [x] 匿名项目：公司页可筛选「匿名项目」，匿名项目评价不出现在任何项目页
- [x] 首页项目卡展示公司名与公司等级；空状态均有可点行动按钮
- [x] `/about`、`/privacy`、`/contact`、`/data`、`/requests` 页面
- [x] 数据源切换到聚合产物 `site/public/data/v1`
- [x] 移动端响应式断点与 44px 点击区域（375px 真机实测未执行）
- [x] CSP、`X-Content-Type-Options`、`Referrer-Policy` 等响应头（`site/public/_headers`；Astro 内联脚本需要 `script-src 'unsafe-inline'`）

## M2 提交链路（需求 M3）

- [x] 问卷精简为 7 项：公司、项目、不公开项目名、综合评分、在职时长、正文、同意声明
- [x] 移除岗位、在职状态、城市与「想对后来者说的话」
- [x] 页面不显示字数上限（正文仍受后端 2000 字安全校验，不对外提示）
- [x] URL 预填公司与项目，顶部显示「正在评价：XX · YY」
- [x] 成功页：回执只显示一次、审核通过后展示、查看公司页 / 再写一条 / 申请删除或更正
- [x] 提交过频提示「提交太频繁，请稍后再试」；不提供审核状态查询
- [x] 问卷页 `survey/`：原生表单 + JS 增强、本地暂存、超时 / 重试 / 兜底
- [x] `POST /api/submit` Pages Function：大小 / 长度校验、蜜罐、PoW、限流、幂等
- [x] D1 表结构与 `pending` 写入
- [x] 审核状态机（`pending` → `approved` / `rejected`）与 `audit_log` 表
- [x] 零依赖测试脚本 `scripts/test-m2.mjs`
- [x] 复用 D1 `goodcompany` 并执行迁移
- [x] 创建 `gdr-survey` / `gdr-admin` 两个 Pages 项目并绑定 D1
- [x] 问卷页部署到 Cloudflare Pages（`survey.goodcorp.games`）
- [x] 接入自定义域名 `goodcorp.games`，DNS 托管 Cloudflare
- [x] 旧 `gdr-survey.pages.dev` 301 到 `survey.goodcorp.games`
- [ ] 填写问卷兜底收件邮箱（代码已支持 `data-fallback-email`，当前留空时隐藏「邮件提交」；待邮箱可用后填入）
- [x] PoW 挑战改为服务端签发（HMAC 签名 + 10 分钟过期）
- [x] 客户端 PoW 难度与服务端 `POW_DIFFICULTY` 联动
- [ ] 备用境外提交端点（Deno Deploy / Fly.io / Vercel；需外部账号，本轮暂缓）
- [x] 过期数据清理任务（`ipHash`、已发布提交）
- [x] D1 导出备份（`npm run d1:export`，输出到本地 `.backups/`）

## M3 审核控制台（需求 M4）

- [x] 登录失效、网络失败、发布失败分别提示并给出下一步动作
- [x] `admin/` 静态 SPA 与管理员登录（PAT、sessionStorage、服务端权限校验）
- [x] 控制台 Pages Functions API：登录校验、待审列表、通过、拒绝、审计
- [x] 待审列表、详情、公司 / 项目匹配、脱敏编辑
- [x] 公司 / 项目可搜索选择与模糊匹配（内置常见游戏公司 / 项目别名库 `admin/lib/aliases.json`，`npm run test:admin`）
- [x] 发布前检查清单（四项必勾，未勾完不能通过或暂存，M4·FE-1）
- [x] 敏感信息检查（手机号 / 邮箱 / 身份证标红禁发，微信 / QQ / 住址黄色提醒，M4·FE-2，`npm run test:admin-review`）
- [x] 相似内容提示（与同公司已发布评价 + 暂存条目做字符二元组余弦对比，可继续发布，M4·FE-3）
- [x] 拒绝原因下拉模板（七选一，「其他」必填说明，M4·FE-4）
- [x] 匿名项目归类（`projectAnonymous: true`，不关联具体项目，M4·FE-5）
- [x] 画像精简为在职时长四区间（决策 4 / 5，旧数据 role / city 保持兼容）
- [x] 通过：Git Data API 单次原子提交到公开仓，并标记 D1 为 `approved`
- [x] 拒绝：标记 D1 为 `rejected` 并记录原因
- [x] 审计日志写入 D1 `audit_log`
- [x] 审计扩展：登录成功 / 失败、无权限访问、展示站部署、Git commit SHA；新增只读审计查询页 `/audit.html`（仅 D1，不入公开仓）
- [x] 批量通过：暂存后一次发布多条，复用「全部发布」（一次 commit、一次展示站更新）
- [x] 待审等待时长（列表显示已等待天数，超过 7 天标黄）
- [x] 删除 / 更正队列：回执校验、列表、处理、审计
- [x] 联系消息队列：消息列表、已处理标记、审计
- [x] 问卷 `anonymousProject` → 后端 `projectHidden` → 审核台全链路贯通
- [ ] GitHub OAuth Device Flow 登录（替代手动粘贴 PAT；需 GitHub OAuth App，本轮暂缓，保留 PAT）
- [x] 控制台部署后与真实 token 联调（`admin.goodcorp.games`）
- [x] 本地一键控制台 `start-admin.cmd`，通过后自动构建并部署展示站
- [x] 展示端标记「已更正」（审核台更正已递增 `revision`，Git 历史保留旧版本）
- [x] 删除 / 申诉请求处理队列
- [x] 审核台首页待处理总览（待审评价 / 删除更正 / 联系消息，操作后即时更新，30 秒轮询）
- [x] 大仓库时改用分页 / 增量读取待审列表（列表「加载更多」）

> 说明：批量通过已实现为「暂存 + 全部发布」；当前允许新建公司/项目和黄色软提醒条目，尚未收紧到“仅已匹配公司且无任何敏感提示”。
> 与需求偏差：审核台已部署到 `admin.goodcorp.games`，可从公网访问；需求文档 4.4 原写「只在本机打开」。当前以 PAT + 服务端鉴权兜底。

## M4 发布管线

- [x] `data-validate.yml`
- [x] `site-deploy.yml`
- [x] 首次 `dev → main` 合并，控制台 `publicBranch` 已改回 `main`
- [x] 移除 `data/companies` 与 `data/reviews` 中的演示数据
- [x] 本地控制台通过后自动构建正式站并部署 `gdr-site`（只读 `data/`）
- [x] 开启 GitHub Pages，镜像到 `github.goodcorp.games`
- [x] Cloudflare Pages 主域 `goodcorp.games` 与开发预览 `dev.goodcorp.games`
- [ ] 配置 `main` / `dev` 分支保护与 CODEOWNERS 实际权限（平台权限受限，继续按 PR 流程约定执行）

## M5 上线加固

- [x] 自定义域名、HTTPS、旧 `pages.dev` 301
- [ ] 备用境外提交端点与客户端切换（需外部账号，本轮暂缓）
- [x] 隐私说明、免责声明、审核红线文本
- [x] 公开页面不展示别名、身份信息、精确时间、审核人
- [x] 隐私页保留期与清理任务一致（待审 90 天 / 拒绝 30 天 / 通过 7 天脱敏 / IP 摘要 30 天 / 申请与联系 90 天）
- [ ] 公开 JSON 字段严格收敛到需求白名单：旧评价仍带 `profile.role/employment/city`，审核台新增的 `title/tags` 也不在白名单内（页面不展示，但公开数据仍包含）
- [ ] 电信 / 联通 / 移动 / 广电多网络实测（需真机与多运营商环境，本轮未执行）
- [x] 定时清理：`approved` 7 天后脱敏原始 payload
- [x] 定时清理：`rejected` 30 天删除、`pending` 90 天删除
- [x] 定时清理：30 天清空 `ip_hash` 与 `payload.meta.ipHash`
- [x] D1 导出备份

## M6 匿名与删除

- [x] 小样本展示规则（公司/项目 <5 条隐藏在职时长与项目信息）
- [x] 关于页、隐私页
- [x] 删除/更正、联系我们页面表单壳
- [x] `requests` 表 + 提交/状态查询 API（回执校验）
- [x] `contact_messages` 表 + 收件 API
- [x] 审核台删除/更正队列与处理（删除公开评价、更正并递增 `revision`）
- [x] 审核台联系消息列表与已处理标记
- [x] 审计动作：`delete` / `correct` / `contact_handled`
- [x] 保留期：联系方式 30 天、申请/联系记录处理完 90 天
- [x] 删除 / 更正仅凭回执受理（回执必须对应已发布评价），公司与其他方走「联系我们」
- [x] 更正递增 `revision` 并在展示端标记「已更正」；删除从公开仓移除评价
- [x] 成功页回执提示「只出现一次、网站不展示」；全站无「绝对匿名」类承诺

## M7 防刷（需求文档：本期不实现，仅记录）

- [x] 已有基础机制：频率限制（5 次/分、100 次/天）、24 小时去重、蜜罐、填写耗时标记
- [x] 服务端签发 PoW（HMAC 签名 + 10 分钟过期），客户端难度与服务端联动
- [x] 不引入账号、手机号、邮箱验证或设备指纹
- [ ] 无感人机验证、可疑队列、集中评价提醒等方案池待定（需求文档明确本期不做）

## 部署待办（需工作电脑 + Cloudflare 权限）

> 2026-11-24 已用本机 `.secrets/cloudflare.env` 中的 API Token 执行以下部署。

- [x] D1：执行 `survey/migrations/0002_requests.sql`
- [x] `gdr-site` / `gdr-site-dev`：绑定 D1 `DB`，配置 `IP_SALT`、`ALLOWED_ORIGINS`
- [x] `gdr-survey`：配置 `POW_SECRET`、`POW_DIFFICULTY`，重新部署
- [x] 清理 Worker：填入真实 `database_id`，执行 `npm run deploy:cleanup`，Cron 已生效
- [x] 重新部署 `gdr-survey`、`gdr-site`、`gdr-admin`（另含 `gdr-site-dev`）
- [x] 联调：问卷服务端 PoW、删除/更正申请、回执状态查询、联系消息；审核台队列 API 已部署（未带 token 时 401 正常，实际处理动作待用 PAT 登录实测）
- [x] 执行一次 `npm run d1:export`，确认备份可用（`.backups/goodcompany-*.sql`）
- [x] `dev → main` 后验证 GitHub Pages 镜像表单调用 Cloudflare API 的完整链路（镜像已重建，contact / requests 表单均指向 `goodcorp.games` API，跨域返回正常）

## 技术债与待决问题

- [x] 统一合并策略：采用 merge commit（保留 PR 合并节点，与现有历史一致）
- [x] 确认公司名是否使用真名、项目名是否展示：公司使用真实名称，项目名可展示，匿名项目单独归类
- [x] 确认小样本阈值：统一为 5（评级门槛与逐条展示在职时长 / 项目信息一致）；按决策 11 不做在职时长分布统计
- [x] 确认审核时效承诺：文案写「人工审核，时间不固定，请耐心等待」，不承诺具体小时数
- [x] 别名是否对外公开：仅内部使用；公开 JSON 与 `/api/companies` 不再返回别名，站内搜索仍通过构建期 `site/src/generated/aliases.json` 匹配
- [ ] 公开 JSON 白名单收敛：移除旧评价的 `profile.role/employment/city`，并决定 `title/tags` 是否保留（需求白名单未包含）
- [ ] 审核台公网暴露与需求 4.4「只在本机打开」对齐：下线公网入口、加访问限制，或修订需求文档

## 需求文档覆盖核对（2026-11-24）

| 需求模块 | 对应 TODO 位置 | 完成度 | 说明 |
| --- | --- | --- | --- |
| M1 展示站 | M1 | 已完成 | 入口、等级、排序、匿名项目筛选、空状态、移动端样式均已实现；375px 未真机实测 |
| M2 评级 | M1 | 已完成 | 5 篇起评、好评率、3 星中评、等级门槛、规则展开均与需求一致 |
| M3 问卷 | M2 提交链路 | 已完成 | 7 项字段、预填、无字数提示、成功页与回执提示均已实现；兜底邮箱待定（非需求硬性项） |
| M4 审核台 | M3 审核控制台 | 已完成 | 清单、敏感信息、相似提示、拒绝模板、匿名项目、队列与错误提示均已实现；登录为 PAT，公网部署与需求原文有偏差 |
| M5 数据与合规 | M0 / M5 / M6 | 基本完成 | 保留期与隐私文案一致；公开 JSON 仍含旧画像字段与 `title/tags`，白名单待收敛 |
| M6 匿名与删除 | M6 | 已完成 | <5 条隐藏、关于/隐私/删除/联系页面、仅凭回执受理、审核记录均已实现 |
| M7 防刷 | M7 | 本期不实现 | 需求明确只记录方案；基础频率限制、去重、蜜罐、耗时标记、服务端 PoW 已具备 |

未完成项均为部署 / 外部环境或白名单收敛类事项，不影响 M1–M6 产品需求的主流程验收。
