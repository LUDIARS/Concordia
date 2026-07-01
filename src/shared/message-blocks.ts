/**
 * Discord/Slack 投稿用テキスト整形 (純粋・provider 非依存)。
 *
 * 課題: markdown テーブル (`| a | b |`) はプロポーショナルフォントの Discord/Slack で
 * 桁がズレて崩れる。 さらに長文を文字数上限で分割すると、 テーブル/コードブロックが
 * メッセージ境界で割れて完全に壊れる。
 *
 * 対処:
 *  - {@link wrapTablesInCode}: markdown テーブルブロックを ``` コードフェンスで囲み、
 *    等幅表示で桁を保つ。 既に ``` 内のテーブルは二重に囲まない。
 *  - {@link splitPreservingBlocks}: 上限で分割する際、 ``` フェンスブロックを
 *    **またいで割らない** (ブロックは丸ごと次メッセージへ)。 単体で上限を超える
 *    ブロックは行単位で割り、 各チャンクを再度 ``` で開閉する。
 *
 * SRP: テキスト → 整形済みテキスト / メッセージ配列 の純変換のみ。 送信は呼び出し側。
 */

const FENCE = "```";

/** `| a | b |` 形式のテーブル行か。 */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

/** `|---|:--:|` 形式のセパレータ行か (ダッシュ + パイプ主体)。 */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^\|?[\s:|-]+\|?$/.test(t);
}

/** ``` で始まる (言語指定含む) フェンス行か。 */
function isFence(line: string): boolean {
  return line.trim().startsWith(FENCE);
}

/**
 * markdown テーブルブロックを ``` で囲む。 既存の ``` フェンス内は触らない。
 * テーブル = ヘッダ行 + 直後のセパレータ行 + 連続するテーブル行。
 */
export function wrapTablesInCode(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    // テーブル開始: ヘッダ + セパレータ。 フェンス外のときだけ。
    if (!inFence && isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const block: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      out.push(FENCE, ...block, FENCE);
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** セグメント: ``` フェンスブロック (atomic) か、 それ以外の地のテキスト。 */
interface Segment {
  type: "code" | "text";
  content: string;
}

/** テキストを「フェンスブロック」「地のテキスト」のセグメント列に分ける。 */
function segment(text: string): Segment[] {
  const lines = text.split("\n");
  const segs: Segment[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flushText = () => {
    if (buf.length) segs.push({ type: "text", content: buf.join("\n") });
    buf = [];
  };
  let codeBuf: string[] = [];
  for (const line of lines) {
    if (isFence(line)) {
      if (!inFence) {
        flushText();
        inFence = true;
        codeBuf = [line];
      } else {
        codeBuf.push(line);
        segs.push({ type: "code", content: codeBuf.join("\n") });
        codeBuf = [];
        inFence = false;
      }
      continue;
    }
    if (inFence) codeBuf.push(line);
    else buf.push(line);
  }
  // 未閉フェンス: code 扱いで閉じる (壊れた入力でも落とさない)。
  if (inFence && codeBuf.length) segs.push({ type: "code", content: codeBuf.join("\n") + `\n${FENCE}` });
  flushText();
  return segs;
}

/** 1 本のフェンスブロックを maxLen 以内の複数フェンスへ行単位で割る。 */
function splitCodeBlock(block: string, maxLen: number): string[] {
  const lines = block.split("\n");
  // 先頭フェンス行 (言語指定保持) と末尾フェンスを除いた中身。
  const open = lines[0] && isFence(lines[0]) ? lines[0] : FENCE;
  const body = lines.slice(lines[0] && isFence(lines[0]) ? 1 : 0, isFence(lines[lines.length - 1]) ? -1 : undefined);
  const out: string[] = [];
  let cur: string[] = [];
  const wrap = (rows: string[]) => `${open}\n${rows.join("\n")}\n${FENCE}`;
  for (const row of body) {
    const trial = wrap([...cur, row]);
    if (cur.length && trial.length > maxLen) {
      out.push(wrap(cur));
      cur = [row];
    } else {
      cur.push(row);
    }
  }
  if (cur.length) out.push(wrap(cur));
  return out.length ? out : [block.slice(0, maxLen)];
}

/** 1 行が長すぎるとき maxLen 境界で素朴にハード分割する (稀)。 */
function hardSplit(line: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > maxLen) {
    out.push(rest.slice(0, maxLen));
    rest = rest.slice(maxLen);
  }
  if (rest.length) out.push(rest);
  return out;
}

/**
 * テキストを maxLen 以内のメッセージ配列へ分割する。 ``` フェンスブロックは
 * またいで割らず、 入らなければブロックごと次メッセージへ送る。
 */
export function splitPreservingBlocks(text: string, maxLen: number): string[] {
  const segs = segment(text);
  const msgs: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.replace(/\n+$/, "");
    if (t.length) msgs.push(t);
    cur = "";
  };
  const fits = (add: string) => (cur ? cur.length + 1 + add.length : add.length) <= maxLen;
  const append = (s: string) => {
    cur = cur ? `${cur}\n${s}` : s;
  };

  for (const seg of segs) {
    if (seg.type === "code") {
      if (fits(seg.content)) {
        append(seg.content);
      } else {
        flush();
        if (seg.content.length <= maxLen) {
          cur = seg.content;
        } else {
          for (const chunk of splitCodeBlock(seg.content, maxLen)) msgs.push(chunk);
        }
      }
    } else {
      for (const line of seg.content.split("\n")) {
        if (fits(line)) {
          append(line);
        } else {
          flush();
          if (line.length <= maxLen) {
            cur = line;
          } else {
            for (const piece of hardSplit(line, maxLen)) msgs.push(piece);
          }
        }
      }
    }
  }
  flush();
  return msgs.length ? msgs : [text.slice(0, maxLen)];
}

/**
 * 投稿前整形のワンショット: テーブルを ``` で囲んでから、 必要なら maxLen で
 * ブロック安全分割する。 1 メッセージに収まれば 1 要素配列を返す。
 */
export function formatForChunkedPost(text: string, maxLen: number): string[] {
  const wrapped = wrapTablesInCode(text);
  if (wrapped.length <= maxLen) return [wrapped];
  return splitPreservingBlocks(wrapped, maxLen);
}
