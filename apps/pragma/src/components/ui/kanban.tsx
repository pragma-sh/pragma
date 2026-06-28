import {
  createContext,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  defaultDropAnimationSideEffects,
  DndContext,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  KeyboardSensor,
  MeasuringStrategy,
  type Modifiers,
  MouseSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  type AnimateLayoutChanges,
  arrayMove,
  defaultAnimateLayoutChanges,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

interface KanbanContextProps<T> {
  columns: Record<string, T[]>;
  setColumns: (columns: Record<string, T[]>) => void;
  getItemId: (item: T) => string;
  columnIds: string[];
  activeId: UniqueIdentifier | null;
  setActiveId: (id: UniqueIdentifier | null) => void;
  findContainer: (id: UniqueIdentifier) => string | undefined;
  isColumn: (id: UniqueIdentifier) => boolean;
  modifiers?: Modifiers;
  // True when moves are deferred to `onMove` (the board never live-reorders), so
  // the drop animation must be skipped — otherwise the overlay tweens back to the
  // item's unchanged original column before the deferred move applies.
  deferMoves: boolean;
}

// The context is generic at the call sites but stored as `unknown`-keyed records;
// each consumer reads back through the typed helpers above.
const KanbanContext = createContext<KanbanContextProps<unknown>>({
  columns: {},
  setColumns: () => {},
  getItemId: () => "",
  columnIds: [],
  activeId: null,
  setActiveId: () => {},
  findContainer: () => undefined,
  isColumn: () => false,
  modifiers: undefined,
  deferMoves: false,
});

const ColumnContext = createContext<{
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners | undefined;
  isDragging?: boolean;
  disabled?: boolean;
}>({
  attributes: {} as DraggableAttributes,
  listeners: undefined,
  isDragging: false,
  disabled: false,
});

const ItemContext = createContext<{
  listeners: DraggableSyntheticListeners | undefined;
  isDragging?: boolean;
  disabled?: boolean;
}>({
  listeners: undefined,
  isDragging: false,
  disabled: false,
});

const IsOverlayContext = createContext(false);

// Stable context payloads for the drag-overlay clones (no listeners, always "dragging").
const OVERLAY_COLUMN_CONTEXT = {
  attributes: {} as DraggableAttributes,
  listeners: undefined,
  isDragging: true,
  disabled: false,
};
const OVERLAY_ITEM_CONTEXT = {
  listeners: undefined,
  isDragging: true,
  disabled: false,
};

const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: "0.4",
      },
    },
  }),
};

/** Build the next column map for a cross-column item move, or `null` if no move. */
function computeCrossColumnMove<T>(
  columns: Record<string, T[]>,
  activeContainer: string,
  overContainer: string,
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
  getItemValue: (item: T) => string,
  isColumn: (id: UniqueIdentifier) => boolean,
): Record<string, T[]> | null {
  const activeItems = columns[activeContainer] ?? [];
  const overItems = columns[overContainer] ?? [];
  const activeIndex = activeItems.findIndex((item) => getItemValue(item) === activeId);
  // Dropping on the column itself appends to the end of the target column.
  const overIndex = isColumn(overId)
    ? overItems.length
    : overItems.findIndex((item) => getItemValue(item) === overId);

  const newActiveItems = [...activeItems];
  const newOverItems = [...overItems];
  const [movedItem] = newActiveItems.splice(activeIndex, 1);
  if (movedItem === undefined) return null;
  newOverItems.splice(overIndex, 0, movedItem);
  return { ...columns, [activeContainer]: newActiveItems, [overContainer]: newOverItems };
}

/** Build the next column map for a same-column reorder, or `null` if indices match. */
function computeSameColumnReorder<T>(
  columns: Record<string, T[]>,
  container: string,
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
  getItemValue: (item: T) => string,
): Record<string, T[]> | null {
  const items = columns[container] ?? [];
  const activeIndex = items.findIndex((item) => getItemValue(item) === activeId);
  const overIndex = items.findIndex((item) => getItemValue(item) === overId);
  if (activeIndex === overIndex) return null;
  return { ...columns, [container]: arrayMove(items, activeIndex, overIndex) };
}

