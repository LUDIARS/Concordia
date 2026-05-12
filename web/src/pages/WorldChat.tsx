/**
 * WorldChat — spatial chat (実験 UI).
 *
 * - active session が member sprite として 2D 空間に配置される
 * - chat.posted (chitchat / world scope) が member 位置から自分 (画面中央) に向けて
 *   バルーンとして飛ぶ
 * - バルーンを click/tap で掴む → 自分の周囲に滞留 / 離すと返信 composer
 * - 掴まれず通り過ぎたバルーンは減衰して止まる (移動して回収可)
 * - WASD / 矢印キー / canvas drag で camera 移動 (= 自分の位置を世界に対して動かす)
 * - 投稿は scope 選択: world (全員に届く) / local (自分の周囲のみ)
 * - spatial state はローカル (other client と同期しない)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import type { SessionRow, ChatMessage } from "../api.js";
import { useWsEvent } from "../hooks/useWsEvent.js";
import { wsClient } from "../lib/ws-client.js";

// ─── world parameters ──────────────────────────────────────

const MEMBER_RING_RADIUS = 480;        // 自分から member への距離
const BALLOON_INITIAL_SPEED = 280;     // px/sec
const BALLOON_ACCEL = 30;              // 自分に向けた追加加速
const BALLOON_DECAY = 0.985;           // 自分通過後の減衰
const BALLOON_PASS_THRESHOLD = 60;     // この距離以内に来たら "通過" 扱いを開始
const BALLOON_LIFETIME_SEC = 60;       // 60 秒経過で自動消失
const GRAB_RADIUS = 80;                // 自分から GRAB_RADIUS 内のバルーンしか掴めない
const ORBIT_RADIUS = 100;              // 掴んだバルーンが滞留する距離
const PLAYER_MOVE_SPEED = 360;         // px/sec (キー操作)
const VIEW_DRAG_FRICTION = 0.1;

// ─── types ─────────────────────────────────────────────────

interface Vec {
  x: number;
  y: number;
}

interface Balloon {
  id: number;             // chat message id
  text: string;
  author_label: string;
  channel: string;
  scope: "world" | "local";
  ts: number;
  pos: Vec;               // world coordinates
  vel: Vec;
  grabbed: boolean;
  passed: boolean;        // 自分を一度通過した
  bornAt: number;         // performance.now()
  orbitAngle: number;     // grabbed 中の orbit
}

// ─── helpers ───────────────────────────────────────────────

/** session_id を deterministic に member の角度に hash する. */
function hashAngle(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ((h % 360) / 360) * Math.PI * 2;
}

function memberPosition(session: SessionRow): Vec {
  const a = hashAngle(session.id);
  return {
    x: Math.cos(a) * MEMBER_RING_RADIUS,
    y: Math.sin(a) * MEMBER_RING_RADIUS,
  };
}

