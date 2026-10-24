import type { FbanimV2PackageSource } from "./animationPackageV2";

/**
 * 外部动画格式 adapter（docs/pose-motion-system.md §6）：在第三方格式与 `.fbanim` v2 包源之间双向转换。
 * adapter 只负责格式映射，不直接写库；导入结果仍走 `.fbanim` 校验与项目导入流程，导出输入是已校验的包。
 */
export type CompatibilitySeverity = "info" | "warning" | "error";

export interface CompatibilityIssue {
  severity: CompatibilitySeverity;
  /** 稳定的机器可读代码，例如 `baked-curve`、`dropped-constraint`。 */
  code: string;
  message: string;
  /** 受影响的资产或子对象 ID（动作、插槽、附件等）。 */
  assetId?: string;
}

/** 兼容性报告：必须如实列出烘焙、近似和丢失；含 error 的结果不会被应用。 */
export interface CompatibilityReport {
  adapter: { id: string; version: string };
  issues: CompatibilityIssue[];
}

export interface AnimationAdapterFile {
  name: string;
  bytes: Uint8Array;
}

export interface AnimationPackageAdapter {
  /** 反向域名风格的稳定 ID，例如 `org.example.reanim`。 */
  id: string;
  name: string;
  version: string;
  /** 可导入的文件扩展名（小写，含点，例如 `.reanim.zip`）；导出文件名由 adapter 决定。 */
  extensions: string[];
  import?(file: AnimationAdapterFile): Promise<{ package: FbanimV2PackageSource; report: CompatibilityReport }>;
  export?(pkg: FbanimV2PackageSource): Promise<{ file: AnimationAdapterFile; report: CompatibilityReport }>;
}

export interface AnimationAdapterSummary {
  id: string;
  name: string;
  version: string;
  extensions: string[];
  canImport: boolean;
  canExport: boolean;
}

const ADAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const EXTENSION = /^(\.[a-z0-9][a-z0-9-]*)+$/;

/** 结构检查：注册前拒绝缺字段、ID 非反向域名或扩展名不规范的 adapter。 */
export function validateAnimationAdapter(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "adapter 必须是对象";
  const adapter = value as Partial<AnimationPackageAdapter>;
  if (typeof adapter.id !== "string" || !ADAPTER_ID.test(adapter.id)) return "adapter ID 必须是反向域名格式";
  if (typeof adapter.name !== "string" || !adapter.name.trim()) return `adapter ${adapter.id} 缺少名称`;
  if (typeof adapter.version !== "string" || !adapter.version.trim()) return `adapter ${adapter.id} 缺少版本`;
  if (!Array.isArray(adapter.extensions) || adapter.extensions.some((item) => typeof item !== "string" || !EXTENSION.test(item))) return `adapter ${adapter.id} 的扩展名必须是小写且以点开头`;
  if (adapter.extensions.some((item) => item === ".fbanim" || item === ".zip")) return `adapter ${adapter.id} 不能接管 .fbanim/.zip`;
  if (typeof adapter.import !== "function" && typeof adapter.export !== "function") return `adapter ${adapter.id} 至少需要实现 import 或 export`;
  if (adapter.import && !adapter.extensions.length) return `adapter ${adapter.id} 实现了 import 但没有声明扩展名`;
  return null;
}

export function summarizeAnimationAdapter(adapter: AnimationPackageAdapter): AnimationAdapterSummary {
  return { id: adapter.id, name: adapter.name, version: adapter.version, extensions: [...adapter.extensions], canImport: typeof adapter.import === "function", canExport: typeof adapter.export === "function" };
}

/** 按最长扩展名匹配可导入该文件的 adapter（文件名大小写不敏感）。 */
export function findAnimationAdapterForFile<T extends Pick<AnimationAdapterSummary, "extensions" | "canImport">>(adapters: readonly T[], fileName: string): T | undefined {
  const name = fileName.toLowerCase();
  let best: T | undefined, bestLength = 0;
  for (const adapter of adapters) {
    if (!adapter.canImport) continue;
    for (const extension of adapter.extensions) if (name.endsWith(extension) && extension.length > bestLength) { best = adapter; bestLength = extension.length; }
  }
  return best;
}

export const hasCompatibilityErrors = (report: CompatibilityReport) => report.issues.some((issue) => issue.severity === "error");