/** Resolve the live-reorder result for a `DragOverEvent`, or `null` to skip. */
function computeDragOverResult<T>(
  event: DragOverEvent,
  columns: Record<string, T[]>,
  findContainer: (id: UniqueIdentifier) => string | undefined,
  isColumn: (id: UniqueIdentifier) => boolean,
  getItemValue: (item: T) => string,
): Record<string, T[]> | null {
  const { active, over } = event;
  if (!over || isColumn(active.id)) return null;
  const activeContainer = findContainer(active.id);
  const overContainer = findContainer(over.id);
  if (!activeContainer || !overContainer) return null;
  if (activeContainer !== overContainer) {
    return computeCrossColumnMove(
      columns,
      activeContainer,
      overContainer,
      active.id,
      over.id,
      getItemValue,
      isColumn,
    );
  }
  return computeSameColumnReorder(columns, activeContainer, active.id, over.id, getItemValue);
}

/** Build a reordered column map (columns themselves dragged), or `null` if unchanged. */
function computeColumnReorder<T>(
  columns: Record<string, T[]>,
  columnIds: string[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
): Record<string, T[]> | null {
  const activeIndex = columnIds.indexOf(activeId as string);
  const overIndex = columnIds.indexOf(overId as string);
  if (activeIndex === overIndex) return null;
  const newColumns: Record<string, T[]> = {};
  for (const key of arrayMove(Object.keys(columns), activeIndex, overIndex)) {
    newColumns[key] = columns[key] ?? [];
  }
  return newColumns;
}

/** Resolve the (active/over container + indices) for a deferred item move. */
function resolveDeferredMove<T>(
  event: DragEndEvent,
  columns: Record<string, T[]>,
  findContainer: (id: UniqueIdentifier) => string | undefined,
  isColumn: (id: UniqueIdentifier) => boolean,
  getItemValue: (item: T) => string,
): KanbanMoveEvent | null {
  const { active, over } = event;
  const activeContainer = findContainer(active.id);
  const overContainer = over ? findContainer(over.id) : undefined;
  if (!activeContainer || !overContainer || !over) return null;
  const activeIndex = (columns[activeContainer] ?? []).findIndex(
    (item) => getItemValue(item) === active.id,
  );
  const overIndex = isColumn(over.id)
    ? (columns[overContainer] ?? []).length
    : (columns[overContainer] ?? []).findIndex((item) => getItemValue(item) === over.id);
  return { event, activeContainer, activeIndex, overContainer, overIndex };
}

interface DragHandlerContext<T> {
  columns: Record<string, T[]>;
  columnIds: string[];
  findContainer: (id: UniqueIdentifier) => string | undefined;
  isColumn: (id: UniqueIdentifier) => boolean;
  getItemValue: (item: T) => string;
  setColumns: (columns: Record<string, T[]>) => void;
  onMove?: (event: KanbanMoveEvent) => void;
}

/** Route a deferred item move (caller-owned) to `onMove`. Returns true if handled. */
function dispatchDeferredMove<T>(event: DragEndEvent, ctx: DragHandlerContext<T>): boolean {
  if (!ctx.onMove || ctx.isColumn(event.active.id)) return false;
  const move = resolveDeferredMove(
    event,
    ctx.columns,
    ctx.findContainer,
    ctx.isColumn,
    ctx.getItemValue,
  );
  if (move) ctx.onMove(move);
  return true;
}

/** Reorder columns when both active and over are columns. Returns true if handled. */
function applyColumnReorder<T>(event: DragEndEvent, ctx: DragHandlerContext<T>): boolean {
  const { active, over } = event;
  if (!over || !ctx.isColumn(active.id) || !ctx.isColumn(over.id)) return false;
  const next = computeColumnReorder(ctx.columns, ctx.columnIds, active.id, over.id);
  if (next) ctx.setColumns(next);
  return true;
}

/** Live-reorder an item within its same column (no caller `onMove`). */
function applySameColumnItemReorder<T>(event: DragEndEvent, ctx: DragHandlerContext<T>): void {
  const { active, over } = event;
  if (!over) return;
  const activeContainer = ctx.findContainer(active.id);
  const overContainer = ctx.findContainer(over.id);
  if (!activeContainer || !overContainer || activeContainer !== overContainer) return;
  const next = computeSameColumnReorder(
    ctx.columns,
    activeContainer,
    active.id,
    over.id,
    ctx.getItemValue,
  );
  if (next) ctx.setColumns(next);
}

/** Route a drop: deferred move → caller, column reorder, or live same-column reorder. */
function applyDragEnd<T>(event: DragEndEvent, ctx: DragHandlerContext<T>): void {
  if (!event.over) return;
  if (dispatchDeferredMove(event, ctx)) return;
  if (applyColumnReorder(event, ctx)) return;
  applySameColumnItemReorder(event, ctx);
}

/** Details of a single item move, surfaced to `Kanban`'s `onMove` callback. */
export interface KanbanMoveEvent {
  event: DragEndEvent;
  activeContainer: string;
  activeIndex: number;
  overContainer: string;
  overIndex: number;
}

/** Props for the `Kanban` root: a controlled column→items map plus drag callbacks. */
export interface KanbanRootProps<T> extends HTMLAttributes<HTMLDivElement> {
  value: Record<string, T[]>;
  onValueChange: (value: Record<string, T[]>) => void;
  getItemValue: (item: T) => string;
  children: ReactNode;
  onMove?: (event: KanbanMoveEvent) => void;
  asChild?: boolean;
  modifiers?: Modifiers;
}

/** Drag handlers for the board, derived from the controlled column state. */
function useKanbanDragHandlers<T>({
  columns,
  columnIds,
  findContainer,
  isColumn,
  getItemValue,
  setColumns,
  onMove,
}: {
  columns: Record<string, T[]>;
  columnIds: string[];
  findContainer: (id: UniqueIdentifier) => string | undefined;
  isColumn: (id: UniqueIdentifier) => boolean;
  getItemValue: (item: T) => string;
  setColumns: (columns: Record<string, T[]>) => void;
  onMove?: (event: KanbanMoveEvent) => void;
}): {
  handleDragStart: (event: DragStartEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragEnd: (event: DragEndEvent) => void;
  handleDragCancel: () => void;
  activeId: UniqueIdentifier | null;
  setActiveId: (id: UniqueIdentifier | null) => void;
} {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      // When the caller owns moves, skip live cross-column reordering; the drop is
      // routed through `onMove` in `handleDragEnd`.
      if (onMove) return;
      const next = computeDragOverResult(event, columns, findContainer, isColumn, getItemValue);
      if (next) setColumns(next);
    },
    [columns, findContainer, isColumn, getItemValue, setColumns, onMove],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      applyDragEnd(event, {
        columns,
        columnIds,
        findContainer,
        isColumn,
        getItemValue,
        setColumns,
        onMove,
      });
    },
    [columns, columnIds, findContainer, isColumn, getItemValue, setColumns, onMove],
  );

  return {
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeId,
    setActiveId,
  };
}

