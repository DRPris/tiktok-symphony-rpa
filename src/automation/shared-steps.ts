import { Page } from 'playwright';
import { config } from '../config';
import { SELECTORS } from './selectors';
import { NeedsManualError, ContentRejectedError } from './errors';

/**
 * 点击 "+ Start new chat" 按钮创建新对话，避免复用其他任务的聊天窗口。
 * 在多页并发场景下，TikTok 同一账号的不同 Tab 可能共享最近会话，
 * 必须显式创建新 chat 才能隔离各任务的上下文。
 */
export async function startNewChat(page: Page): Promise<void> {
  // 策略 1：Playwright locator 文本匹配（最可靠）
  try {
    const loc = page.locator('text=/Start new chat/i').first();
    const visible = await loc.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await loc.click();
      console.log('[shared-steps] startNewChat: ✅ 通过 locator 点击成功');
      await page.waitForTimeout(2000);
      return;
    }
  } catch {}

  // 策略 2：通过 DOM 遍历查找包含 "Start new chat" 或 "New chat" 文本的元素
  const clicked = await page.evaluate(() => {
    // 遍历所有可见元素
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const text = (el.textContent || '').trim();
      // 匹配包含 "Start new chat" 的叶子节点（避免匹配到父容器）
      if (/^\+?\s*Start new chat$/i.test(text) || /^New chat$/i.test(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top < 800) {
          (el as HTMLElement).click();
          return text.substring(0, 30);
        }
      }
    }
    return null;
  });

  if (clicked) {
    console.log(`[shared-steps] startNewChat: ✅ 通过 DOM 遍历点击成功: "${clicked}"`);
    await page.waitForTimeout(2000);
    return;
  }

  // 策略 3：给当前 URL 加 ?new=1 参数强制刷新（让页面重新初始化）
  console.log('[shared-steps] startNewChat: 未找到"Start new chat"按钮，继续执行（将依赖 URL 无 chatId 时自动创建新会话）');
}

/**
 * 移除/隐藏页面上可能拦截点击的蒙版元素
 * 包括：reactour 新手引导、其他透明蒙版
 * ⚠️ 使用 CSS 隐藏，不能 remove() DOM 节点，否则 React 会报
 *    "Failed to execute 'removeChild' on 'Node'" 错误崩溃
 * 该函数不会报错，可重复调用
 */
export async function removeOverlays(page: Page): Promise<void> {
  try {
    const result = await page.evaluate(() => {
      let count = 0;
      const hide = (el: Element) => {
        const e = el as HTMLElement;
        e.style.display = 'none';
        e.style.pointerEvents = 'none';
        e.style.visibility = 'hidden';
        count++;
      };
      // 隐藏 reactour 新手引导
      const tour = document.querySelector('#___reactour');
      if (tour) hide(tour);
      // 隐藏蒙版类元素
      document.querySelectorAll('[class*="reactour"], [class*="tour-mask"]').forEach(hide);
      return count;
    });
    if (result > 0) {
      console.log(`[shared-steps] removeOverlays: 隐藏了 ${result} 个蒙版元素`);
    }
  } catch {
    // 忽略
  }
}

/**
 * 随机延迟，模拟人类操作节奏，避免风控
 */
