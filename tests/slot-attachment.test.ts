import { describe, expect, test } from "bun:test";
import { buildFbanimV2Entries, deleteMotionKeyframe, migrateMotionClipV1ToV2, resolveSlotAttachmentId, sampleMotionClip, setMotionSegmentInterpolation, upsertSlotAttachmentKeyframe, validateMotionClip, validateMotionClipBindingReferences, verifyFbanimV2Entries, type CharacterBinding, type MotionClip, type MotionClipV1, type Skeleton } from "../packages/shared/src";

const skeleton: Skeleton = { schemaVersion: 1, kind: "skeleton", id: "s", name: "S", coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" }, bones: [{ id: "b", name: "Bone", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] };
const identity = { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
const region = (id: string) => ({ id, name: id, type: "region" as const, materialId: `m-${id}`, imageSlot: "raw" as const, size: [1, 1] as [number, number], pivot: [0.5, 0.5] as [number, number], rest: identity });
const binding: CharacterBinding = { schemaVersion: 1, kind: "character-binding", id: "cb", name: "CB", skeletonId: "s", slots: [{ id: "head", name: "Head", boneId: "b", attachmentId: "face", drawOrder: 0 }], attachments: [region("face"), region("face-hurt")] };
const clip = (): MotionClip => ({ schemaVersion: 1, kind: "motion-clip", id: "c", name: "C", skeletonId: "s", duration: 1, loop: false, tracks: [], events: [] });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

describe("插槽附件轨道", () => {
  test("step 采样：首帧前取首帧，之后保持到下一关键帧；null 表示隐藏", () => {
    let value = upsertSlotAttachmentKeyframe(clip(), "head", 0.25, "face-hurt");
    value = upsertSlotAttachmentKeyframe(value, "head", 0.75, null);
    expect(validateMotionClip(value, skeleton).ok).toBe(true);
    const slot = binding.slots[0]!;
    expect(resolveSlotAttachmentId(slot, sampleMotionClip(value, skeleton, 0))).toBe("face-hurt");
    expect(resolveSlotAttachmentId(slot, sampleMotionClip(value, skeleton, 0.5))).toBe("face-hurt");
    expect(resolveSlotAttachmentId(slot, sampleMotionClip(value, skeleton, 0.9))).toBeNull();
    expect(resolveSlotAttachmentId(slot, sampleMotionClip(clip(), skeleton, 0.9))).toBe("face");
  });

  test("只允许 slot: 目标与 step 插值，值必须是附件 ID 或 null", () => {
    const valid = upsertSlotAttachmentKeyframe(clip(), "head", 0, "face") as MotionClipV1;
    const track = valid.tracks[0]!;
    expect(validateMotionClip({ ...valid, tracks: [{ ...track, interpolation: "linear" }] }, skeleton).ok).toBe(false);
    expect(validateMotionClip({ ...valid, tracks: [{ ...track, targetId: "b" }] }, skeleton).ok).toBe(false);
    expect(validateMotionClip({ ...valid, tracks: [{ ...track, keyframes: [{ time: 0, value: 3 }] }] }, skeleton).ok).toBe(false);
    expect(validateMotionClip({ ...valid, tracks: [{ targetId: "slot:head", property: "translation", interpolation: "linear", keyframes: [{ time: 0, value: [0, 0, 0] }] }] }, skeleton).ok).toBe(false);
  });

  test("v2 迁移保持离散值，插值切换不会把换图变成补间", () => {
    const v1 = upsertSlotAttachmentKeyframe(upsertSlotAttachmentKeyframe(clip(), "head", 0, "face"), "head", 0.5, null) as MotionClipV1;
    const v2 = migrateMotionClipV1ToV2(v1);
    expect(validateMotionClip(v2, skeleton).ok).toBe(true);
    expect(v2.tracks[0]!.keyframes.map((key) => key.value)).toEqual(["face", null]);
    expect(setMotionSegmentInterpolation(v2, "slot:head", "attachment", 0.2, { type: "linear" })).toBe(v2);
    const written = upsertSlotAttachmentKeyframe(v2, "head", 0.25, "face-hurt");
    expect(validateMotionClip(written, skeleton).ok).toBe(true);
    expect(deleteMotionKeyframe(written, "slot:head", "attachment", 0.25).tracks[0]!.keyframes).toHaveLength(2);
  });

  test("包构建与校验拒绝引用不存在的插槽或附件", async () => {
    const good = upsertSlotAttachmentKeyframe(clip(), "head", 0, "face-hurt");
    expect(validateMotionClipBindingReferences(good, binding)).toEqual([]);
    expect(validateMotionClipBindingReferences(upsertSlotAttachmentKeyframe(clip(), "tail", 0, "face"), binding)).toHaveLength(1);
    expect(validateMotionClipBindingReferences(upsertSlotAttachmentKeyframe(clip(), "head", 0, "nope"), binding)).toHaveLength(1);
    const source = (motionClip: MotionClip) => ({ createdBy: { name: "test", version: "1" }, skeleton, characterBinding: binding, actions: [{ id: "a", name: "A", motionClip, speed: 1, repeat: 1, loop: false }], textures: binding.attachments.map((attachment) => ({ attachmentId: attachment.id, bytes: png })) });
    const entries = await buildFbanimV2Entries(source(good));
    expect((await verifyFbanimV2Entries(entries)).ok).toBe(true);
    await expect(buildFbanimV2Entries(source(upsertSlotAttachmentKeyframe(clip(), "head", 0, "nope")))).rejects.toThrow("插槽或附件");
  });
});