/**
 * Root of a drag-and-drop board. Owns the dnd-kit context and routes drops either
 * into the controlled `value` (live reordering) or, when `onMove` is supplied,
 * defers the mutation to the caller so persistence/side effects can run on drop.
 */
function Kanban<T>({
  value,
  onValueChange,
  getItemValue,
  children,
  className,
  asChild = false,
  onMove,
  modifiers,
  ...props
}: KanbanRootProps<T>) {
  const columns = value;
  const setColumns = onValueChange;

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const columnIds = useMemo(() => Object.keys(columns), [columns]);

  const isColumn = useCallback(
    (id: UniqueIdentifier) => columnIds.includes(id as string),
    [columnIds],
  );

  const findContainer = useCallback(
    (id: UniqueIdentifier) => {
      if (isColumn(id)) return id as string;
      return columnIds.find((key) => columns[key]?.some((item) => getItemValue(item) === id));
    },
    [columns, columnIds, getItemValue, isColumn],
  );

  const {
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeId,
    setActiveId,
  } = useKanbanDragHandlers({
    columns,
    columnIds,
    findContainer,
    isColumn,
    getItemValue,
    setColumns,
    onMove,
  });

  const contextValue = useMemo<KanbanContextProps<unknown>>(
    () => ({
      columns: columns as Record<string, unknown[]>,
      setColumns: setColumns as (columns: Record<string, unknown[]>) => void,
      getItemId: getItemValue as (item: unknown) => string,
      columnIds,
      activeId,
      setActiveId,
      findContainer,
      isColumn,
      modifiers,
      deferMoves: onMove !== undefined,
    }),
    [
      columns,
      setColumns,
      getItemValue,
      columnIds,
      activeId,
      setActiveId,
      findContainer,
      isColumn,
      modifiers,
      onMove,
    ],
  );

  const Comp = asChild ? Slot.Root : "div";

  return (
    <KanbanContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        modifiers={modifiers}
        measuring={{
          droppable: {
            strategy: MeasuringStrategy.Always,
          },
        }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <Comp
          data-slot="kanban"
          data-dragging={activeId !== null}
          className={cn(activeId !== null && "cursor-grabbing!", className)}
          {...props}
        >
          {children}
        </Comp>
      </DndContext>
    </KanbanContext.Provider>
  );
}

/** Props for the board layout wrapper that lays columns out in a grid. */
export interface KanbanBoardProps extends HTMLAttributes<HTMLDivElement> {
  asChild?: boolean;
}

/** Lays out columns and provides the column-level sortable context. */
function KanbanBoard({ className, asChild = false, children, ...props }: KanbanBoardProps) {
  const { columnIds } = useContext(KanbanContext);
  const Comp = asChild ? Slot.Root : "div";

  return (
    <SortableContext items={columnIds} strategy={rectSortingStrategy}>
      <Comp
        data-slot="kanban-board"
        className={cn("grid auto-rows-fr gap-4 sm:grid-cols-3", className)}
        {...props}
      >
        {children}
      </Comp>
    </SortableContext>
  );
}

/** Props for a single column; `value` is the column id (key in the board map). */
export interface KanbanColumnProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  disabled?: boolean;
  asChild?: boolean;
}

