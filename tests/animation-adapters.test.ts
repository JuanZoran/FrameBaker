import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFbanimV2Entries, createZip, findAnimationAdapterForFile, readZip, validateAnimationAdapter, verifyFbanimV2Entries, type AnimationPackageAdapter, type FbanimV2PackageSource } from "../packages/shared/src";
import { animationAdaptersApi } from "../apps/server/src/api/animationAdapters";
import { loadAnimationAdapterPlugins, registerAnimationAdapter, unregisterAnimationAdapter } from "../apps/server/src/animationAdapters";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const identity = { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
const source = (name: string): FbanimV2PackageSource => ({
  createdBy: { name: "toy", version: "1" },
  skeleton: { schemaVersion: 1, kind: "skeleton", id: "s", name, coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" }, bones: [{ id: "b", name: "Bone", parentId: null, rest: identity }] },
  characterBinding: { schemaVersion: 1, kind: "character-binding", id: "cb", name, skeletonId: "s", slots: [{ id: "slot", name: "Slot", boneId: "b", attachmentId: "a", drawOrder: 0 }], attachments: [{ id: "a", name: "A", type: "region", materialId: "m", imageSlot: "raw", size: [1, 1], pivot: [0.5, 0.5], rest: identity }] },
  actions: [{ id: "idle", name: "Idle", motionClip: { schemaVersion: 1, kind: "motion-clip", id: "c", name: "Idle", skeletonId: "s", duration: 1, loop: true, tracks: [], events: [] }, speed: 1, repeat: 1, loop: true }],
  textures: [{ attachmentId: "a", bytes: png }],
});
const report = (id: string, issues: Array<{ severity: "info" | "warning" | "error"; code: string; message: string }> = []) => ({ adapter: { id, version: "1" }, issues });
/** 玩具格式：文件内容就是角色名；导出写回角色名。 */
const toy: AnimationPackageAdapter = {
  id: "test.toy", name: "Toy", version: "1", extensions: [".toy.txt"],
  async import(file) {
    const name = new TextDecoder().decode(file.bytes);
    if (name === "broken") return { package: source(name), report: report("test.toy", [{ severity: "error", code: "unsupported", message: "无法转换" }]) };
    return { package: source(name), report: report("test.toy", [{ severity: "warning", code: "baked-curve", message: "曲线已烘焙" }]) };
  },
  async export(pkg) { return { file: { name: "out.toy.txt", bytes: new TextEncoder().encode(pkg.skeleton.name) }, report: report("test.toy") }; },
};
const post = (path: string, file: Blob, name: string) => {
  const form = new FormData();
  form.append("file", file, name);
  return animationAdaptersApi.handle(new Request(`http://localhost/api${path}`, { method: "POST", body: form }));
};

afterEach(() => { unregisterAnimationAdapter("test.toy"); unregisterAnimationAdapter("test.plugin"); });

describe("动画格式 adapter", () => {
  test("注册前校验 ID、扩展名与能力", () => {
    expect(validateAnimationAdapter(toy)).toBeNull();
    expect(validateAnimationAdapter({ ...toy, id: "toy" })).toContain("反向域名");
    expect(validateAnimationAdapter({ ...toy, extensions: [".FBX"] })).toContain("小写");
    expect(validateAnimationAdapter({ ...toy, extensions: [".fbanim"] })).toContain(".fbanim");
    expect(validateAnimationAdapter({ ...toy, import: undefined, export: undefined })).toContain("import 或 export");
    registerAnimationAdapter(toy);
    expect(() => registerAnimationAdapter(toy)).toThrow("已注册");
  });

  test("按最长扩展名匹配可导入的 adapter", () => {
    const adapters = [{ id: "a", extensions: [".txt"], canImport: true }, { id: "b", extensions: [".toy.txt"], canImport: true }, { id: "c", extensions: [".toy.txt.gz"], canImport: false }];
    expect(findAnimationAdapterForFile(adapters, "Hero.TOY.txt")?.id).toBe("b");
    expect(findAnimationAdapterForFile(adapters, "a.toy.txt.gz")).toBeUndefined();
  });

  test("导入返回经过校验的 .fbanim 与兼容性报告", async () => {
    registerAnimationAdapter(toy);
    const list = await (await animationAdaptersApi.handle(new Request("http://localhost/api/animation-adapters"))).json();
    expect(list.adapters).toEqual([{ id: "test.toy", name: "Toy", version: "1", extensions: [".toy.txt"], canImport: true, canExport: true }]);
    const response = await post("/animation-adapters/test.toy/import", new Blob(["Hero"]), "hero.toy.txt");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report.issues[0].code).toBe("baked-curve");
    const entries = await readZip(new Blob([Buffer.from(body.fbanim, "base64")]));
    const verified = await verifyFbanimV2Entries(entries.map((entry) => ({ path: entry.name, bytes: entry.data })));
    expect(verified.ok && verified.value.skeleton.name).toBe("Hero");
  });

  test("报告含 error 时拒绝应用并返回报告；未知 adapter 为 404", async () => {
    registerAnimationAdapter(toy);
    const failed = await post("/animation-adapters/test.toy/import", new Blob(["broken"]), "x.toy.txt");
    expect(failed.status).toBe(422);
    expect((await failed.json()).report.issues[0].code).toBe("unsupported");
    expect((await post("/animation-adapters/test.none/import", new Blob(["x"]), "x.toy.txt")).status).toBe(404);
  });

  test("导出先校验 .fbanim，再由 adapter 生成外部文件", async () => {
    registerAnimationAdapter(toy);
    const entries = await buildFbanimV2Entries(source("Exported"));
    const zip = await createZip(entries.map((entry) => ({ name: entry.path, data: entry.bytes })));
    const body = await (await post("/animation-adapters/test.toy/export", zip, "package.fbanim")).json();
    expect(body.file.name).toBe("out.toy.txt");
    expect(Buffer.from(body.file.data, "base64").toString()).toBe("Exported");
    expect((await post("/animation-adapters/test.toy/export", new Blob(["not a zip"]), "bad.fbanim")).status).toBe(400);
  });

  test("从环境变量声明的模块加载插件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "framebaker-adapter-"));
    try {
      writeFileSync(join(dir, "plugin.mjs"), `export default { id: "test.plugin", name: "Plugin", version: "1", extensions: [".plug"], async import() { throw new Error("unused"); } };\n`);
      expect(await loadAnimationAdapterPlugins("plugin.mjs", dir)).toEqual(["test.plugin"]);
      expect(await loadAnimationAdapterPlugins("", dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
