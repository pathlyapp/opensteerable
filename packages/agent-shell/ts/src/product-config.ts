/**
 * 产品注入配置（3.1）：shell 不硬编码任何产品特有的端点/链接/目录名，
 * 由产品组装根（products/<id>/active.ts）在模块求值早期注入。
 *
 * 与 brand.ts 的分工：brand 是「产品身份」（显示名/自称/默认智能体），
 * 本模块是「产品资源」（遥测端点、帮助链接、数据目录）。两者都由产品
 * 组装根注入；缺省时 shell 表现为中性框架（无遥测、无帮助链接、
 * 数据目录 .agent-shell）。
 *
 * 本模块只允许依赖 node 内置模块（与 brand.ts 同约束）。
 */

export interface ProductLinks {
  /** 帮助菜单「打开发布页」URL（通常是产品的下载/更新通道页）。 */
  releasePage?: string;
  /** 帮助菜单「访问官网」URL。 */
  website?: string;
}

export interface ProductUpdates {
  /**
   * electron-updater generic 通道根地址（目录，不含 latest*.yml）。
   * 打包配置里的 publishUrl 由产品组装根注入到这里。空则不检查更新。
   */
  feedUrl?: string;
}

export interface ProductConfig {
  /**
   * 云端遥测端点（insights flush 的 API base）。空 = 不上报（中性默认）；
   * 用户设置里的 apiBase 与环境变量仍可覆盖。
   */
  insightsApiBase?: string;
  /** 帮助菜单链接；缺省的项不渲染。 */
  links?: ProductLinks;
  /**
   * 桌面自动更新。缺省不检查。只在已打包的应用里生效，除非
   * `DEEPPATH_APP_UPDATE=1`。`DEEPPATH_UPDATE_FEED_URL` 可覆盖 feedUrl。
   */
  updates?: ProductUpdates;
  /**
   * BS 模式的 userData 目录名（~/ 下）。CS 模式由 Electron 按
   * productName 分目录，不经此字段。
   */
  dataDirName?: string;
  /**
   * 主 SQLite 文件名（userData 目录下）。产品必须显式声明以保住存量
   * 数据；中性 shell 缺省 'agent-shell.db'。
   */
  dbFileName?: string;
  /**
   * 宿主工具族：产品声明引入哪些工具。缺省全开。
   * 形状由 host-tools 解析；本模块只存声明、不依赖解析器。
   */
  hostTools?: Record<string, boolean | { capability?: boolean; chrome?: boolean }>;
  /**
   * 命令安全询问：host = 弹宿主审批；off = 本轮不挂审批。缺省 host。
   * STEERABLE_APPROVAL=0 仍是调试逃生口。
   */
  approval?: 'host' | 'off';
  /**
   * 对话模式。缺省 `['agent','plan']`。只留一种时渲染层不显示切换。
   */
  chatModes?: Array<'agent' | 'plan'>;
  /**
   * 设置入口。缺省全开。`false` 藏对应侧栏页或综合设置分段。
   */
  settings?: Record<string, boolean>;
  /**
   * 对话与配置的导出/导入。缺省关。只有显式 `true` 的产品才有入口和接口。
   */
  portable?: boolean;
  /**
   * 产品钉死的大模型。`settings.llm === false` 时必填，运行时用这份，
   * 不再读设置页。密钥用 `apiKeyEnv` 指向环境变量，不要把 key 写进仓库。
   */
  llm?: {
    provider?: string;
    vendorId?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    temperature?: number;
    maxTotalTokens?: number;
  };
  /**
   * shell 内置智能体。按需引入，缺省全关。
   * `true` 才种子；未声明或 `false` 不写入，已有行归档。
   */
  builtinAgents?: Partial<Record<'local-assistant' | 'all-round-assistant', boolean>>;
  /**
   * shell 内置技能。按需引入，缺省全关。
   * `true` 引入全部；对象里 `true` 的目录才引入。设置页入口不受影响。
   */
  builtinSkills?: boolean | Partial<Record<string, boolean>>;
  /**
   * 产品预置 MCP 服务。按需引入，缺省空。已有同名服务不覆盖。
   * 设置页入口不受影响。
   */
  builtinMcp?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    enabled?: boolean;
  }>;
}

/** shell 内置智能体：只有产品显式 `true` 才开。 */
export function isShellBuiltinAgentEnabled(
  id: 'local-assistant' | 'all-round-assistant',
  config: ProductConfig = getProductConfig(),
): boolean {
  return config.builtinAgents?.[id] === true;
}

/** 对话与配置能否导出/导入。缺省关，产品必须显式打开。 */
export function isPortableProduct(config: ProductConfig = getProductConfig()): boolean {
  return config.portable === true;
}

/** shell 内置技能：`true` 全开；否则只有对象里显式 `true` 的目录开。 */
export function isShellBuiltinSkillEnabled(
  id: string,
  config: ProductConfig = getProductConfig(),
): boolean {
  const value = config.builtinSkills;
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return value[id] === true;
}

let productConfig: ProductConfig | null = null;

/**
 * 注入产品配置（产品组装根在第一个 import 时调用）。重复注入抛错
 * （组装期笔误，fail fast——与 setProductBrand 同语义）。
 */
export function setProductConfig(config: ProductConfig): void {
  if (productConfig) {
    throw new Error('[product-config] product config already set');
  }
  productConfig = config;
}

/** 读取已注入的产品配置；未注入返回空对象（中性框架行为）。 */
export function getProductConfig(): ProductConfig {
  return productConfig ?? {};
}

/** 测试用：清掉已注入的产品配置，避免用例互相污染。 */
export function resetProductConfigForTests(): void {
  productConfig = null;
}
