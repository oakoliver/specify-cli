/**
 * @oakoliver/specify-cli - Duplicate-key-aware JSON loading
 *
 * Python's ``json.loads(..., object_pairs_hook=unique_object)`` lets upstream
 * reject JSON objects that repeat a key (``JSON.parse`` silently keeps the
 * last value). Used by the step catalog (``_unique_json_fields``) and
 * available to other catalog families that reject ambiguous objects.
 *
 * ``objectPairsHook`` semantics are mirrored: the hook runs for each object
 * when it closes (inner objects first), receiving its ``[key, value]`` pairs
 * in document order, and may throw.
 *
 * @module json-unique
 */

/**
 * Find the first duplicated key in the order Python's ``object_pairs_hook``
 * would observe it (objects are reported when they close, inner first).
 * ``text`` must already be valid JSON. Returns ``null`` when every object has
 * unique keys.
 */
export function findDuplicateJsonKey(text: string): string | null {
  const stack: Array<{ keys: Set<string>; dup: string | null; isObject: boolean; expectKey: boolean }> = [];
  let i = 0;
  const n = text.length;
  const readString = (): string => {
    // text[i] === '"'
    let j = i + 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '"') break;
      j += 1;
    }
    const raw = text.slice(i, j + 1);
    i = j + 1;
    return JSON.parse(raw) as string;
  };
  while (i < n) {
    const c = text[i];
    if (c === '{') {
      stack.push({ keys: new Set(), dup: null, isObject: true, expectKey: true });
      i += 1;
    } else if (c === '[') {
      stack.push({ keys: new Set(), dup: null, isObject: false, expectKey: false });
      i += 1;
    } else if (c === '}' || c === ']') {
      const frame = stack.pop();
      if (frame && frame.isObject && frame.dup !== null) return frame.dup;
      i += 1;
    } else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top && top.isObject) top.expectKey = true;
      i += 1;
    } else if (c === '"') {
      const top = stack[stack.length - 1];
      const value = readString();
      if (top && top.isObject && top.expectKey) {
        if (top.keys.has(value)) {
          if (top.dup === null) top.dup = value;
        } else {
          top.keys.add(value);
        }
        top.expectKey = false;
      }
    } else {
      i += 1;
    }
  }
  return null;
}

/**
 * ``json.loads(text, object_pairs_hook=hook)`` where ``hook`` rejects
 * duplicate keys: parses ``text`` (``SyntaxError`` on malformed JSON) and
 * throws ``onDuplicate(key)`` when any object repeats a key.
 */
export function loadsUniqueJson(text: string, onDuplicate: (key: string) => Error): unknown {
  const value = JSON.parse(text) as unknown;
  const dup = findDuplicateJsonKey(text);
  if (dup !== null) throw onDuplicate(dup);
  return value;
}