function randomDelay(min = 500, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 1. 输入 prompt 并发送
 * 注意：TikTok Creative Studio 使用 ProseMirror (tiptap) 编辑器，
 * 发送按钮是无文本的圆形图标按钮（无 aria-label），
 * 因此优先通过 Enter 键发送，失败时再尝试点击按钮。
 */
export async function inputPromptAndSend(page: Page, prompt: string): Promise<void> {
  console.log('[shared-steps] inputPromptAndSend: 定位对话输入框...');

  // 预处理：移除可能的新手引导蒙版（reactour）防止拦截点击
  await removeOverlays(page);

  const inputEl = await page.waitForSelector(SELECTORS.common.chatInput, {
    timeout: config.browser.defaultTimeout,
  });
  if (!inputEl) {
    throw new Error('[shared-steps] inputPromptAndSend: 未找到对话输入框');
  }

  // 聚焦并清空（使用 force 绕过蒙版）
  await inputEl.click({ force: true });
  await randomDelay(300, 600);
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await randomDelay(200, 400);

  // 输入 prompt：使用 insertText 触发 ProseMirror 正确的 beforeInput/input 事件
  console.log(`[shared-steps] inputPromptAndSend: 输入文本 (${prompt.length} 字符)...`);
  // 先尝试 fill（对普通 input/textarea 有效）。对 contenteditable，fill 可能不触发事件。
  try {
    await inputEl.fill(prompt);
  } catch {
    // fill 可能对 contenteditable 抛异常，用 insertText 代替
    await page.keyboard.insertText(prompt);
  }
  await randomDelay(800, 1200);

  // 验证输入框是否有内容（确保文本已输入）
  const hasContent = await inputEl.evaluate(el => (el.textContent || '').trim().length > 0);
  if (!hasContent) {
    console.log('[shared-steps] inputPromptAndSend: fill 未生效，使用 insertText 重试...');
    await inputEl.click({ force: true });
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await randomDelay(200, 400);
    await page.keyboard.insertText(prompt);
    await randomDelay(800, 1200);
  }

  // 发送消息
  console.log('[shared-steps] inputPromptAndSend: 尝试发送...');
  let sent = false;

  // 方案0: 新版 TikTok Agent 首页发送按钮（"€ 15 ↑" 样式）
  // 新版 UI 的发送按钮包含积分成本和向上箭头，位于输入区域右侧或下方
  // 可能是 button/div/span 元素，不一定有 rounded-full class
  // 策略：先在输入框的父容器内搜索（最可靠），再在全页搜索
  try {
    await randomDelay(500, 800);
    const result = await page.evaluate(() => {
      // 查找输入框位置作为参考
      const inputEl = document.querySelector(
        '.tiptap.ProseMirror, div.ProseMirror, div[contenteditable="true"], ' +
        'textarea[placeholder*="describe"], textarea[placeholder*="vision"], ' +
        'textarea[placeholder*="Upload"], [class*="chat-input"], [class*="chatInput"], ' +
        'textarea[class*="input"], textarea[class*="textarea"]'
      ) as HTMLElement | null;
      const inputRect = inputEl?.getBoundingClientRect();

      // 排除文本列表：导航、建议卡片、帮助等
      const EXCLUDE_TEXTS = ['Trend', 'Dreamina', 'English', 'Help', 'support', 'Feedback',
        'Agent', 'Home', 'Create', 'Tools', 'Library', 'Products', 'Trends', 'Inspire',
        'apparel', 'beauty', 'furniture', 'Drop files', 'Start new chat',
        'Business Center', 'Ads Manager', 'TikTok One', 'Leads Center',
        'Rename', 'Delete', 'Edit', 'Copy', 'Cancel', 'Close'];
      const isExcluded = (text: string) => {
        return EXCLUDE_TEXTS.some(t => text.includes(t));
      };

      // 检查元素是否在导航区域内
      const isInNavArea = (el: HTMLElement): boolean => {
        let node: HTMLElement | null = el;
        for (let i = 0; i < 8 && node; i++) {
          const tag = node.tagName?.toLowerCase();
          if (tag === 'nav' || tag === 'header') return true;
          const role = (node.getAttribute('role') || '').toLowerCase();
          if (role === 'navigation' || role === 'banner') return true;
          const cls = (node.className || '').toString().toLowerCase();
          if (cls.includes('sidebar') || cls.includes('nav-') || cls.includes('navbar') ||
            cls.includes('header') || cls.includes('global-toolbar')) return true;
          node = node.parentElement;
        }
        return false;
      };

      // 在给定容器内查找发送按钮
      const findSendButton = (container: HTMLElement | Document): HTMLElement | null => {
        const candidates = Array.from(container.querySelectorAll(
          'button, [role="button"], [class*="cursor-pointer"], [class*="send"], [class*="Send"]'
        )) as HTMLElement[];
        // 补充：带 cursor:pointer 的 div/span
        const extraEls = Array.from(container.querySelectorAll('div, span')) as HTMLElement[];
        for (const el of extraEls) {
          if (candidates.includes(el)) continue;
          const cs = window.getComputedStyle(el);
          if (cs.cursor === 'pointer') candidates.push(el);
        }

        for (const htmlEl of candidates) {
          const cs = window.getComputedStyle(htmlEl);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          if (cs.pointerEvents === 'none') continue;  // ★ 排除不可点击元素
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          // 尺寸过滤：发送按钮 14-150px 宽，14-60px 高（放宽最小尺寸以匹配小图标按钮）
          if (rect.width < 14 || rect.width > 150 || rect.height < 14 || rect.height > 60) continue;
          if (rect.top < 80) continue;
          if (cs.position === 'fixed' || cs.position === 'sticky') continue;
          if (isInNavArea(htmlEl)) continue;

          const text = (htmlEl.textContent || '').trim();
          const cls = (htmlEl.className || '').toString().toLowerCase();
          const aria = (htmlEl.getAttribute('aria-label') || '').toLowerCase();

          // 排除覆盖层按钮（图片删除/关闭按钮等）
          if (cls.includes('pointer-events-none')) continue;
          if (cls.includes('absolute') && (cls.includes('z-[') || cls.includes('z-10') || cls.includes('z-20'))) continue;
          if (cls.includes('bg-transparent') && cls.includes('absolute')) continue;
          if (cls.includes('inset-x-') || cls.includes('inset-0')) continue;

          if (isExcluded(text)) continue;
          if (aria.includes('upload') || aria.includes('attach') || aria.includes('add')) continue;

          // 特征检测
          const hasArrowChar = text.includes('↑') || text.includes('➤') || text.includes('➢') || text.includes('▶');
          const hasCredits = /[€$£]\s*\d+/.test(text) || /\d+\s*credits?/i.test(text) || /^\d+\s*↑$/.test(text);
          const svg = htmlEl.querySelector('svg');
          const hasSvgArrow = !!svg && text.length < 20;
          const hasSendLabel = aria.includes('send') || cls.includes('send');

          // 至少满足一个特征
          if (!hasArrowChar && !hasCredits && !hasSendLabel && !hasSvgArrow) continue;

          // 当 inputRect 为 null 时，只信强信号
          if (!inputRect) {
            if (!hasArrowChar && !hasCredits && !hasSendLabel) continue;
          }

          // 可点击性检查
          const isClickable = cs.cursor === 'pointer' || htmlEl.tagName === 'BUTTON' ||
            htmlEl.getAttribute('role') === 'button' || cls.includes('btn') || cls.includes('button');
          if (!isClickable) continue;

          // 位置检查：在输入框附近（新版 UI 的发送按钮可能在输入框下方 200px 的控件行）
          if (inputRect) {
            const isRightOfInput = rect.left >= inputRect.right - 150 &&
              Math.abs(rect.top - inputRect.top) < 250;
            const isBelowInput = rect.top >= inputRect.bottom - 50 &&
              rect.top <= inputRect.bottom + 250 &&
              rect.left >= inputRect.left - 80;
            const isInsideInputCard = rect.top >= inputRect.top - 80 &&
              rect.bottom <= inputRect.bottom + 250 &&
              rect.left >= inputRect.left - 50;
            if (!isRightOfInput && !isBelowInput && !isInsideInputCard) continue;
          }

          return htmlEl;
        }
        return null;
      };

      // 策略1：在输入框的父容器（输入卡片）内查找
      let foundBtn: HTMLElement | null = null;
      if (inputEl) {
        let parent: HTMLElement | null = inputEl;
        for (let level = 0; level < 5 && parent; level++) {
          parent = parent.parentElement;
          if (!parent) break;
          foundBtn = findSendButton(parent);
          if (foundBtn) break;
        }
      }

      // 策略1.5：在输入框父容器内查找发送按钮（优先特征匹配，其次最右元素）
      if (!foundBtn && inputEl && inputRect) {
        let parent: HTMLElement | null = inputEl;
        for (let level = 0; level < 4 && parent; level++) {
          parent = parent.parentElement;
          if (!parent) break;
          // 搜索所有元素（不仅是可点击的），因为发送按钮可能没有 cursor:pointer
          const allEls = Array.from(parent.querySelectorAll(
            'button, [role="button"], div, span, a'
          )) as HTMLElement[];
          // 候选列表
          const candidates: HTMLElement[] = [];
          for (const el of allEls) {
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
            if (cs.pointerEvents === 'none') continue;
            if (cs.position === 'fixed' || cs.position === 'sticky') continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.width < 14 || r.width > 200 || r.height < 14 || r.height > 80) continue;
            // ★ 位置约束：必须在输入框附近（上下 300px，左右不限但要在合理范围）
            const dy = Math.abs(r.top - inputRect.top);
            if (dy > 350 && r.top > inputRect.bottom + 300) continue;
            if (r.top < inputRect.top - 100 && r.bottom < inputRect.top) continue;
            const elCls = (el.className || '').toString().toLowerCase();
            // 排除覆盖层元素
            if (elCls.includes('pointer-events-none')) continue;
            if (elCls.includes('absolute') && (elCls.includes('z-[') || elCls.includes('z-10') || elCls.includes('z-20'))) continue;
            if (elCls.includes('bg-transparent') && elCls.includes('absolute')) continue;
            if (elCls.includes('inset-x-') || elCls.includes('inset-0')) continue;
            // ★ 排除图片缩略图/预览元素
            if (elCls.includes('object-cover') || elCls.includes('overflow-hidden')) continue;
            if (elCls.includes('image') || elCls.includes('thumb') || elCls.includes('img-')) continue;
            // 排除导航/建议卡片
            const elText = (el.textContent || '').trim();
            if (isExcluded(elText)) continue;
            if (isInNavArea(el)) continue;
            const elAria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (elAria.includes('upload') || elAria.includes('attach') || elAria.includes('add')) continue;
            // 排除太大的文本块（发送按钮文本很短）
            if (elText.length > 50) continue;
            candidates.push(el);
          }
          // 优先：有 SVG 图标 + 文本很短的元素（发送按钮 "€ 15 ↑" 特征）
          const svgCandidates = candidates.filter(el => {
            const svg = el.querySelector('svg');
            if (!svg) return false;
            const t = (el.textContent || '').trim();
            if (t.length >= 20) return false;
            // ★ 排除图片缩略图/预览元素
            const ec = (el.className || '').toString().toLowerCase();
            if (ec.includes('object-cover') || ec.includes('overflow-hidden')) return false;
            if (ec.includes('image') || ec.includes('thumb')) return false;
            // ★ 排除完全空文本的元素（发送按钮至少有 "15" 文本）
            if (t.length === 0) return false;
            // ★ 位置：发送按钮在输入框下方或右侧，不在上方
            const r = el.getBoundingClientRect();
            if (inputRect && r.bottom < inputRect.top - 20) return false;  // 不在输入框上方
            return true;
          });
          if (svgCandidates.length > 0) {
            // 在 SVG 候选中选最右的
            svgCandidates.sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return rb.left - ra.left;
            });
            foundBtn = svgCandidates[0];
            break;
          }
          // 其次：有箭头/credits 特征的元素
          const featureCandidates = candidates.filter(el => {
            const t = (el.textContent || '').trim();
            const c = (el.className || '').toString().toLowerCase();
            const a = (el.getAttribute('aria-label') || '').toLowerCase();
            return t.includes('↑') || t.includes('➤') || t.includes('▶') ||
                   /[€$£]\s*\d+/.test(t) || /\d+\s*credits?/i.test(t) ||
                   a.includes('send') || c.includes('send');
          });
          if (featureCandidates.length > 0) {
            featureCandidates.sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return rb.left - ra.left;
            });
            foundBtn = featureCandidates[0];
            break;
          }
          // 最后：选最右的可点击元素（需要 cursor:pointer 或 button 标签）
          const clickableCandidates = candidates.filter(el => {
            const cs = window.getComputedStyle(el);
            return cs.cursor === 'pointer' || el.tagName === 'BUTTON' ||
              el.getAttribute('role') === 'button';
          });
          if (clickableCandidates.length > 0) {
            clickableCandidates.sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return rb.left - ra.left;
            });
            foundBtn = clickableCandidates[0];
            break;
          }
        }
      }

      // 策略2：全页搜索
      if (!foundBtn) {
        foundBtn = findSendButton(document);
      }

      if (foundBtn) {
        const rect = foundBtn.getBoundingClientRect();
        foundBtn.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        foundBtn.click();
        return {
          clicked: true,
          tag: foundBtn.tagName,
          text: (foundBtn.textContent || '').trim().substring(0, 60),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          cls: (foundBtn.className || '').toString().substring(0, 60),
        };
      }

      // 诊断：收集输入框附近所有元素的信息（包括非可点击元素）
      const diag: any[] = [];
      if (inputRect) {
        // 搜索所有元素（不仅限于可点击的），重点关注含 SVG 的元素
        const nearbyEls = Array.from(document.querySelectorAll('button, [role="button"], div, span, a')) as HTMLElement[];
        for (const el of nearbyEls) {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.width < 10 || r.height < 10) continue;
          // 在输入框周围更广范围（500px）
          const dx = Math.max(0, Math.max(inputRect.left - r.right, r.left - inputRect.right));
          const dy = Math.max(0, Math.max(inputRect.top - r.bottom, r.top - inputRect.bottom));
          if (dx > 500 || dy > 400) continue;
          // 只记录有意义的元素：含 SVG、或可点击、或含箭头/credits 文本
          const hasSvg = !!el.querySelector('svg');
          const isClickable = cs.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
          const t = (el.textContent || '').trim();
          const hasFeature = t.includes('↑') || t.includes('➤') || /[€$£]\s*\d+/.test(t) || /\d+\s*credits?/i.test(t);
          if (!hasSvg && !isClickable && !hasFeature) continue;
          // 排除子元素已被父元素覆盖的情况（避免重复）
          if (t.length > 80) continue;
          diag.push({
            tag: el.tagName,
            text: t.substring(0, 40),
            w: Math.round(r.width),
            h: Math.round(r.height),
            x: Math.round(r.left),
            y: Math.round(r.top),
            cls: (el.className || '').toString().substring(0, 60),
            cursor: cs.cursor,
            svg: hasSvg,
            pe: cs.pointerEvents,
          });
        }
      }
      return { clicked: false, diag };
    });

    if ((result as any).clicked) {
      const r = result as any;
      console.log(`[shared-steps] inputPromptAndSend: ✅ [新版策略] 点击发送按钮 <${r.tag}> "${r.text}" (${r.w}x${r.h}) pos=(${r.x},${r.y}) cls="${r.cls}"`);
      sent = true;
    } else {
      // 诊断：打印输入框附近所有候选元素
      const diag: any[] = (result as any).diag || [];
      if (diag.length > 0) {
        console.log(`[shared-steps] inputPromptAndSend: 🔍 方案0 未找到发送按钮，输入框附近 ${diag.length} 个候选元素:`);
        diag.slice(0, 50).forEach((c, i) => {
          console.log(`  [${i}] <${c.tag}> "${c.text}" ${c.w}x${c.h} pos=(${c.x},${c.y}) cursor=${c.cursor} svg=${c.svg} pe=${c.pe} cls="${c.cls}"`);
        });
      } else {
        console.log('[shared-steps] inputPromptAndSend: 方案0 未找到发送按钮，且输入框附近无可点击元素');
      }
    }
  } catch (e) {
    console.warn('[shared-steps] inputPromptAndSend: 新版发送按钮检测异常:', (e as Error).message?.substring(0, 100));
  }

  // 方案1: 寻找已激活的发送按钮（旧版圆形图标按钮兼容）
  // TikTok 旧版发送按钮: 36x36 圆形图标按钮，有内容时从 opacity-30 变为正常状态
  if (!sent) {
    try {
      const allButtons = await page.$$('button, [role="button"]');
      for (const btn of allButtons) {
        const btnInfo = await btn.evaluate(el => {
          const cls = el.className || '';
          const isRound = cls.includes('rounded-full');
          const isDisabled = cls.includes('cursor-not-allowed') || cls.includes('opacity-30') || cls.includes('opacity-50');
          const size = el.getBoundingClientRect();
          const isSmall = size.width <= 60 && size.width >= 28;
          // 发送按钮特征：圆形、小尺寸、非禁用
          // 也匹配带 send class 的按钮
          const hasSendClass = cls.toLowerCase().includes('send');
          return { isRound, isDisabled, isSmall, hasSendClass, width: size.width, cls: cls.substring(0, 100) };
        });
        if (!btnInfo.isDisabled && ((btnInfo.isRound && btnInfo.isSmall) || btnInfo.hasSendClass)) {
          console.log(`[shared-steps] inputPromptAndSend: 找到发送按钮 (${btnInfo.width}px, class=${btnInfo.cls.substring(0, 50)})`);
          await btn.click({ force: true });
          sent = true;
          break;
        }
      }
    } catch (e) {
      console.warn('[shared-steps] inputPromptAndSend: 按钮查找失败:', (e as Error).message?.substring(0, 100));
    }
  }

  // 方案2: 使用键盘快捷键发送（Enter / Ctrl+Enter / Meta+Enter）
  if (!sent) {
    console.log('[shared-steps] inputPromptAndSend: 未找到可用发送按钮，使用键盘快捷键发送');
    await inputEl.click({ force: true });
    await randomDelay(200, 400);
    // 先试 Enter
    await page.keyboard.press('Enter');
    await randomDelay(500, 800);
    // 检查是否发送成功
    const enterCheck = await page.evaluate(() => {
      const input = document.querySelector('.tiptap.ProseMirror, div[contenteditable="true"], textarea') as HTMLElement | null;
      const t = input ? (input.textContent || (input as HTMLTextAreaElement).value || '').trim() : '';
      return { cleared: t.length < 5, url: window.location.href };
    });
    if (!enterCheck.cleared && !/\/chat\/\d+/.test(enterCheck.url)) {
      console.log('[shared-steps] inputPromptAndSend: Enter 未生效，尝试 Ctrl+Enter...');
      await inputEl.click({ force: true });
      await randomDelay(200, 400);
      await page.keyboard.press('Control+Enter');
      await randomDelay(500, 800);
      const ctrlCheck = await page.evaluate(() => {
        const input = document.querySelector('.tiptap.ProseMirror, div[contenteditable="true"], textarea') as HTMLElement | null;
        const t = input ? (input.textContent || (input as HTMLTextAreaElement).value || '').trim() : '';
        return { cleared: t.length < 5, url: window.location.href };
      });
      if (!ctrlCheck.cleared && !/\/chat\/\d+/.test(ctrlCheck.url)) {
        console.log('[shared-steps] inputPromptAndSend: Ctrl+Enter 未生效，尝试 Meta+Enter...');
        await inputEl.click({ force: true });
        await randomDelay(200, 400);
        await page.keyboard.press('Meta+Enter');
      }
    }
  }

  await randomDelay(1500, 2500);

  // 发送后验证：检查输入框是否清空、URL 是否跳转
  const sendCheck = await page.evaluate(() => {
    const input = document.querySelector('.tiptap.ProseMirror, div[contenteditable="true"], textarea') as HTMLElement | null;
    const inputText = input ? (input.textContent || (input as HTMLTextAreaElement).value || '').trim() : '';
    return {
      inputText: inputText.substring(0, 60),
      inputCleared: inputText.length < 5,
      url: window.location.href,
    };
  });
  console.log(`[shared-steps] inputPromptAndSend: 发送后验证 — 输入框清空=${sendCheck.inputCleared}, URL=${sendCheck.url}`);

  // 关键判断：如果 URL 已经从 /chat 变成 /chat/{id}，说明消息已成功发送并创建了会话
  const urlHasChatId = /\/chat\/\d+/.test(sendCheck.url);
  if (urlHasChatId) {
    // URL 含 chat ID = 消息已发送成功，即使输入框看起来有残留（那是新对话的 placeholder）
    console.log('[shared-steps] inputPromptAndSend: 发送完成（URL 已变更到 chat ID，确认发送成功）');
    return;
  }

  if (!sendCheck.inputCleared) {
    console.warn(`[shared-steps] inputPromptAndSend: ⚠️ 输入框未清空（残留: "${sendCheck.inputText}"），消息可能未发送！尝试兜底策略...`);

    // 兜底策略 A: 更积极地搜索发送按钮（放宽所有限制，但排除导航按钮）
    const fallbackResult = await page.evaluate(() => {
      const inputEl = document.querySelector(
        '.tiptap.ProseMirror, div[contenteditable="true"], textarea, ' +
        '[class*="chat-input"], [class*="chatInput"], [class*="input-area"], ' +
        '[class*="composer"], [class*="prompt"]'
      ) as HTMLElement | null;
      const inputRect = inputEl?.getBoundingClientRect();

      // 排除文本列表：导航、建议卡片、帮助等
      const EXCLUDE_TEXTS = ['Trend', 'Dreamina', 'English', 'Help', 'support', 'Feedback',
        'Agent', 'Home', 'Create', 'Tools', 'Library', 'Products', 'Trends', 'Inspire',
        'apparel', 'beauty', 'furniture', 'Drop files', 'Start new chat',
        'Business Center', 'Ads Manager', 'TikTok One', 'Leads Center',
        'Rename', 'Delete', 'Edit', 'Copy', 'Cancel', 'Close'];
      const isExcluded = (text: string) => EXCLUDE_TEXTS.some(t => text.includes(t));

      // 导航区域检查
      const isInNavArea = (el: HTMLElement): boolean => {
        let node: HTMLElement | null = el;
        for (let i = 0; i < 8 && node; i++) {
          const tag = node.tagName?.toLowerCase();
          if (tag === 'nav' || tag === 'header') return true;
          const role = (node.getAttribute('role') || '').toLowerCase();
          if (role === 'navigation' || role === 'banner') return true;
          const cls = (node.className || '').toString().toLowerCase();
          if (cls.includes('sidebar') || cls.includes('nav-') || cls.includes('navbar') ||
            cls.includes('header') || cls.includes('global-toolbar')) return true;
          node = node.parentElement;
        }
        return false;
      };

      // 搜索所有可点击元素，查找可能的发送按钮
      const allEls = Array.from(document.querySelectorAll(
        'button, [role="button"], [class*="cursor-pointer"], [class*="send"], [class*="Send"]'
      )) as HTMLElement[];
      const extraEls = Array.from(document.querySelectorAll('div, span')) as HTMLElement[];
      for (const el of extraEls) {
        if (allEls.includes(el)) continue;
        const cs = window.getComputedStyle(el);
        if (cs.cursor === 'pointer') allEls.push(el);
      }

      for (const htmlEl of allEls) {
        const cs = window.getComputedStyle(htmlEl);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // ★ 排除 pointer-events:none 的元素
        if (cs.pointerEvents === 'none') continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < 14 || rect.width > 200 || rect.height < 14 || rect.height > 80) continue;
        if (rect.top < 80) continue;
        if (cs.position === 'fixed' || cs.position === 'sticky') continue;
        if (isInNavArea(htmlEl)) continue;

        const text = (htmlEl.textContent || '').trim();
        const cls = (htmlEl.className || '').toString().toLowerCase();
        const aria = (htmlEl.getAttribute('aria-label') || '').toLowerCase();

        // ★ 排除覆盖层按钮（图片删除/关闭按钮等）
        if (cls.includes('pointer-events-none')) continue;
        if (cls.includes('absolute') && (cls.includes('z-[') || cls.includes('z-10') || cls.includes('z-20'))) continue;
        if (cls.includes('bg-transparent') && cls.includes('absolute')) continue;
        if (cls.includes('inset-x-') || cls.includes('inset-0')) continue;

        if (isExcluded(text)) continue;
        if (cls.includes('truncate') || cls.includes('task-progress')) continue;
        if (aria.includes('upload') || aria.includes('attach') || aria.includes('add')) continue;

        // 放宽特征：任何含箭头/积分/send 的可点击元素
        const hasArrowChar = text.includes('↑') || text.includes('➤') || text.includes('➢') || text.includes('▶');
        const hasCredits = /[€$£]\s*\d+/.test(text) || /\d+\s*credits?/i.test(text);
        const hasSendLabel = aria.includes('send') || cls.includes('send');
        const hasSvgIcon = !!htmlEl.querySelector('svg') && text.length < 20;

        // 当 inputRect 为 null 时，只信强信号
        if (!inputRect) {
          if (!hasArrowChar && !hasCredits && !hasSendLabel) continue;
        } else {
          if (!hasArrowChar && !hasCredits && !hasSendLabel && !hasSvgIcon) continue;
        }

        // 位置检查：输入框附近（与方案0 一致，放宽范围）
        if (inputRect) {
          const isNear =
            (rect.left >= inputRect.right - 150 && Math.abs(rect.top - inputRect.top) < 250) ||
            (rect.top >= inputRect.bottom - 50 && rect.top <= inputRect.bottom + 250) ||
            (rect.top >= inputRect.top - 80 && rect.bottom <= inputRect.bottom + 250 && rect.left >= inputRect.left - 80);
          if (!isNear) continue;
        }

        htmlEl.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        htmlEl.click();
        return { clicked: true, tag: htmlEl.tagName, text: text.substring(0, 60), w: Math.round(rect.width), h: Math.round(rect.height) };
      }
      return { clicked: false };
    });

    if ((fallbackResult as any).clicked) {
      const r = fallbackResult as any;
      console.log(`[shared-steps] inputPromptAndSend: ✅ [兜底A] 点击发送按钮 <${r.tag}> "${r.text}" (${r.w}x${r.h})`);
      await randomDelay(2000, 3000);
    } else {
      // 兜底策略 B: 再按一次 Enter
      console.log('[shared-steps] inputPromptAndSend: [兜底B] 未找到发送按钮，使用 Enter 键重试');
      const freshInput = await page.$('.tiptap.ProseMirror, div[contenteditable="true"], textarea');
      if (freshInput) {
        await freshInput.click({ force: true });
        await page.keyboard.press('Enter');
      } else {
        await page.keyboard.press('Enter');
      }
      await randomDelay(2000, 3000);
    }

    const recheck = await page.evaluate(() => {
      const input = document.querySelector('.tiptap.ProseMirror, div[contenteditable="true"], textarea') as HTMLElement | null;
      const t = input ? (input.textContent || (input as HTMLTextAreaElement).value || '').trim() : '';
      const u = window.location.href;
      return { cleared: t.length < 5 || /\/chat\/\d+/.test(u), text: t.substring(0, 60), url: u };
    });
    console.log(`[shared-steps] inputPromptAndSend: 兜底后清空=${recheck.cleared}, URL=${recheck.url}`);
  }
  console.log('[shared-steps] inputPromptAndSend: 发送完成');
}

