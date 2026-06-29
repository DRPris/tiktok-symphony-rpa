// 集中管理所有 TikTok Symphony Creative Studio 页面的选择器
// 便于页面更新时快速维护，只需修改此文件
//
// ⚠️ 重构提示：本文件中的字符串值会在系统启动时被 selector-store.ts 用
//    data/selectors.json 中的覆盖项就地 mutate；外部调用方仍可继续使用
//    `SELECTORS.common.chatInput` 这种字符串引用形式，无需修改任何业务代码。
//    若需要恢复默认，调用 getDefaultSelectors() 取深拷贝再 applySelectorOverrides(_, defaults, true)。

export const SELECTORS = {
  // 通用 - 适配 /create & /chat 页面自定义元素
  common: {
    chatInput:
      '.tiptap.ProseMirror, div.ProseMirror, ' +
      'textarea[placeholder*="Describe"], textarea[placeholder*="describe"], ' +
      'div[contenteditable="true"], ' +
      'textarea[placeholder*="TikTok trend"], textarea[placeholder*="vision"], ' +
      'textarea[placeholder*="Upload product"], textarea[placeholder*="describe your vision"], ' +
      '[class*="chat-input"], [class*="chatInput"], [class*="chatbox-input"], ' +
      'textarea[class*="input"], textarea[class*="textarea"], ' +
      '[class*="chatbox"] [contenteditable="true"], [class*="input-area"] [contenteditable="true"], ' +
      '[class*="composer"] [contenteditable="true"], [class*="prompt"] [contenteditable="true"], ' +
      '[data-role="chat-input"], [class*="message-input"]',
    // Send 按钮：可能是 <ks-icon-button> 或带 send 字样的 KsButton
    sendButton:
      'button[aria-label="Send"], [aria-label="Send"], button.send-btn, button[type="submit"], [class*="KsIconButton"][class*="send"], [class*="send-btn"], ' +
      '[class*="send-button"], [class*="SendButton"], [role="button"][aria-label*="send" i], ' +
      'button[class*="send"]',
    loadingSpinner: '.loading, [class*="loading"], [class*="spinner"]',
  },

  // 登录相关
  login: {
    loginPage: '[class*="login"], form[action*="login"]',
    emailInput: 'input[type="email"], input[name="email"]',
    passwordInput: 'input[type="password"]',
    loginButton: 'button[type="submit"]',
  },

  // 主页 & 模板选择（Symphony Creative Studio 新版）
  home: {
    // 关闭弹窗（Seedance 2.0 公告 / 产品更新 / 通用 modal）
    modalCloseButton:
      'button[class*="close"], button[class*="Close"], [class*="closeButton"], [aria-label="close"], [aria-label="Close"], button[class*="dismiss"], [class*="modal"] button[class*="icon"]',
    // 视频生成类型选择
    textToVideo: 'p:has-text("Text to video"), div:has-text("Text to video"):not(:has(div)), span:has-text("Text to video")',
    imageToVideo: 'p:has-text("Image to video"), div:has-text("Image to video"):not(:has(div)), span:has-text("Image to video")',
    referenceToVideo: 'p:has-text("Reference to Video"), div:has-text("Reference to Video"):not(:has(div)), span:has-text("Reference to Video")',
    // "Try now" / "Get started" 主 CTA 按钮
    tryNowButton: 'button:has-text("Try now"), a:has-text("Try now"), button:has-text("Get started"), a:has-text("Get started")',
    // 旧版兼容（已废弃）
    templateGrid: '[class*="template-grid"], [class*="template-list"]',
    templateCard: '[class*="template-card"], [class*="template-item"]',
    generateButton: 'button:has-text("Generate Your Own"), a:has-text("Generate Your Own")',
  },

  // Agent 模式 - 适配 /create 及 /chat 页面的自定义元素 <ks-button-...> + KsButton class
  agent: {
    // 侧边栏 "Agent" 导航项（2026-06 改版后 Agent 从首位挊到第三位）
    // 侧边栏可能是 <a>、<button>、<div> 等元素
    sidebarAgentNav:
      'nav a:has-text("Agent"), aside a:has-text("Agent"), ' +
      'nav button:has-text("Agent"), aside button:has-text("Agent"), ' +
      '[class*="sidebar"] a:has-text("Agent"), [class*="sidebar"] button:has-text("Agent"), ' +
      '[class*="side-nav"] :has-text("Agent"), ' +
      '[class*="nav-menu"] :has-text("Agent"), ' +
      'a[href*="/agent"]:has-text("Agent"), ' +
      'button:has-text("Agent"):not([class*="tab"])',
    // 内容区 Agent 标签页 tab
    agentTab:
      '[role="tab"]:has-text("Agent"), ' +
      'div[class*="tab"]:has-text("Agent"):not(:has(div[class*="tab"])), ' +
      'button[class*="tab"]:has-text("Agent"), ' +
      '[class*="tabs"] > *:has-text("Agent")',
    // 通用入口（兜底）
    agentModeEntry:
      'a[href*="agent"]:has-text("Agent"), ' +
      'button:has-text("Agent"), [role="tab"]:has-text("Agent"), ' +
      '[class*="agent"]:not([class*="agent-avatar"]):not([class*="message"])',
    // 兼容：自定义元素 ks-button-* / KsButton class / 普通 button / div 容器
    trendingTemplate:
      '[class*="KsButton"]:has-text("Trending Template"), button:has-text("Trending Template"), [class*="chatbox"]:has-text("Trending Template"), a:has-text("Trending Template"), button:has-text("Trending template"), div:has-text("Trending Template"):not(:has(div))',
    topAds:
      '[class*="KsButton"]:has-text("Top Performing Ads"), button:has-text("Top Performing Ads"), [class*="chatbox"]:has-text("Top Performing Ads"), a:has-text("Top Performing Ads"), button:has-text("Top performing ads"), button:has-text("Top ads"), div:has-text("Top Performing Ads"):not(:has(div))',
    selectButton: '[class*="KsButton"]:has-text("Select"), button:has-text("Select")',
    filterInput: 'input[class*="filter"], input[class*="search"]',
    // 模式切换按钮：TikTok Symphony / TikTok trend（新旧命名兼容）
    // 新版已将 "TikTok trend" 重命名为 "TikTok Symphony" 或 "Symphony"
    tiktokTrendButton:
      '[class*="chatbox-setting-btn"]:has-text("TikTok"), [class*="KsButton"]:has-text("TikTok Symphony"), button:has-text("TikTok Symphony"), [class*="KsButton"]:has-text("TikTok trend"), button:has-text("TikTok trend"), [class*="setting-btn"]:has-text("Symphony"), button:has-text("Symphony"):not(:has-text("Dreamina")), [class*="select"]:has-text("TikTok Symphony"), [role="option"]:has-text("TikTok Symphony"), [role="option"]:has-text("Symphony"), [class*="dropdown-item"]:has-text("TikTok Symphony"), [class*="menu-item"]:has-text("TikTok Symphony")',
    // Dreamina Seedance 2.0 模式下拉触发器（点击打开下拉列表）
    dreaminaButton:
      '[class*="chatbox-setting-btn"]:has-text("Dreamina"), [class*="KsButton"]:has-text("Dreamina"), button:has-text("Dreamina"), button:has-text("Seedance"), ' +
      'span:has-text("Dreamina"), div:has-text("Dreamina Seedance"):not(:has(div:has-text("Dreamina")))',
    uploadReferenceVideo:
      '[class*="KsButton"]:has-text("Upload reference video"), button:has-text("Upload reference video"), div:has-text("Upload reference video"), button:has-text("Upload Reference Video")',
    selectTrend:
      '[class*="KsButton"]:has-text("Select a trend"), button:has-text("Select a trend"), div:has-text("Select a trend"), button:has-text("Select a Trend")',
    // "+" 按钮（上传图 / Library）：优先 aria-label="Upload first frame"（2026-06 新版）
    addButton:
      'button[aria-label="Upload first frame"], button[aria-label="Upload"], button[aria-label="Attach"], ' +
      '[data-testid="library-add-button"], [class*="KsButton"]:has-text("Add"):not(:has-text("Address")), ' +
      'button[aria-label="Add"], button[aria-label="add"]',
    // 上传选项：TikTok 新版用 "Upload files"，旧版用 "Upload images"
    uploadImagesOption:
      '[class*="KsButton"]:has-text("Upload files"), [class*="KsButton"]:has-text("Upload images"), button:has-text("Upload files"), button:has-text("Upload images"), div:has-text("Upload files"), div:has-text("Upload images"), [role="menuitem"]:has-text("Upload")',
  },

  // Brief 和分镜确认 - 同时兼容自定义元素
  conversation: {
    confirmBrief:
      '[class*="KsButton"]:has-text("Generate a storyboard"), [class*="KsButton"]:has-text("Generate storyboard"), [class*="KsButton"]:has-text("Looks great"), [class*="KsButton"]:has-text("Confirm"), [class*="KsButton"]:has-text("Continue"), button:has-text("Generate a storyboard"), button:has-text("Generate storyboard"), button:has-text("Looks great"), button:has-text("looks great"), button:has-text("Confirm"), button:has-text("Continue"), button:has-text("Create storyboard")',
    confirmStoryboard:
      '[class*="KsButton"]:has-text("Generate your TikTok-ready ad video"), [class*="KsButton"]:has-text("Generate the video"), [class*="KsButton"]:has-text("Generate video"), [class*="KsButton"]:has-text("Looks good"), [class*="KsButton"]:has-text("Start generating"), button:has-text("Generate your TikTok-ready ad video"), button:has-text("Generate the video"), button:has-text("Generate video"), button:has-text("Looks good"), button:has-text("looks good"), button:has-text("Start generating"), button:has-text("Continue to generate"), button:has-text("Looks perfect")',
    aiResponse: '[class*="ai-response"], [class*="assistant-message"], [class*="bot-message"], [data-message-role="assistant"]',
    userMessage: '[class*="user-message"], [data-message-role="user"]',
  },

  // 视频生成 & 结果
  generation: {
    retryButton: 'button:has-text("Please try again"), button:has-text("Let\'s try generating the video again"), button:has-text("Regenerate"), button:has-text("Try again")',
    // 只匹配有实际视频源的 video 元素（避免匹配空 video 标签或缩略图）
    videoPlayer: 'video[src*="video"], video[src*="output"], video:has(source[src*="video"]), video[src]:not([src*="thumbnail"]):not([src*="preview"])',
    // 下载按钮：排除导航栏中的通用 Download 链接，只匹配对话区内的
    downloadButton:
      'button:has-text("Download video"), button:has-text("Download Video"), button:has-text("Download"):not([class*="nav"]), a[download][href*="video"], a[href*="video"][download]',
    // 生成中状态指示器（避免匹配 Task progress 的静态进度条）
    generatingIndicator: '[class*="generating"]:not([style*="display: none"]), [class*="progress-bar"], [class*="loading-animation"]',
    generationComplete: '[class*="complete"], [class*="success"], [class*="video-ready"]',
  },

  // 文件上传
  upload: {
    fileInput: 'input[type="file"]',
    uploadButton: 'button:has-text("Upload"), [class*="upload"]',
    uploadComplete: '[class*="upload-success"], [class*="uploaded"], [class*="file-item"], [class*="thumbnail"]',
  },
};

