import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Minimal, safe Markdown renderer for AI replies and Aurex's own documents (the legal pages). It
 * builds React elements (no innerHTML), so the text can never inject markup. Supports headings,
 * paragraphs, lists (one level of nesting), pipe tables, fenced code, blockquotes, inline code, bold,
 * italics and links. Links go out only to http(s) addresses; other targets are kept as plain text
 * unless `resolveLink` maps them to a page inside Aurex.
 */
type Resolve = ((href: string) => string | null) | undefined;

function inline(text: string, keyBase: string, resolve: Resolve): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\(([^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key, resolve)}</strong>);
    else if (m[3] || m[4]) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    else if (m[5]) {
      const label = tok.slice(1, tok.indexOf("]"));
      const href = m[6];
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>,
        );
      } else {
        const to = resolve?.(href);
        out.push(to && to.startsWith("/") && !to.startsWith("//") ? <Link key={key} to={to}>{label}</Link> : label);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^(\s*)[-*+]\s+/;
const NUMBER = /^(\s*)\d+[.)]\s+/;
const TABLE = /^\s*\|.*\|\s*$/;
const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function Markdown({ text, resolveLink, className }: { text: string; resolveLink?: (href: string) => string | null; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const span = (t: string, key: string) => inline(t, key, resolveLink);
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={k++}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 3);
      const Tag = (`h${level}` as "h1" | "h2" | "h3");
      blocks.push(<Tag key={k++}>{span(h[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }
    // A pipe table: header row, a --- separator row, then body rows.
    if (TABLE.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE.test(lines[i])) rows.push(cells(lines[i++]));
      const t = k++;
      blocks.push(
        <div key={t} className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{span(c, `th${t}-${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, j) => <td key={j}>{span(r[j] ?? "", `td${t}-${ri}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = NUMBER.test(line) && !BULLET.test(line);
      const marker = ordered ? NUMBER : BULLET;
      const base = (marker.exec(line)?.[1] ?? "").length;
      const items: { text: string; children: { text: string; ordered: boolean }[] }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const top = marker.exec(l);
        const sub = BULLET.exec(l) ?? NUMBER.exec(l);
        if (top && top[1].length <= base) items.push({ text: l.replace(marker, ""), children: [] });
        else if (sub && sub[1].length > base && items.length) {
          const bullet = BULLET.test(l);
          items[items.length - 1].children.push({ text: l.replace(bullet ? BULLET : NUMBER, ""), ordered: !bullet });
        }
        else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) {
          // A continuation line of the item above.
          const last = items[items.length - 1];
          if (last.children.length) last.children[last.children.length - 1].text += ` ${l.trim()}`;
          else last.text += ` ${l.trim()}`;
        } else break;
        i++;
      }
      const List = ordered ? "ol" : "ul";
      const t = k++;
      blocks.push(
        <List key={t}>
          {items.map((it, j) => {
            const Sub = it.children[0]?.ordered ? "ol" : "ul";
            return (
              <li key={j}>
                {span(it.text, `li${t}-${j}`)}
                {it.children.length > 0 && (
                  <Sub>
                    {it.children.map((c, ci) => (
                      <li key={ci}>{span(c.text, `li${t}-${j}-${ci}`)}</li>
                    ))}
                  </Sub>
                )}
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k++}>{span(quote.join(" "), `q${k}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !TABLE.test(lines[i])) para.push(lines[i++]);
    if (para.length === 0) para.push(lines[i++]); // never stall on an unrecognised line
    blocks.push(<p key={k++}>{span(para.join(" "), `p${k}`)}</p>);
  }
  return <div className={`md${className ? ` ${className}` : ""}`}>{blocks}</div>;
}
