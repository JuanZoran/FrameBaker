import { Elysia, t } from "elysia";
import { AnimationAdapterError, exportWithAnimationAdapter, importWithAnimationAdapter, listAnimationAdapters } from "../animationAdapters";

/** 外部动画格式 adapter：只做格式转换，结果由前端沿用 `.fbanim` 导入/下载流程。 */
export const animationAdaptersApi = new Elysia({ prefix: "/api" })
  .get("/animation-adapters", () => ({ adapters: listAnimationAdapters() }))
  .post("/animation-adapters/:id/import", async ({ params, body, status }) => {
    try {
      const { fbanim, report } = await importWithAnimationAdapter(params.id, { name: body.file.name ?? "upload", bytes: new Uint8Array(await body.file.arrayBuffer()) });
      return { report, fbanim: Buffer.from(fbanim).toString("base64") };
    } catch (e) {
      if (e instanceof AnimationAdapterError) return status(e.status, { error: e.message, report: e.report ?? null });
      throw e;
    }
  }, { body: t.Object({ file: t.File() }) })
  .post("/animation-adapters/:id/export", async ({ params, body, status }) => {
    try {
      const { file, report } = await exportWithAnimationAdapter(params.id, body.file);
      return { report, file: { name: file.name, data: Buffer.from(file.bytes).toString("base64") } };
    } catch (e) {
      if (e instanceof AnimationAdapterError) return status(e.status, { error: e.message, report: e.report ?? null });
      throw e;
    }
  }, { body: t.Object({ file: t.File() }) });