function dist(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── main component ────────────────────────────────────────

export function WorldChat() {
  const [members, setMembers] = useState<SessionRow[]>([]);
  const [balloons, setBalloons] = useState<Balloon[]>([]);
  const balloonsRef = useRef<Balloon[]>([]);
  balloonsRef.current = balloons;

  // 自分自身のセッション (POSTする時の session_id 用)
  const [self, setSelf] = useState<{ id: string | null; role: string }>({
    id: null,
    role: "human",
  });

  // 自分の世界座標 (camera は player を中央表示する).
  const playerRef = useRef<Vec>({ x: 0, y: 0 });
  const [, forceRender] = useState(0);

  // 入力状態 (WASD / 矢印)
  const keysRef = useRef<Set<string>>(new Set());

  // 返信 composer
  const [composer, setComposer] = useState<{ text: string; scope: "world" | "local"; replyTo: Balloon | null } | null>(null);

  // 初回 + イベントで member 一覧を取得
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void api.monitor().then((m) => {
        if (cancelled) return;
        setMembers(m.active);
      });
    };
    refresh();
    const off = wsClient.onMessage((ev) => {
      if (
        ev.type === "session.started" ||
        ev.type === "session.ended" ||
        ev.type === "session.lost" ||
        ev.type === "session.event" ||
        ev.type === "persona.assigned" ||
        ev.type === "persona.released"
      ) {
        refresh();
      }
    });
    return () => { cancelled = true; off(); };
  }, []);

  // 過去 50 件の chitchat を 一気にバルーン化はしない (うるさいので).
  // 起動時は静か → 新着のみバルーンで降ってくる.

  // self 推定: ws 経路では取れないので /v1/monitor の最後の active session を仮 self にしておく.
  // 完全に正確に取りたければ skill 側で session_id を expose する必要がある.
  useEffect(() => {
    if (!self.id && members.length > 0) {
      // 他の host とのまぜこぜを避けるため、一番最近 last_seen された host=自分 の session を 仮 self に.
      const hostMatch = members.find((m) => m.host === window.location.hostname);
      const fallback = members[0];
      const pick = hostMatch ?? fallback;
      const role = (pick.metadata as any)?.role_label ?? "human";
      setSelf({ id: pick.id, role });
    }
  }, [members, self.id]);

  // WS chat.posted で バルーン spawn
  useWsEvent("chat.posted", (ev) => {
    if (ev.type !== "chat.posted") return;
    if (ev.scope === "local") return; // 他人の local は届かない
    if (ev.channel !== "chitchat" && ev.channel !== "world") return;
    // 詳細を fetch して text を取る
    void api.chatList(ev.channel, 1).then((res) => {
      const m = res.messages.find((x) => x.id === ev.message_id);
      if (!m) return;
      spawnBalloonFromMessage(m);
    });
  });

  function spawnBalloonFromMessage(m: ChatMessage) {
    // 自分の発言なら balloon にしない (echo 抑制)
    if (m.session_id && m.session_id === self.id) return;
    const speaker = m.session_id ? members.find((s) => s.id === m.session_id) : null;
    const origin = speaker
      ? memberPosition(speaker)
      : { x: 0, y: -MEMBER_RING_RADIUS - 40 }; // human / unknown は 北側から
    const player = playerRef.current;
    const dx = player.x - origin.x;
    const dy = player.y - origin.y;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const speed = BALLOON_INITIAL_SPEED;
    const scopeMeta = (m.metadata as any)?.scope;
    const scope: "world" | "local" = scopeMeta === "local" ? "local" : "world";
    const balloon: Balloon = {
      id: m.id,
      text: m.text,
      author_label: m.author_label,
      channel: m.channel,
      scope,
      ts: m.ts,
      pos: { ...origin },
      vel: { x: (dx / len) * speed, y: (dy / len) * speed },
      grabbed: false,
      passed: false,
      bornAt: performance.now(),
      orbitAngle: Math.random() * Math.PI * 2,
    };
    setBalloons((prev) => [...prev, balloon]);
  }

  // 物理 + camera loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // player 移動 (キー)
      const k = keysRef.current;
      let mx = 0, my = 0;
      if (k.has("w") || k.has("arrowup"))    my -= 1;
      if (k.has("s") || k.has("arrowdown"))  my += 1;
      if (k.has("a") || k.has("arrowleft"))  mx -= 1;
      if (k.has("d") || k.has("arrowright")) mx += 1;
      if (mx || my) {
        const len = Math.sqrt(mx * mx + my * my);
        playerRef.current.x += (mx / len) * PLAYER_MOVE_SPEED * dt;
        playerRef.current.y += (my / len) * PLAYER_MOVE_SPEED * dt;
      }

      // balloon 物理
      const player = playerRef.current;
      const nowSec = now / 1000;
      const next: Balloon[] = [];
      for (const b of balloonsRef.current) {
        if ((now - b.bornAt) / 1000 > BALLOON_LIFETIME_SEC) continue; // 寿命切れ
        if (b.grabbed) {
          // 自分の周囲を orbit
          b.orbitAngle += 0.6 * dt;
          b.pos.x = player.x + Math.cos(b.orbitAngle) * ORBIT_RADIUS;
          b.pos.y = player.y + Math.sin(b.orbitAngle) * ORBIT_RADIUS;
        } else {
          // 自分に向けた追加加速 (passed=false の間)
          const d = dist(b.pos, player);
          if (!b.passed && d < BALLOON_PASS_THRESHOLD) {
            b.passed = true;
          }
          if (!b.passed) {
            const dx = player.x - b.pos.x;
            const dy = player.y - b.pos.y;
            const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            b.vel.x += (dx / len) * BALLOON_ACCEL * dt;
            b.vel.y += (dy / len) * BALLOON_ACCEL * dt;
          } else {
            // passed: 慣性で進んで減衰
            b.vel.x *= Math.pow(BALLOON_DECAY, dt * 60);
            b.vel.y *= Math.pow(BALLOON_DECAY, dt * 60);
          }
          b.pos.x += b.vel.x * dt;
          b.pos.y += b.vel.y * dt;
        }
        next.push(b);
        // suppress unused
        void nowSec;
      }
      setBalloons(next);
      forceRender((v) => v + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // キー入力
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (composer) return; // composer 中はキー操作を移動に使わない
      keysRef.current.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [composer]);

  // バルーン click ハンドラ
  const onBalloonClick = (id: number) => {
    setBalloons((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        if (b.grabbed) {
          // 離す → composer
          setComposer({ text: "", scope: "world", replyTo: b });
          return { ...b, grabbed: false };
        } else {
          // 掴む条件: 自分との距離が GRAB_RADIUS 以内
          if (dist(b.pos, playerRef.current) > GRAB_RADIUS && !b.passed) return b; // 遠い飛んでるバルーンは掴めない
          return { ...b, grabbed: true, vel: { x: 0, y: 0 } };
        }
      }),
    );
  };

  const submitComposer = async () => {
    if (!composer || !composer.text.trim()) return;
    try {
      await api.chatPost({
        channel: "chitchat",
        text: composer.text.trim(),
        author_label: self.role,
        session_id: self.id,
        scope: composer.scope,
        in_reply_to: composer.replyTo?.id ?? null,
      });
    } catch {
      /* swallow */
    }
    if (composer.replyTo) {
      // 返信した balloon は消す
      setBalloons((prev) => prev.filter((b) => b.id !== composer.replyTo!.id));
    }
    setComposer(null);
  };

  // ─── render ──────────────────────────────────────────────

  return (
    <div className="relative w-full h-[calc(100vh-9rem)] bg-bg overflow-hidden rounded border border-border select-none">
      <Hud
        memberCount={members.length}
        balloonCount={balloons.length}
        selfRole={self.role}
        onRecenter={() => { playerRef.current = { x: 0, y: 0 }; forceRender((v) => v + 1); }}
      />
      <World
        members={members}
        balloons={balloons}
        playerPos={playerRef.current}
        selfRole={self.role}
        onBalloonClick={onBalloonClick}
      />
      {composer && (
        <Composer
          state={composer}
          onChange={(c) => setComposer(c)}
          onSubmit={() => void submitComposer()}
          onCancel={() => setComposer(null)}
        />
      )}
    </div>
  );
}

