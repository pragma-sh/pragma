import { FindReplaceBar } from "@/components/find-replace/FindReplaceBar";
import type { FindReplaceApi } from "@/components/find-replace/find-replace-state";

/** Wires a replace-capable find hook (editor/markdown/terminal) into `FindReplaceBar`'s props. */
export function EditorFindReplaceBar({ find }: { find: FindReplaceApi }) {
  return (
    <FindReplaceBar
      currentMatch={find.currentMatch}
      findPlaceholder="Find in file"
      ignoreCase={find.ignoreCase}
      matchCount={find.matchCount}
      onClose={find.closeBar}
      onIgnoreCaseChange={find.setIgnoreCase}
      onNext={find.findNext}
      onPrevious={find.findPrevious}
      onQueryChange={find.setQuery}
      open={find.open}
      query={find.query}
      replace={{
        value: find.replaceValue,
        onValueChange: find.setReplaceValue,
        onReplace: find.replaceOne,
        onReplaceAll: find.replaceAll,
        replaceDisabled: find.matchCount === 0,
      }}
    />
  );
}
