# redcode

# GG cursor已经暂时关闭了help歇菜了家人们

**The free build of Claude Code. / Claude Code 免费构建版**

All telemetry stripped. All injected security-prompt guardrails removed. All experimental features unlocked. One binary, zero callbacks home.  
*移除了所有遥测数据。破解了所有强制注入的安全提示护栏。解锁了所有实验性功能。单文件运行，绝无任何向主服务器的网络回调。*

```bash
curl -fsSL https://raw.githubusercontent.com/kyxiaxiang/redcode/main/install.sh | bash
```

> **EN:** Checks your system, installs Bun if needed, clones, builds with all features enabled, and puts `redcode` on your PATH. Then just `export ANTHROPIC_API_KEY="sk-ant-..."` (or use `/free`) and run `redcode`.  
> **ZH:** 脚本会自动检测你的系统，必要时安装 Bun，克隆仓库，开启所有被隐藏的功能并完成构建，最后将 `redcode` 加入到你的环境变量中。如果需要使用你自己的 API Key 则 `export ANTHROPIC_API_KEY="sk-ant-..."`，如果想白嫖模型可以直接进系统敲 `/free` 指令。

---

## What is this / 这是什么项目

**EN:** This is a clean, buildable fork of Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI -- the terminal-native AI coding agent. The upstream source became publicly available on March 31, 2026 through a source map exposure in the npm distribution. This fork applies four categories of changes on top of that snapshot.  
**ZH:** 这是 Anthropic 出品的终端原生 AI 编程智能体 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 的纯净可编译分支。其上游源码于 2026 年 3 月 31 日通过 npm 分发中的 source map 意外泄露。本分支在此开源快照的基础上进行了四大类深度修改。

### 1. Embedded Free AI Channel (/free) / 内置免费 AI 通道 (/free)

**EN:** Integrated `cursor2api` as a deeply-embedded local proxy. By running `/free` in the terminal, you can instantly spin up a local proxy that intercepts and signs Claude AI requests using dynamically generated headers. This enables free access to models like Claude Sonnet 4.6 without requiring an Anthropic subscription or API key.  
**Highlights (核心亮点):**
- **Zero Configuration (零额外配置):** Just type `/free` and you are good to go. 无需繁琐部署，敲下 `/free` 即可全权接管后续流量。
- **Stealthy (隐蔽且无感):** Operates silently in the background, masking all traffic. 后台静默运行，伪装原生请求且不输出干扰信息。
- **Unlimited Usage (无限制游玩):** Bypass official API quota limits. 完美绕过官方 API 的额度扣费和封号风险。

**ZH:** 深度集成了 `cursor2api` 作为本地反向代理。只需在终端内执行 `/free` 命令，系统便会瞬间启动本地代理，通过动态生成的请求头对所有发送给 Claude AI 的请求进行拦截和签名伪装。这让你能够在完全不需要 Anthropic 订阅或 API 密钥的情况下，自由畅享诸如 Claude Sonnet 4.6 等最新模型。

### 2. Telemetry removed / 移除隐私遥测

**EN:** The upstream binary phones home through OpenTelemetry/gRPC, GrowthBook analytics, Sentry error reporting, and custom event logging. In this build:
- All outbound telemetry endpoints are dead-code-eliminated or stubbed.
- GrowthBook feature flag evaluation still works locally (needed for runtime feature gates) but does not report back.
- No crash reports, no usage analytics, no session fingerprinting.  

**ZH:** 官方程序会在后台通过 OpenTelemetry/gRPC、GrowthBook 分析、Sentry 错误收集和自定义事件日志不断向官方服务器“打电话”。而在本版本中：
- 所有的外部遥测节点都被代码剔除或空置。
- GrowthBook 功能标志的计算逻辑在本地保留（系统运行必须依赖它的判断），但已彻底物理拔除它的回传能力。
- 零崩溃报告、零使用情况分析、零会话记录追踪。

### 3. Security-prompt guardrails removed / 破除“赛博安全”护栏

**EN:** Anthropic injects system-level instructions into every conversation that constrain Claude's behavior beyond what the model itself enforces. These include:
- Hardcoded refusal patterns for certain categories of prompts.
- Injected "cyber risk" instruction blocks.
- Managed-settings security overlays pushed from Anthropic's servers.