/** One sortable column. Set `disabled` to pin a column (no column reordering). */
function KanbanColumn({
  value,
  className,
  asChild = false,
  disabled,
  children,
  ...props
}: KanbanColumnProps) {
  const isOverlay = useContext(IsOverlayContext);

  const {
    setNodeRef,
    transform,
    transition,
    attributes,
    listeners,
    isDragging: isSortableDragging,
  } = useSortable({
    id: value,
    disabled: disabled || isOverlay,
    animateLayoutChanges,
  });

  const { activeId, isColumn } = useContext(KanbanContext);
  const isColumnDragging = activeId ? isColumn(activeId) : false;

  const columnContext = useMemo(
    () => ({ attributes, listeners, isDragging: isColumnDragging, disabled }),
    [attributes, listeners, isColumnDragging, disabled],
  );

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  } as CSSProperties;

  const Comp = asChild ? Slot.Root : "div";

  if (isOverlay) {
    return (
      <ColumnContext.Provider value={OVERLAY_COLUMN_CONTEXT}>
        <Comp
          data-slot="kanban-column"
          data-value={value}
          data-dragging={true}
          className={cn("group/kanban-column flex flex-col", className)}
          {...props}
        >
          {children}
        </Comp>
      </ColumnContext.Provider>
    );
  }

  return (
    <ColumnContext.Provider value={columnContext}>
      <Comp
        data-slot="kanban-column"
        data-value={value}
        data-dragging={isSortableDragging}
        data-disabled={disabled}
        ref={setNodeRef}
        style={style}
        className={cn(
          "group/kanban-column flex flex-col",
          isSortableDragging && "z-50 opacity-50",
          disabled && "opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </Comp>
    </ColumnContext.Provider>
  );
}

/** Props for the column drag handle. */
export interface KanbanColumnHandleProps extends HTMLAttributes<HTMLDivElement> {
  cursor?: boolean;
  asChild?: boolean;
}

/** Drag handle for reordering a column (reveals on column hover). */
function KanbanColumnHandle({
  className,
  asChild = false,
  cursor = true,
  children,
  ...props
}: KanbanColumnHandleProps) {
  const { attributes, listeners, isDragging, disabled } = useContext(ColumnContext);

  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp
      data-slot="kanban-column-handle"
      data-dragging={isDragging}
      data-disabled={disabled}
      {...attributes}
      {...listeners}
      className={cn(
        "opacity-0 transition-opacity group-hover/kanban-column:opacity-100",
        cursor && (isDragging ? "cursor-grabbing!" : "cursor-grab!"),
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  );
}

/** Props for a draggable item; `value` is the item id. */
export interface KanbanItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  disabled?: boolean;
  asChild?: boolean;
}

/** A single sortable item. Drag is initiated through a nested `KanbanItemHandle`. */
function KanbanItem({
  value,
  className,
  asChild = false,
  disabled,
  children,
  ...props
}: KanbanItemProps) {
  const isOverlay = useContext(IsOverlayContext);

  const {
    setNodeRef,
    transform,
    transition,
    attributes,
    listeners,
    isDragging: isSortableDragging,
  } = useSortable({
    id: value,
    disabled: disabled || isOverlay,
    animateLayoutChanges,
  });

  const { activeId, isColumn } = useContext(KanbanContext);
  const isItemDragging = activeId ? !isColumn(activeId) : false;

  const itemContext = useMemo(
    () => ({ listeners, isDragging: isItemDragging, disabled }),
    [listeners, isItemDragging, disabled],
  );

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  } as CSSProperties;

  const Comp = asChild ? Slot.Root : "div";

  if (isOverlay) {
    return (
      <ItemContext.Provider value={OVERLAY_ITEM_CONTEXT}>
        <Comp
          data-slot="kanban-item"
          data-value={value}
          data-dragging={true}
          className={cn(className)}
          {...props}
        >
          {children}
        </Comp>
      </ItemContext.Provider>
    );
  }

  return (
    <ItemContext.Provider value={itemContext}>
      <Comp
        data-slot="kanban-item"
        data-value={value}
        data-dragging={isSortableDragging}
        data-disabled={disabled}
        ref={setNodeRef}
        style={style}
        {...attributes}
        className={cn(isSortableDragging && "z-50 opacity-50", disabled && "opacity-50", className)}
        {...props}
      >
        {children}
      </Comp>
    </ItemContext.Provider>
  );
}