/**
 * 2. 上传商品图片
 * 新版 /chat 页面流程：
 *   1) 点击 "+"(Upload first frame) 按钮 → 弹出下拉菜单
 *   2) 点击 "Upload images" 菜单项 → 打开文件选择器
 *   3) 通过 fileChooser 事件一次性填充所有图片
 */
export async function uploadProductImages(page: Page, imagePaths: string[]): Promise<void> {
  console.log(`[shared-steps] uploadProductImages: 准备一次性上传 ${imagePaths.length} 张图片...`);

  // 策略 A: 先检查是否已有 file input（重试场景）
  let fileInput = await page.$(SELECTORS.upload.fileInput);
  if (fileInput) {
    await fileInput.setInputFiles(imagePaths);
    console.log(`[shared-steps] uploadProductImages: ✅ 通过已有 file input 一次性上传 ${imagePaths.length} 张成功`);
    await randomDelay(2000, 3500);
    return;
  }

  // 策略 B: 点击 "+" → 等待菜单 → 点击 "Upload images" → fileChooser 一次传所有图片
  console.log('[shared-steps] uploadProductImages: 点击 "+" 按钮展开上传菜单...');
  const clicked = await clickAddButton(page);
  if (!clicked) {
    throw new Error('[shared-steps] uploadProductImages: 未找到 "+" 按钮');
  }
  await randomDelay(500, 1000);

  // 等待 "Upload images" 菜单项出现
  const uploadMenuSelector = 'text="Upload images" >> visible=true';
  let uploadMenuItem = null;
  try {
    uploadMenuItem = await page.waitForSelector(uploadMenuSelector, { timeout: 5000, state: 'visible' });
  } catch {
    // 备用：用 evaluate 找并点击 "Upload images"
    console.log('[shared-steps] uploadProductImages: text selector 未匹配，尝试 evaluate...');
    const found = await page.evaluate(() => {
      const allEls = document.querySelectorAll('div, span, li, button, a, [role="menuitem"]');
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        if (text === 'Upload images' || text === 'Upload Images') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            (el as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    });
    if (found) {
      console.log('[shared-steps] uploadProductImages: 通过 evaluate 点击了 "Upload images"');
      await randomDelay(500, 1000);
      fileInput = await page.$(SELECTORS.upload.fileInput);
      if (fileInput) {
        await fileInput.setInputFiles(imagePaths);
        console.log(`[shared-steps] uploadProductImages: ✅ 通过 file input 一次性上传 ${imagePaths.length} 张成功`);
        await randomDelay(2000, 3500);
        return;
      }
    }
    throw new Error('[shared-steps] uploadProductImages: 未找到 "Upload images" 菜单项');
  }

  // 正常流程：fileChooser 一次性上传所有图片
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      uploadMenuItem.click(),
    ]);
    await fileChooser.setFiles(imagePaths);
    console.log(`[shared-steps] uploadProductImages: ✅ 通过 fileChooser 一次性上传 ${imagePaths.length} 张成功`);
  } catch (e: any) {
    console.warn(`[shared-steps] uploadProductImages: fileChooser 失败: ${e.message?.substring(0, 80)}`);
    // 兜底：等待 file input
    await randomDelay(500, 1000);
    fileInput = await page.$(SELECTORS.upload.fileInput);
    if (fileInput) {
      await fileInput.setInputFiles(imagePaths);
      console.log(`[shared-steps] uploadProductImages: ✅ 通过 file input 兜底上传 ${imagePaths.length} 张成功`);
    } else {
      throw new Error('[shared-steps] uploadProductImages: 点击 "Upload images" 后无法上传');
    }
  }

  await randomDelay(3000, 5000);
  console.log('[shared-steps] uploadProductImages: 所有图片上传完成');
}

/** 等待上传完成标志 */
async function waitUploadComplete(page: Page, index: number): Promise<void> {
  try {
    await page.waitForSelector(SELECTORS.upload.uploadComplete, { timeout: 5000 });
    console.log(`[shared-steps] uploadProductImages: 第 ${index + 1} 张上传完成`);
  } catch {
    console.warn(`[shared-steps] uploadProductImages: 第 ${index + 1} 张上传完成标志未检测到，继续...`);
  }
  await randomDelay(500, 1000);
}

