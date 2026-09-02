import type {
  ChannelDirectory,
  ChannelDirectoryMetaKind,
  ChannelDirectoryQuestionRow,
} from "../api/sessions/deps.js";
import {
  parsePendingQuestionOptions,
  type DiscordConfigRepo,
  type DiscordPendingQuestionRow,
  type DiscordPendingQuestionsRepo,
  type DiscordSessionChannelsRepo,
} from "../db/discord-repo.js";

const META_CHANNEL_KINDS: ChannelDirectoryMetaKind[] = ["chitchat", "consultation", "houkoku", "system", "genius"];

export interface DiscordChannelDirectoryDeps {
  pendingQuestions: DiscordPendingQuestionsRepo;
  sessionChannels: DiscordSessionChannelsRepo;
  config: DiscordConfigRepo;
}

export function makeDiscordChannelDirectory(deps: DiscordChannelDirectoryDeps): ChannelDirectory {
  const toQuestion = (row: DiscordPendingQuestionRow | null): ChannelDirectoryQuestionRow | null => {
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      question: row.question,
      options: parsePendingQuestionOptions(row.options_json),
      answered_at: row.answered_at,
      ts: row.ts,
    };
  };

  return {
    findSessionChannel(sessionId) {
      const row = deps.sessionChannels.findBySessionId(sessionId);
      return row ? { channel_id: row.channel_id, status: row.status } : null;
    },
    listMetaChannels() {
      const cfg = deps.config.all();
      const meta: Record<ChannelDirectoryMetaKind, string | null> = {
        chitchat: null,
        consultation: null,
        houkoku: null,
        system: null,
        genius: null,
      };
      for (const kind of META_CHANNEL_KINDS) {
        meta[kind] = cfg[`${kind}_channel_id`] ?? null;
      }
      return meta;
    },
    insert(input) {
      return toQuestion(deps.pendingQuestions.insert(input))!;
    },
    findById(id) {
      return toQuestion(deps.pendingQuestions.findById(id));
    },
    findUnansweredByQuestion(sessionId, question) {
      return toQuestion(deps.pendingQuestions.findUnansweredByQuestion(sessionId, question));
    },
    findRecentlyAnsweredByQuestion(sessionId, question, sinceTs) {
      return toQuestion(deps.pendingQuestions.findRecentlyAnsweredByQuestion(sessionId, question, sinceTs));
    },
    markAnswered(id, answerIndex, answerText) {
      deps.pendingQuestions.markAnswered(id, answerIndex, answerText);
    },
    markAnsweredMulti(id, answerIndices, answerText) {
      deps.pendingQuestions.markAnsweredMulti(id, answerIndices, answerText);
    },
    markAnsweredOther(id, answerText) {
      deps.pendingQuestions.markAnsweredOther(id, answerText);
    },
    markResolvedLocally(id) {
      deps.pendingQuestions.markResolvedLocally(id);
    },
  };
}
