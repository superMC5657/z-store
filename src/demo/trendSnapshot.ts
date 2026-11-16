// 来自 github.com/trending 的真实快照（2026-11-16）。演示站离线，需要刷新时重新抓取。
// icon 为应用图标策略的离线结果：L2 品牌库(SimpleIcons) → L3 仓库 Git Trees；
// 都没命中时留空，由前端落到 L5 首字母徽章。
export interface DemoTrendRow {
  owner: string;
  repo: string;
  desc: string;
  lang: string;
  stars: number;
  forks: number;
  gain: number;
  icon: string;
  /** 依最新 Release 资产名离线检测；无二进制发布的库/技能包为空。 */
  platforms: readonly string[];
}

export const DEMO_TREND_SNAPSHOT: Record<'daily' | 'weekly' | 'monthly', readonly DemoTrendRow[]> = {
  "daily": [
    {
      "owner": "dream-num",
      "repo": "univer",
      "desc": "Build your own AI office with Univer Office SDK. Bring editing, calculation, collaboration, and file processing into your product for people and AI agents. Built on an extensible open-source core.",
      "lang": "TypeScript",
      "stars": 25595,
      "forks": 2338,
      "gain": 988,
      "icon": "https://raw.githubusercontent.com/dream-num/univer/dev/examples/public/favicon.svg",
      "platforms": []
    },
    {
      "owner": "ag-ui-protocol",
      "repo": "ag-ui",
      "desc": "AG-UI: the Agent-User Interaction Protocol. Bring Agents into Frontend Applications.",
      "lang": "TypeScript",
      "stars": 17835,
      "forks": 1818,
      "gain": 355,
      "icon": "https://raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/apps/dojo/src/app/icon.png",
      "platforms": []
    },
    {
      "owner": "google-labs-code",
      "repo": "stitch-skills",
      "desc": "A library of Agent Skills designed to work with the Stitch MCP server. Each skill follows the Agent Skills open standard, for compatibility with coding agents such as Antigravity, Gemini CLI, Claude Code, Cursor.",
      "lang": "TypeScript",
      "stars": 9278,
      "forks": 1125,
      "gain": 247,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "backnotprop",
      "repo": "plannotator",
      "desc": "The workspace to stay in the loop and on top of agents - shape, decide, plan, annotate, review code, share with team, and send all feedback to agents with one click.",
      "lang": "TypeScript",
      "stars": 11820,
      "forks": 1082,
      "gain": 866,
      "icon": "https://raw.githubusercontent.com/backnotprop/plannotator/main/apps/vscode-extension/images/icon.png",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "ChromeDevTools",
      "repo": "chrome-devtools-mcp",
      "desc": "Chrome DevTools for coding agents",
      "lang": "TypeScript",
      "stars": 56902,
      "forks": 4812,
      "gain": 717,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "alibaba",
      "repo": "open-code-review",
      "desc": "Secure, fast, efficient, battle-tested at Alibaba's scale. Hybrid architecture code review tool: deterministic pipelines + LLM Agent, precise line-level comments, built-in multi-language ruleset (NPE, thread-safety, XSS, SQL injection), OpenAI & Anthropic compatible.",
      "lang": "Go",
      "stars": 52049,
      "forks": 4107,
      "gain": 691,
      "icon": "https://raw.githubusercontent.com/alibaba/open-code-review/main/extensions/vscode/resources/icon.png",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "Tencent",
      "repo": "LoopForge",
      "desc": "Self-hosted workflows for coding-agent delivery. Orchestrate CodeBuddy, Codex and Claude Code with scripts and human approval gates. Includes Local workflows for coding assistants.",
      "lang": "Go",
      "stars": 1458,
      "forks": 264,
      "gain": 423,
      "icon": "https://raw.githubusercontent.com/Tencent/LoopForge/main/web/vscode-web/extensions/media-preview/icon.png",
      "platforms": []
    },
    {
      "owner": "ggml-org",
      "repo": "ggml",
      "desc": "Tensor library for machine learning",
      "lang": "C++",
      "stars": 15899,
      "forks": 2018,
      "gain": 43,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "elementalsouls",
      "repo": "Claude-BugHunter",
      "desc": "A Claude Code skill bundle for bug hunting and external red-team work - 82 skills, 15 slash commands, 681 disclosed-report patterns curated across 24 core vulnerability classes, plus enterprise identity + infrastructure attack matrices.",
      "lang": "Python",
      "stars": 6415,
      "forks": 967,
      "gain": 98,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "GoogleChrome",
      "repo": "modern-web-guidance-src",
      "desc": "Keep your coding agent up to date with the latest web best practices",
      "lang": "TypeScript",
      "stars": 7137,
      "forks": 599,
      "gain": 1219,
      "icon": "https://cdn.simpleicons.org/googlechrome",
      "platforms": []
    },
    {
      "owner": "tradermonty",
      "repo": "claude-trading-skills",
      "desc": "Claude Code skills for equity investors and traders — market analysis, technical charting, economic calendars, screeners, and trading strategy development.",
      "lang": "Python",
      "stars": 5525,
      "forks": 1173,
      "gain": 706,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "NVIDIA",
      "repo": "SkillEvaluator",
      "desc": "Multi-tier framework for evaluating AI agent skills with quality gates, semantic overlap detection, synthetic evaluation dataset generation, and live agent evaluation that measures how skills affect agent behavior.",
      "lang": "Python",
      "stars": 1654,
      "forks": 227,
      "gain": 122,
      "icon": "https://cdn.simpleicons.org/nvidia",
      "platforms": [
        "linux"
      ]
    }
  ],
  "weekly": [
    {
      "owner": "meta",
      "repo": "astryx",
      "desc": "An open source design system that's fully customizable and agent ready",
      "lang": "TypeScript",
      "stars": 28839,
      "forks": 2252,
      "gain": 13501,
      "icon": "https://cdn.simpleicons.org/meta",
      "platforms": []
    },
    {
      "owner": "anthropics",
      "repo": "skills",
      "desc": "Public repository for Agent Skills",
      "lang": "Python",
      "stars": 195348,
      "forks": 22962,
      "gain": 6077,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "sherlock-project",
      "repo": "sherlock",
      "desc": "Hunt down social media accounts by username across social networks",
      "lang": "Python",
      "stars": 112470,
      "forks": 12989,
      "gain": 10412,
      "icon": "https://raw.githubusercontent.com/sherlock-project/sherlock/master/docs/images/sherlock-logo.png",
      "platforms": []
    },
    {
      "owner": "backnotprop",
      "repo": "plannotator",
      "desc": "The workspace to stay in the loop and on top of agents - shape, decide, plan, annotate, review code, share with team, and send all feedback to agents with one click.",
      "lang": "TypeScript",
      "stars": 11820,
      "forks": 1082,
      "gain": 1719,
      "icon": "https://raw.githubusercontent.com/backnotprop/plannotator/main/apps/vscode-extension/images/icon.png",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "vercel-labs",
      "repo": "agent-browser",
      "desc": "Browser automation CLI for AI agents",
      "lang": "Rust",
      "stars": 51610,
      "forks": 3608,
      "gain": 4217,
      "icon": "https://raw.githubusercontent.com/vercel-labs/agent-browser/main/docs/src/app/favicon.ico",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "ZhuLinsen",
      "repo": "daily_stock_analysis",
      "desc": "LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。 LLM-powered multi-market stock analysis system with multi-source market data, real-time news, decision dashboard, automated notifications, and cost-free scheduled runs.",
      "lang": "Python",
      "stars": 72497,
      "forks": 57568,
      "gain": 4548,
      "icon": "https://raw.githubusercontent.com/ZhuLinsen/daily_stock_analysis/main/docs/assets/dsa_vi/darklogo.png",
      "platforms": [
        "windows",
        "macos"
      ]
    },
    {
      "owner": "we-promise",
      "repo": "sure",
      "desc": "The personal finance app for everyone (by everyone)",
      "lang": "Ruby",
      "stars": 15700,
      "forks": 1373,
      "gain": 4556,
      "icon": "https://raw.githubusercontent.com/we-promise/sure/main/desktop/src-tauri/icons/icon.png",
      "platforms": [
        "macos",
        "android",
        "ios"
      ]
    },
    {
      "owner": "milind-soni",
      "repo": "OpenMausBot",
      "desc": "Open-source Grok Bot alternative with a virtual machine that bots can use",
      "lang": "TypeScript",
      "stars": 23371,
      "forks": 3244,
      "gain": 5463,
      "icon": "https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/electron/resources/app-icon.png",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "google",
      "repo": "elephant-goldfish-model",
      "desc": "Open-source plugin for designing and reviewing software with agents",
      "lang": "Python",
      "stars": 19746,
      "forks": 1461,
      "gain": 5060,
      "icon": "https://cdn.simpleicons.org/google",
      "platforms": []
    },
    {
      "owner": "google-deepmind",
      "repo": "mujoco",
      "desc": "Multi-Joint dynamics with Contact. A general purpose physics simulator.",
      "lang": "C++",
      "stars": 18068,
      "forks": 2213,
      "gain": 1922,
      "icon": "https://raw.githubusercontent.com/google-deepmind/mujoco/main/studio/favicon.ico",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "addyosmani",
      "repo": "agent-skills",
      "desc": "Production-grade engineering skills for AI coding agents.",
      "lang": "JavaScript",
      "stars": 117937,
      "forks": 12340,
      "gain": 3889,
      "icon": "https://cdn.simpleicons.org/agentskills",
      "platforms": []
    }
  ],
  "monthly": [
    {
      "owner": "Nutlope",
      "repo": "hallmark",
      "desc": "Anti-AI-slop design skill for Claude Code, Cursor, and Codex.",
      "lang": "CSS",
      "stars": 55489,
      "forks": 2978,
      "gain": 25448,
      "icon": "https://raw.githubusercontent.com/Nutlope/hallmark/main/site/favicon.svg",
      "platforms": []
    },
    {
      "owner": "cloudflare",
      "repo": "security-audit-skill",
      "desc": "A coding-agent skill for multi-phase security audits with independently verified, machine-readable findings",
      "lang": "JavaScript",
      "stars": 73220,
      "forks": 4901,
      "gain": 43540,
      "icon": "https://cdn.simpleicons.org/cloudflare",
      "platforms": []
    },
    {
      "owner": "pingdotgg",
      "repo": "t3code",
      "desc": "The best way to control Claude Code, Codex and more from any computer or phone",
      "lang": "TypeScript",
      "stars": 61511,
      "forks": 11023,
      "gain": 33583,
      "icon": "",
      "platforms": [
        "windows",
        "macos",
        "linux",
        "android"
      ]
    },
    {
      "owner": "thedotmack",
      "repo": "claude-mem",
      "desc": "Persistent Context Across Sessions for Every Agent – Captures everything your agent does during sessions, compresses it with AI, and injects relevant context back into future sessions. Works with Claude Code, OpenClaw, Codex, Gemini, Hermes, Copilot, OpenCode + More",
      "lang": "TypeScript",
      "stars": 117369,
      "forks": 10193,
      "gain": 17038,
      "icon": "https://raw.githubusercontent.com/thedotmack/claude-mem/main/integrations/eve/template/apps/web/app/icon.svg",
      "platforms": []
    },
    {
      "owner": "pbakaus",
      "repo": "impeccable",
      "desc": "The design vocabulary for your coding agent. Steer with polish and bolder, review with critique and audit, catch AI slop before it ships.",
      "lang": "Rust",
      "stars": 110745,
      "forks": 6617,
      "gain": 29631,
      "icon": "https://raw.githubusercontent.com/pbakaus/impeccable/main/cursor-plugin/assets/icon.png",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    },
    {
      "owner": "anthropics",
      "repo": "skills",
      "desc": "Public repository for Agent Skills",
      "lang": "Python",
      "stars": 195348,
      "forks": 22962,
      "gain": 14332,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "HKUDS",
      "repo": "DeepTutor",
      "desc": "DeepTutor: Lifelong Personalized Tutoring. https://deeptutor.info/.",
      "lang": "Python",
      "stars": 59480,
      "forks": 7203,
      "gain": 18278,
      "icon": "https://raw.githubusercontent.com/HKUDS/DeepTutor/main/web/public/logo.png",
      "platforms": [
        "windows",
        "macos"
      ]
    },
    {
      "owner": "heygen-com",
      "repo": "hyperframes",
      "desc": "Write HTML. Render video. Built for agents.",
      "lang": "TypeScript",
      "stars": 84737,
      "forks": 7845,
      "gain": 20878,
      "icon": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/assets/logo.png",
      "platforms": []
    },
    {
      "owner": "sherlock-project",
      "repo": "sherlock",
      "desc": "Hunt down social media accounts by username across social networks",
      "lang": "Python",
      "stars": 112470,
      "forks": 12989,
      "gain": 18371,
      "icon": "https://raw.githubusercontent.com/sherlock-project/sherlock/master/docs/images/sherlock-logo.png",
      "platforms": []
    },
    {
      "owner": "AgriciDaniel",
      "repo": "claude-seo",
      "desc": "Universal SEO skill for Claude Code. 26 sub-skills + 19 sub-agents covering technical SEO, E-E-A-T, schema, GEO/AEO, agent readiness (Lighthouse Agentic Browsing, WebMCP, llms.txt), backlinks, local SEO, e-commerce, international SEO, Google APIs, and PDF/Excel reporting. 9 optional extensions for live SEO data.",
      "lang": "Python",
      "stars": 29711,
      "forks": 3741,
      "gain": 10672,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "Leonxlnx",
      "repo": "taste-skill",
      "desc": "Agent skills that give coding agents taste: art direction, reference images and a browser check instead of generic AI pages",
      "lang": "JavaScript",
      "stars": 116224,
      "forks": 7791,
      "gain": 19546,
      "icon": "https://raw.githubusercontent.com/Leonxlnx/taste-skill/main/assets/sponsors/kimi-icon.png",
      "platforms": []
    },
    {
      "owner": "anthropics",
      "repo": "knowledge-work-plugins",
      "desc": "Open source repository of plugins primarily intended for knowledge workers to use in Claude Cowork",
      "lang": "Python",
      "stars": 36181,
      "forks": 3997,
      "gain": 6417,
      "icon": "",
      "platforms": []
    },
    {
      "owner": "Vincentwei1021",
      "repo": "video-shotcraft",
      "desc": "AI video skill for Claude Code & Codex — cinematic, editable product promos with Remotion: 124 shot recipe cards, 150 motion previews, beat sync, sound design, Motion Workbench & JianYing (CapCut CN) export.",
      "lang": "TypeScript",
      "stars": 20052,
      "forks": 1872,
      "gain": 7937,
      "icon": "https://raw.githubusercontent.com/Vincentwei1021/video-shotcraft/main/gallery/logo-mark-reverse.svg",
      "platforms": []
    },
    {
      "owner": "vercel-labs",
      "repo": "agent-browser",
      "desc": "Browser automation CLI for AI agents",
      "lang": "Rust",
      "stars": 51610,
      "forks": 3608,
      "gain": 7545,
      "icon": "https://raw.githubusercontent.com/vercel-labs/agent-browser/main/docs/src/app/favicon.ico",
      "platforms": [
        "windows",
        "macos",
        "linux"
      ]
    }
  ]
};