/**
 * 在输入框区域查找并点击 "+" 按钮（添加附件/上传图片）
 * 2026-06 新版：按钮 aria-label="Upload first frame"，60x60 方形按钮
 * 策略：
 *   1) Playwright selector 直接定位（最可靠）
 *   2) 全页面搜索 aria-label 含 upload/attach 的按钮
 *   3) 容器内小元素搜索（兜底）
 */
async function clickAddButton(page: Page): Promise<boolean> {
  // 先等待对话输入框出现（表明页面已就绪）
  try {
    await page.waitForSelector(SELECTORS.common.chatInput, {
      state: 'visible',
      timeout: 15000,
    });
  } catch {
    console.warn('[shared-steps] clickAddButton: 输入框未出现，仍尝试查找按钮');
  }
  await randomDelay(800, 1500);

  // 策略 1: Playwright selector 直接点击（最可靠）
  try {
    const btn = await page.$(SELECTORS.agent.addButton);
    if (btn) {
      const isVisible = await btn.isVisible().catch(() => false);
      if (isVisible) {
        await btn.click({ force: true });
        console.log('[shared-steps] clickAddButton: ✅ 通过 selector 直接点击成功');
        return true;
      }
    }
  } catch (e: any) {
    console.warn(`[shared-steps] clickAddButton: selector 策略异常: ${e.message?.substring(0, 80)}`);
  }

  // 策略 2: page.evaluate 搜索 aria-label 含 upload/attach 的按钮
  const found = await page.evaluate(() => {
    const inputEl = document.querySelector(
      '.tiptap.ProseMirror, div.ProseMirror, div[contenteditable="true"], ' +
      'textarea[placeholder*="TikTok trend"], textarea[placeholder*="vision"], ' +
      '[class*="chat-input"], [class*="chatInput"]'
    ) as HTMLElement | null;
    const inputRect = inputEl?.getBoundingClientRect();

    // 查找所有按钮
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const el of buttons) {
      const htmlEl = el as HTMLElement;
      const aria = (htmlEl.getAttribute('aria-label') || '').toLowerCase();
      const cls = (htmlEl.className || '').toString().toLowerCase();
      const text = (htmlEl.textContent || '').trim();
      const rect = htmlEl.getBoundingClientRect();
      
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width > 80 || rect.height > 80) continue;
      
      // 匹配条件：aria-label 含 upload/attach/add/first frame
      const isUploadBtn = aria.includes('upload') || aria.includes('attach') || 
        aria.includes('first frame') || aria.includes('add file');
      // 或者：无文本的小方形按钮，位于输入框附近
      const isIconBtn = text.length === 0 && Math.abs(rect.width - rect.height) < 10 && rect.width >= 30;
      // 或者：文本就是 "+"
      const isPlusBtn = text === '+';
      
      if (!isUploadBtn && !isIconBtn && !isPlusBtn) continue;
      
      // 位置检查：必须在输入框附近
      if (inputRect) {
        if (rect.bottom < inputRect.top - 100) continue;
        if (rect.top > inputRect.bottom + 80) continue;
        if (rect.right < inputRect.left - 50) continue;
        if (rect.left > inputRect.right + 50) continue;
      }
      
      // 排除侧边栏按钮（x < 100 的都是侧边栏）
      if (rect.left < 100) continue;
      
      htmlEl.click();
      return { 
        ok: true, 
        info: `<${htmlEl.tagName}> aria="${aria}" cls="${cls.substring(0, 60)}" pos=(${Math.round(rect.left)},${Math.round(rect.top)}) size=${Math.round(rect.width)}x${Math.round(rect.height)}` 
      };
    }
    
    return { ok: false, reason: 'no-match' };
  });

  if (found.ok) {
    console.log(`[shared-steps] clickAddButton: ✅ evaluate 点击成功: ${(found as any).info}`);
    return true;
  }

  // 策略 3: 打印调试信息
  const debug = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    return allBtns
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.width <= 80 && r.height <= 80;
      })
      .slice(0, 15)
      .map(b => {
        const r = b.getBoundingClientRect();
        return {
          text: (b.textContent || '').trim().substring(0, 30),
          cls: (b.className || '').substring(0, 60),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          aria: b.getAttribute('aria-label') || '',
          hasSvg: !!b.querySelector('svg'),
        };
      });
  });
  console.warn('[shared-steps] clickAddButton: 未找到 "+" 按钮。调试信息:');
  console.warn(JSON.stringify(debug, null, 2));

  return false;
}

/**
 * 3. 等待 AI 回复完成并返回回复文本
 * 多维度检测：消息容器数量、body 文本增长、操作按钮、URL 跳转、视频/图片元素
 * 每 15s 打印一次诊断快照，便于定位问题
 */
