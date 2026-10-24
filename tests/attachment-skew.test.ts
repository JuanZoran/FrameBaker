import { describe, expect, test } from "bun:test";
import { attachmentOffsetMatrix, quaternionFromZRotation, sampleMotionClip, transformPoint, transformToMatrix, upsertMotionKeyframe, validateMotionClip, type MotionClip, type Skeleton } from "../packages/shared/src";

const skeleton: Skeleton = { schemaVersion: 1, kind: "skeleton", id: "s", name: "S", coordinateSystem: { handedness: "right", upAxis: "y", forwardAxis: "+z", unit: "normalized" }, bones: [{ id: "b", name: "Bone", parentId: null, rest: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] };
const clip = (): MotionClip => ({ schemaVersion: 1, kind: "motion-clip", id: "c", name: "C", skeletonId: "s", duration: 1, loop: false, tracks: [], events: [] });

describe("部件错切轨道", () => {
  test("仅允许 att: 目标，数值为 [-π, π] 弧度且 z 为 0", () => {
    expect(validateMotionClip(upsertMotionKeyframe(clip(), "att:a", "skew", 0, [0.2, -0.3, 0]), skeleton).ok).toBe(true);
    expect(validateMotionClip(upsertMotionKeyframe(clip(), "b", "skew", 0, [0.2, 0, 0]), skeleton).ok).toBe(false);
    expect(validateMotionClip(upsertMotionKeyframe(clip(), "att:a", "skew", 0, [4, 0, 0]), skeleton).ok).toBe(false);
    expect(validateMotionClip(upsertMotionKeyframe(clip(), "att:a", "skew", 0, [0, 0, 1]), skeleton).ok).toBe(false);
  });

  test("线性插值采样到 attachmentOffsets.skew", () => {
    let value = upsertMotionKeyframe(clip(), "att:a", "skew", 0, [0, 0, 0]);
    value = upsertMotionKeyframe(value, "att:a", "skew", 1, [0, 0.4, 0]);
    expect(sampleMotionClip(value, skeleton, 0.5).attachmentOffsets.a!.skew![1]).toBeCloseTo(0.2, 10);
  });

  test("无错切时与 T×R×S 完全一致", () => {
    const offset = { translation: [3, -2, 0] as [number, number, number], rotation: quaternionFromZRotation(0.7), scale: [2, 0.5, 1] as [number, number, number] };
    const expected = transformToMatrix({ translation: offset.translation, rotation: offset.rotation, scale: offset.scale });
    attachmentOffsetMatrix(offset)!.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 12));
    expect(attachmentOffsetMatrix({})).toBeUndefined();
  });

  test("旋转 + Y 轴错切可精确表达 Flash 风格 kx/ky 仿射", () => {
    // Flash/Animate：X 轴方向角 kx、Y 轴方向角 ky，各自乘以缩放。
    const kx = 0.3, ky = 1.1, sx = 1.4, sy = 0.8;
    const matrix = attachmentOffsetMatrix({ rotation: quaternionFromZRotation(kx), skew: [0, ky - kx, 0], scale: [sx, sy, 1] })!;
    const xAxis = transformPoint(matrix, [1, 0, 0]), yAxis = transformPoint(matrix, [0, 1, 0]);
    expect(xAxis[0]).toBeCloseTo(Math.cos(kx) * sx, 12);
    expect(xAxis[1]).toBeCloseTo(Math.sin(kx) * sx, 12);
    expect(yAxis[0]).toBeCloseTo(-Math.sin(ky) * sy, 12);
    expect(yAxis[1]).toBeCloseTo(Math.cos(ky) * sy, 12);
  });

  test("两轴等角错切等价于额外旋转", () => {
    const angle = 0.5;
    const skewed = attachmentOffsetMatrix({ skew: [angle, angle, 0] })!, rotated = attachmentOffsetMatrix({ rotation: quaternionFromZRotation(angle) })!;
    skewed.forEach((value, index) => expect(value).toBeCloseTo(rotated[index]!, 12));
  });
});
