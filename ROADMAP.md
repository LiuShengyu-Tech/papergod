# Papergod 长期实现路线图

## 目标

Papergod 是一个可通过 npm 安装和启动的、本地优先的 AI LaTeX 写作平台。界面提供类似 Overleaf 的文件编辑、编译和 PDF 预览；写作、分析、评审与修订由 Codex、OpenCode 等 Agent CLI 驱动，并通过结构化数据和可审阅 diff 保证用户始终掌握最终修改权。

## 当前功能覆盖

| 能力 | 状态 | 当前实现 |
| --- | --- | --- |
| npm 安装并启动本地网页 | 已实现 | 提供 `papergod` bin、`npx papergod [workspace]` 与首次初始化 |
| 多论文工作区切换 | 已实现 | Tools 中集中添加/切换本地目录，论文、历史、写作库与 Agent 配置按目录隔离 |
| 工作区目录浏览与终端 | 已实现 | 原生选择器失败时提供受限网页目录浏览；Tools 提供按 workspace 隔离的交互式 PTY/xterm |
| 文献引用与 Zotero | 已实现（MVP） | 本地 BibTeX/PDF 文件夹扫描、Zotero Desktop/collection 搜索、可选 Better BibTeX 检测、统一 references.bib、citekey 检查与插入 |
| 文献综述生成与插入 | 已实现 | References 中多选文献 → 生成可审阅综述段落（Mock 确定性 / 外部 Agent 实质性综述），确认后经原子修订插入，\citep 引用可溯源 |
| Overleaf 风格编辑界面 | 已实现（Demo） | 文件栏、CodeMirror、PDF 预览、AI 面板 |
| LaTeX 编辑、保存与编译 | 已实现（基础） | 支持 `.tex` 文件和多种本地引擎，含安全边界与错误反馈 |
| Agent 建议、diff、接受/拒绝 | 已实现 | Mock/Codex/Claude Code/OpenCode 统一生成结构化建议，逐条接受或拒绝 |
| Agent CLI 接入 | 已实现 | 自动探测 Codex/Claude Code/OpenCode 的版本与认证状态，支持路径、前置参数、模型覆盖、连接检查及安全结构化调用 |
| 多 Agent 协作图 | 已实现 | 原生编排画布：Agent 节点/审批关卡、任务连线、输入输出摘要、调度/运行/失败/完成状态、审计记录 |
| 文章/段落/句子/词汇模型 | 已实现 | 稳定节点 ID、精确范围、摘要、意图和两级词汇作用域 |
| 全文 Prompt 与每段 Prompt | 已实现 | 全文核心 Prompt 与元素级 Prompt 均可编辑并持久化 |
| 算法语料与句型库 | 已实现 | 支持存储、检索、变量槽、来源和候选提取，并内置开箱即用的学术句式与检查表 |
| 通用/本轮协作词汇库 | 已实现 | 全局/本轮作用域合并、检索和采用记录，并提供精确表达 starter vocabulary |
| 句子意图与段落大意提取 | 已实现（基础） | 大纲展示段落摘要、逐句意图并可单独编辑 |
| 段落节奏统计分析 | 已实现 | 段落/文档级句长与段长统计（均值、样本标准差、变异系数、中位数、极差、IQR、相邻变化 Δ、变化程度指标 VI 0–100），公式逐条展示，柱状图可视化，并对“AI 机械感”给出启发式判定 |
| PDF 句式提取入库 | 已实现 | 工作区 PDF 文本层提取（Mock 规则/外部 Agent），候选句式泛化槽位，用户确认后加入句型库 |
| 专注批注阅读 | 已实现 | 三栏沉浸大窗按小标题、自然段和句子逐级聚焦，分别记录段落/逐句 Prompt，并接入后续 Agent 上下文 |
| 阅读批注与意见管理 | 已实现 | 精确范围锚点、类别、严重度、状态和来源 |
| 全文意见编排与任务分配 | 已实现 | Mock/Codex/Claude Code/OpenCode 结构化编排、原子意见、节点分配、依赖/冲突图与显式决策 |
| 同行评审/论文评审团 | 已实现 | 五类预设/自定义 reviewer、rubric、独立 Agent 报告、共识/冲突汇总及 M6 交接 |
| 自助 revise | 已实现 | 意见导入、计划执行、可编辑回复信、修改清单、编译复核、未处理检查和导出 |
| 一键生成论文 | 已实现 | 核心/分层 Prompt、结构大纲和写作库受控生成，全文 diff 审阅后方可应用 |
| 修改位置与历史 | 已实现 | 最近 5 次版本抽屉、逐块 diff、源码定位、持久 revision、恢复点、校验和与安全回滚 |
| 自动化测试 | 已实现 | 125 项 API、结构、CLI、工作区/PTY、BibTeX/Zotero、Agent 配置、写作库、评审、修订、生成、编排、统计分析、综述、PDF 提取、安全和编译测试通过 |
| Agent 上下文工程（文件索引 + 按需读取） | 已实现 | 写作库物化为 `.papergod/library/` 可读文件，prompt 仅注入项目绝对路径、目录清单、目标文件字节范围与库路径；各外部 CLI 放开 workspace 只读访问，正文与库全文不再进入 prompt |

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

