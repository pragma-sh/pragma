import { type ReactNode, useState } from "react";

import { type Editor, useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  type LucideIcon,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** One formatting action in the markdown toolbar. */
function ToolbarButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      aria-pressed={active}
      className={cn("size-6", active && "bg-muted text-foreground")}
      disabled={disabled}
      label={label}
      // Keep the editor's selection: a toolbar click must not blur the surface.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      size="icon-sm"
      variant="ghost"
    >
      {children}
    </IconButton>
  );
}

function ToolbarDivider() {
  return <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />;
}

/** Link popover: set (with an URL input) or clear the link mark on the selection. */
function LinkControl({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");

  const apply = () => {
    const url = href.trim();
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setOpen(false);
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setHref(editor.getAttributes("link").href ?? "");
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <IconButton
          aria-pressed={active}
          className={cn("size-6", active && "bg-muted text-foreground")}
          label="Link"
          size="icon-sm"
          variant="ghost"
        >
          <LinkIcon className="size-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          {/* Radix focuses the popover's first focusable element on open. */}
          <Input
            className="h-7 flex-1 text-xs"
            onChange={(event) => setHref(event.target.value)}
            placeholder="https://…"
            value={href}
          />
          <Button className="h-7" size="sm" type="submit" variant="secondary">
            {href.trim() ? "Set" : "Clear"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Table dropdown: insert, and row/column/table operations while inside one. */
function TableControl({ editor, inTable }: { editor: Editor; inTable: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-pressed={inTable}
          className={cn("size-6", inTable && "bg-muted text-foreground")}
          label="Table"
          size="icon-sm"
          variant="ghost"
        >
          <TableIcon className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        >
          Insert table
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!inTable}
          onSelect={() => editor.chain().focus().addRowAfter().run()}
        >
          Add row below
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onSelect={() => editor.chain().focus().addColumnAfter().run()}
        >
          Add column after
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onSelect={() => editor.chain().focus().deleteRow().run()}
        >
          Delete row
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onSelect={() => editor.chain().focus().deleteColumn().run()}
        >
          Delete column
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onSelect={() => editor.chain().focus().deleteTable().run()}
        >
          Delete table
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One data-driven toolbar action: label + icon + activity probe + command. */
interface ToolbarAction {
  label: string;
  icon: LucideIcon;
  /** Reads whether the action's construct is active at the current selection. */
  isActive?: (editor: Editor) => boolean;
  /** Reads whether the action can run at all (undo/redo history). */
  isEnabled?: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

/** Builds a toolbar action for a simple mark/node toggle (bold, lists, quote, ...). */
function toggleAction(
  label: string,
  icon: LucideIcon,
  markOrNodeName: string,
  toggle: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>,
): ToolbarAction {
  return {
    label,
    icon,
    isActive: (e) => e.isActive(markOrNodeName),
    run: (e) => toggle(e.chain().focus()).run(),
  };
}

/**
 * Toolbar actions grouped into divider-separated sections. Every action maps to
 * a markdown construct GFM can express (headings, emphasis, lists, task lists,
 * quotes, code, rules), so the serialized file stays portable.
 */
const TOOLBAR_SECTIONS: ToolbarAction[][] = [
  [
    {
      label: "Undo",
      icon: Undo2,
      isEnabled: (e) => e.can().undo(),
      run: (e) => e.chain().focus().undo().run(),
    },
    {
      label: "Redo",
      icon: Redo2,
      isEnabled: (e) => e.can().redo(),
      run: (e) => e.chain().focus().redo().run(),
    },
  ],
  ([1, 2, 3] as const).map((level) => ({
    label: `Heading ${level}`,
    icon: [Heading1, Heading2, Heading3][level - 1] as LucideIcon,
    isActive: (e: Editor) => e.isActive("heading", { level }),
    run: (e: Editor) => e.chain().focus().toggleHeading({ level }).run(),
  })),
  [
    toggleAction("Bold", Bold, "bold", (c) => c.toggleBold()),
    toggleAction("Italic", Italic, "italic", (c) => c.toggleItalic()),
    toggleAction("Strikethrough", Strikethrough, "strike", (c) => c.toggleStrike()),
    toggleAction("Inline code", Code, "code", (c) => c.toggleCode()),
  ],
  [
    toggleAction("Bullet list", List, "bulletList", (c) => c.toggleBulletList()),
    toggleAction("Ordered list", ListOrdered, "orderedList", (c) => c.toggleOrderedList()),
    toggleAction("Task list", ListTodo, "taskList", (c) => c.toggleTaskList()),
  ],
  [
    toggleAction("Blockquote", Quote, "blockquote", (c) => c.toggleBlockquote()),
    toggleAction("Code block", SquareCode, "codeBlock", (c) => c.toggleCodeBlock()),
    {
      label: "Horizontal rule",
      icon: Minus,
      run: (e) => e.chain().focus().setHorizontalRule().run(),
    },
  ],
];

/** Formatting toolbar for the WYSIWYG markdown surface. */
export function MarkdownToolbar({ editor, children }: { editor: Editor; children?: ReactNode }) {
  // Re-compute on selection/doc changes so active/enabled states track the caret.
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      sections: TOOLBAR_SECTIONS.map((section) =>
        section.map((action) => ({
          active: action.isActive?.(instance) ?? false,
          enabled: action.isEnabled?.(instance) ?? true,
        })),
      ),
      link: instance.isActive("link"),
      table: instance.isActive("table"),
    }),
  });

  return (
    <div className="flex items-center gap-0.5">
      {TOOLBAR_SECTIONS.map((section, sectionIndex) => (
        <div className="flex items-center gap-0.5" key={section[0]?.label}>
          {sectionIndex > 0 && <ToolbarDivider />}
          {section.map((action, actionIndex) => {
            const Icon = action.icon;
            const buttonState = state.sections[sectionIndex]?.[actionIndex];
            return (
              <ToolbarButton
                active={buttonState?.active ?? false}
                disabled={!(buttonState?.enabled ?? true)}
                key={action.label}
                label={action.label}
                onClick={() => action.run(editor)}
              >
                <Icon className="size-3.5" />
              </ToolbarButton>
            );
          })}
        </div>
      ))}
      <ToolbarDivider />
      <LinkControl active={state.link} editor={editor} />
      <TableControl editor={editor} inTable={state.table} />
      {children ? (
        <>
          <ToolbarDivider />
          {children}
        </>
      ) : null}
    </div>
  );
}
