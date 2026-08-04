import {
  AccessoryWidgetBackground,
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
  ZStack,
  type ImageProps,
} from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  padding,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type Widget, type WidgetEnvironment } from "expo-widgets";
import { Platform } from "react-native";

import type {
  WidgetAgentCounts,
  WidgetInboxEntry,
  WidgetProjectEntry,
  WidgetWorktreeEntry,
} from "./widget-data";

// A function marked with the `'widget'` directive is stringified at build time
// and evaluated inside the widget extension, where only the `@expo/ui/swift-ui`
// exports exist as globals. It therefore cannot close over anything from this
// module — every constant, helper, and color literal lives inside the function
// body, and everything data-shaped arrives through props.
//
// The extension's child handling is also stricter than React's: it keeps only
// children that are element nodes and never flattens nested arrays, so a mapped
// list must be the sole child of its container or every row vanishes without a
// warning.

/** Props for the small "needs attention" widget. */
export interface AttentionWidgetProps {
  paired: boolean;
  attention: number;
  url: string;
}

/** Props for the medium/large agent-status widget. */
export interface AgentsWidgetProps extends WidgetAgentCounts {
  paired: boolean;
  updatedAt: number;
  url: string;
}

/** Props for the medium/large inbox widget. */
export interface InboxWidgetProps {
  paired: boolean;
  updatedAt: number;
  items: WidgetInboxEntry[];
  total: number;
  url: string;
}

/** Props for the medium/large project rollup widget. */
export interface ProjectsWidgetProps {
  paired: boolean;
  updatedAt: number;
  projects: WidgetProjectEntry[];
  url: string;
}

const attentionLayout = (props: Partial<AttentionWidgetProps>, environment: WidgetEnvironment) => {
  "widget";
  const unpaired = props.paired === false;
  const count = props.attention ?? 0;
  const tint = count > 0 ? "red" : "secondary";
  const label = count === 1 ? "agent waiting" : "agents waiting";
  const link = props.url ? [widgetURL(props.url)] : [];

  if (environment.widgetFamily === "accessoryInline") {
    return <Text modifiers={link}>{unpaired ? "Pragma — not paired" : `${count} ${label}`}</Text>;
  }

  if (environment.widgetFamily === "accessoryCircular") {
    return (
      <ZStack modifiers={link}>
        <AccessoryWidgetBackground />
        <VStack spacing={0}>
          <Image size={11} systemName="bell.badge.fill" />
          <Text modifiers={[font({ size: 18, weight: "bold", design: "rounded" })]}>
            {String(count)}
          </Text>
        </VStack>
      </ZStack>
    );
  }

  if (environment.widgetFamily === "accessoryRectangular") {
    return (
      <VStack alignment="leading" modifiers={link} spacing={0}>
        <Text modifiers={[font({ textStyle: "caption" })]}>PRAGMA</Text>
        <Text modifiers={[font({ size: 26, weight: "bold", design: "rounded" })]}>
          {String(count)}
        </Text>
        <Text modifiers={[font({ textStyle: "caption" })]}>{label}</Text>
      </VStack>
    );
  }

  // iOS renders a widget with no `containerBackground` on the system's own
  // gray backdrop. Paint it from `colorScheme` so the widget follows the system
  // appearance, and pin the text colors to match — the extension's default
  // label color does not follow the container we painted, so it stays white on
  // white in light mode.
  //
  // Two details keep light mode actually white. The test is `!== "dark"`, not
  // `=== "light"`: the extension builds `colorScheme` by interpolating a Swift
  // enum into a string, so anything unexpected must fall back to light rather
  // than paint a dark card on a light home screen. And both schemes use the
  // named `white`/`black` rather than a hex literal, because a color the native
  // side fails to decode drops the whole modifier and the gray backdrop returns.
  const light = environment.colorScheme !== "dark";
  const background = containerBackground(light ? "white" : "black", "widget");
  const muted = light ? "#6B6B72" : "#9C9CA4";
  // The count is the whole point of this widget: let it fill the card and lean
  // on `minimumScaleFactor` to shrink only once the digits run out of room.
  const countColor = count > 0 ? tint : light ? "#0B0B0C" : "#FFFFFF";

  return (
    <VStack alignment="center" modifiers={[...link, background, padding({ all: 2 })]} spacing={0}>
      <HStack spacing={0}>
        <Image color={tint} size={14} systemName="bell.badge.fill" />
        <Spacer />
      </HStack>
      <Text
        modifiers={[
          font({ size: 108, weight: "bold", design: "rounded" }),
          foregroundStyle(countColor),
          minimumScaleFactor(0.2),
          lineLimit(1),
          frame({ maxWidth: 1000, maxHeight: 1000 }),
        ]}
      >
        {unpaired ? "—" : String(count)}
      </Text>
      <Text
        modifiers={[
          font({ textStyle: "caption", weight: "medium" }),
          foregroundStyle(muted),
          lineLimit(2),
        ]}
      >
        {unpaired ? "Pair in the Pragma app" : "Needs attention"}
      </Text>
    </VStack>
  );
};

