# Xiaoxiao Agent

自有品牌的多模型 AI 桌面工作空间。基于 Electron 独立开发，支持流式对话、工作目录工具和 MCP，不依赖 Claude 官方桌面端。

## 直接使用

Apple Silicon Mac 可打开 dist/mac-arm64/Xiaoxiao Agent.app；dist 中也提供 DMG。当前构建未使用 Apple Developer ID 签名或公证，仅供本地试用；正式分发前需要配置你自己的签名证书。

1. 打开「模型设置」，选择预设或自定义服务。
2. 填写模型 ID、Base URL 和 API Key，保存后可测试连接、获取模型列表。
3. 回到对话，选择模型，直接发送消息。
4. 开启 Agent 模式并选择工作目录后，可让模型读取文件、写入文本或运行命令。
5. 「MCP 与运行」可增加外部工具，例如浏览器自动化。

API 用量按所配置提供商的账号计费。模型 ID 请使用你的账号实际可用的名称。不同模型的工具调用、上下文和兼容程度不同，不能保证每个网关都具有相同能力。

## 开发运行

~~~bash
npm ci
npm start
~~~

需要 Node.js 22.16+。Electron 安装时需要下载运行时；若 GitHub 下载不可达，可在安装阶段指定你信任的镜像，例如：

~~~bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
~~~

运行时下载会根据 Electron npm 包内的 checksums.json 验证。npm 环境若阻止安装脚本，可手动运行 node node_modules/electron/install.js。

## 模型接入

| 服务 | 类型 | Base URL |
| --- | --- | --- |
| OpenAI 或兼容网关 | OpenAI Compatible | 使用服务方提供的 v1 根地址 |
| Claude | Anthropic | 默认 https://api.anthropic.com/v1 |
| DeepSeek、Gemini、通义千问 | OpenAI Compatible | 从服务预设填充，或填写你的部署地址 |
| Ollama | Ollama | 默认 http://127.0.0.1:11434/v1，无需 Key |

Base URL 不包含 chat/completions 或 messages。网络接口使用 HTTPS，本机回环地址可用 HTTP。遇到非流式网关时可关闭「启用流式输出」。已保存配置可获取模型列表，接口不支持列表时可手填模型 ID。

Key 由 Electron safeStorage 使用系统加密存储保护，不回传给对话界面。更换 API 地址时需要重新填写或清除原有 Key。对话历史和本地文件本身不加密；需要保护数据时请使用系统磁盘加密与账号访问控制。

## Agent 工具

| 工具 | 行为 |
| --- | --- |
| read_selected_document | 读取本次显式附加的 UTF-8 文本，最大 64 KiB |
| list_files | 列出所选目录的直接子项，最多 500 条 |
| read_file | 读取工作目录内文件，最多 64 KiB |
| write_file | 写入工作目录内文本，单次最多 12 KiB；逐次显示内容并确认 |
| run_command | 在所选目录执行命令；每次确认，最长 60 秒，输出最多 64 KiB |
| fetch_url | 读取公共 HTTPS 文本网页；不执行网页脚本，不自动跟随重定向 |
| MCP 工具 | 根据启用的服务发现工具；连接与每次调用均需确认 |

命令运行于当前用户权限下，工作目录不是操作系统沙箱。运行未知命令前查看确认窗口中的完整命令。文件工具会检查规范路径及符号链接边界，但不会限制你明确批准的命令或外部 MCP 服务访问范围。

Agent 最多执行 1–30 轮模型请求，可在设置里调整。默认 12 轮，单个任务 10 分钟超时，可随时停止。工具结果作为不可信数据传回模型。

## 浏览器与其他 MCP

在「MCP 与运行」保存服务器数组。默认关闭；设置 enabled 为 true 后，在下一次 Agent 请求时提示连接。

~~~json
[
  {
    "name": "Browser",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest"],
    "env": {},
    "enabled": false
  }
]
~~~

此例需要 Node.js/npx 和该服务要求的浏览器；生产环境建议把服务器版本固定为你验证过的版本。浏览器工具由外部服务提供，浏览器安装与第三方网页交互没有在本项目中做实站验证。

远程服务使用 transport: "http"、url、headers；本地进程使用 transport: "stdio"、command、args、env。env/header 值在磁盘上加密保存，设置界面可查看与编辑。配置界面包含密钥，分享截图或 JSON 时请自行移除。外部服务可能执行实际操作，每次工具调用都需要确认。

## 会话与数据

- 会话自动保存，支持重命名、删除和 Markdown 导出。
- 关闭窗口再打开可恢复历史；新建会话不会删除旧会话。
- 同一会话切换模型时，已完成的历史会发送给新选模型。需要隔离不同提供商的内容时先建新会话。
- 历史上下文最多取最近 40 条，并按约 12 万字符的软预算裁剪；失败回合不加入下一次模型上下文。
- 历史中的附件文字不永久附加；需要再次读取时重新附加文件。
- 独立数据目录：macOS 的 ~/Library/Application Support/Xiaoxiao Agent；不读取 Claude 或早期实验版目录。
- settings.json、providers.json、conversations.json 使用原子替换写入，文件权限为 0600。
- 桌面集成测试使用独立临时数据目录。

## 品牌与打包

src/brand.json 设置名称与图标，src/brand.svg 是原始图稿。更换图标后同步生成 src/brand.png，再运行 npm run icons 生成安装包图标。

~~~bash
npm run icons
npm run pack
npm run dist:mac
~~~

electron-builder.yml 控制安装包名称、App ID、平台和签名设置。当前已验证 macOS arm64；Windows/Linux 目标需要在对应平台构建并验证，不能视为已经发布。

## 验证

~~~bash
npm run check
npm test
npm run test:desktop
~~~

测试覆盖流式分块、OpenAI/Anthropic 工具回传、推理元数据、参数验证、执行步数、目录边界、命令取消、MCP 真正的 stdio 握手与退出、原子存储及网页地址过滤。桌面测试使用本地模拟模型服务，覆盖启动、模型设置、目录工具、流式回复、磁盘保存和重启恢复。

尚未使用你的真实付费 API Key 做端到端测试。当前不包含 Claude 官方专有服务、自动更新、云同步、系统级电脑控制、图片/PDF 输入或长期记忆。这是可继续扩展的独立客户端，不宣称与任何官方产品完全等价。
