/**
 * Lazada Venture → 域名映射 & 商品 URL 构造工具
 *
 * 用途：用户原始数据只有 venture（如 "PH"）和 productId（如 "4738495529"），
 *       本模块将其复原为完整的 Lazada 商品详情页 URL，供后续商品解析 Agent 使用。
 *
 * URL 格式参考现有数据：
 *   https://www.lazada.com.ph/products/pdp-i4738495529-s28630725476.html
 *   └─────────────────┘  └──────┘ └──────────────────────────┘
 *       域名部分          固定前缀   i{itemId}-s{sellerId}.html
 *
 * 当仅有 itemId（无 sellerId）时，构造的 URL 会被 Lazada 302 重定向到完整 URL。
 */

// ─── Venture → 域名映射表 ──────────────────────────────
const VENTURE_DOMAIN_MAP: Record<string, string> = {
  // 国家码缩写
  TH: 'lazada.co.th',
  PH: 'lazada.com.ph',
  MY: 'lazada.com.my',
  SG: 'lazada.sg',
  ID: 'lazada.co.id',
  VN: 'lazada.vn',
};

// 域名 → 国家码 反向映射（用于从 URL 提取 venture）
const DOMAIN_VENTURE_MAP: Record<string, string> = {};
for (const [code, domain] of Object.entries(VENTURE_DOMAIN_MAP)) {
  DOMAIN_VENTURE_MAP[domain] = code;
}

export interface VentureInfo {
  /** 规范化后的 venture 码（大写两字母，如 "PH"） */
  ventureCode: string;
  /** Lazada 域名（如 "lazada.com.ph"） */
  domain: string;
  /** 国家英文名 */
  country: string;
}

const VENTURE_COUNTRY_NAMES: Record<string, string> = {
  TH: 'Thailand',
  PH: 'Philippines',
  MY: 'Malaysia',
  SG: 'Singapore',
  ID: 'Indonesia',
  VN: 'Vietnam',
};

/**
 * 将用户输入的 venture 字符串规范化为标准 venture 码。
 *
 * 支持的输入格式：
 *   - "PH" / "ph"               → "PH"
 *   - "lazada.com.ph"           → "PH"
 *   - "www.lazada.com.ph"       → "PH"
 *   - "https://www.lazada.com.ph" → "PH"
 *
 * @returns 规范化后的 venture 码，无法识别时返回 null
 */
export function normalizeVenture(input: string): string | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();

  // 1. 直接匹配两字母国家码
  const upper = raw.toUpperCase();
  if (VENTURE_DOMAIN_MAP[upper]) {
    return upper;
  }

  // 2. 从域名中提取
  for (const [domain, code] of Object.entries(DOMAIN_VENTURE_MAP)) {
    if (raw.includes(domain)) {
      return code;
    }
  }

  return null;
}

/**
 * 根据 venture 码或域名字符串获取完整信息
 */
export function getVentureInfo(input: string): VentureInfo | null {
  const code = normalizeVenture(input);
  if (!code) return null;

  return {
    ventureCode: code,
    domain: VENTURE_DOMAIN_MAP[code],
    country: VENTURE_COUNTRY_NAMES[code] || code,
  };
}

export interface ParsedProductId {
  /** 商品 itemId（纯数字） */
  itemId: string;
  /** 卖家 sellerId（纯数字），可能为空 */
  sellerId?: string;
}

/**
 * 解析用户输入的 productId，提取 itemId 和 sellerId。
 *
 * 支持的输入格式：
 *   - "4738495529"                     → { itemId: "4738495529" }
 *   - "i4738495529"                    → { itemId: "4738495529" }
 *   - "i4738495529-s28630725476"       → { itemId: "4738495529", sellerId: "28630725476" }
 *   - "4738495529-28630725476"         → { itemId: "4738495529", sellerId: "28630725476" }
 *   - "pdp-i4738495529-s28630725476"   → { itemId: "4738495529", sellerId: "28630725476" }
 *
 * @returns 解析结果，格式不合法时返回 null
 */
export function parseProductId(input: string): ParsedProductId | null {
  if (!input) return null;
  const raw = input.trim();

  // 去掉可能的 "pdp-" 前缀
  let cleaned = raw.replace(/^pdp-/i, '');

  // 去掉可能的 ".html" 后缀
  cleaned = cleaned.replace(/\.html$/i, '');

  // 匹配 i{itemId}-s{sellerId} 或 i{itemId} 或 {itemId}-{sellerId} 或 {itemId}
  // 格式1: i123456-s789012
  let m = cleaned.match(/^i(\d+)-s(\d+)$/i);
  if (m) {
    return { itemId: m[1], sellerId: m[2] };
  }

  // 格式2: i123456
  m = cleaned.match(/^i(\d+)$/i);
  if (m) {
    return { itemId: m[1] };
  }

  // 格式3: 123456-789012 (纯数字-纯数字)
  m = cleaned.match(/^(\d+)-(\d+)$/);
  if (m) {
    return { itemId: m[1], sellerId: m[2] };
  }

  // 格式4: 123456 (纯数字)
  m = cleaned.match(/^(\d+)$/);
  if (m) {
    return { itemId: m[1] };
  }

  return null;
}

export interface ResolveUrlOptions {
  /** 是否通过 HTTP 请求跟随重定向获取最终 URL（默认 true） */
  followRedirect?: boolean;
  /** 重定向超时时间（毫秒），默认 10000 */
  redirectTimeout?: number;
}