// ─── HUD ─────────────────────────────────────────────────

function Hud({
  memberCount, balloonCount, selfRole, onRecenter,
}: { memberCount: number; balloonCount: number; selfRole: string; onRecenter: () => void }) {
  return (
    <div className="absolute top-3 left-3 right-3 flex items-center gap-3 text-xs z-10">
      <div className="bg-surface/80 backdrop-blur border border-border rounded px-2 py-1">
        <span className="text-subtle">role</span> <span className="text-accent">{selfRole}</span>
      </div>
      <div className="bg-surface/80 backdrop-blur border border-border rounded px-2 py-1">
        <span className="text-subtle">members</span> <span className="text-text">{memberCount}</span>
        <span className="text-subtle ml-2">balloons</span> <span className="text-text">{balloonCount}</span>
      </div>
      <button
        onClick={onRecenter}
        className="bg-surface/80 backdrop-blur border border-border rounded px-2 py-1 text-subtle hover:text-accent"
      >
        recenter
      </button>
      <span className="ml-auto text-subtle bg-surface/80 backdrop-blur border border-border rounded px-2 py-1">
        WASD / ↑↓←→ で移動 · バルーンを click で掴む / 再 click で返信
      </span>
    </div>
  );
}

// ─── world rendering (camera centered on player) ───────────