const agentsLayout = (props: Partial<AgentsWidgetProps>, environment: WidgetEnvironment) => {
  "widget";
  const unpaired = props.paired === false;
  const link = props.url ? [widgetURL(props.url)] : [];
  // See `attentionLayout`: without these the widget keeps the system's dark
  // legacy backdrop and light label color regardless of the home screen's
  // appearance.
  const light = environment.colorScheme !== "dark";
  const background = containerBackground(light ? "white" : "black", "widget");
  const muted = light ? "#6B6B72" : "#9C9CA4";
  const primary = light ? "#0B0B0C" : "#FFFFFF";

  const tile = (label: string, value: number, symbol: ImageProps["systemName"], color: string) => (
    <VStack alignment="center" key={label} spacing={0}>
      <HStack spacing={4}>
        <Image color={color} size={12} systemName={symbol} />
        <Text
          modifiers={[
            font({ textStyle: "caption", weight: "medium" }),
            foregroundStyle(muted),
            minimumScaleFactor(0.7),
            lineLimit(1),
          ]}
        >
          {label}
        </Text>
      </HStack>
      <Text
        modifiers={[
          font({ size: 84, weight: "bold", design: "rounded" }),
          foregroundStyle(primary),
          minimumScaleFactor(0.2),
          lineLimit(1),
          frame({ maxWidth: 1000, maxHeight: 1000 }),
        ]}
      >
        {unpaired ? "—" : String(value)}
      </Text>
    </VStack>
  );

  return (
    <VStack alignment="center" modifiers={[...link, background]} spacing={0}>
      <HStack modifiers={[frame({ maxWidth: 1000, maxHeight: 1000 })]} spacing={12}>
        {tile("Working", props.working ?? 0, "bolt.fill", "orange")}
        {tile("Attention", props.attention ?? 0, "bell.badge.fill", "red")}
        {tile("Done", props.done ?? 0, "checkmark.circle.fill", "green")}
      </HStack>
    </VStack>
  );
};