This build strips those injections. The model's own safety training still applies -- this just removes the extra layer of prompt-level restrictions that the CLI wraps around it.  

**ZH:** Anthropic 会在每一次对话的系统提示词中强制塞入一堆指令，用来从极严苛的角度约束 Claude 的行为。这包括：
- 对特定提示词类别的硬编码拒绝模板。
- 强行注入的“网络安全风险”警示代码块。
- 从官方服务器动态推送覆盖的安全管理配置。

本版本强行剥离了上述所有恶心限制。当然模型本身自带的基础安全认知依然有效，我们只是拆掉了这个 CLI 外壳给模型强加的这层强制枷锁。

### 4. Experimental features enabled / 解锁所有实验性开关

**EN:** Claude Code ships with dozens of feature flags gated behind `bun:bundle` compile-time switches. Most are disabled in the public npm release. This build unlocks all 45+ flags that compile cleanly.  
**ZH:** Claude Code 内置了数十个由 `bun:bundle` 编译时控制的功能开关。绝大多数在官方放出的 npm 公开版本中被刻意关停了。本版本暴力解锁了所有能够成功编译的 45+ 个实验性特性。

| Feature (特性) | What it does (功能说明) |
|---|---|
| `ULTRAPLAN` | Remote multi-agent planning on Claude Code web (Opus-class) / 基于 Claude 网页端的多智能体深度规划(Opus级别) |
| `ULTRATHINK` | Deep thinking mode -- type "ultrathink" to boost reasoning effort / 深度思考模式(输入 ultrathink 开启) |
| `VOICE_MODE` | Push-to-talk voice input and dictation / 按需语音输入与听写支持 |
| `AGENT_TRIGGERS` | Local cron/trigger tools for background automation / 用于后台自动化的本地定时计划任务触发器 |
| `BRIDGE_MODE` | IDE remote-control bridge (VS Code, JetBrains) / IDE 远程控制桥接通信模块 |
| `TOKEN_BUDGET` | Token budget tracking and usage warnings / Token 额度追踪及耗尽警告支持 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Built-in explore/plan agent presets / 内置的探索与规划智能体预设 |
| `VERIFICATION_AGENT` | Verification agent for task validation / 用于任务确认校验的安全智能体 |
| `BASH_CLASSIFIER` | Classifier-assisted bash permission decisions / 用于 bash 权限验证判断的分类器助手 |
| `EXTRACT_MEMORIES` | Post-query automatic memory extraction / 查询完成后的自动化长上下文记忆提取机制 |
| `HISTORY_PICKER` | Interactive prompt history picker / 交互式历史提示词筛选器 |
| `MESSAGE_ACTIONS` | Message action entrypoints in the UI / UI 中的消息操作入口点支持 |
| `QUICK_SEARCH` | Prompt quick-search / 提示词快捷搜索系统 |
| `SHOT_STATS` | Shot-distribution stats / Shot 分布数据统计 |
| `COMPACTION_REMINDERS` | Smart reminders around context compaction / 上下文即将被压缩截断的智能提式 |
| `CACHED_MICROCOMPACT` | Cached microcompact state through query flows / 贯穿查询流的微缩状态缓存支持 |

*(See [FEATURES.md](FEATURES.md) for the full audit of all 88 flags and their status.)*

---

## Quick install / 极速安装

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/kyxiaxiang/redcode/main/install.sh | bash
```

**EN:** This will check your system, install Bun if needed, clone the repo, build the binary with all experimental features enabled, and symlink it as `redcode` on your PATH.  
**ZH:** 脚本将检测系统环境并安装要求版本的 Bun。随后拉取新版仓库并将所有的限制功能全部解禁编译。最后在系统的 PATH 环境变量中将生成的可执行文件自动链接为 `redcode`。

### Windows

**EN:** Windows currently does not support the automated installation script. You must manually clone this repository, compile the Windows executable using `bun run build:dev:full:exe`, and manually add the resulting executable to your system's environment variable `PATH`.  
**ZH:** Windows 系统暂不支持上述的一键安装脚本。Windows 用户需要自行克隆本仓库代码，进入目录后执行专属构建命令 `bun run build:dev:full:exe`，并在编译完成后自行将产出目录添加至系统的全局环境变量 `PATH`。

### After install (安装完成后直接运行)

```bash
# Optional API Key (可以直接不填使用 /free)
export ANTHROPIC_API_KEY="sk-ant-..."
redcode
```

---

## Requirements / 环境要求

- [Bun](https://bun.sh) >= 1.3.11
- macOS or Linux (Windows via WSL) / 对 Windows 原生用户请使用 WSL
- An Anthropic API key (or use `/free` without one) / 可选的 API 密钥

```bash
# Install Bun if you don't have it (手动安装 Bun)
curl -fsSL https://bun.sh/install | bash
```

---

## Build / 手动构建

```bash
# Clone the repo
git clone https://github.com/kyxiaxiang/redcode.git
cd redcode

