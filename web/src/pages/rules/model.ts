import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs } from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { requireOk, runMutation } from "../../lib/mutation.js";

export interface RuleForm {
  id: string;
  description: string;
  trigger_type: "tick" | "event";
  tick_sec: string;
  event_kind: string;
  cooldown_sec: string;
  instructions: string;
  /** create 時のみ意味あり: false = review-pending で disabled. true = 即時 enabled. */
  enabled: boolean;
}

export const EMPTY_FORM: RuleForm = {
  id: "",
  description: "",
  trigger_type: "tick",
  tick_sec: "300",
  event_kind: "",
  cooldown_sec: "300",
  instructions: "",
  enabled: false,
};

export interface Rule {
  id: string;
  description: string | null;
  trigger_type: "tick" | "event";
  tick_sec: number | null;
  event_kind: string | null;
  conditions: any;
  instructions: string;
  target: string | null;
  cooldown_sec: number;
  last_fired_at: number | null;
  enabled: boolean;
  added_at: number;
  added_by: string;
  removed_at: number | null;
  removed_by: string | null;
  removed_reason: string | null;
}

export interface RuleLog {
  id: number;
  ts: number;
  rule_id: string | null;
  action: string;
  detail: string | null;
  actor: string;
}

export type FormMode = { kind: "create" } | { kind: "edit"; ruleId: string };
