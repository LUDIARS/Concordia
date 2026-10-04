import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./chat-markdown.css";

const COMPONENTS: Components = {
  table: ({ children }) => (
    <div className="chat-markdown-table" role="region" aria-label="表（横スクロール可能）" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ src, alt, title }) => <img src={src} alt={alt ?? ""} title={title} loading="lazy" />,
};

/** GFM tables and code retain structure; raw HTML stays text and default safe URL handling is preserved. */
export function ChatMarkdown({ content }: { content: string }) {
  return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{content}</Markdown></div>;
}