# Install dependencies (安装依赖)
bun install

# Standard build -- produces ./cli (标准构建)
bun run build

# Dev build -- dev version stamp, experimental GrowthBook key (开发版构建)
bun run build:dev

# Dev build with ALL experimental features enabled -- produces ./cli-dev (暴力解锁版构建)
bun run build:dev:full

# Compiled build (alternative output path) -- produces ./dist/cli 
bun run compile
```

---

## Run / 运行命令

```bash
# Run the built binary directly
./cli

# Or the dev binary
./cli-dev

# Set your API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Or use Claude.ai OAuth
./cli /login
```

### Quick test / 快速测试

```bash
# One-shot mode (单次任务模式)
./cli -p "what files are in this directory?"

# Interactive REPL (交互式控制台模式)
./cli

# With specific model (指定特定模型运行)
./cli --model claude-sonnet-4-6-20250514
```

---

## Project structure / 项目源码结构

```text
scripts/
  build.ts              # Build script with feature flag system (带功能开关逻辑的构建脚本)

src/
  entrypoints/cli.tsx   # CLI entrypoint (CLI 程序入口)
  commands.ts           # Command registry (slash commands) (命令注册中心)
  tools.ts              # Tool registry (agent tools) (智能体工具注册)
  QueryEngine.ts        # LLM query engine (大语言模型查询驱动引擎)
  screens/REPL.tsx      # Main interactive UI (主交互界面核心)

  commands/             # /slash command implementations (/斜杠系统命令实现)
  tools/                # Agent tool implementations (Bash, Read, Edit, etc.) (各种工具实现)
  components/           # Ink/React terminal UI components (采用 Ink 和 React 开发的控制台界面组件)
  services/             # API client, MCP, OAuth, analytics (各种客户端与后端通信服务)
  state/                # App state store (应用状态存储库)
  utils/                # Utilities (底层常用工具类)
  skills/               # Skill system (预设专业技能系统)
  plugins/              # Plugin system (插件系统)
```

---

## Tech stack / 技术栈构成

| Component / 组件 | Technology / 技术 |
|---|---|
| Runtime (运行环境) | [Bun](https://bun.sh) |
| Language (开发语言) | TypeScript |
| Terminal UI (控制台界面) | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing (命令行参数解析) | [Commander.js](https://github.com/tj/commander.js) |
| Schema validation (约束校验) | Zod v4 |
| Code search (代码搜索引擎) | ripgrep (bundled) |
| Protocols (通信协议) | MCP, LSP |
| API | Anthropic Messages API |

---

## Acknowledgments / 鸣谢

**EN:** This version of redcode includes an embedded proxy to enable a free AI channel via the `/free` command. We would like to acknowledge the following open-source projects that made this possible:  
**ZH:** 本版本的 redcode 通过内嵌的反向代理实现了 `/free` 免费 AI 指令通道。感谢以下开源项目为此功能提供的巨大帮助和创意：

- [cursor2api](https://github.com/7836246/cursor2api)
- [free-code](https://github.com/paoloanzn/free-code)

---

## License / 许可与免责声明

**EN:** The original Claude Code source is the property of Anthropic. This fork exists because the source was publicly exposed through their npm distribution. Use at your own discretion.  
**ZH:** 原始的 Claude Code 源码所有权归 Anthropic 官方所有。本项目及其衍生代码的出现，完全是由于其 npm 安装包配置失误发生了严重的源代码意外泄漏事件。请根据您当地的政策自行斟酌使用。
