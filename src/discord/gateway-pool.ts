import {
  Client,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
} from "discord.js";

/**
 * 1 つの bot token に対する物理 Discord Gateway 接続の lease。
 *
 * logical runtime (本社 / 子会社) は同じ Client に guild-scoped listener を載せる。
 * release は冪等で、最後の runtime が離れたときだけ Client を破棄する。
 */
export interface DiscordGatewayLease {
  readonly client: Client;
  login(): Promise<void>;
  release(): Promise<void>;
}

interface GatewayEntry {
  client: Client;
  refs: number;
  loginPromise: Promise<void> | null;
}

export type DiscordClientFactory = (options: ClientOptions) => Client;

const CLIENT_OPTIONS: ClientOptions = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  // 共有 Client では guild ごとに default を変えられない。安全側の無通知を共通既定にし、
  // 明示的な通知だけ各 send payload の allowedMentions で許可する。
  allowedMentions: { parse: [] },
};

/** token 単位で物理 Client を共有する、プロセス内の小さな connection pool。 */
export class DiscordGatewayPool {
  private readonly entries = new Map<string, GatewayEntry>();

  constructor(private readonly createClient: DiscordClientFactory = (options) => new Client(options)) {}

  acquire(token: string): DiscordGatewayLease {
    let entry = this.entries.get(token);
    if (!entry) {
      const client = this.createClient(CLIENT_OPTIONS);
      // logical runtime ごとに guild-scoped listener を持つため、子会社数は 10 を超え得る。
      // EventEmitter の既定警告を避けるだけで、listener は lease release 時に必ず外す。
      client.setMaxListeners(0);
      entry = { client, refs: 0, loginPromise: null };
      this.entries.set(token, entry);
    }
    entry.refs += 1;
    let released = false;

    return {
      client: entry.client,
      login: async () => {
        if (released) throw new Error("Discord gateway lease already released");
        if (!entry!.loginPromise) {
          const pending = entry!.client.login(token).then(() => undefined);
          entry!.loginPromise = pending.catch((error) => {
            entry!.loginPromise = null;
            throw error;
          });
        }
        await entry!.loginPromise;
      },
      release: async () => {
        if (released) return;
        released = true;
        entry!.refs = Math.max(0, entry!.refs - 1);
        if (entry!.refs > 0) return;
        if (this.entries.get(token) === entry) this.entries.delete(token);
        entry!.client.destroy();
      },
    };
  }

  /** 診断 / 単体テスト用。token 自体は外へ出さない。 */
  connectionCount(): number {
    return this.entries.size;
  }
}
