import type { RuleFrontmatter } from "./types.js";

/**
 * Minimal, zero-dependency YAML frontmatter parser for markdown rules.
 * Adheres to fail-open principle: malformed YAML returns empty metadata without throwing.
 */
export function parseFrontmatter(rawContent: string): {
  frontmatter: RuleFrontmatter;
  body: string;
} {
  const trimmed = rawContent.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: rawContent };
  }

  // Find closing delimiter (--- or ...)
  const endIdx = trimmed.indexOf("\n---", 3);
  const altEndIdx = trimmed.indexOf("\n...", 3);
  const actualEndIdx =
    endIdx !== -1 ? endIdx : altEndIdx !== -1 ? altEndIdx : -1;

  if (actualEndIdx === -1) {
    return { frontmatter: {}, body: rawContent };
  }

  const yamlBlock = trimmed.slice(3, actualEndIdx).trim();
  const body = trimmed.slice(actualEndIdx + 4).trim();

  const frontmatter: RuleFrontmatter = {};

  try {
    const lines = yamlBlock.split("\n");
    let currentKey: string | null = null;
    let currentList: string[] | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      // Check for list item under current key
      if (trimmedLine.startsWith("-") && currentKey) {
        let itemVal = trimmedLine.slice(1).trim();
        if (
          (itemVal.startsWith('"') && itemVal.endsWith('"')) ||
          (itemVal.startsWith("'") && itemVal.endsWith("'"))
        ) {
          itemVal = itemVal.slice(1, -1);
        }
        if (!currentList) {
          currentList = [];
          frontmatter[currentKey] = currentList;
        }
        currentList.push(itemVal);
        continue;
      }

      // Key-value pair (key: value)
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        currentKey = line.slice(0, colonIdx).trim();
        currentList = null;

        let rawVal = line.slice(colonIdx + 1).trim();

        if (!rawVal) {
          // Key with block list beneath it
          continue;
        }

        // Inline array: [item1, item2]
        if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
          const inner = rawVal.slice(1, -1).trim();
          const items = inner
            .split(",")
            .map((s) => {
              const str = s.trim();
              if (
                (str.startsWith('"') && str.endsWith('"')) ||
                (str.startsWith("'") && str.endsWith("'"))
              ) {
                return str.slice(1, -1);
              }
              return str;
            })
            .filter((s) => s.length > 0);
          frontmatter[currentKey] = items;
          continue;
        }

        // Boolean
        if (rawVal === "true") {
          frontmatter[currentKey] = true;
          continue;
        }
        if (rawVal === "false") {
          frontmatter[currentKey] = false;
          continue;
        }

        // Number
        if (/^\d+$/.test(rawVal)) {
          frontmatter[currentKey] = Number.parseInt(rawVal, 10);
          continue;
        }

        // Plain string (strip surrounding quotes if present)
        if (
          (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
          (rawVal.startsWith("'") && rawVal.endsWith("'"))
        ) {
          rawVal = rawVal.slice(1, -1);
        }
        frontmatter[currentKey] = rawVal;
      }
    }
  } catch {
    // Fail-open: ignore parsing errors and return whatever was parsed so far
  }

  return { frontmatter, body };
}
