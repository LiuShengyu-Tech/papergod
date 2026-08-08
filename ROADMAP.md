# Papergod 长期实现路线图

## 目标

Papergod 是一个可通过 npm 安装和启动的、本地优先的 AI LaTeX 写作平台。界面提供类似 Overleaf 的文件编辑、编译和 PDF 预览；写作、分析、评审与修订由 Codex、OpenCode 等 Agent CLI 驱动，并通过结构化数据和可审阅 diff 保证用户始终掌握最终修改权。

## 当前功能覆盖

| 能力 | 状态 | 当前实现 |
| --- | --- | --- |
| npm 安装并启动本地网页 | 已实现 | 提供 `papergod` bin、`npx papergod [workspace]` 与首次初始化 |
| Overleaf 风格编辑界面 | 已实现（Demo） | 文件栏、CodeMirror、PDF 预览、AI 面板 |
| LaTeX 编辑、保存与编译 | 已实现（基础） | 支持 `.tex` 文件和多种本地引擎，含安全边界与错误反馈 |
| Agent 建议、diff、接受/拒绝 | 已实现 | Mock/Codex/Claude Code/OpenCode 统一生成结构化建议，逐条接受或拒绝 |
| Agent CLI 接入 | 已实现 | 自动探测 Codex/Claude Code/OpenCode 的版本与认证状态，支持路径、前置参数、模型覆盖、连接检查及安全结构化调用 |
| 多 Agent 协作图 | 规划中 | 下一阶段提供角色节点、任务连线、输入输出和运行状态的可视化编排 |
| 文章/段落/句子/词汇模型 | 已实现 | 稳定节点 ID、精确范围、摘要、意图和两级词汇作用域 |
| 全文 Prompt 与每段 Prompt | 已实现 | 全文核心 Prompt 与元素级 Prompt 均可编辑并持久化 |
| 算法语料与句型库 | 已实现 | 支持存储、检索、变量槽、来源和候选提取 |
| 通用/本轮协作词汇库 | 已实现 | 全局/本轮作用域合并、检索和采用记录 |
| 句子意图与段落大意提取 | 已实现（基础） | 大纲展示段落摘要、逐句意图并可单独编辑 |
| 专注批注阅读 | 已实现 | 三栏沉浸大窗按小标题、自然段和句子逐级聚焦，分别记录段落/逐句 Prompt，并接入后续 Agent 上下文 |
| 阅读批注与意见管理 | 已实现 | 精确范围锚点、类别、严重度、状态和来源 |
| 全文意见编排与任务分配 | 已实现 | Mock/Codex/Claude Code/OpenCode 结构化编排、原子意见、节点分配、依赖/冲突图与显式决策 |
| 同行评审/论文评审团 | 已实现 | 五类预设/自定义 reviewer、rubric、独立 Agent 报告、共识/冲突汇总及 M6 交接 |
| 自助 revise | 已实现 | 意见导入、计划执行、可编辑回复信、修改清单、编译复核、未处理检查和导出 |
| 一键生成论文 | 已实现 | 核心/分层 Prompt、结构大纲和写作库受控生成，全文 diff 审阅后方可应用 |
| 修改位置与历史 | 已实现（修订流程） | 持久 revision、范围定位、恢复点、校验和与安全回滚 |
| 自动化测试 | 已实现 | 91 项 API、结构、CLI、Agent 配置/Prompt 预览、Demo 初始化、库、评审、修订、生成、安全和编译测试通过 |

## 目标架构

```text
Browser
  ├─ LaTeX editor / PDF preview / file tree
  ├─ Document outline / paragraph & sentence inspector
  ├─ Prompt / corpus / vocabulary workspace
  └─ Review / revise / diff history
       │
Local Node.js service
  ├─ Project & structured document store
  ├─ LaTeX compiler
  ├─ Corpus and vocabulary service
  ├─ Annotation and revision service
  ├─ Agent orchestrator + JSON validation
  └─ Codex / OpenCode / Mock adapters
       │
Local workspace
  ├─ *.tex / bibliography / assets
  └─ .papergod/project.json + runs + revisions
```

## 实施里程碑

### M1：项目模型与持久化基础

- [x] 定义 project/document/section/paragraph/sentence 的稳定 ID 与排序字段
- [x] 定义全文 Prompt、段落 Prompt、句子意图和摘要字段
- [x] 定义 corpus、sentence pattern、global/session vocabulary
- [x] 定义 annotation、review、revision、agent run 数据结构
- [x] 在工作区 `.papergod/` 中原子化持久化并提供 API
- [x] 增加 schema 校验、迁移版本和测试

