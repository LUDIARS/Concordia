import { describe, expect, it } from 'vitest';
import { commandText, isAllowedFetchLinkCommand } from './consult-fetch-link-command.mjs';

const script = 'E:/Document/Consult/_source/tools/fetch-link/fetch-link.mjs';
const url = 'https://docs.google.com/spreadsheets/d/1AbcDEF_ghij-KLMN/edit?usp=sharing&gid=0#gid=0';

describe('consult fetch-link command', () => {
  it('取得スクリプトを URL 1 つで呼ぶ形だけを許す (引用・区切り・大小文字の違いを吸収)', () => {
    expect(isAllowedFetchLinkCommand(`node ${script} '${url}'`, script)).toBe(true);
    expect(isAllowedFetchLinkCommand(`node "${script}" "${url}"`, script)).toBe(true);
    // PowerShell で書く Windows 区切りのパスも同じスクリプトとして受ける (パスの一致で縛っているので抜け道にならない)。
    expect(isAllowedFetchLinkCommand(`node.exe E:\\Document\\Consult\\_source\\tools\\fetch-link\\fetch-link.mjs 'https://www.notion.so/x-0123'`, script)).toBe(true);
    expect(isAllowedFetchLinkCommand(`node "e:\\document\\consult\\_source\\tools\\fetch-link\\fetch-link.mjs" 'https://www.notion.so/x-0123'`, script)).toBe(true);
    expect(isAllowedFetchLinkCommand(`node ${script} https://www.notion.so/Page-0123?pvs=4`, script)).toBe(true);
  });

  it('codex がシェルで包んだ配列の形も中身で判定する', () => {
    expect(commandText(['powershell.exe', '-Command', `node ${script} '${url}'`])).toBe(`node ${script} '${url}'`);
    expect(isAllowedFetchLinkCommand(['bash', '-lc', `node ${script} '${url}'`], script)).toBe(true);
    expect(isAllowedFetchLinkCommand(['node', script, 'https://www.notion.so/a-0123'], script)).toBe(true);
    expect(isAllowedFetchLinkCommand(['powershell.exe', '-Command'], script)).toBe(false);
  });

  it('ほかのコマンド・つなげたコマンド・展開・別のスクリプトは許さない', () => {
    for (const bad of [
      'cat E:/Document/Consult/engineer/AGENTS.md',
      `node ${script} '${url}'; cat secret.txt`,
      `node ${script} '${url}' && whoami`,
      `node ${script} '${url}' | tee out.txt`,
      `node ${script} '${url}' > out.txt`,
      `node ${script} https://x.example/$(whoami)`,
      `node ${script} "https://x.example/$HOME"`,
      `node ${script} "https://x.example/\`whoami\`"`,
      `node ${script} https://x.example/a&whoami`,
      `node ${script} '${url}' 'https://second.example'`,
      `node ${script} 'file:///C:/Users/secret.txt'`,
      `node ${script} 'C:/Users/secret.txt'`,
      `node ${script}`,
      `node E:/Document/Consult/other.mjs '${url}'`,
      `node -e "require('fs')" '${url}'`,
      `node ${script} '${url}'\nwhoami`,
    ]) {
      expect(isAllowedFetchLinkCommand(bad, script), bad).toBe(false);
    }
  });

  it('スクリプトのパスが渡されていなければ何も許さない', () => {
    expect(isAllowedFetchLinkCommand(`node ${script} '${url}'`, undefined)).toBe(false);
    expect(isAllowedFetchLinkCommand(`node ${script} '${url}'`, '')).toBe(false);
  });
});
