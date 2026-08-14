# Agent 上下文工程重构方案（Context Engineering）

> 目标：把「把整篇论文 + 写作库全文塞进 prompt」改成「文件索引 + 按需读取」，让单次 prompt 极短，由 Agent 顺着路径自行读取 workspace 内的论文与写作库文件。

## 1. 现状问题

当前每次调用外部 AI Agent（Codex / Claude Code / OpenCode / Pi）时，下面内容会**全部拼进单个 prompt 文本**，随 `runProcess` 的 stdin 一次性发给 CLI：

| 注入点 | 位置 | 内容 |
|---|---|---|
| 论文正文 | `buildPrompt(request)` 的 `<document>…</document>` | **整篇 .tex 全文**（图灵论文 ~68KB） |
| 多层 prompt | `buildPrompt` / `index.js` 拼装 | 项目 corePrompt / 文档 / 段落 / 元素 / 临时指令（全文） |
| 写作库 | `buildLibraryContext` → `resourceContext` | 选中的语料 content、句型 template、词汇 definition **全文** |
| 引用 | `buildCitationContext` | 选中的参考文献条目全文 |

后果：prompt 极长、token 贵、响应慢，且违背「本地优先 + 按需」的初衷。

## 2. 目标架构

Prompt 里只放**极小的「路径索引」**，不放正文：

```
你是一个学术写作编辑。工作目录是：
  C:\Users\...\my-paper          （论文主目录，绝对路径）
目录结构：
  main.tex                        —— 目标论文（本次只处理第 123–456 字节范围）
  intro.tex / methods.tex / ...   —— 其它章节（如需上下文可自行读取）
  references.bib                  —— 参考文献库
  .papergod/library/corpus.md     —— 语料文件（可检索）
  .papergod/library/patterns.md   —— 句型模板文件
  .papergod/library/vocabulary.md —— 词汇文件
  .papergod/index.json            —— 完整索引（含各文件说明与条目清单）

请先读取目标文件（及所需的库文件），再返回结构化建议。不要改写文件，只读。
```

Agent 然后**自己顺着路径去读文件**，读完再返回结构化 JSON 建议。写入仍然由 Papergod 走「建议 → 可见 diff → 用户审阅 → 原子应用」流程，Agent 不变文件。

## 3. 目录结构（物化文件）

在 workspace 内（原来是 `.papergod/project.json` 存放库信息），新增一份**可被 Agent 直接读的物化副本**：

```
.papergod/
  project.json               （原有：结构化元数据，供 Papergod 自身读写）
  library/                   （新增：物化给 Agent 读的库文件）
    corpus.md                 —— 所有语料，每条含 id/name/source/content/tags
    patterns.md               —— 所有句型模板，含 slots
    vocabulary.md             —— 全局 + 本轮词汇，含 term/preferred/definition
  index.json                  （新增：目录清单 + 条目索引，供 prompt 引用与 Agent 检索入口）
```

物化文件由 Papergod 在每次 Agent 调用前用 `materializeLibraries()` 刷新，保证与 `project.json` 同步。文件用 Markdown（人类+模型都可读），`index.json` 提供机器可读的条目 ID ↔ 文件的映射，供 prompt 里给出精确的「找句型的路径」。

## 4. 上下文构建新协议

新增 `buildWorkspaceIndex(workspaceRoot, { file, targetRange, libraries })`，产出：

1. **绝对路径根** `workspaceRoot`
2. **目录清单**：一层文件列表（`.tex`、`references.bib`、`.papergod/library/*`、`.papergod/index.json`），每条带一句话用途
3. **目标定位**：`file` + `[start–end)` 字节范围（本次处理的范围）
4. **库检索指引**：库文件的路径 + 「按 id/tag/sectionType 检索」的说明，不再贴库全文

`buildPrompt` / `buildReviewPrompt` / `buildPaperGenerationPrompt` / `buildReviewOrchestrationPrompt` / literature-review / text-extraction 全部改为引用该索引，删除 `<document>全文</document>` 与库全文与 citation 全文段落。

## 5. Adapter 只读放开（关键差异）

| Provider | 现状 | 改造 |
|---|---|---|
| codex | `cwd=workspaceRoot`，`--sandbox read-only` | cwd 已对；确认 read-only 可读 cwd（是）；保留读、禁写 |
| claude-code | `cwd=workspaceRoot`，`--permission-mode plan --tools ''` | `--tools ''` 会禁读文件工具，需放开只读工具（如 `--tools Read`）或去掉 `--tools` |
| opencode | `--dir temporary`（临时目录）+ `permission: deny` | **改成 `--dir workspaceRoot`**，permission 由 deny 改「允许读 .tex/库文件」 |
| pi | `cwd=workspaceRoot`，`--no-tools`（禁所有工具） | `--no-tools` 会禁读文件；改为 `--tools <whitelist>` 只保留读文件工具，或去掉并靠 prompt 约束 |

每个 adapter 具体参数在实现阶段用其 `--help` 逐一定案；原则：**只读、仅限 workspace 内、不写**。

## 6. Mock 与测试

Mock 不读文件，直接在进程内按现有确定性逻辑生成（`composeMockSuggestions` 等），确保依然产出可验证结果。测试用 fake CLI 断言新 prompt **含路径索引、不含全文**（`input` 里应出现 workspaceRoot/文件路径，不应出现论文正文的长文本），并断言物化库文件正确生成。

## 7. 安全边界（保持不变）

- Agent 只读、仅限 workspace 内（cwd 限制 + 各 CLI sandbox/deny 设定）
- 写文件仍由 Papergod 控制：结构化建议 → 用户审阅 diff → 原子应用（恢复点）
- 不改动现有「建议→应用→回滚」审计链

## 8. 分阶段实施清单

1. `src/server/library-files.js`：物化库文件 + `index.json`（`materializeLibraries` / 更新时机）
2. `agent-adapters.js`：`buildWorkspaceIndex`；`buildPrompt` 等改为索引式（删全文）
3. 各 adapter cwd/权限调整（codex/claude/opencode/pi）
4. `index.js` 接线：各请求流程在调用前物化库、传 `buildWorkspaceIndex`
5. Mock 兼容 + 全量测试
6. README/ROADMAP + 端到端验证