const inboxLayout = (props: Partial<InboxWidgetProps>, environment: WidgetEnvironment) => {
  "widget";
  const limit = environment.widgetFamily === "systemLarge" ? 4 : 2;
  const unpaired = props.paired === false;
  // The widget gallery renders the layout with no props at all, so `paired` is
  // undefined rather than false. Show representative rows there instead of the
  // empty state, which reads as a broken widget.
  const preview = props.paired === undefined;
  const sample: WidgetInboxEntry[] = [
    {
      id: "preview-1",
      kind: "command",
      symbol: "terminal.fill",
      agent: "claude",
      location: "pragma / mobile-widgets",
      prompt: "Run the widget snapshot tests?",
      url: "",
    },
    {
      id: "preview-2",
      kind: "question",
      symbol: "questionmark.circle.fill",
      agent: "opencode",
      location: "pragma / main",
      prompt: "Which package should own the shared constant?",
      url: "",
    },
    {
      id: "preview-3",
      kind: "command",
      symbol: "terminal.fill",
      agent: "codex",
      location: "pragma / gateway-cors",
      prompt: "Apply the migration to the local database?",
      url: "",
    },
    {
      id: "preview-4",
      kind: "question",
      symbol: "questionmark.circle.fill",
      agent: "cursor",
      location: "pragma / ssh-remote",
      prompt: "Keep the legacy socket path for one more release?",
      url: "",
    },
  ];
  const items = (preview ? sample : (props.items ?? [])).slice(0, limit);
  const total = preview ? 6 : (props.total ?? 0);
  const link = props.url ? [widgetURL(props.url)] : [];
  // See `attentionLayout`: without these the widget keeps the system's dark
  // legacy backdrop and light label color regardless of the home screen's
  // appearance.
  const light = environment.colorScheme !== "dark";
  const background = containerBackground(light ? "white" : "black", "widget");
  const primary = light ? "#0B0B0C" : "#FFFFFF";
  const muted = light ? "#6B6B72" : "#9C9CA4";
  const faint = light ? "#8E8E95" : "#78787F";

  // A `'widget'` function is stringified and evaluated in the extension, so it
  // cannot call anything defined outside its own body.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const row = (item: WidgetInboxEntry) => {
    const content = (
      <HStack alignment="top" spacing={6}>
        <Image color="red" size={12} systemName={item.symbol as ImageProps["systemName"]} />
        <VStack alignment="leading" spacing={1}>
          <Text
            modifiers={[
              font({ textStyle: "footnote", weight: "medium" }),
              foregroundStyle(primary),
              lineLimit(2),
            ]}
          >
            {item.prompt}
          </Text>
          <Text modifiers={[font({ textStyle: "caption2" }), foregroundStyle(muted), lineLimit(1)]}>
            {`${item.agent} · ${item.location}`}
          </Text>
        </VStack>
        <Spacer />
      </HStack>
    );
    // The preview rows carry no deep link, and an empty `Link` destination is
    // not a valid URL.
    if (!item.url) return <VStack key={item.id}>{content}</VStack>;
    return (
      <Link destination={item.url} key={item.id}>
        {content}
      </Link>
    );
  };

  return (
    <VStack alignment="leading" modifiers={[...link, background]} spacing={8}>
      <HStack spacing={6}>
        <Image color={muted} size={12} systemName="tray.full.fill" />
        <Text
          modifiers={[font({ textStyle: "caption", weight: "semibold" }), foregroundStyle(muted)]}
        >
          INBOX
        </Text>
        <Spacer />
        <Text modifiers={[font({ textStyle: "caption2" }), foregroundStyle(faint)]}>
          {unpaired ? "not paired" : String(total)}
        </Text>
      </HStack>
      {items.length === 0 ? (
        <VStack alignment="leading" spacing={2}>
          <Text
            modifiers={[
              font({ textStyle: "footnote", weight: "medium" }),
              foregroundStyle(primary),
            ]}
          >
            {unpaired ? "Not paired" : "Inbox zero"}
          </Text>
          <Text modifiers={[font({ textStyle: "caption2" }), foregroundStyle(muted), lineLimit(2)]}>
            {unpaired
              ? "Pair this device in the Pragma app."
              : "Approvals and questions land here."}
          </Text>
        </VStack>
      ) : (
        // The extension drops any child that is not a single element node, and
        // it does not flatten arrays: a bare `items.map(...)` sitting beside
        // other children arrives as one nested array and every row disappears.
        // Giving the array its own container makes it that container's sole
        // child, which the native side reads as a flat child list.
        <VStack alignment="leading" spacing={8}>
          {items.map((item) => row(item))}
        </VStack>
      )}
      <Spacer />
      {total > items.length ? (
        <Text modifiers={[font({ textStyle: "caption2" }), foregroundStyle(faint)]}>
          {`+${total - items.length} more`}
        </Text>
      ) : null}
    </VStack>
  );
};

