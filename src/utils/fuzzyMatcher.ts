export interface FuzzyMatch {
  score: number;
  matches: number[];
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query || !target) {
    return null;
  }

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  let score = 0;
  let queryIndex = 0;
  let targetIndex = 0;
  const matches: number[] = [];
  let consecutiveMatches = 0;
  let lastMatchIndex = -1;

  while (queryIndex < queryLower.length && targetIndex < targetLower.length) {
    const queryChar = queryLower[queryIndex];
    const targetChar = targetLower[targetIndex];

    if (queryChar === targetChar) {
      matches.push(targetIndex);

      // Base score
      score += 1;

      if (targetIndex === lastMatchIndex + 1) {
        consecutiveMatches++;
        score += consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
      }

      if (targetIndex === 0 || isWordBoundary(target, targetIndex)) {
        score += 10;
      }

      if (
        targetIndex > 0 &&
        (target[targetIndex - 1] === '/' || target[targetIndex - 1] === '\\')
      ) {
        score += 15;
      }

      if (
        targetIndex > 0 &&
        target[targetIndex - 1] === target[targetIndex - 1].toLowerCase() &&
        target[targetIndex] === target[targetIndex].toUpperCase()
      ) {
        score += 8;
      }

      lastMatchIndex = targetIndex;
      queryIndex++;
    }

    targetIndex++;
  }

  if (queryIndex !== queryLower.length) {
    return null;
  }

  const matchSpread = matches.length > 0 ? matches[matches.length - 1] - matches[0] : 0;
  score -= matchSpread * 0.1;

  const lastSlash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  const filenameStart = lastSlash + 1;
  const matchesInFilename = matches.filter((m) => m >= filenameStart).length;
  score += matchesInFilename * 3;

  return { score, matches };
}

function isWordBoundary(str: string, index: number): boolean {
  if (index === 0) return true;

  const prev = str[index - 1];
  const curr = str[index];

  if (prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '\\') {
    return true;
  }

  if (prev === prev.toLowerCase() && curr === curr.toUpperCase()) {
    return true;
  }

  return false;
}

export function fuzzySearch<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit: number = 20
): Array<{ item: T; score: number }> {
  const results: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const text = getText(item);
    const match = fuzzyMatch(query, text);

    if (match) {
      results.push({ item, score: match.score });
    }
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}
