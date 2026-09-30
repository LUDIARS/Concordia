import { describe, expect, it } from "vitest";
import {
  buildConsultIntakeQuestion,
  consultIntakeReplyBlock,
  isConsultIntakeComplete,
  MAX_CONSULT_INTAKE_FIELD_CHARS,
  normalizeConsultIntake,
  resolveConsultIntake,
} from "./intake.js";

describe("resolveConsultIntake", () => {
  it("reads labelled lines and treats the post title as the topic when no topic label is given", () => {
    const resolved = resolveConsultIntake({
      title: "DDD って何が良いの",
      body: "技術レベル: 初級\n役職: エンジニア\n目的: 設計の参考にしたい",
    });
    expect(resolved.intake).toEqual({
      topic: "DDD って何が良いの",
      skill_level: "初級",
      role_title: "エンジニア",
      purpose: "設計の参考にしたい",
    });
    expect(resolved.missing).toEqual([]);
    expect(resolved.asked).toBe(false);
  });

  it("asks for the missing required fields and the purpose once", () => {
    const resolved = resolveConsultIntake({ title: "集約の切り方", body: "境界がよく分からない" });
    expect(resolved.missing).toEqual(["skill_level", "role_title", "purpose"]);
  });

  it("fills skill level and role from the requester defaults and says so in the question", () => {
    const resolved = resolveConsultIntake({
      title: "集約の切り方",
      body: "境界がよく分からない",
      defaults: { skill_level: "中級", role_title: "エンジニア" },
    });
    expect(resolved.intake.skill_level).toBe("中級");
    expect(resolved.missing).toEqual(["purpose"]);
    expect(resolved.fromDefaults).toEqual(["skill_level", "role_title"]);
    const question = buildConsultIntakeQuestion(resolved);
    expect(question).toContain("目的:");
    expect(question).not.toContain("技術レベル:");
    expect(question).toContain("技術レベル「中級」・役職「エンジニア」 として回答します");
  });

  it("assigns an unlabelled reply to the only open field", () => {
    const body = `境界がよく分からない\n\n${consultIntakeReplyBlock("設計レビューで説明したい")}`;
    const resolved = resolveConsultIntake({
      title: "集約の切り方",
      body,
      defaults: { skill_level: "中級", role_title: "エンジニア" },
    });
    expect(resolved.intake.purpose).toBe("設計レビューで説明したい");
    expect(resolved.intake.skill_level).toBe("中級");
    expect(resolved.missing).toEqual([]);
  });

  it("splits an unlabelled multi-field reply in question order", () => {
    const body = `境界がよく分からない\n${consultIntakeReplyBlock("初級、デザイナー、知りたいだけ")}`;
    const resolved = resolveConsultIntake({ title: "集約の切り方", body });
    expect(resolved.intake.skill_level).toBe("初級");
    expect(resolved.intake.role_title).toBe("デザイナー");
    expect(resolved.intake.purpose).toBe("知りたいだけ");
  });

  it("lets a labelled reply correct a default value", () => {
    const body = `x\n${consultIntakeReplyBlock("技術レベル: 上級\n目的: 知ること自体")}`;
    const resolved = resolveConsultIntake({
      title: "t",
      body,
      defaults: { skill_level: "中級", role_title: "エンジニア" },
    });
    expect(resolved.intake.skill_level).toBe("上級");
    expect(resolved.fromDefaults).toEqual(["role_title"]);
  });

  it("does not ask for the purpose again once a reply has been received", () => {
    const body = `x\n${consultIntakeReplyBlock("技術レベル: 初級\n役職: 学生")}`;
    const resolved = resolveConsultIntake({ title: "t", body });
    expect(resolved.asked).toBe(true);
    expect(resolved.intake.purpose).toBe("");
    expect(resolved.missing).toEqual([]);
  });

  it("keeps asking for required fields that are still empty after a reply", () => {
    const body = `x\n${consultIntakeReplyBlock("技術レベル: 初級")}`;
    expect(resolveConsultIntake({ title: "t", body }).missing).toEqual(["role_title"]);
  });

  it("treats an echoed hint as empty", () => {
    const resolved = resolveConsultIntake({ title: "t", body: "役職: (例: エンジニア)" });
    expect(resolved.intake.role_title).toBe("");
  });
});

describe("normalizeConsultIntake", () => {
  it("trims values, drops non-strings and clips long input", () => {
    const intake = normalizeConsultIntake({
      topic: "  集約  ",
      skill_level: 3,
      role_title: "x".repeat(MAX_CONSULT_INTAKE_FIELD_CHARS + 5),
    });
    expect(intake.topic).toBe("集約");
    expect(intake.skill_level).toBe("");
    expect(intake.role_title).toHaveLength(MAX_CONSULT_INTAKE_FIELD_CHARS);
    expect(isConsultIntakeComplete(intake)).toBe(false);
    expect(isConsultIntakeComplete({ topic: "a", skill_level: "b", role_title: "c", purpose: "" })).toBe(true);
  });
});
