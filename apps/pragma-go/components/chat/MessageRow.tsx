import { Text as NativeText, useColorScheme, View } from "react-native";
import { Renderer, useMarkdown, type MarkedStyles } from "react-native-marked";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-typescript";

import { Text } from "@/components/ui/text";
import { useThemeColors } from "@/lib/theme";
import type { TranscriptRow } from "@/lib/types";

type SyntaxToken = { type: string; content: string | SyntaxToken[] };
type SyntaxEngine = {
  languages: Record<string, unknown>;
  tokenize(text: string, grammar: unknown): Array<string | SyntaxToken>;
};

const syntax = Prism as unknown as SyntaxEngine;

/** One transcript row: threaded message bubble, or a muted activity line. */
export function MessageRow({ row }: { row: TranscriptRow }) {
  if (row.kind === "event") {
    return row.tool ? <ToolLine tool={row.tool} /> : <EventLine text={row.text} />;
  }
  return <ChatMessage row={row} />;
}

function ChatMessage({ row }: { row: Exclude<TranscriptRow, { kind: "event" }> }) {
  if (row.role === "system" || row.role === "tool") return <MutedMessage text={row.text} />;
  return <MessageBubble isUser={row.role === "user"} text={row.text} />;
}

function MutedMessage({ text }: { text: string }) {
  return (
    <View className="items-center px-6 py-1.5">
      <Text className="text-center text-xs text-muted-foreground">{text}</Text>
    </View>
  );
}

function MessageBubble({ isUser, text }: { isUser: boolean; text: string }) {
  const alignment = isUser ? "items-end" : "items-start";
  const bubble = isUser
    ? "rounded-2xl rounded-br-sm bg-primary"
    : "rounded-2xl rounded-bl-sm bg-secondary";
  return (
    <View className={`px-4 py-1.5 ${alignment}`}>
      <View className={`max-w-[82%] px-4 py-2.5 ${bubble}`}>
        <MessageMarkdown isUser={isUser}>{text}</MessageMarkdown>
      </View>
    </View>
  );
}

const markdownStyles: MarkedStyles = {
  text: { fontSize: 16, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  h1: { fontSize: 24, lineHeight: 30, marginBottom: 8 },
  h2: { fontSize: 21, lineHeight: 27, marginBottom: 8 },
  h3: { fontSize: 18, lineHeight: 24, marginBottom: 6 },
  code: { borderRadius: 6, padding: 10 },
  codespan: { fontFamily: "monospace" },
};

/** Renders message markdown, reparsing safely as streamed text grows. */
function MessageMarkdown({ children, isUser }: { children: string; isUser: boolean }) {
  const colorScheme = useColorScheme();
  // A user bubble paints `bg-primary`, so its text is the theme's own
  // `primary-foreground` rather than a hard-coded near-black/near-white.
  const userForeground = useThemeColors().primaryForeground;
  const renderer = new CodeHighlightingRenderer(colorScheme === "dark");
  const elements = useMarkdown(children, {
    colorScheme,
    renderer,
    styles: markdownStyles,
    theme: messageTheme(isUser, colorScheme === "dark", userForeground),
  });

  return <View>{elements}</View>;
}

function messageTheme(isUser: boolean, isDark: boolean, foreground: string) {
  if (!isUser) return undefined;
  return { colors: { text: foreground, ...messageColors[isDark ? "dark" : "light"] } };
}

const messageColors = {
  dark: { link: "#1d4ed8", code: "#e4e4e7", border: "#71717a" },
  light: { link: "#93c5fd", code: "#27272a", border: "#a1a1aa" },
};

/** Adds language-aware highlighting to fenced Markdown code blocks. */
class CodeHighlightingRenderer extends Renderer {
  constructor(private readonly isDark: boolean) {
    super();
  }

  override code(text: string, language?: string) {
    const grammar = syntax.languages[codeLanguage(language)];
    const colors = codeColors(this.isDark);
    const content = grammar ? renderTokens(syntax.tokenize(text, grammar), this.isDark) : text;
    return <CodeBlock colors={colors} content={content} key={this.getKey()} />;
  }
}

function CodeBlock({
  colors,
  content,
}: {
  colors: { backgroundColor: string; color: string };
  content: React.ReactNode;
}) {
  return (
    <View
      className="mb-2 overflow-hidden rounded-md border border-border"
      style={{ backgroundColor: colors.backgroundColor }}
    >
      <NativeText
        selectable
        style={{
          backgroundColor: colors.backgroundColor,
          color: colors.color,
          fontFamily: "monospace",
          fontSize: 13,
          lineHeight: 19,
          padding: 10,
        }}
      >
        {content}
      </NativeText>
    </View>
  );
}

function codeLanguage(language: string | undefined): string {
  const normalized = language?.trim().toLowerCase();
  return (
    ({ ts: "typescript", js: "javascript", sh: "bash", shell: "bash", py: "python" }[
      normalized ?? ""
    ] ??
      normalized) ||
    "plaintext"
  );
}

function codeColors(isDark: boolean) {
  return isDark
    ? { backgroundColor: "#18181b", color: "#abb2bf" }
    : { backgroundColor: "#e5e7eb", color: "#24292f" };
}

function renderTokens(tokens: Array<string | SyntaxToken>, isDark: boolean): React.ReactNode[] {
  return tokens.map((token, index) => {
    if (typeof token === "string") return token;
    return (
      <NativeText key={index} style={{ color: tokenColor(token.type, isDark) }}>
        {typeof token.content === "string" ? token.content : renderTokens(token.content, isDark)}
      </NativeText>
    );
  });
}

function tokenColor(type: string, isDark: boolean): string {
  const darkColors: Record<string, string> = {
    comment: "#5c6370",
    function: "#61afef",
    keyword: "#c678dd",
    number: "#d19a66",
    operator: "#56b6c2",
    property: "#e06c75",
    punctuation: "#abb2bf",
    string: "#98c379",
  };
  const lightColors: Record<string, string> = {
    comment: "#6a737d",
    function: "#005cc5",
    keyword: "#d73a49",
    number: "#005cc5",
    operator: "#d73a49",
    property: "#005cc5",
    punctuation: "#24292f",
    string: "#032f62",
  };
  return (isDark ? darkColors : lightColors)[type] ?? (isDark ? "#abb2bf" : "#24292f");
}

/** A gray secondary line: file edit or spawned sub-agents. */
function EventLine({ text }: { text: string }) {
  return (
    <View className="px-4 py-0.5">
      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

/**
 * Tool-call activity: name + status chip, with an optional human summary on a
 * second line. Avoids dumping raw JSON args into the chat.
 */
function ToolLine({
  tool,
}: {
  tool: NonNullable<Extract<TranscriptRow, { kind: "event" }>["tool"]>;
}) {
  const statusClass =
    tool.status === "error"
      ? "text-destructive"
      : tool.status === "done"
        ? "text-muted-foreground"
        : "text-warning-foreground";
  return (
    <View className="gap-0.5 px-4 py-1">
      <View className="flex-row items-center gap-2">
        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
          {tool.name}
        </Text>
        <Text className={`text-xs uppercase ${statusClass}`}>{tool.status}</Text>
      </View>
      {tool.summary ? (
        <Text className="font-mono text-xs text-muted-foreground" numberOfLines={3}>
          {tool.summary}
        </Text>
      ) : null}
    </View>
  );
}