// ─────────────────────────────────────────────
// 默认值快照（深拷贝），用于「重置/差异比较/导出」
// 启动后 SELECTORS 可能被 user override 覆盖，但 _DEFAULT_SELECTORS 永远是出厂值
// ─────────────────────────────────────────────
const _DEFAULT_SELECTORS = JSON.parse(JSON.stringify(SELECTORS)) as typeof SELECTORS;

/** 获取出厂默认选择器（深拷贝，调用方改了不会影响内部） */
export function getDefaultSelectors(): typeof SELECTORS {
  return JSON.parse(JSON.stringify(_DEFAULT_SELECTORS));
}

/**
 * 把覆盖项应用到 SELECTORS 对象（就地 mutate）。
 *
 * @param target  通常传入本模块的 SELECTORS（也支持任意结构相同的对象，便于测试）
 * @param patches 两种格式都支持：
 *                1) 扁平形式：{ "common.chatInput": "new selector" }
 *                2) 嵌套形式：{ common: { chatInput: "new selector" } }
 * @param resetFirst 为 true 时先把 target 重置回 _DEFAULT_SELECTORS，再叠加 patches；
 *                   常用于「移除某条 override 后让旧值不残留」。
 */
export function applySelectorOverrides(
  target: any,
  patches: Record<string, any>,
  resetFirst = false
): void {
  if (resetFirst) {
    const def = getDefaultSelectors() as any;
    for (const group of Object.keys(def)) {
      if (!target[group]) target[group] = {};
      for (const key of Object.keys(def[group])) {
        target[group][key] = def[group][key];
      }
    }
  }
  if (!patches || typeof patches !== 'object') return;
  for (const k of Object.keys(patches)) {
    const v = patches[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // 嵌套形式：{ common: { chatInput: '...' } }
      if (!target[k]) target[k] = {};
      for (const sk of Object.keys(v)) {
        if (typeof v[sk] === 'string') target[k][sk] = v[sk];
      }
    } else if (typeof v === 'string') {
      // 扁平形式：{ 'common.chatInput': '...' }
      const dot = k.indexOf('.');
      if (dot < 0) continue;
      const group = k.slice(0, dot);
      const key = k.slice(dot + 1);
      if (!target[group]) target[group] = {};
      target[group][key] = v;
    }
  }
}

/** 把当前 SELECTORS 拍平成 { 'common.chatInput': '...' } 形式，便于面板展示/比较 */
export function flattenSelectors(s: any = SELECTORS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of Object.keys(s)) {
    const sub = s[group];
    if (sub && typeof sub === 'object') {
      for (const key of Object.keys(sub)) {
        if (typeof sub[key] === 'string') {
          out[`${group}.${key}`] = sub[key];
        }
      }
    }
  }
  return out;
}