export interface ResolveUrlResult {
  /** 构造的初始 URL（可能只有 itemId，无 sellerId） */
  constructedUrl: string;
  /** 最终 URL（跟随重定向后的 URL，若 followRedirect=false 则等于 constructedUrl） */
  finalUrl: string;
  /** 是否成功跟随了重定向 */
  redirected: boolean;
  /** 解析出的 venture 信息 */
  venture: VentureInfo;
  /** 解析出的 productId 信息 */
  productId: ParsedProductId;
}

/**
 * 根据 venture 和 productId 构造 Lazada 商品 URL。
 *
 * @param venture  venture 码或域名（如 "PH"、"lazada.com.ph"）
 * @param productId 商品 ID（支持多种格式，详见 parseProductId）
 * @returns 构造的 URL，输入无效时返回 null
 */
export function constructProductUrl(
  venture: string,
  productId: string,
): string | null {
  const ventureInfo = getVentureInfo(venture);
  if (!ventureInfo) return null;

  const parsed = parseProductId(productId);
  if (!parsed) return null;

  return constructUrlFromParts(ventureInfo.domain, parsed.itemId, parsed.sellerId);
}

/**
 * 从组成部分构造 URL
 */
function constructUrlParts(
  domain: string,
  itemId: string,
  sellerId?: string,
): string {
  const idPart = sellerId
    ? `pdp-i${itemId}-s${sellerId}`
    : `pdp-i${itemId}`;
  return `https://www.${domain}/products/${idPart}.html`;
}

/**
 * 从组成部分构造 URL（公开接口）
 */
export function constructUrlFromParts(
  domain: string,
  itemId: string,
  sellerId?: string,
): string {
  return constructUrlParts(domain, itemId, sellerId);
}

/**
 * 根据 venture 和 productId 构造 URL，并可选地跟随重定向获取最终 URL。
 *
 * 当 productId 仅包含 itemId（无 sellerId）时，Lazada 会 302 重定向到包含 sellerId 的完整 URL。
 * 本方法通过 fetch 跟随重定向，返回最终 URL。
 *
 * @param venture  venture 码或域名
 * @param productId 商品 ID
 * @param options   解析选项
 * @returns 解析结果对象，输入无效时返回 null
 */
export async function resolveProductUrl(
  venture: string,
  productId: string,
  options: ResolveUrlOptions = {},
): Promise<ResolveUrlResult | null> {
  const { followRedirect = true, redirectTimeout = 10000 } = options;

  const ventureInfo = getVentureInfo(venture);
  if (!ventureInfo) return null;

  const parsed = parseProductId(productId);
  if (!parsed) return null;

  const constructedUrl = constructUrlParts(
    ventureInfo.domain,
    parsed.itemId,
    parsed.sellerId,
  );

  // 如果已有 sellerId 或不需要跟随重定向，直接返回
  if (parsed.sellerId || !followRedirect) {
    return {
      constructedUrl,
      finalUrl: constructedUrl,
      redirected: false,
      venture: ventureInfo,
      productId: parsed,
    };
  }

  // 跟随重定向获取最终 URL
  let finalUrl = constructedUrl;
  let redirected = false;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), redirectTimeout);

    const resp = await fetch(constructedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // 模拟浏览器请求，避免被 Lazada 反爬拦截
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timer);

    // resp.url 是跟随所有重定向后的最终 URL
    if (resp.url && resp.url !== constructedUrl) {
      finalUrl = resp.url;
      redirected = true;
    }

    // 如果 resp.url 不包含 sellerId，尝试从 redirect 链中提取
    // 有些情况 Lazada 返回 200 但 URL 不变，需要从 HTML 中提取 canonical URL
    if (!redirected && resp.ok) {
      const html = await resp.text();
      const canonicalMatch = html.match(
        /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
      );
      if (canonicalMatch && canonicalMatch[1]) {
        const canonicalUrl = canonicalMatch[1];
        if (canonicalUrl !== constructedUrl) {
          finalUrl = canonicalUrl;
          redirected = true;
        }
      }
    }
  } catch (err) {
    // 重定向跟随失败不影响返回构造的 URL
    console.warn(
      `[venture-map] 跟随重定向失败，返回构造的 URL: ${(err as Error).message}`,
    );
  }

  return {
    constructedUrl,
    finalUrl,
    redirected,
    venture: ventureInfo,
    productId: parsed,
  };
}

/**
 * 从已有的 Lazada 商品 URL 中提取 venture 码和 productId。
 * 用于反向校验或从 URL 还原原始输入。
 *
 * @returns { venture, productId } 或 null
 */
export function extractFromUrl(
  url: string,
): { venture: string; productId: string; itemId: string; sellerId?: string } | null {
  if (!url) return null;

  let hostname = '';
  let pathname = '';
  try {
    const u = new URL(url);
    hostname = u.hostname.toLowerCase();
    pathname = u.pathname;
  } catch {
    return null;
  }

  // 从域名提取 venture
  const ventureCode = normalizeVenture(hostname);
  if (!ventureCode) return null;

  // 从路径提取 itemId 和 sellerId
  // 格式: /products/{slug}-i{itemId}-s{sellerId}.html 或 /products/pdp-i{itemId}.html
  const match = pathname.match(/-i(\d+)(?:-s(\d+))?\.html?$/i);
  if (!match) return null;

  const itemId = match[1];
  const sellerId = match[2];
  const productId = sellerId
    ? `i${itemId}-s${sellerId}`
    : `i${itemId}`;

  return { venture: ventureCode, productId, itemId, sellerId };
}
