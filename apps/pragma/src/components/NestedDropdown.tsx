import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NestedDropdownContext = createContext<{
  query: string;
  close: () => void;
} | null>(null);

function useNestedDropdown() {
  const context = useContext(NestedDropdownContext);
  if (!context) {
    throw new Error("NestedDropdown items must be rendered inside NestedDropdown");
  }
  return context;
}

function matchesSearch(value: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || value.toLowerCase().includes(needle);
}

interface NestedDropdownProps {
  trigger: ReactNode;
  children: ReactNode;
  /** Pass `false` when the menu lives inside another modal overlay. */
  modal?: boolean;
  align?: "start" | "center" | "end";
  contentClassName?: string;
}

/**
 * A hover-nested dropdown. Submenus stay regular shadcn dropdowns so hovering a
 * parent reveals the next level. Mark a group `searchable` to filter its children
 * without breaking that hover chain.
 */
export function NestedDropdown({
  trigger,
  children,
  modal = true,
  align = "start",
  contentClassName,
}: NestedDropdownProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const context = useMemo(() => ({ query: "", close }), [close]);
  return (
    <NestedDropdownContext.Provider value={context}>
      <DropdownMenu modal={modal} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} className={cn("min-w-64", contentClassName)}>
          <DropdownMenuGroup>{children}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </NestedDropdownContext.Provider>
  );
}

interface NestedDropdownGroupProps {
  label: ReactNode;
  /** Current value shown on the right of the submenu trigger. */
  value?: ReactNode;
  /** Filter text when this group sits inside a searchable parent. */
  searchValue?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchLabel?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Fires when the submenu is opened or hovered, e.g. to lazy-load items. */
  onOpen?: () => void;
  children: ReactNode;
}

/**
 * A hover submenu. Searchable groups filter {@link NestedDropdownItem} and nested
 * {@link NestedDropdownGroup} children while keeping them as regular dropdowns.
 */
export function NestedDropdownGroup({
  label,
  value,
  searchValue,
  searchable = false,
  searchPlaceholder = "Search...",
  searchLabel,
  emptyText = "No results.",
  disabled = false,
  onOpen,
  children,
}: NestedDropdownGroupProps) {
  const parent = useNestedDropdown();
  const [query, setQuery] = useState("");
  const context = useMemo(() => ({ query, close: parent.close }), [parent.close, query]);
  const filterText = searchValue ?? (typeof label === "string" ? label : "");
  if (!matchesSearch(filterText, parent.query)) return null;

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) onOpen?.();
    if (!nextOpen) setQuery("");
  }

  return (
    <NestedDropdownContext.Provider value={context}>
      <DropdownMenuSub onOpenChange={handleOpenChange}>
        <DropdownMenuSubTrigger
          disabled={disabled}
          onFocus={() => onOpen?.()}
          onPointerEnter={() => onOpen?.()}
        >
          {label}
          {value ? (
            <span className="ml-auto min-w-0 truncate text-muted-foreground">{value}</span>
          ) : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className={cn("min-w-56", searchable && "p-0")}>
          {searchable ? (
            <SearchField
              label={searchLabel ?? (typeof label === "string" ? `Search ${label}` : "Search")}
              placeholder={searchPlaceholder}
              value={query}
              onChange={setQuery}
            />
          ) : null}
          <DropdownMenuGroup className={cn("group/results", searchable && "p-1")}>
            {children}
            {searchable ? (
              <output className="hidden px-1.5 py-4 text-center text-sm text-muted-foreground group-has-[[data-slot=dropdown-menu-item]]/results:hidden group-has-[[data-slot=dropdown-menu-sub-trigger]]/results:hidden">
                {emptyText}
              </output>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </NestedDropdownContext.Provider>
  );
}

interface NestedDropdownItemProps {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  selected?: boolean;
  /** Filter value when this item sits inside a searchable group. */
  searchValue?: string;
}

/** A selectable leaf in a {@link NestedDropdown} or {@link NestedDropdownGroup}. */
export function NestedDropdownItem({
  children,
  onSelect,
  disabled = false,
  selected = false,
  searchValue,
}: NestedDropdownItemProps) {
  const { query, close } = useNestedDropdown();
  const filterText = searchValue ?? (typeof children === "string" ? children : "");
  if (!matchesSearch(filterText, query)) return null;

  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => {
        if (disabled) return;
        onSelect?.();
        close();
      }}
    >
      {children}
      {selected ? <CheckIcon className="ml-auto" /> : null}
    </DropdownMenuItem>
  );
}

/** Visual break between root items and nested groups. */
export function NestedDropdownSeparator() {
  return <DropdownMenuSeparator />;
}

function SearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3">
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <input
        aria-label={label}
        className="flex h-11 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground"
        placeholder={placeholder}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
            return;
          }
          if (event.key.length === 1 || event.key === "Backspace") {
            event.stopPropagation();
          }
        }}
      />
    </div>
  );
}