/** Props for the item drag handle. */
export interface KanbanItemHandleProps extends HTMLAttributes<HTMLDivElement> {
  cursor?: boolean;
  asChild?: boolean;
}

/** Drag handle for moving an item; spreads the sortable listeners onto its child. */
function KanbanItemHandle({
  className,
  asChild = false,
  cursor = true,
  children,
  ...props
}: KanbanItemHandleProps) {
  const { listeners, isDragging, disabled } = useContext(ItemContext);

  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp
      data-slot="kanban-item-handle"
      data-dragging={isDragging}
      data-disabled={disabled}
      {...listeners}
      className={cn(cursor && (isDragging ? "cursor-grabbing!" : "cursor-grab!"), className)}
      {...props}
    >
      {children}
    </Comp>
  );
}

/** Props for a column's item list; `value` is the owning column id. */
export interface KanbanColumnContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  asChild?: boolean;
}

/** Sortable item list for a column. */
function KanbanColumnContent({
  value,
  className,
  asChild = false,
  children,
  ...props
}: KanbanColumnContentProps) {
  const { columns, getItemId } = useContext(KanbanContext);

  const itemIds = useMemo(() => (columns[value] ?? []).map(getItemId), [columns, getItemId, value]);

  const Comp = asChild ? Slot.Root : "div";

  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <Comp
        data-slot="kanban-column-content"
        className={cn("flex flex-col gap-2", className)}
        {...props}
      >
        {children}
      </Comp>
    </SortableContext>
  );
}

/** Props for the drag overlay; children may be a render function keyed by id/variant. */
export interface KanbanOverlayProps extends Omit<
  React.ComponentProps<typeof DragOverlay>,
  "children"
> {
  children?:
    | ReactNode
    | ((params: { value: UniqueIdentifier; variant: "column" | "item" }) => ReactNode);
}

/** Floating preview of the dragged column/item, portaled to the document body. */
function KanbanOverlay({ children, className, ...props }: KanbanOverlayProps) {
  const { activeId, isColumn, modifiers, deferMoves } = useContext(KanbanContext);
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => setMounted(true), []);

  const variant = activeId ? (isColumn(activeId) ? "column" : "item") : "item";

  const content =
    activeId && children
      ? typeof children === "function"
        ? children({ value: activeId, variant })
        : children
      : null;

  if (!mounted) return null;

  return createPortal(
    <DragOverlay
      dropAnimation={deferMoves ? null : dropAnimationConfig}
      modifiers={modifiers}
      className={cn("z-50", activeId && "cursor-grabbing", className)}
      {...props}
    >
      <IsOverlayContext.Provider value={true}>{content}</IsOverlayContext.Provider>
    </DragOverlay>,
    document.body,
  );
}

export {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanColumnHandle,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
};