export async function waitForAIResponse(page: Page, timeout?: number): Promise<string> {
  const effectiveTimeout = timeout || 60000;
  console.log(`[shared-steps] waitForAIResponse: 等待AI回复 (超时: ${effectiveTimeout / 1000}s)...`);

  const startTime = Date.now();
  const pollInterval = 3000;

  // 记录发送前的初始状态（基线）
  const initial = await page.evaluate(() => {
    const body = document.body.innerText || '';
    // 统计可能的对话消息容器（覆盖多种命名）
    const msgContainers = document.querySelectorAll(
      '[class*="message"], [class*="Message"], [class*="bubble"], [class*="Bubble"], ' +
      '[class*="chat-item"], [class*="ChatItem"], [data-message-id], [role="article"]'
    );
    return {
      bodyLength: body.length,
      msgCount: msgContainers.length,
      videoCount: document.querySelectorAll('video').length,
      imgCount: document.querySelectorAll('img').length,
      url: window.location.href,
    };
  });
  console.log(`[shared-steps] waitForAIResponse: 初始状态 — bodyLen=${initial.bodyLength}, msgCount=${initial.msgCount}, videoCount=${initial.videoCount}, imgCount=${initial.imgCount}, url=${initial.url}`);

  let lastSnapshotTime = 0;

  while (Date.now() - startTime < effectiveTimeout) {
    const state = await page.evaluate(() => {
      const body = document.body.innerText || '';
      // 消息容器统计
      const msgContainers = document.querySelectorAll(
        '[class*="message"], [class*="Message"], [class*="bubble"], [class*="Bubble"], ' +
        '[class*="chat-item"], [class*="ChatItem"], [data-message-id], [role="article"]'
      );
      // 操作按钮检测
      const buttons = Array.from(document.querySelectorAll('button'));
      const actionBtnTexts = buttons.map(b => (b.textContent || '').toLowerCase().trim()).filter(t => t.length > 3);
      const hasConfirmBtn = actionBtnTexts.some(t =>
        t.includes('looks great') || t.includes('looks good') ||
        t.includes("let's move on") || t.includes('confirm') ||
        t.includes('generate video') || t.includes('start generating') ||
        // 新版 TikTok Symphony 实际按钮文案
        t.includes('generate a storyboard') || t.includes('generate storyboard') ||
        t.includes('generate your tiktok-ready ad video') ||
        t.includes('tiktok-ready ad video') ||
        t.includes('continue')
      );
      const hasRetryBtn = actionBtnTexts.some(t =>
        t.includes('try again') || t.includes('regenerate')
      );
      const hasDownloadBtn = actionBtnTexts.some(t =>
        t.includes('download')
      );
      // loading 指示器
      const hasLoading = !!(document.querySelector('[class*="typing"]') ||
        document.querySelector('[class*="thinking"]') ||
        document.querySelector('[class*="streaming"]') ||
        document.querySelector('[class*="loading"]:not([style*="display: none"])'));
      return {
        bodyLength: body.length,
        msgCount: msgContainers.length,
        videoCount: document.querySelectorAll('video').length,
        imgCount: document.querySelectorAll('img').length,
        url: window.location.href,
        hasConfirmBtn, hasRetryBtn, hasDownloadBtn, hasLoading,
        bodyTail: body.trim().slice(-300),
      };
    });

    const bodyGrew = state.bodyLength > initial.bodyLength + 100;
    const msgGrew = state.msgCount > initial.msgCount;
    const mediaGrew = state.videoCount > initial.videoCount || state.imgCount > initial.imgCount + 1;
    const urlChanged = state.url !== initial.url;

    // ✓ 明确的完成信号
    if (state.hasConfirmBtn || state.hasDownloadBtn) {
      console.log(`[shared-steps] waitForAIResponse: ✅ 检测到操作按钮 (confirm=${state.hasConfirmBtn}, download=${state.hasDownloadBtn})`);
      const text = await page.evaluate(() => document.body.innerText || '');
      return text.trim().slice(-2000);
    }

    if (state.hasRetryBtn) {
      console.log('[shared-steps] waitForAIResponse: ⚠️ 检测到重试按钮，生成可能失败');
      return 'generation_failed';
    }

    // ✗ 内容策略拒绝检测（如图片含人脸）—— 直接抛错不重试
    if (state.bodyTail && /without faces|face.*detected|contain.*face|image.*not.*allowed/i.test(state.bodyTail)) {
      console.error('[shared-steps] waitForAIResponse: ❌ 检测到内容策略拒绝（图片含人脸）');
      throw new ContentRejectedError('图片含人脸，Seedance 拒绝生成', { bodyTail: state.bodyTail.substring(0, 200) });
    }

    // ✓ 内容稳定后视为回复完成
    if ((bodyGrew || msgGrew) && !state.hasLoading) {
      console.log(`[shared-steps] waitForAIResponse: 检测到新内容 (bodyGrew=${bodyGrew}, msgGrew=${msgGrew}, mediaGrew=${mediaGrew})，等待稳定...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      const stable = await page.evaluate(() => ({
        bodyLength: (document.body.innerText || '').length,
        msgCount: document.querySelectorAll(
          '[class*="message"], [class*="Message"], [class*="bubble"], [class*="Bubble"], ' +
          '[class*="chat-item"], [class*="ChatItem"], [data-message-id], [role="article"]'
        ).length,
      }));
      if (Math.abs(stable.bodyLength - state.bodyLength) < 50 && stable.msgCount === state.msgCount) {
        console.log(`[shared-steps] waitForAIResponse: ✅ 内容已稳定 (bodyLen=${stable.bodyLength}, msgCount=${stable.msgCount})`);
        const text = await page.evaluate(() => document.body.innerText || '');
        return text.trim().slice(-2000);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // 每 15 秒打印一次完整诊断快照
    if (elapsed - lastSnapshotTime >= 15) {
      lastSnapshotTime = elapsed;
      console.log(`[shared-steps] waitForAIResponse: 📊 ${elapsed}s 诊断快照:`);
      console.log(`  - URL: ${state.url}${urlChanged ? ' (已跳转!)' : ''}`);
      console.log(`  - bodyLen: ${initial.bodyLength} -> ${state.bodyLength} (grew=${bodyGrew})`);
      console.log(`  - msgCount: ${initial.msgCount} -> ${state.msgCount} (grew=${msgGrew})`);
      console.log(`  - videoCount: ${initial.videoCount} -> ${state.videoCount}, imgCount: ${initial.imgCount} -> ${state.imgCount}`);
      console.log(`  - loading=${state.hasLoading}, confirmBtn=${state.hasConfirmBtn}, retryBtn=${state.hasRetryBtn}`);
      console.log(`  - 页面文本尾部 300 字: "${state.bodyTail.replace(/\n+/g, ' | ').substring(0, 300)}"`);
    } else {
      console.log(`[shared-steps] waitForAIResponse: 已等待 ${elapsed}s, loading=${state.hasLoading}, bodyLen=${state.bodyLength}, msgCount=${state.msgCount}, urlChanged=${urlChanged}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  // 超时
  console.warn(`[shared-steps] waitForAIResponse: ⏱️ 等待超时 (${effectiveTimeout / 1000}s)`);
  const finalText = await page.evaluate(() => document.body.innerText || '');
  if (finalText.length > initial.bodyLength + 100) {
    console.log('[shared-steps] waitForAIResponse: 超时但页面有新内容，返回现有文本');
    return finalText.trim().slice(-2000);
  }
  throw new Error(`[shared-steps] waitForAIResponse: AI回复超时 (${effectiveTimeout / 1000}s)`);
}

/**
 * 通用确认按钮点击器：轮询查找包含指定文本的可点击元素并点击
 * 策略：
 *  1) 遍历所有可见元素，找到 textContent.trim() 几乎等于目标文本的「叶子」元素
 *  2) 从该元素向上爬最多 8 层，找到第一个可点击祖先（button/a/[role=button]/onclick/cursor:pointer）
 *  3) 优先点击祖先，回退点击元素本身
 *  4) 第一轮失败时打印诊断快照（页面上所有可能候选元素的信息）
 */
async function clickConfirmButtonByText(
  page: Page,
  candidateTexts: string[],
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const startTime = Date.now();
  let lastReport = 0;
  let diagnosticsPrinted = false;
  while (Date.now() - startTime < timeoutMs) {
    await removeOverlays(page);
    const result = await page.evaluate(
      ({ texts, withDiagnostics }: { texts: string[]; withDiagnostics: boolean }) => {
        const isVisible = (el: HTMLElement) => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const isClickable = (el: HTMLElement) => {
          const tag = el.tagName.toUpperCase();
          if (tag === 'BUTTON' || tag === 'A') return true;
          const role = el.getAttribute('role');
          if (role === 'button' || role === 'link') return true;
          if ((el as any).onclick) return true;
          const cls = (el.className || '').toString().toLowerCase();
          if (cls.includes('btn') || cls.includes('button')) return true;
          const cursor = window.getComputedStyle(el).cursor;
          if (cursor === 'pointer') return true;
          return false;
        };
        const findClickableAncestor = (el: HTMLElement, maxDepth = 8): HTMLElement | null => {
          let cur: HTMLElement | null = el;
          let depth = 0;
          while (cur && depth < maxDepth) {
            if (isClickable(cur)) return cur;
            cur = cur.parentElement;
            depth++;
          }
          return null;
        };

        // 收集所有「叶子」匹配元素：textContent.trim() 包含目标文本，且自身较小
        const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
        const diagCandidates: any[] = [];

        for (const t of texts) {
          const tLower = t.toLowerCase();
          for (const el of all) {
            const tag = el.tagName.toUpperCase();
            // BUTTON/A 元素本身可点击，不限制子节点数；其他元素仅看近叶子节点
            const isSelfClickable = tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button';
            if (!isSelfClickable && el.children.length > 3) continue;
            const text = (el.textContent || '').trim();
            if (!text) continue;
            const textLower = text.toLowerCase();
            if (!textLower.includes(tLower)) continue;
            // 文本不能比目标文本长太多（避免抓到大容器）；BUTTON 放宽到 +60
            const maxExtra = isSelfClickable ? 60 : 40;
            if (text.length > t.length + maxExtra) continue;
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();

            // 找可点击祖先（包括自身）
            const target = isClickable(el) ? el : findClickableAncestor(el);

            if (withDiagnostics) {
              diagCandidates.push({
                tag: el.tagName,
                cls: (el.className || '').toString().substring(0, 80),
                text: text.substring(0, 80),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                matched: t,
                hasClickAncestor: !!target,
                ancestorTag: target ? target.tagName : null,
                ancestorCls: target ? (target.className || '').toString().substring(0, 80) : null,
              });
            }

            if (!target) continue;
            const trect = target.getBoundingClientRect();
            // 祖先尺寸要求：真正的确认按钮是 rounded-full 粘贴型 200+x30+。
            // truncate-wrapper 这种 Task Progress 内联标签仅 146x20，要过滤掉。
            if (trect.width < 140 || trect.height < 28) continue;
            // 过滤掉明显是文本装饰容器的：truncate、Task progress 卡片
            const targetCls = (target.className || '').toString().toLowerCase();
            if (targetCls.includes('truncate') || targetCls.includes('task-progress') || targetCls.includes('task_progress')) continue;

            target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
            target.click();
            return {
              clicked: true,
              tag: target.tagName,
              cls: (target.className || '').toString().substring(0, 80),
              text: (target.textContent || '').trim().substring(0, 80),
              matchedKeyword: t,
              w: Math.round(trect.width),
              h: Math.round(trect.height),
              diagCandidates: [],
            };
          }
        }
        return { clicked: false, diagCandidates };
      },
      { texts: candidateTexts, withDiagnostics: !diagnosticsPrinted },
    );

    if ((result as any).clicked) {
      const r: any = result;
      console.log(
        `[shared-steps] ${label}: ✅ 已点击 <${r.tag}> 匹配 "${r.matchedKeyword}" 文本="${r.text}" 尺寸=${r.w}x${r.h} class="${r.cls}"`,
      );
      return true;
    }

    // 第一轮（约 2s 后）打印诊断
    if (!diagnosticsPrinted) {
      diagnosticsPrinted = true;
      const diag: any[] = (result as any).diagCandidates || [];
      console.log(`[shared-steps] ${label}: 🔬 诊断 — 发现 ${diag.length} 个文本匹配候选元素`);
      diag.slice(0, 10).forEach((c, i) => {
        console.log(
          `  [${i}] <${c.tag}.${c.cls}> 尺寸=${c.w}x${c.h} 文本="${c.text}" 匹配="${c.matched}" 可点击祖先=${c.hasClickAncestor ? `<${c.ancestorTag}.${c.ancestorCls}>` : '无'}`,
        );
      });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed - lastReport >= 10) {
      lastReport = elapsed;
      console.log(`[shared-steps] ${label}: 轮询中 ${elapsed}s，未找到匹配文本的可点击元素...`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/**
 * 通用策略：点击 AI 回复后出现的「建议按钮组」中的第一个按钮。
 * TikTok Symphony Agent 在生成 Brief/Storyboard 后会渲染一组建议按钮（2-3 个），
 * 第一个按钮始终是正面确认选项（如 "Looks good, create the storyboard!"）。
 * 直接点击第一个即可，无需匹配具体文案，对 TikTok 改版更鲁棒。
 */
async function clickFirstSuggestionButton(page: Page, label: string): Promise<boolean> {
  const result = await page.evaluate(() => {
    // TikTok Symphony 的建议按钮特征：
    // 1. 是 button / [role="button"] / cursor-pointer / 带边框的可点击 div
    // 2. 出现在聊天内容区域（非导航栏/输入区）
    // 3. 多个按钮成组出现（兄弟关系或同一父容器）
    // 4. 按钮文本较短（通常 < 80 字符），尺寸适中
    const isVisible = (el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // 收集所有可见的、看起来像「建议按钮」的元素
    const allBtns = Array.from(document.querySelectorAll(
      'button, [role="button"], [class*="cursor-pointer"], [class*="suggestion"], [class*="quick-reply"], [class*="chip"]'
    )) as HTMLElement[];
    // 补充：检测所有带 cursor:pointer+border 样式的 div/span（兜底）
    const extraDivs = Array.from(document.querySelectorAll('div, span')) as HTMLElement[];
    for (const el of extraDivs) {
      if (allBtns.includes(el)) continue;
      const cs = window.getComputedStyle(el);
      if (cs.cursor === 'pointer' && cs.borderStyle !== 'none' && cs.borderWidth !== '0px') {
        allBtns.push(el);
      }
    }

    // 辅助：判断元素是否在导航区域（header/nav/sidebar）
    const isInNavArea = (el: HTMLElement): boolean => {
      let node: HTMLElement | null = el;
      for (let i = 0; i < 8 && node; i++) {
        const tag = node.tagName?.toLowerCase();
        if (tag === 'nav' || tag === 'header') return true;
        const role = (node.getAttribute('role') || '').toLowerCase();
        if (role === 'navigation' || role === 'banner') return true;
        const cls = (node.className || '').toString().toLowerCase();
        if (cls.includes('sidebar') || cls.includes('nav-') || cls.includes('navbar') || cls.includes('header')) return true;
        node = node.parentElement;
      }
      return false;
    };

    // 已知的导航/非建议按钮文本关键词
    const NAV_TEXTS = /^(home|agent|create|tools|library|products|inspire|business center|creative center|ad account|assets|reporting|campaign|audiences|finance)$/i;
    // 产品卡片操作按钮文本（Rename/Delete/Edit 等不是建议按钮）
    const PRODUCT_CARD_TEXTS = /^(rename|delete|edit|copy|duplicate|remove|cancel|close|share|download)$/i;
    // 产品名称+操作按钮混合文本（如 "XXX TikTok UGC AdRenameDelete"）
    const isProductCardText = (text: string): boolean => {
      const t = text.toLowerCase();
      return (t.includes('rename') && t.includes('delete')) ||
             (t.includes('ugc ad') && (t.includes('rename') || t.includes('delete')));
    };

    const candidates: HTMLElement[] = [];

    for (const btn of allBtns) {
      if (!isVisible(btn)) continue;
      const rect = btn.getBoundingClientRect();
      // 尺寸过滤：建议按钮通常宽 140-600px，高 28-60px
      if (rect.width < 140 || rect.width > 700 || rect.height < 28 || rect.height > 70) continue;
      // 位置过滤：排除页面顶部导航区域的元素（y < 120px 几乎都是导航栏）
      if (rect.top < 120) continue;
      const text = (btn.textContent || '').trim();
      // 文本长度过滤：按钮文案通常 5-80 字符
      if (text.length < 5 || text.length > 100) continue;
      // 排除已知的非建议按钮
      const cls = (btn.className || '').toString().toLowerCase();
      if (cls.includes('truncate') || cls.includes('task-progress') || cls.includes('task_progress')) continue;
      if (cls.includes('nav') || cls.includes('header') || cls.includes('sidebar')) continue;
      // 排除输入区域的发送按钮、+按钮等
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (ariaLabel.includes('send') || ariaLabel.includes('attach') || ariaLabel.includes('upload')) continue;
      // 排除纯图标按钮（无文字或文字过短）
      if (text.length < 5) continue;
      // 排除导航类按钮文本
      if (NAV_TEXTS.test(text)) continue;
      // 排除产品卡片操作按钮
      if (PRODUCT_CARD_TEXTS.test(text)) continue;
      // 排除产品名称+操作混合文本
      if (isProductCardText(text)) continue;
      // 排除祖先链中有 nav/header/sidebar 的元素
      if (isInNavArea(btn)) continue;

      candidates.push(btn);
    }

    if (candidates.length === 0) {
      // ★ 即使 candidates 为空，也尝试全页面搜索 PRIORITY_TEXTS
      // 因为按钮可能被严格过滤条件排除了
    }

    // ★ 最高优先级：全页面搜索包含已知建议按钮文案的可点击元素
    // 不受 candidates 过滤条件限制，直接在页面上搜索
    const PRIORITY_TEXTS = [
      'looks good, create the storyboard',
      'looks good, create the video',
      'looks good, generate the video',
      'looks good',
      "looks great, let's make the video",
      "looks great, let's generate",
      'looks great',
      'looks perfect',
      'create the storyboard',
      'present video prompt',
      'generate the video',
      // ★ 'generate video' 太宽泛，会匹配到 "Generate video prompt"（step 2/3 按钮）
      // 只在没有其他匹配时才用
      'generate video',
      'create the video',
      'start generating',
      "let's move on",
      'continue to generate',
    ];
    // 先在 candidates 中搜索
    for (const pt of PRIORITY_TEXTS) {
      const ptLower = pt.toLowerCase();
      const match = candidates.find(btn => {
        const t = (btn.textContent || '').trim().toLowerCase();
        return t.includes(ptLower);
      });
      if (match) {
        // ★ 如果匹配的不是 BUTTON，找最近的祖先 BUTTON 来点击
        let clickTarget = match;
        if (match.tagName !== 'BUTTON') {
          let ancestor: HTMLElement | null = match.parentElement;
          while (ancestor) {
            if (ancestor.tagName === 'BUTTON' || ancestor.getAttribute('role') === 'button') {
              clickTarget = ancestor;
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
        clickTarget.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        // ★ 修复：scrollIntoView 后重新获取坐标，避免旧坐标导致点击偏移
        const rect = clickTarget.getBoundingClientRect();
        // ★ 先尝试在 evaluate 内直接 click（React 合成事件更可靠），再返回坐标作为后备
        try { (clickTarget as HTMLElement).click(); } catch {}
        return {
          found: true,
          clickX: Math.round(rect.left + rect.width / 2),
          clickY: Math.round(rect.top + rect.height / 2),
          text: (match.textContent || '').trim().substring(0, 80),
          tag: clickTarget.tagName,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          groupSize: 1,
          matchedPriority: pt,
          source: match === clickTarget ? 'candidates' : 'candidates_ancestor',
        };
      }
    }
    // ★ 再在全页面搜索（放宽过滤条件）
    // 收集所有匹配元素，选最小的（最精确的）而非第一个
    const allClickable = Array.from(document.querySelectorAll(
      'button, [role="button"], [class*="cursor-pointer"], div, span'
    )) as HTMLElement[];
    for (const pt of PRIORITY_TEXTS) {
      const ptLower = pt.toLowerCase();
      // 收集所有包含目标文本的元素
      const matches: HTMLElement[] = [];
      for (const el of allClickable) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 20) continue;
        if (r.top < 120) continue;
        const t = (el.textContent || '').trim().toLowerCase();
        if (t.length > 100) continue;
        if (!t.includes(ptLower)) continue;
        matches.push(el);
      }
      if (matches.length > 0) {
        // ★ 选最精确的匹配：面积最小的元素（实际按钮比容器小）
        // 优先级：BUTTON 标签 > 面积最小
        matches.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const areaA = ra.width * ra.height;
          const areaB = rb.width * rb.height;
          // BUTTON 优先
          if (a.tagName === 'BUTTON' && b.tagName !== 'BUTTON') return -1;
          if (b.tagName === 'BUTTON' && a.tagName !== 'BUTTON') return 1;
          // 面积小的优先
          return areaA - areaB;
        });
        const match = matches[0];
        // ★ 如果匹配的不是 BUTTON，找最近的祖先 BUTTON 来点击
        let clickTarget = match;
        if (match.tagName !== 'BUTTON') {
          let ancestor: HTMLElement | null = match.parentElement;
          while (ancestor) {
            if (ancestor.tagName === 'BUTTON' || ancestor.getAttribute('role') === 'button') {
              clickTarget = ancestor;
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
        clickTarget.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        // ★ 修复：scrollIntoView 后重新获取坐标
        const rect = clickTarget.getBoundingClientRect();
        // ★ 先尝试在 evaluate 内直接 click
        try { (clickTarget as HTMLElement).click(); } catch {}
        return {
          found: true,
          clickX: Math.round(rect.left + rect.width / 2),
          clickY: Math.round(rect.top + rect.height / 2),
          text: (match.textContent || '').trim().substring(0, 80),
          tag: clickTarget.tagName,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          groupSize: 1,
          matchedPriority: pt,
          source: match === clickTarget ? 'page_search' : 'page_search_ancestor',
        };
      }
    }

    // 诊断：PRIORITY_TEXTS 未匹配，打印候选元素信息
    const diagCandidates = candidates.map(c => {
      const r = c.getBoundingClientRect();
      return `<${c.tagName}> "${(c.textContent || '').trim().substring(0, 50)}" ${Math.round(r.width)}x${Math.round(r.height)} pos=(${Math.round(r.left)},${Math.round(r.top)})`;
    });

    // 找到「成组」的按钮：检查是否有多个按钮共享同一父容器（兄弟按钮）
    // 按钮组的特征：同一个父元素下有 >= 2 个候选按钮
    const parentGroups = new Map<HTMLElement, HTMLElement[]>();
    for (const btn of candidates) {
      const parent = btn.parentElement;
      if (!parent) continue;
      if (!parentGroups.has(parent)) parentGroups.set(parent, []);
      parentGroups.get(parent)!.push(btn);
    }

    // 找到最佳按钮组：优先选择2-5个按钮的组（典型建议按钮），位置越靠下越好（聊天内容区）
    let bestGroup: HTMLElement[] = [];
    let bestGroupY = -1;
    for (const [, group] of parentGroups) {
      if (group.length < 2) continue;
      // 超过8个按钮的组不可能是建议按钮组（建议按钮通常2-5个），直接跳过
      if (group.length > 8) continue;
      const avgY = group.reduce((s, b) => s + b.getBoundingClientRect().top, 0) / group.length;
      // 优先选择位置更低的组（更可能是聊天区域的建议按钮）
      if (bestGroup.length === 0 || avgY > bestGroupY) {
        bestGroup = group;
        bestGroupY = avgY;
      }
    }

    // 如果没找到成组的，往上多级查找（按钮可能各自包在多层 div 中）
    if (bestGroup.length < 2) {
      for (let level = 2; level <= 4; level++) {
        const ancestorGroups = new Map<HTMLElement, HTMLElement[]>();
        for (const btn of candidates) {
          let ancestor: HTMLElement | null = btn;
          for (let i = 0; i < level; i++) ancestor = ancestor?.parentElement as HTMLElement | null;
          if (!ancestor) continue;
          if (!ancestorGroups.has(ancestor)) ancestorGroups.set(ancestor, []);
          ancestorGroups.get(ancestor)!.push(btn);
        }
        for (const [, group] of ancestorGroups) {
          if (group.length < 2) continue;
          if (group.length > 8) continue;
          const avgY = group.reduce((s, b) => s + b.getBoundingClientRect().top, 0) / group.length;
          if (bestGroup.length === 0 || avgY > bestGroupY) {
            bestGroup = group;
            bestGroupY = avgY;
          }
        }
        if (bestGroup.length >= 2) break;
      }
    }

    // 如果仍未找到成组按钮，返回失败
    if (bestGroup.length < 2) {
      return { clicked: false, reason: 'no_button_group', candidateCount: candidates.length, diag: diagCandidates };
    }

    // 点击组中的第一个按钮（位置最靠前/靠左的）
    // 按 DOM 顺序排列（TikTok 默认第一个是正面选项）
    const firstBtn = bestGroup[0];
    firstBtn.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    // ★ 修复：scrollIntoView 后重新获取坐标
    const rect = firstBtn.getBoundingClientRect();
    // ★ 先尝试在 evaluate 内直接 click
    try { (firstBtn as HTMLElement).click(); } catch {}
    return {
      found: true,
      clickX: Math.round(rect.left + rect.width / 2),
      clickY: Math.round(rect.top + rect.height / 2),
      text: (firstBtn.textContent || '').trim().substring(0, 80),
      tag: firstBtn.tagName,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      groupSize: bestGroup.length,
    };
  });

  if ((result as any).found) {
    const r = result as any;
    const priorityInfo = r.matchedPriority ? ` 优先匹配="${r.matchedPriority}"` : '';
    const sourceInfo = r.source ? ` [${r.source}]` : '';
    console.log(
      `[shared-steps] ${label}: ✅ [首按钮策略] 点击建议按钮 <${r.tag}> 文本="${r.text}" 尺寸=${r.w}x${r.h} 位置=(${r.clickX},${r.clickY}) (组内${r.groupSize}个按钮)${priorityInfo}${sourceInfo}`,
    );
    // ★ 修复：evaluate 内已尝试 element.click()，这里再用 mouse.click 作为双保险
    // 某些 React 组件需要真实的鼠标事件序列 (mousedown→mouseup→click) 才能触发
    await page.mouse.click(r.clickX, r.clickY);
    await new Promise(resolve => setTimeout(resolve, 500));
    // ★ 二次确认点击：如果坐标点击未生效，用 Playwright 选择器再找按钮点击
    // 通过文本定位按钮并使用 force: true 点击
    try {
      const btnText = r.text as string;
      if (btnText && btnText.length > 3) {
        const escaped = btnText.replace(/"/g, '\\"').substring(0, 50);
        const selector = `button:has-text("${escaped}"), [role="button"]:has-text("${escaped}")`;
        const btn = await page.$(selector);
        if (btn) {
          await btn.click({ force: true }).catch(() => {});
          console.log(`[shared-steps] ${label}: 二次确认点击成功`);
        }
      }
    } catch {}
    return true;
  }
  const reason = (result as any).reason || 'unknown';
  const count = (result as any).candidateCount || 0;
  const diag: string[] = (result as any).diag || [];
  console.log(`[shared-steps] ${label}: [首按钮策略] 未找到建议按钮组 (reason=${reason}, candidates=${count})`);
  if (diag.length > 0) {
    diag.forEach((d, i) => console.log(`  候选[${i}]: ${d}`));
  }
  return false;
}

/**
 * 4. 确认 Brief
 * 策略优先级：
 *   1. 点击第一个建议按钮（最鲁棒，不依赖按钮文案）
 *   2. Playwright 选择器匹配已知文案
 *   3. 文本搜索兜底
 */
export async function confirmBrief(page: Page): Promise<void> {
  console.log('[shared-steps] confirmBrief: 等待确认按钮出现...');
  await removeOverlays(page);

  const TIMEOUT = 180000; // 总超时 180s
  const start = Date.now();

  const taskProgressSelectors = [
    'button:has-text("Develop Storyboard")',
    'button:has-text("Generate Storyboard")',
    'button:has-text("Generate a storyboard")',
    'button[class*="cursor-pointer"]:has-text("Storyboard")',
  ];

  const textCandidates = [
    'Develop Storyboard',
    'Develop storyboard',
    'Generate storyboard',
    'Generate a storyboard',
    'Create storyboard',
    'Looks good, create the storyboard',
    'Looks good',
    "Looks great, let's make the video!",
    "Looks great, let's make the video",
    'Looks great',
    "Let's move on",
    'Confirm',
    'Continue',
  ];

  let lastLog = 0;

  while (Date.now() - start < TIMEOUT) {
    const elapsed = Math.round((Date.now() - start) / 1000);

    // 策略0（优先）：直接点击第一个建议按钮，默认一切OK继续生成
    const firstBtnClicked = await clickFirstSuggestionButton(page, 'confirmBrief');
    if (firstBtnClicked) {
      await randomDelay(1000, 2000);
      console.log('[shared-steps] confirmBrief: 完成');
      return;
    }

    // 策略1：Playwright 选择器直接匹配 BUTTON
    for (const sel of taskProgressSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const box = await btn.boundingBox();
          if (box && box.width > 100 && box.height > 25) {
            await btn.scrollIntoViewIfNeeded();
            await btn.click();
            console.log(`[shared-steps] confirmBrief: ✅ 通过选择器点击 "${sel}" (${Math.round(box.width)}x${Math.round(box.height)}) 耗时${elapsed}s`);
            await randomDelay(1000, 2000);
            console.log('[shared-steps] confirmBrief: 完成');
            return;
          }
        }
      } catch {}
    }

    // 策略2：文本搜索 + 可点击祖先检测
    await removeOverlays(page);
    const result = await page.evaluate(
      ({ texts }: { texts: string[] }) => {
        const isVisible = (el: HTMLElement) => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const all = Array.from(document.querySelectorAll('button, [role="button"], [class*="cursor-pointer"], [class*="suggestion"], [class*="chip"]')) as HTMLElement[];
        // 补充：查找带 cursor:pointer+border 样式的 div/span
        const extraEls = Array.from(document.querySelectorAll('div, span')) as HTMLElement[];
        for (const el of extraEls) {
          if (all.includes(el)) continue;
          const cs = window.getComputedStyle(el);
          if (cs.cursor === 'pointer') all.push(el);
        }
        for (const t of texts) {
          const tLower = t.toLowerCase();
          for (const el of all) {
            const text = (el.textContent || '').trim();
            if (!text) continue;
            if (!text.toLowerCase().includes(tLower)) continue;
            if (text.length > t.length + 60) continue;
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 25) continue;
            const cls = (el.className || '').toString().toLowerCase();
            if (cls.includes('truncate') || cls.includes('task-progress') || cls.includes('task_progress')) continue;
            el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
            el.click();
            return { clicked: true, tag: el.tagName, text: text.substring(0, 60), w: Math.round(rect.width), h: Math.round(rect.height) };
          }
        }
        return { clicked: false };
      },
      { texts: textCandidates },
    );

    if ((result as any).clicked) {
      const r = result as any;
      console.log(`[shared-steps] confirmBrief: ✅ 已点击 <${r.tag}> 文本="${r.text}" 尺寸=${r.w}x${r.h} 耗时${elapsed}s`);
      await randomDelay(1000, 2000);
      console.log('[shared-steps] confirmBrief: 完成');
      return;
    }

    // 日志输出（每10s一次）
    if (elapsed - lastLog >= 10) {
      console.log(`[shared-steps] confirmBrief: 轮询中 ${elapsed}s，未找到可点击的确认按钮...`);
      lastLog = elapsed;
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  // 180s 内未找到 Brief 确认按钮 —— 视为需人工介入（按钮文案改版/选择器全失效），不再自动重试
  throw new NeedsManualError('Brief 确认按钮 180s 内未找到', {
    stage: 'confirmBrief',
    url: page.url(),
  });
}

/**
 * 5. 确认分镜 (Storyboard)
 * 策略优先级：
 *   1. 点击第一个建议按钮（最鲁棒，不依赖按钮文案）
 *   2. Playwright 选择器匹配已知文案
 *   3. 文本搜索兜底
 */
export async function confirmStoryboard(page: Page): Promise<void> {
  console.log('[shared-steps] confirmStoryboard: 等待确认按钮出现...');
  await removeOverlays(page);

  const TIMEOUT = 180000;
  const start = Date.now();

  // Playwright 原生选择器
  const taskProgressSelectors = [
    'button:has-text("Generate the video")',
    'button:has-text("Generate Video")',
    'button:has-text("Generate video")',
    'button[class*="cursor-pointer"]:has-text("Video")',
  ];

  const textCandidates = [
    'Continue to generate',
    'Generate your TikTok-ready ad video',
    'Generate the video',
    'Generate video',
    'Great, generate the video',
    "Looks great, let's make the video!",
    "Looks perfect, let's generate the video!",
    'Looks perfect',
    'Looks good',
    'Start generating',
  ];

  let lastLog = 0;

  while (Date.now() - start < TIMEOUT) {
    const elapsed = Math.round((Date.now() - start) / 1000);

    // 策略0（优先）：直接点击第一个建议按钮，默认一切OK继续生成
    const firstBtnClicked = await clickFirstSuggestionButton(page, 'confirmStoryboard');
    if (firstBtnClicked) {
      await randomDelay(1000, 2000);
      console.log('[shared-steps] confirmStoryboard: 完成');
      return;
    }

    // 策略1：Playwright 选择器快速匹配
    for (const sel of taskProgressSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const box = await btn.boundingBox();
          if (box && box.width > 100 && box.height > 25) {
            await btn.scrollIntoViewIfNeeded();
            await btn.click();
            console.log(`[shared-steps] confirmStoryboard: ✅ 通过选择器点击 "${sel}" (${Math.round(box.width)}x${Math.round(box.height)}) 耗时${elapsed}s`);
            await randomDelay(1000, 2000);
            console.log('[shared-steps] confirmStoryboard: 完成');
            return;
          }
        }
      } catch {}
    }

    // 策略2：文本搜索兜底
    await removeOverlays(page);
    const ok = await clickConfirmButtonByText(page, textCandidates, 5000, 'confirmStoryboard');
    if (ok) {
      await randomDelay(1000, 2000);
      console.log('[shared-steps] confirmStoryboard: 完成');
      return;
    }

    // 日志输出（每10s一次）
    if (elapsed - lastLog >= 10) {
      console.log(`[shared-steps] confirmStoryboard: 轮询中 ${elapsed}s，未找到可点击的确认按钮...`);
      lastLog = elapsed;
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  // 180s 内未找到 Storyboard 确认按钮 —— 视为需人工介入，不再自动重试
  throw new NeedsManualError('Storyboard 确认按钮 180s 内未找到', {
    stage: 'confirmStoryboard',
    url: page.url(),
  });
}

/**
 * 8.5 推进 storyboard 阶段的 "Pending user inputs"
 *
 * 现象：confirmStoryboard 点了 "Looks perfect, let's generate the video!" 后AI 会说「I'm working on producing the final video」，
 * 但右下 Task progress 卡片仍显示 `Generate a storyboard - Pending user inputs 2/3`。
 * 此时必须在输入框发一句“推进”话术，才会跳到 3/3 阶段真正开始生成视频。
 *
 * 该函数轮询最多 maxAttempts 次，每次判断页面是否还在 Pending user inputs 状态。
 * 如果在则发送推进话术；进入 3/3 或没有 Pending 字样时提前退出。
 */
export async function pushPendingUserInputs(
  page: Page,
  maxAttempts: number = 3,
): Promise<void> {
  const PROMPT =
    "Please continue and generate the final video using the storyboard you have already drafted. Use defaults for any remaining options.";

  // ★ Step 8 点击后，页面需要时间转换（AI 处理 step 2/3 → step 3/3）
  console.log('[shared-steps] pushPendingUserInputs: 等待 20s 让页面转换...');
  await new Promise(r => setTimeout(r, 20000));

  // ★ 防止重复点击同一个按钮（"Great, generate the video!" 等）
  let hasClickedBtn = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 检查当前 task progress 状态
    const status = await page.evaluate(() => {
      const body = document.body.innerText || '';
      const rootText = (document.querySelector('#root') as HTMLElement)?.innerText || '';
      const effectiveBody = body.length > 0 ? body : rootText;
      const hasPending = /Pending user inputs/i.test(effectiveBody);
      // ★ 修复 stage 检测：TikTok 实际 UI 格式为 "1/3 | Generate Product Brief"
      // 要求 X/Y 后跟 | 字符，避免匹配日期等无关数字
      const m = effectiveBody.match(/(\d)\s*\/\s*(\d)\s*\|/);
      const stage = m ? `${m[1]}/${m[2]}` : '?';
      const hasClickableBtn = /looks good|present video|create.*video|generate.*video/i.test(effectiveBody);
      return { hasPending, stage, hasClickableBtn };
    });
    console.log(
      `[shared-steps] pushPendingUserInputs: 第 ${attempt}/${maxAttempts} 次检查——stage=${status.stage}, pending=${status.hasPending}, clickableBtn=${status.hasClickableBtn}`,
    );

    // ★ 如果没有 Pending 但还在 2/3 阶段，说明 AI 还在处理，等待后重试
    if (!status.hasPending && status.stage !== '3/3' && status.stage !== '?') {
      console.log(
        `[shared-steps] pushPendingUserInputs: stage=${status.stage} 且无 Pending，等待 15s 后重试（AI 可能还在处理）...`,
      );
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    // ★ stage=3/3 或未知 且无 Pending — 可能需要点击按钮进入视频生成
    if (!status.hasPending) {
      if (hasClickedBtn) {
        console.log('[shared-steps] pushPendingUserInputs: 已点击过按钮且无 Pending，认为已进入生成阶段');
        return;
      }
      console.log(
        `[shared-steps] pushPendingUserInputs: stage=${status.stage} 无 Pending，尝试点击建议按钮...`,
      );
      const clicked = await clickFirstSuggestionButton(page, 'pushPendingUserInputs');
      if (clicked) {
        hasClickedBtn = true;
        console.log('[shared-steps] pushPendingUserInputs: ✅ 点击了建议按钮，等待 10s...');
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.log('[shared-steps] pushPendingUserInputs: 未找到可点击按钮，认为已进入生成阶段');
      }
      return;
    }

    // 还在 Pending：先尝试点击按钮，再发推进话术
    console.log(
      `[shared-steps] pushPendingUserInputs: 检测到 Pending user inputs，尝试点击按钮...`,
    );

    // ★ 如果已经点击过按钮，不再重复点击，只等待
    if (hasClickedBtn) {
      console.log('[shared-steps] pushPendingUserInputs: 已点击过按钮，等待 15s 让 AI 处理...');
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    // ★ 先尝试点击建议按钮（可能有 "Continue"、"Generate" 等按钮）
    const btnClicked = await clickFirstSuggestionButton(page, 'pushPendingUserInputs');
    if (btnClicked) {
      hasClickedBtn = true;
      console.log('[shared-steps] pushPendingUserInputs: ✅ 点击了建议按钮，等待 30s 让页面完全转换...');
      await new Promise(r => setTimeout(r, 30000));
      // ★ 检查页面是否崩溃（白屏）
      const healthCheck = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        const bodyLen = (document.body.innerText || '').length;
        return { btnCount: btns.length, bodyLen };
      });
      if (healthCheck.btnCount === 0 && healthCheck.bodyLen === 0) {
        console.log('[shared-steps] pushPendingUserInputs: ⚠️ 页面白屏，尝试 reload 恢复...');
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 10000));
          console.log('[shared-steps] pushPendingUserInputs: ✅ 页面 reload 完成');
        } catch (e: any) {
          console.warn(`[shared-steps] pushPendingUserInputs: reload 失败: ${e.message}`);
        }
      }
      continue;  // 下一轮检查是否已跳出 Pending
    }

    // ★ 按钮没找到，打印页面文本片段用于诊断
    const pageText = await page.evaluate(() => {
      const body = document.body.innerText || '';
      return body.substring(0, 300) + ' ... ' + body.slice(-300);
    });
    console.log(`[shared-steps] pushPendingUserInputs: 📋 页面文本片段: ${pageText.substring(0, 400)}`);

    // ★ 发推进话术
    console.log(
      `[shared-steps] pushPendingUserInputs: 未找到按钮，发送推进话术...`,
    );
    try {
      await inputPromptAndSend(page, PROMPT);
    } catch (err: any) {
      console.warn(
        `[shared-steps] pushPendingUserInputs: 发送失败（${err.message}），本次跳过`,
      );
      continue;
    }

    // 等 AI 处理（推进 storyboard 阶段）
    await new Promise(r => setTimeout(r, 15000));
  }

  // 最后再检查一次
  const finalStatus = await page.evaluate(() => {
    const body = document.body.innerText || '';
    const rootText = (document.querySelector('#root') as HTMLElement)?.innerText || '';
    const effectiveBody = body.length > 0 ? body : rootText;
    const m = effectiveBody.match(/(\d)\s*\/\s*(\d)\s*\|/);
    return {
      hasPending: /Pending user inputs/i.test(effectiveBody),
      stage: m ? `${m[1]}/${m[2]}` : '?',
    };
  });
  console.log(
    `[shared-steps] pushPendingUserInputs: 最终状态 stage=${finalStatus.stage}, pending=${finalStatus.hasPending}`,
  );
  if (finalStatus.hasPending) {
    // ★ 循环结束后才检测到 Pending — 尝试点击按钮（仅当尚未点击过时）
    if (!hasClickedBtn) {
      console.log('[shared-steps] pushPendingUserInputs: 循环结束后检测到 Pending，尝试点击按钮...');
      const finalBtnClicked = await clickFirstSuggestionButton(page, 'pushPendingUserInputs_final');
      if (finalBtnClicked) {
        console.log('[shared-steps] pushPendingUserInputs: ✅ 循环后点击了建议按钮，等待 20s...');
        await new Promise(r => setTimeout(r, 20000));
        // 再检查一次
        const recheck = await page.evaluate(() => {
          const body = document.body.innerText || '';
          const rootText = (document.querySelector('#root') as HTMLElement)?.innerText || '';
          const effectiveBody = body.length > 0 ? body : rootText;
          return /Pending user inputs/i.test(effectiveBody);
        });
        if (!recheck) {
          console.log('[shared-steps] pushPendingUserInputs: ✅ 循环后点击成功，已跳出 Pending');
          return;
        }
      }
    }
    // ⚠️ 仍卡在 Pending user inputs
    throw new NeedsManualError(
      `${maxAttempts} 次推进后仍处于 Pending user inputs (stage=${finalStatus.stage})`,
      { stage: 'pushPendingUserInputs', taskStage: finalStatus.stage, url: page.url() },
    );
  }
}

/**
 * 6. 检查视频生成状态（单次检查，不阻塞）
 *
 * 设计变更：从阻塞式轮询改为单次检查。
 * 调用方（轮询器）每 30s 调用一次，每次 acquire→navigate→check→release，
 * 不长期持有 page，避免页面池被耗尽。
 */
export async function checkVideoGenerationStatus(
  page: Page
): Promise<{ status: 'ready' | 'generating' | 'error' | 'loading'; detail?: string }> {
  const currentUrl = page.url();

  // ★ 如果页面不在 TikTok，说明导航失败或页面被重置
  if (!currentUrl.includes('tiktok.com')) {
    console.log(`[shared-steps] checkVideoGenerationStatus: 页面不在 TikTok (URL=${currentUrl})，返回 loading`);
    return { status: 'loading', detail: `URL=${currentUrl}` };
  }

  // 单次检查：页面上出现明确的 "完成" 标志
  const state = await page.evaluate(() => {
    const body = document.body.innerText || '';
    const html = document.body.innerHTML || '';
    const rootText = (document.querySelector('#root') as HTMLElement)?.innerText ||
                     (document.querySelector('#app') as HTMLElement)?.innerText ||
                     (document.querySelector('[id]') as HTMLElement)?.innerText || '';
    const effectiveBody = body.length > 0 ? body : rootText;

    const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a[class*="cursor"]')) as HTMLElement[];
    const btnTexts = allBtns.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map((b) => (b.textContent || '').trim().substring(0, 50)).filter(t => t.length > 0).slice(0, 20);
    const btnTextJoined = btnTexts.join(' ').toLowerCase();

    const hasDownloadText = effectiveBody.toLowerCase().includes('download video') ||
                            btnTextJoined.includes('download');
    const hasDownloadLink = !!document.querySelector('a[download][href*="video"], a[href*="video"][download]');
    const hasReadyText = effectiveBody.toLowerCase().includes('your video is ready') ||
                         effectiveBody.toLowerCase().includes('video is ready') ||
                         effectiveBody.toLowerCase().includes('generated successfully') ||
                         effectiveBody.toLowerCase().includes('video has been generated') ||
                         btnTextJoined.includes('your video is ready');
    const videoEls = document.querySelectorAll('video[src]');
    const hasNewVideo = Array.from(videoEls).some(v => {
      const src = v.getAttribute('src') || '';
      return src.includes('video') || src.includes('output') || src.includes('generated');
    });
    const hasRetryText = effectiveBody.toLowerCase().includes('please try again') ||
                         effectiveBody.toLowerCase().includes('try generating') ||
                         effectiveBody.toLowerCase().includes('regenerate') ||
                         btnTextJoined.includes('regenerate');

    const effectiveBodyLower = effectiveBody.toLowerCase();
    const isGenerating = effectiveBodyLower.includes('generating your video') ||
                         effectiveBodyLower.includes('generating video') ||
                         effectiveBodyLower.includes('generating the final video') ||
                         effectiveBodyLower.includes('generating the video') ||
                         effectiveBodyLower.includes("i'm now generating") ||
                         effectiveBodyLower.includes('video generation in progress') ||
                         effectiveBodyLower.includes('working on producing') ||
                         effectiveBodyLower.includes('producing your video') ||
                         effectiveBodyLower.includes('thinking.') ||
                         effectiveBodyLower.includes('thinking...') ||
                         btnTextJoined.includes('generating...') ||
                         btnTextJoined.includes('loading...');

    return {
      hasDownloadText, hasDownloadLink, hasReadyText, hasNewVideo, hasRetryText, isGenerating,
      bodyLen: body.length, rootLen: rootText.length, htmlLen: html.length,
      btnTexts, readyState: document.readyState, title: document.title,
      bodyTail: effectiveBody.trim().slice(-200).replace(/\n/g, ' '),
    };
  });

  // 白屏检测：页面内容为空
  if (state.bodyLen === 0 && state.btnTexts.length === 0) {
    console.log(`[shared-steps] checkVideoGenerationStatus: 页面白屏 (URL=${currentUrl}, bodyLen=0, btnTexts=[], htmlLen=${state.htmlLen}, title=${state.title}, readyState=${state.readyState})，返回 loading`);
    return { status: 'loading', detail: `white screen, URL=${currentUrl}, htmlLen=${state.htmlLen}` };
  }

  // 视频生成完成
  if (state.hasDownloadText || state.hasDownloadLink || state.hasReadyText || state.hasNewVideo) {
    console.log(`[shared-steps] checkVideoGenerationStatus: ✅ 视频生成完成! (download=${state.hasDownloadText}, ready=${state.hasReadyText}, newVideo=${state.hasNewVideo})`);
    return { status: 'ready' };
  }

  // 生成失败
  if (state.hasRetryText && !state.isGenerating) {
    console.log('[shared-steps] checkVideoGenerationStatus: ❌ 检测到重试/失败文本');
    return { status: 'error', detail: 'retry text detected' };
  }

  // 生成中或未知状态
  if (state.isGenerating) {
    console.log(`[shared-steps] checkVideoGenerationStatus: generating=true, bodyLen=${state.bodyLen}, btnTexts=${state.btnTexts.length} [${state.btnTexts.slice(0, 5).join(', ')}], URL=${currentUrl.substring(0, 80)}`);
    return { status: 'generating', detail: 'isGenerating=true' };
  }
  // ★ 未检测到生成中文本，也不是完成/失败 → 返回 loading，下次再检查
  console.log(`[shared-steps] checkVideoGenerationStatus: 未知状态 (bodyLen=${state.bodyLen}, bodyTail=${state.bodyTail?.substring(0, 100)}), URL=${currentUrl.substring(0, 80)}`);
  return { status: 'loading', detail: `unknown state, bodyLen=${state.bodyLen}` };
}

/**
 * 7. 重试视频生成
 */
export async function retryGeneration(page: Page): Promise<void> {
  console.log('[shared-steps] retryGeneration: 查找重试按钮...');

  const retryBtn = await page.waitForSelector(SELECTORS.generation.retryButton, {
    timeout: config.browser.defaultTimeout,
  });
  if (!retryBtn) {
    throw new Error('[shared-steps] retryGeneration: 未找到重试按钮');
  }

  await randomDelay(500, 1000);
  await retryBtn.click();
  console.log('[shared-steps] retryGeneration: 已点击重试，等待重新生成...');

  await randomDelay(2000, 3000);
  console.log('[shared-steps] retryGeneration: 重试已触发');
}

/**
 * 8. 下载视频
 */
export async function downloadVideo(page: Page, savePath: string): Promise<string> {
  console.log(`[shared-steps] downloadVideo: 准备下载视频到 ${savePath}...`);

  // 监听 download 事件
  const downloadPromise = page.waitForEvent('download', {
    timeout: config.browser.defaultTimeout,
  });

  // 点击下载按钮
  const downloadBtn = await page.waitForSelector(SELECTORS.generation.downloadButton, {
    timeout: config.browser.defaultTimeout,
  });
  if (!downloadBtn) {
    throw new Error('[shared-steps] downloadVideo: 未找到下载按钮');
  }

  await randomDelay(500, 1000);
  await downloadBtn.click();
  console.log('[shared-steps] downloadVideo: 已点击下载按钮，等待下载...');

  // 等待下载完成
  const download = await downloadPromise;
  const tempPath = await download.path();
  if (!tempPath) {
    throw new Error('[shared-steps] downloadVideo: 下载失败，未获取到临时文件路径');
  }

  console.log(`[shared-steps] downloadVideo: 下载完成，临时路径: ${tempPath}`);

  // 移动到目标路径
  const fs = await import('fs');
  const pathModule = await import('path');

  // 确保目标目录存在
  const dir = pathModule.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.copyFileSync(tempPath, savePath);
  console.log(`[shared-steps] downloadVideo: 文件已保存到 ${savePath}`);

  return savePath;
}

/**
 * 9. 获取当前页面状态
 */
export async function getCurrentPageState(
  page: Page
): Promise<'chat' | 'brief' | 'storyboard' | 'generating' | 'complete' | 'failed' | 'unknown'> {
  console.log('[shared-steps] getCurrentPageState: 分析当前页面状态...');

  // 检测失败状态（重试按钮存在）
  const retryBtn = await page.$(SELECTORS.generation.retryButton);
  if (retryBtn) {
    console.log('[shared-steps] getCurrentPageState: 状态 = failed');
    return 'failed';
  }

  // 检测生成完成（视频播放器或下载按钮存在）
  const videoPlayer = await page.$(SELECTORS.generation.videoPlayer);
  const downloadBtn = await page.$(SELECTORS.generation.downloadButton);
  if (videoPlayer || downloadBtn) {
    console.log('[shared-steps] getCurrentPageState: 状态 = complete');
    return 'complete';
  }

  // 检测正在生成
  const generating = await page.$(SELECTORS.generation.generatingIndicator);
  if (generating) {
    console.log('[shared-steps] getCurrentPageState: 状态 = generating');
    return 'generating';
  }

  // 检测分镜确认按钮
  const storyboardBtn = await page.$(SELECTORS.conversation.confirmStoryboard);
  if (storyboardBtn) {
    console.log('[shared-steps] getCurrentPageState: 状态 = storyboard');
    return 'storyboard';
  }

  // 检测 Brief 确认按钮
  const briefBtn = await page.$(SELECTORS.conversation.confirmBrief);
  if (briefBtn) {
    console.log('[shared-steps] getCurrentPageState: 状态 = brief');
    return 'brief';
  }

  // 检测对话输入框（基本聊天状态）
  const chatInput = await page.$(SELECTORS.common.chatInput);
  if (chatInput) {
    console.log('[shared-steps] getCurrentPageState: 状态 = chat');
    return 'chat';
  }

  console.log('[shared-steps] getCurrentPageState: 状态 = unknown');
  return 'unknown';
}
