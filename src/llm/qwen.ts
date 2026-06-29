/**
 * 通义千问 (Qwen) LLM 客户端
 *
 * 使用阿里云 DashScope 的 OpenAI 兼容接口：
 *   POST {baseUrl}/chat/completions
 *
 * 参考：https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 */
import { config } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 多模态消息（仅用于视觉模型） */
export interface VisionContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}
export interface VisionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | VisionContentPart[];
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 覆盖默认模型 */
  model?: string;
}

/**
 * 调用 Qwen Chat Completions（OpenAI 兼容协议）
 * @returns LLM 返回的文本
 */
export async function chatComplete(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const { apiKey, baseUrl, model: defaultModel, timeout } = config.llm;

  if (!apiKey) {
    throw new Error('未配置 LLM_API_KEY，请在 .env 中填入通义千问 API Key');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 800,
    stream: false,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Qwen 接口返回 ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Qwen 返回内容为空');
    }
    return content.trim();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Qwen 接口超时 (>${timeout}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 Qwen-VL（多模态拍图“看图说话”）
 * 请求与 Chat Completions 结构一致，仅 messages.content 可传 [{type:'image_url', image_url:{url}}]
 */
export async function chatCompleteVision(
  messages: VisionMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const { apiKey, baseUrl, visionModel, timeout } = config.llm;

  if (!apiKey) {
    throw new Error('未配置 LLM_API_KEY，请在 .env 中填入通义千问 API Key');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: options.model || visionModel,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 800,
    stream: false,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Qwen-VL 接口返回 ${res.status}: ${errText.slice(0, 300)}`
      );
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Qwen-VL 返回内容为空');
    }
    return content.trim();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Qwen-VL 接口超时 (>${timeout}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