验收：项目元数据可创建、读取、更新；重新启动服务后数据不丢失；路径与输入校验测试通过。

### M2：可发布 npm CLI

- [x] 提供 `papergod` bin 与 `npx papergod [workspace]`
- [x] 支持端口、工作区、Agent provider 等 CLI 参数
- [x] 完善 npm `files`、版本、启动错误和首次初始化
- [x] 验证干净目录安装、启动、关闭流程

验收：在任意论文目录执行 `npx papergod` 可初始化并打开本地服务。

### M3：真实 Agent CLI 适配层

- [x] 探测 Codex/Claude Code/OpenCode 可用性、版本与认证状态
- [x] 以参数数组、超时、工作目录和最小环境安全调用 CLI
- [x] 统一结构化 JSON 请求/响应协议
- [x] 对输出做 schema 校验、大小限制、错误归一化和取消处理
- [x] 持久化 CLI 路径、前置参数和模型覆盖，并提供连接检查
- [x] 保留确定性 Mock，测试永不调用外部 Agent

验收：用户可选择 provider；真实 CLI 能只读分析并生成结构化建议；失败时不会损坏论文。

### M4：结构化论文工作台

- [x] 解析 LaTeX 的 section/paragraph/sentence 映射
- [x] 展示全文大纲、段落摘要、逐句意图
- [x] 支持元素级选择、编辑和 AI 重写
- [x] 支持全文及每段 Prompt 编辑
- [x] 提供专注批注大窗，按章节、段落、句子逐级阅读并维护两级修改 Prompt
- [x] 保持结构节点与 `.tex` 文本范围同步

验收：用户能定位任一段/句，查看它的作用并进行局部重写，diff 精确回到原文位置。

### M5：语料、句型与词汇协作

- [x] 管理算法语料与可复用句型模板
- [x] 管理通用词汇库和本轮协作词汇库
- [x] 提供标签、适用章节、变量槽位和引用来源
- [x] Agent 生成时检索并记录实际采用的句型/词汇
- [x] 支持从现有论文提取候选表达，经用户确认后入库

验收：可选择语料和词汇约束生成段落，并追溯每个表达来自哪个库。

### M6：批注、意见编排与可审阅修订

- [x] 建立文本范围锚定的批注与处理状态
- [x] 从用户输入/审稿意见中提取原子意见
- [x] 把意见分配到文章、段落或句子并形成依赖图
- [x] 分步执行修改，展示 before/after、原因和影响范围
- [x] 支持逐条/批量接受、拒绝、延期和回滚

验收：一轮批注可转成可执行修订计划，任何文本写入都必须经过可见 diff。

### M7：抽象同行评审团

- [x] 定义方法、统计、写作、领域、复现性等 reviewer profile
- [x] 支持构造自定义评审团和评审 rubric
- [x] 并行产生独立意见并进行冲突/共识汇总
- [x] 评审结论可一键进入 M6 修订工作流

验收：同一稿件能得到角色独立、可追溯、可合并的结构化评审报告。

### M8：自助 Revise 与一键生成

- [x] 导入审稿意见并关联原文
- [x] 生成 response letter 与修订计划
- [x] 按计划修订、重新编译并检查未处理意见
- [x] 从论文核心 Prompt、段落 Prompt、语料和词汇生成初稿
- [x] 提供完整运行历史、修改清单、导出和恢复点

验收：从“粘贴审稿意见”到“修订稿 + 回复信 + 修改清单”形成完整闭环。

### M9：多 Agent 可视化编排

- [ ] 定义 Agent 节点、角色、能力、输入输出端口和任务连线
- [ ] 提供类似 Hive 的编排画布，显示调度、运行、失败和完成状态
- [ ] 支持串行、并行、评审回路和人工确认关卡
- [ ] 为每条边保存输入摘要，为每个节点保存结构化输出和审计记录
- [ ] 第一版仅编排用户已经配置好的本地 CLI，不自动创建或登录账号

验收：用户能在画布上连接多个本地 Agent，运行一次可追踪协作流程，并定位每一步的输入、输出和失败原因。

## 实现原则

- 本地优先：服务仅绑定 `127.0.0.1`，论文内容默认不离开本机。
- 用户控制：Agent 先提出结构化 patch，用户审阅后才写入源文件。
- 可追溯：每次生成记录 provider、prompt、输入范围、语料引用、输出和决定。
- 可恢复：修改前建立恢复点，批量操作具有原子性。
- 可替换：业务层只依赖统一 Agent 接口，不绑定某一个 CLI。
- 可测试：自动测试使用 Mock adapter，不依赖网络或外部模型。
