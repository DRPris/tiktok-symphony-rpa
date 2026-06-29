/**
 * 商品国家识别 —— 基于 URL 域名自动检测目标市场
 *
 * 检测逻辑：
 *   1. 优先从 URL 域名后缀匹配已知电商平台国家
 *   2. 兜底：通过 URL 路径/子域名特征识别
 *   3. 无法识别时返回 null
 *
 * 根据识别结果自动映射：
 *   - persona:       视频中出现的人物形象（本地化面孔）
 *   - videoLanguage: 视频语言 / 字幕语言
 */

export interface CountryProfile {
  /** 国家英文名 */
  country: string;
  /** ISO 3166-1 alpha-2 国家码 */
  countryCode: string;
  /** 视频人物形象描述（英文，直接嵌入 prompt） */
  persona: string;
  /** 视频语言 */
  videoLanguage: string;
}

// ─── 国家画像映射表 ─────────────────────────────────
const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  TH: {
    country: 'Thailand',
    countryCode: 'TH',
    persona: 'A young Thai person with a friendly, approachable appearance',
    videoLanguage: 'Thai',
  },
  PH: {
    country: 'Philippines',
    countryCode: 'PH',
    persona: 'A young Filipino person with a vibrant, energetic look',
    videoLanguage: 'English',
  },
  MY: {
    country: 'Malaysia',
    countryCode: 'MY',
    persona: 'A young Malaysian person with a modern, stylish appearance',
    videoLanguage: 'English',
  },
  SG: {
    country: 'Singapore',
    countryCode: 'SG',
    persona: 'A young Singaporean person with a cosmopolitan, trendy look',
    videoLanguage: 'English',
  },
  ID: {
    country: 'Indonesia',
    countryCode: 'ID',
    persona: 'A young Indonesian person with a warm, relatable appearance',
    videoLanguage: 'Indonesian',
  },
  VN: {
    country: 'Vietnam',
    countryCode: 'VN',
    persona: 'A young Vietnamese person with a fresh, natural look',
    videoLanguage: 'Vietnamese',
  },
  BR: {
    country: 'Brazil',
    countryCode: 'BR',
    persona: 'A young Brazilian person with a lively, expressive appearance',
    videoLanguage: 'Portuguese',
  },
  MX: {
    country: 'Mexico',
    countryCode: 'MX',
    persona: 'A young Mexican person with a warm, charismatic look',
    videoLanguage: 'Spanish',
  },
  US: {
    country: 'United States',
    countryCode: 'US',
    persona: 'A young American person with a casual, confident look',
    videoLanguage: 'English',
  },
  GB: {
    country: 'United Kingdom',
    countryCode: 'GB',
    persona: 'A young British person with a polished, contemporary look',
    videoLanguage: 'English',
  },
  JP: {
    country: 'Japan',
    countryCode: 'JP',
    persona: 'A young Japanese person with a clean, minimalist aesthetic',
    videoLanguage: 'Japanese',
  },
  KR: {
    country: 'South Korea',
    countryCode: 'KR',
    persona: 'A young Korean person with a trendy K-style appearance',
    videoLanguage: 'Korean',
  },
  CN: {
    country: 'China',
    countryCode: 'CN',
    persona: 'A young Chinese person with a modern, fashionable appearance',
    videoLanguage: 'Chinese',
  },
};

// ─── 域名后缀 → 国家码映射 ──────────────────────────
const DOMAIN_SUFFIX_MAP: [string, string][] = [
  // Lazada 各站
  ['.co.th', 'TH'],
  ['.com.ph', 'PH'],
  ['.com.my', 'MY'],
  ['.sg', 'SG'],
  ['.co.id', 'ID'],
  ['.vn', 'VN'],
  // Shopee 各站
  // shopee.co.th / shopee.com.ph / shopee.com.my / shopee.sg / shopee.co.id / shopee.vn
  // （域名后缀与 Lazada 一致，已被上面覆盖）
  // TikTok Shop
  ['.com.br', 'BR'],
  ['.com.mx', 'MX'],
  ['.co.uk', 'GB'],
  ['.co.jp', 'JP'],
  ['.co.kr', 'KR'],
  // 通用
  ['.com', 'US'], // 兜底：.com 域名默认美国（优先级最低）
];

// ─── 域名关键字 → 国家码（子域名 / 路径特征） ────────
const DOMAIN_KEYWORD_MAP: [RegExp, string][] = [
  [/lazada\.co\.th/i, 'TH'],
  [/lazada\.com\.ph/i, 'PH'],
  [/lazada\.com\.my/i, 'MY'],
  [/lazada\.sg/i, 'SG'],
  [/lazada\.co\.id/i, 'ID'],
  [/lazada\.vn/i, 'VN'],
  [/shopee\.co\.th/i, 'TH'],
  [/shopee\.com\.ph/i, 'PH'],
  [/shopee\.com\.my/i, 'MY'],
  [/shopee\.sg/i, 'SG'],
  [/shopee\.co\.id/i, 'ID'],
  [/shopee\.vn/i, 'VN'],
  [/amazon\.co\.jp/i, 'JP'],
  [/amazon\.co\.uk/i, 'GB'],
  [/amazon\.com\.br/i, 'BR'],
  [/amazon\.com\.mx/i, 'MX'],
  [/amazon\.com/i, 'US'],
  [/tokopedia\.com/i, 'ID'],
  [/tiki\.vn/i, 'VN'],
  [/sendo\.vn/i, 'VN'],
  [/taobao\.com|tmall\.com|jd\.com|1688\.com/i, 'CN'],
  [/coupang\.com/i, 'KR'],
];

/**
 * 从商品 URL 检测目标国家
 * @returns CountryProfile 或 null（无法识别时）
 */
export function detectCountry(productUrl: string): CountryProfile | null {
  if (!productUrl) return null;

  let hostname = '';
  try {
    hostname = new URL(productUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  // 1. 优先精确匹配域名关键字（比后缀更准确）
  for (const [pattern, code] of DOMAIN_KEYWORD_MAP) {
    if (pattern.test(hostname)) {
      return COUNTRY_PROFILES[code] || null;
    }
  }

  // 2. 域名后缀匹配（从最长后缀开始，避免 .com 提前命中）
  const sortedSuffixes = [...DOMAIN_SUFFIX_MAP].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [suffix, code] of sortedSuffixes) {
    if (hostname.endsWith(suffix)) {
      return COUNTRY_PROFILES[code] || null;
    }
  }

  return null;
}

/**
 * 获取所有已知国家的画像列表（用于前端下拉选择）
 */
export function getAllCountryProfiles(): CountryProfile[] {
  return Object.values(COUNTRY_PROFILES);
}

/**
 * 根据国家码获取画像
 */
export function getCountryProfile(countryCode: string): CountryProfile | null {
  return COUNTRY_PROFILES[countryCode.toUpperCase()] || null;
}
