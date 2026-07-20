/** A fuzzy (subsequence) match span: `[from, to)` into the text it was found in. */
export interface FuzzyMatch {
  from: number;
  to: number;
}

/**
 * Finds every non-overlapping fuzzy (subsequence) match of `query` in `text`:
 * query characters must appear in order but not contiguously (`"fb"` matches
 * `"foo bar"`). Each match spans from its first to its last matched
 * character — greedy-leftmost, so it isn't necessarily the tightest possible
 * span — since replace has to act on a single contiguous range and that range
 * includes whatever text sits between the matched characters.
 */
export function findFuzzyMatches(text: string, query: string, ignoreCase: boolean): FuzzyMatch[] {
  if (!query) {
    return [];
  }
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const needle = ignoreCase ? query.toLowerCase() : query;
  const matches: FuzzyMatch[] = [];
  let searchFrom = 0;
  while (searchFrom < haystack.length) {
    let needleIndex = 0;
    let start = -1;
    let end = -1;
    for (let i = searchFrom; i < haystack.length && needleIndex < needle.length; i += 1) {
      if (haystack[i] === needle[needleIndex]) {
        if (start === -1) {
          start = i;
        }
        end = i;
        needleIndex += 1;
      }
    }
    if (needleIndex < needle.length) {
      break;
    }
    matches.push({ from: start, to: end + 1 });
    searchFrom = end + 1;
  }
  return matches;
}

/** The match at-or-after `from`, wrapping to the first match if none remain. */
export function nextFuzzyMatch(matches: FuzzyMatch[], from: number): FuzzyMatch | null {
  if (matches.length === 0) {
    return null;
  }
  return matches.find((match) => match.from >= from) ?? matches[0] ?? null;
}

/** The match before `from`, wrapping to the last match if none precede it. */
export function previousFuzzyMatch(matches: FuzzyMatch[], from: number): FuzzyMatch | null {
  if (matches.length === 0) {
    return null;
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (match && match.from < from) {
      return match;
    }
  }
  return matches[matches.length - 1] ?? null;
}