function World({
  members, balloons, playerPos, selfRole, onBalloonClick,
}: {
  members: SessionRow[];
  balloons: Balloon[];
  playerPos: Vec;
  selfRole: string;
  onBalloonClick: (id: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 画面中央に player を表示するための変換
  const transform = useMemo(() => {
    return `translate(calc(50% - ${playerPos.x}px), calc(50% - ${playerPos.y}px))`;
  }, [playerPos.x, playerPos.y]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{
        backgroundImage:
          "radial-gradient(circle at center, rgba(255,255,255,0.04) 1px, transparent 1px)",
        backgroundSize: "32px 32px",
      }}
    >
      {/* world layer */}
      <div className="absolute inset-0" style={{ transform }}>
        {/* グリッド原点マーク */}
        <div
          className="absolute w-2 h-2 rounded-full bg-subtle/40"
          style={{ left: "-4px", top: "-4px" }}
        />
        {/* members */}
        {members.map((m) => {
          const p = memberPosition(m);
          return <MemberSprite key={m.id} session={m} pos={p} />;
        })}
        {/* balloons */}
        {balloons.map((b) => (
          <BalloonSprite key={b.id} balloon={b} onClick={() => onBalloonClick(b.id)} />
        ))}
      </div>

      {/* player 中央. world layer に対する相対だが画面中央 = self なので別 layer */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
        <div className="flex flex-col items-center">
          <div className="w-14 h-14 rounded-full bg-accent/30 border-2 border-accent flex items-center justify-center text-lg">
            👤
          </div>
          <div className="mt-1 text-[11px] text-accent font-medium">{selfRole}</div>
          <div className="mt-0.5 text-[10px] text-subtle">you</div>
        </div>
      </div>
    </div>
  );
}

function MemberSprite({ session, pos }: { session: SessionRow; pos: Vec }) {
  const role = (session.metadata as any)?.role_label ?? "雑用係";
  return (
    <div
      className="absolute flex flex-col items-center"
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        transform: "translate(-50%, -50%)",
      }}
    >
      <div className="w-12 h-12 rounded-full bg-surface border-2 border-subtle flex items-center justify-center text-base">
        🧵
      </div>
      <div className="mt-1 text-[11px] text-text">{role}</div>
      <div className="text-[9px] text-subtle font-mono">{session.id.slice(0, 6)}</div>
    </div>
  );
}

function BalloonSprite({ balloon, onClick }: { balloon: Balloon; onClick: () => void }) {
  const isLocal = balloon.scope === "local";
  return (
    <button
      onClick={onClick}
      className={
        "absolute pointer-events-auto text-left transition-shadow " +
        (balloon.grabbed
          ? "z-20 shadow-lg shadow-accent/40"
          : "z-10 hover:shadow-md hover:shadow-accent/30")
      }
      style={{
        left: `${balloon.pos.x}px`,
        top: `${balloon.pos.y}px`,
        transform: "translate(-50%, -50%)",
        maxWidth: 240,
      }}
    >
      <div
        className={
          "rounded-2xl px-3 py-2 text-xs whitespace-pre-wrap leading-snug border " +
          (balloon.grabbed
            ? "bg-accent/20 border-accent text-text"
            : isLocal
              ? "bg-warn/15 border-warn/60 text-text"
              : "bg-surface border-border text-text")
        }
      >
        <div className="text-[10px] text-subtle mb-1 flex items-center gap-1">
          <span className="text-accent">{balloon.author_label}</span>
          {isLocal && <span className="text-warn">·local</span>}
        </div>
        <div>{balloon.text}</div>
      </div>
    </button>
  );
}

// ─── reply composer ───────────────────────────────────────

function Composer({
  state, onChange, onSubmit, onCancel,
}: {
  state: { text: string; scope: "world" | "local"; replyTo: Balloon | null };
  onChange: (s: { text: string; scope: "world" | "local"; replyTo: Balloon | null }) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="absolute inset-0 z-30 flex items-end justify-center pb-8 bg-black/30 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-lg p-4 w-full max-w-xl mx-4 shadow-xl">
        {state.replyTo && (
          <div className="text-[11px] text-subtle mb-2 border-l-2 border-subtle pl-2 line-clamp-2">
            ↳ {state.replyTo.author_label}: {state.replyTo.text}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={state.text}
          onChange={(e) => onChange({ ...state, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
            if (e.key === "Escape") onCancel();
          }}
          placeholder="返信を書く… (Enter で送信、 Shift+Enter で改行)"
          className="w-full bg-muted border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent min-h-[80px] resize-none"
        />
        <div className="mt-3 flex items-center gap-3">
          <div className="flex gap-1 text-xs">
            {(["world", "local"] as const).map((s) => (
              <button
                key={s}
                onClick={() => onChange({ ...state, scope: s })}
                className={
                  "px-2 py-1 rounded border " +
                  (state.scope === s
                    ? s === "world"
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-warn/20 border-warn text-warn"
                    : "border-border text-subtle hover:text-text")
                }
              >
                {s === "world" ? "🌐 world" : "📍 local"}
              </button>
            ))}
          </div>
          <span className="text-subtle text-[11px]">
            {state.scope === "world"
              ? "全員に届く"
              : "自分の周囲に残る (他 client には飛ばない)"}
          </span>
          <div className="ml-auto flex gap-2">
            <button onClick={onCancel} className="text-subtle text-sm hover:text-text">cancel</button>
            <button
              onClick={onSubmit}
              disabled={!state.text.trim()}
              className="px-3 py-1 bg-accent/30 border border-accent rounded text-sm disabled:opacity-50"
            >
              send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

