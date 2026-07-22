export interface IntakeProcessor {
  process(userId: string, label: string, input: string): Promise<{ replyText: string }>;
  isLocked(userId: string): boolean;
}

export interface ResolvedIntake extends IntakeProcessor {
  intakeChannelId: string | null;
}

export function resolveIntake(
  deps: { subsidiary?: IntakeProcessor; desk?: IntakeProcessor },
  subsidiaryIntakeChannelId: string | null,
  deskChannelId: string | null,
): ResolvedIntake | undefined {
  if (deps.subsidiary) return { intakeChannelId: subsidiaryIntakeChannelId, ...deps.subsidiary };
  if (deps.desk) return { intakeChannelId: deskChannelId, ...deps.desk };
  return undefined;
}