const projectsLayout = (props: Partial<ProjectsWidgetProps>, environment: WidgetEnvironment) => {
  "widget";
  // A group costs one row for the project plus one per worktree, so the budget
  // is counted in rows rather than projects.
  const rowBudget = environment.widgetFamily === "systemLarge" ? 10 : 4;
  const unpaired = props.paired === false;
  // The widget gallery renders the layout with no props at all, so `paired` is
  // undefined rather than false. Show representative rows there instead of the
  // empty state, which reads as a broken widget.
  const preview = props.paired === undefined;
  const sample: WidgetProjectEntry[] = [
    {
      id: "preview-1",
      name: "pragma",
      color: "red",
      agents: 4,
      url: "",
      worktrees: [
        { id: "preview-1-1", name: "main", color: "green", depth: 0, agents: 1, url: "" },
        { id: "preview-1-2", name: "mobile-widgets", color: "red", depth: 0, agents: 2, url: "" },
        {
          id: "preview-1-3",
          name: "widget-preview",
          color: "orange",
          depth: 1,
          agents: 1,
          url: "",
        },
      ],
    },
    {
      id: "preview-2",
      name: "pragma-server",
      color: "orange",
      agents: 2,
      url: "",
      worktrees: [
        { id: "preview-2-1", name: "gateway-cors", color: "orange", depth: 0, agents: 2, url: "" },
      ],
    },
    {
      id: "preview-3",
      name: "constants",
      color: "green",
      agents: 1,
      url: "",
      worktrees: [
        { id: "preview-3-1", name: "main", color: "green", depth: 0, agents: 1, url: "" },
      ],
    },
  ];
  // Trim whole groups to the row budget, clipping the last group's worktrees
  // rather than dropping a project header with nothing under it.
  const groups: WidgetProjectEntry[] = [];
  let remaining = rowBudget;
  for (const project of preview ? sample : (props.projects ?? [])) {
    if (remaining < 2) break;
    const worktrees = project.worktrees.slice(0, remaining - 1);
    remaining -= worktrees.length + 1;
    groups.push({ ...project, worktrees });
  }
  const link = props.url ? [widgetURL(props.url)] : [];
  // See `attentionLayout`: without these the widget keeps the system's dark
  // legacy backdrop and light label color regardless of the home screen's
  // appearance.
  const light = environment.colorScheme !== "dark";
  const background = containerBackground(light ? "white" : "black", "widget");
  const primary = light ? "#0B0B0C" : "#FFFFFF";
  const muted = light ? "#6B6B72" : "#9C9CA4";
  const faint = light ? "#8E8E95" : "#78787F";

  // A `'widget'` function is stringified and evaluated in the extension, so it
  // cannot call anything defined outside its own body.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const projectRow = (project: WidgetProjectEntry) => {
    const content = (
      <HStack spacing={6}>
        <Image color={project.color} size={9} systemName="circle.fill" />
        <Text
          modifiers={[
            font({ textStyle: "footnote", weight: "semibold" }),
            foregroundStyle(primary),
            lineLimit(1),
          ]}
        >
          {project.name}
        </Text>
        <Spacer />
        <Text
          modifiers={[font({ textStyle: "caption2", design: "rounded" }), foregroundStyle(muted)]}
        >
          {String(project.agents)}
        </Text>
      </HStack>
    );
    // The preview rows carry no deep link, and an empty `Link` destination is
    // not a valid URL.
    if (!project.url) return <VStack>{content}</VStack>;
    return <Link destination={project.url}>{content}</Link>;
  };

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const worktreeRow = (worktree: WidgetWorktreeEntry) => {
    const content = (
      <HStack modifiers={[padding({ leading: 14 + worktree.depth * 12 })]} spacing={6}>
        <Image color={worktree.color} size={7} systemName="circle.fill" />
        <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle(muted), lineLimit(1)]}>
          {worktree.name}
        </Text>
        <Spacer />
        {/* An ancestor kept only for a live child hosts no agent of its own. */}
        {worktree.agents > 0 ? (
          <Text
            modifiers={[font({ textStyle: "caption2", design: "rounded" }), foregroundStyle(faint)]}
          >
            {String(worktree.agents)}
          </Text>
        ) : null}
      </HStack>
    );
    if (!worktree.url) return <VStack key={worktree.id}>{content}</VStack>;
    return (
      <Link destination={worktree.url} key={worktree.id}>
        {content}
      </Link>
    );
  };

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const group = (project: WidgetProjectEntry) => (
    <VStack alignment="leading" key={project.id} spacing={5}>
      {projectRow(project)}
      {/* See `inboxLayout`: a mapped array needs its own container. */}
      <VStack alignment="leading" spacing={5}>
        {project.worktrees.map((worktree) => worktreeRow(worktree))}
      </VStack>
    </VStack>
  );

  return (
    <VStack alignment="leading" modifiers={[...link, background]} spacing={7}>
      <HStack spacing={6}>
        <Image color={muted} size={12} systemName="folder.fill" />
        <Text
          modifiers={[font({ textStyle: "caption", weight: "semibold" }), foregroundStyle(muted)]}
        >
          ACTIVE WORKTREES
        </Text>
        <Spacer />
      </HStack>
      {groups.length === 0 ? (
        <Text
          modifiers={[
            font({ textStyle: "footnote" }),
            foregroundStyle(muted),
            frame({ minHeight: 20 }),
            lineLimit(2),
          ]}
        >
          {unpaired ? "Pair this device in the Pragma app." : "No agents running."}
        </Text>
      ) : (
        // See `inboxLayout`: a mapped array beside sibling children is dropped
        // by the extension, so it needs its own container.
        <VStack alignment="leading" spacing={7}>
          {groups.map((project) => group(project))}
        </VStack>
      )}
      <Spacer />
    </VStack>
  );
};

/** Every widget this app publishes, keyed by the name in the app config. */
export interface PragmaWidgets {
  attention: Widget<AttentionWidgetProps>;
  agents: Widget<AgentsWidgetProps>;
  inbox: Widget<InboxWidgetProps>;
  projects: Widget<ProjectsWidgetProps>;
}

let widgets: PragmaWidgets | null = null;

/**
 * The widget handles, created lazily on first use. Returns `null` off iOS,
 * where the config plugin does not generate a widget extension.
 */
export function pragmaWidgets(): PragmaWidgets | null {
  if (Platform.OS !== "ios") return null;
  widgets ??= {
    attention: createWidget<AttentionWidgetProps>("PragmaAttention", attentionLayout),
    agents: createWidget<AgentsWidgetProps>("PragmaAgents", agentsLayout),
    inbox: createWidget<InboxWidgetProps>("PragmaInbox", inboxLayout),
    projects: createWidget<ProjectsWidgetProps>("PragmaProjects", projectsLayout),
  };
  return widgets;
}
