/**
 * 待收录草稿领域形状（唯一来源）。
 *
 * 同一概念只在两处表达：
 * - `DraftItem` / `DraftEntry`：领域/表单形状（空值用空串，`is_verified` 不入表单）；
 * - `DraftItemWire` / `DraftEntryWire`：IPC 线格式（空值用 `null`，`is_verified` 必填）。
 * 两者之间的转换只在 `mappers.ts` 发生，视图与 API 客户端不各自转换。
 */

/** 草稿状态：`local_collected` 为磁盘残留同义值（判定与 `collected` 等同）。 */
export type DraftStatus = 'draft' | 'submitted' | 'collected' | 'local_collected';

/** 草稿条目（领域形状）：表单、列表、卡片摘要共用。 */
export interface DraftItem {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  /** 空串表示未填（线格式 `null` 在 mappers 归一）。 */
  description_en: string;
  category: string;
  category_name: string;
  aliases: string[];
  default_version: string;
  license: string;
  /** 空串表示未填（线格式 `null` 在 mappers 归一）。 */
  homepage: string;
  install_dirs: string[];
  search_subdirs: string[];
  publishers: string[];
  platforms: string[];
  identifiers: Record<string, string[]>;
  /** 后端真值透传，表单不编辑。 */
  stars?: number;
  forks?: number;
}

/** 草稿条目（领域形状）：status 已归一到 `DraftStatus`。 */
export interface DraftEntry {
  id: string;
  item: DraftItem;
  status: DraftStatus;
  pr_url?: string | null;
  archived: boolean;
  /** 本地新建条目缺席（后端行为必有）。 */
  updated_at?: number;
}

/** 草稿 payload 线格式（与后端 `CatalogItem` 同形，`is_verified` 入库强制 false）。 */
export interface DraftItemWire {
  id: string;
  name: string;
  owner: string;
  repo: string;
  icon: string;
  icon_bg: string;
  description: string;
  description_en?: string | null;
  category: string;
  category_name: string;
  aliases: string[];
  default_version: string;
  license: string;
  stars: number;
  forks: number;
  is_verified: boolean;
  homepage?: string | null;
  install_dirs: string[];
  search_subdirs: string[];
  publishers: string[];
  platforms: string[];
  identifiers: Record<string, string[]>;
}

/** 后端 `custom_apps` 行（线格式）：与 Rust `CustomAppEntry` 同形。 */
export interface DraftEntryWire {
  id: string;
  item: DraftItemWire;
  status: string;
  pr_url?: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
}
