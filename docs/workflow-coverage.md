# Xiaoxiao Agent 0.4.5 与 TRAE 工作流对照

对照依据是 TRAE 的公开文档以及 Xiaoxiao Agent 在 Apple Silicon Mac 上的桌面回归。Xiaoxiao Agent 使用独立的 macOS 界面、本机数据目录和用户选择的模型服务。

| 工作流 | Xiaoxiao Agent 0.4.5 | 与 TRAE 的差距 |
| --- | --- | --- |
| 项目开发界面 | 项目文件树、文件创建、Git、代码编辑器、Agent 和本机 PTY 终端。宽窗口通过 `⌘2` 进入三栏布局，左栏切换文件、Git 和任务详情时，编辑器位置固定。 | 工作区布局配置、编辑器分组、文件管理和断点调试仍需完善。 |
| 编辑和代码建议 | 多标签、跨标签撤销、语法提示、手动补写、可选的随键入补写，以及选区改写。应用建议后由用户保存，保存前检测磁盘版本。 | TRAE CUE 的跨位置跳转和建议、智能导入及重命名待实现。语言服务、类型诊断和语义导航也待实现。 |
| 项目上下文 | 文件名和文本搜索、跳转到行、文件和选区引用，以及项目说明和常用资料快照。 | 语义代码库索引、目录级规则和自动收集相关代码待实现。 |
| Git 和代码审查 | 可新建和切换本地分支，逐文件审阅、暂存和取消暂存，按快照提交。可把单文件或整个暂存区的差异加入计划模式进行只读审查。 | 远程仓库操作、提交消息辅助、跨分支审查和直接采纳审查建议待实现。 |
| Agent 计划和执行 | 只读计划、明确进入执行、任务清单、交互澄清、逐项写入审批和历史。可在多个会话运行和停止任务，执行中可提交补充要求。已有文件可按单次写入记录恢复，恢复前会核对磁盘内容。 | 更细的任务分派、横跨多个文件的检查点恢复和跨设备接续待实现。 |
| 运行与预览 | 项目终端可启动本机服务，独立窗口可预览本机开发页，页面和实时连接限同一服务地址。 | Agent 自动检测运行地址、页面元素回传和内嵌调试待实现。 |
| 工具、技能和模型 | Anthropic、OpenAI Compatible、Ollama。可导入 `SKILL.md`，可用 stdio 和 Streamable HTTP MCP。 | IDE 扩展生态、通用浏览器和深度调试集成待实现。 |
| 远程开发 | 编辑和终端以本机项目为范围。 | SSH 远程项目、远程 Agent、云端环境和跨设备同步待实现。 |
| 交付和定时任务 | 可保存多份 Markdown 交付稿，导出 PDF 或 Word。应用运行时可执行每日或每周只读任务。 | 应用退出后的接续运行和远程派发待实现。 |

代码补写、选区改写和模型审查使用模拟 API 做桌面回归。Git 命令和 PTY 运行于真实的临时项目，网页预览加载临时本机 HTTP 服务。对外商用发布仍需 Developer ID 签名与公证、真实模型兼容性验证和长期运行测试。

## TRAE 公开资料

- [超级代码补全 CUE](https://docs.trae.ai/ide/cue)
- [上下文的基本用法](https://docs.trae.ai/ide/basic-usage-of-context)
- [SOLO 模式](https://docs.trae.ai/ide/solo-mode)
- [源代码管理](https://docs.trae.ai/ide/source-control)
- [智能体审查](https://docs.trae.ai/ide/agent-powered-code-review)
- [规则](https://docs.trae.ai/ide/rules)
- [SSH 远程开发](https://docs.trae.ai/ide/ssh-remote)