- [x] 定义 Agent 节点、角色、能力、输入输出端口和任务连线
- [x] 提供 Papergod 原生的 Agent 编排画布，显示调度、运行、失败和完成状态
- [x] 支持串行、并行、评审回路和人工确认关卡
- [x] 为每条边保存输入摘要，为每个节点保存结构化输出和审计记录
- [x] 第一版仅编排用户已经配置好的本地 CLI，不自动创建或登录账号

验收：用户能在画布上连接多个本地 Agent，运行一次可追踪协作流程，并定位每一步的输入、输出和失败原因。

### M10：Agent 上下文工程（文件索引 + 按需读取）

- [x] 把写作库（语料/句型/词汇）物化为 workspace 内可读文件（`.papergod/library/corpus.md`、`patterns.md`、`vocabulary-global.md`、`vocabulary-session.md` 与 `.papergod/index.json`），外部 Agent 调用前落盘
- [x] 精简 Agent prompt：只注入项目绝对路径、各层目录清单、目标文件字节范围 `[start, end)` 与库文件路径，不再注入文档正文与库全文
- [x] 摘要、评审、意见编排等结构化工作流统一走 workspace-index 分支；编排器内对非文件输入仍保留内联（节点输入原文即 prompt，非文件）
- [x] 放开各外部 CLI 在 workspace 内的只读访问：Pi `--tools read`、Claude Code `--tools Read,Grep,Glob`、OpenCode `--dir workspaceRoot` + 只读权限、Codex 只读沙箱读取当前工作目录
- [x] Mock 与既有建议/评审/段落/全文生成/编排/综述/PDF 提取工作流兼容新协议，自动化测试通过
- [x] 保留安全边界：建议/评审的 `originalText`/`quote` 仍以内存中的 `request.content` 校验为精确连续子串，写入仍走可见 diff 审阅

验收：外部 Agent 通过路径自行读取论文与库文件后返回结构化建议，prompt 中不再出现正文全文；所有工作流测试通过且安全边界不变。

## 实现原则

- 本地优先：服务仅绑定 `127.0.0.1`，论文内容默认不离开本机。
- 用户控制：Agent 先提出结构化 patch，用户审阅后才写入源文件。
- 可追溯：每次生成记录 provider、prompt、输入范围、语料引用、输出和决定。
- 可恢复：修改前建立恢复点，批量操作具有原子性。
- 可替换：业务层只依赖统一 Agent 接口，不绑定某一个 CLI。
- 可测试：自动测试使用 Mock adapter，不依赖网络或外部模型。
