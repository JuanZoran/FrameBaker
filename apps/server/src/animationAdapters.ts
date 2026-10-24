import { delimiter, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFbanimV2Entries,
  createZip,
  hasCompatibilityErrors,
  readZip,
  summarizeAnimationAdapter,
  validateAnimationAdapter,
  verifyFbanimV2Entries,
  type AnimationAdapterFile,
  type AnimationAdapterSummary,
  type AnimationPackageAdapter,
  type CompatibilityReport,
} from "@framebaker/shared";

/**
 * 外部动画格式 adapter 注册表。内嵌 FrameBaker 的宿主可直接 `registerAnimationAdapter()`；
 * 独立运行时从 `FRAMEBAKER_ANIMATION_ADAPTERS`（按系统路径分隔符分隔的模块路径）加载插件。
 * 插件模块可默认导出单个 adapter、adapter 数组，或导出 `adapters` 数组。
 */
const registry = new Map<string, AnimationPackageAdapter>();

export class AnimationAdapterError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 422, readonly report?: CompatibilityReport) {
    super(message);
  }
}

export function registerAnimationAdapter(adapter: AnimationPackageAdapter): void {
  const error = validateAnimationAdapter(adapter);
  if (error) throw new Error(error);
  if (registry.has(adapter.id)) throw new Error(`adapter 已注册：${adapter.id}`);
  registry.set(adapter.id, adapter);
}

/** 仅供测试与宿主热重载：移除已注册的 adapter。 */
export function unregisterAnimationAdapter(id: string): boolean {
  return registry.delete(id);
}

export function listAnimationAdapters(): AnimationAdapterSummary[] {
  return [...registry.values()].map(summarizeAnimationAdapter).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function getAdapter(id: string): AnimationPackageAdapter {
  const adapter = registry.get(id);
  if (!adapter) throw new AnimationAdapterError(`adapter 不存在：${id}`, 404);
  return adapter;
}

function checkReport(adapter: AnimationPackageAdapter, report: CompatibilityReport | undefined): CompatibilityReport {
  if (!report || report.adapter?.id !== adapter.id || !Array.isArray(report.issues)) throw new AnimationAdapterError(`adapter ${adapter.id} 未返回有效的兼容性报告`, 422);
  if (hasCompatibilityErrors(report)) throw new AnimationAdapterError(`adapter ${adapter.id} 报告了无法转换的内容`, 422, report);
  return report;
}

/** 外部文件 → `.fbanim` v2 ZIP；包内容经过与手动导入相同的构建校验。 */
export async function importWithAnimationAdapter(id: string, file: AnimationAdapterFile): Promise<{ fbanim: Uint8Array; report: CompatibilityReport }> {
  const adapter = getAdapter(id);
  if (!adapter.import) throw new AnimationAdapterError(`adapter ${id} 不支持导入`, 400);
  const result = await adapter.import(file);
  const report = checkReport(adapter, result?.report);
  let entries;
  try {
    entries = await buildFbanimV2Entries(result.package);
  } catch (e) {
    throw new AnimationAdapterError(`adapter ${id} 生成的包无效：${(e as Error).message}`, 422, report);
  }
  const zip = await createZip(entries.map((entry) => ({ name: entry.path, data: entry.bytes })));
  return { fbanim: new Uint8Array(await zip.arrayBuffer()), report };
}

/** `.fbanim` v2 ZIP → 外部文件；输入先完整校验，adapter 只会看到闭包完整的包。 */
export async function exportWithAnimationAdapter(id: string, fbanim: Blob): Promise<{ file: AnimationAdapterFile; report: CompatibilityReport }> {
  const adapter = getAdapter(id);
  if (!adapter.export) throw new AnimationAdapterError(`adapter ${id} 不支持导出`, 400);
  let entries;
  try {
    entries = await readZip(fbanim);
  } catch (e) {
    throw new AnimationAdapterError((e as Error).message, 400);
  }
  const verified = await verifyFbanimV2Entries(entries.map((entry) => ({ path: entry.name, bytes: entry.data })));
  if (!verified.ok) throw new AnimationAdapterError(`包内容校验失败：${verified.issues[0]?.path} ${verified.issues[0]?.message}`, 400);
  const { manifest, manifestDigest: _, ...source } = verified.value;
  const result = await adapter.export({ ...source, createdBy: manifest.createdBy });
  const report = checkReport(adapter, result?.report);
  if (!result.file || typeof result.file.name !== "string" || !result.file.name.trim() || !(result.file.bytes instanceof Uint8Array)) throw new AnimationAdapterError(`adapter ${id} 未返回导出文件`, 422, report);
  return { file: result.file, report };
}

function adaptersFromModule(module: Record<string, unknown>): AnimationPackageAdapter[] {
  const value = module.adapters ?? module.default;
  return (Array.isArray(value) ? value : [value]) as AnimationPackageAdapter[];
}

/** 加载 `FRAMEBAKER_ANIMATION_ADAPTERS` 声明的插件模块；相对路径按启动目录解析，失败即抛出以免静默缺失格式。 */
export async function loadAnimationAdapterPlugins(spec = process.env.FRAMEBAKER_ANIMATION_ADAPTERS, cwd = process.cwd()): Promise<string[]> {
  const loaded: string[] = [];
  for (const entry of (spec ?? "").split(delimiter).map((item) => item.trim()).filter(Boolean)) {
    const path = isAbsolute(entry) ? entry : resolve(cwd, entry);
    const module = await import(pathToFileURL(path).href) as Record<string, unknown>;
    for (const adapter of adaptersFromModule(module)) {
      registerAnimationAdapter(adapter);
      loaded.push(adapter.id);
    }
  }
  return loaded;
}
