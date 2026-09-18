/* What to call the model that is answering.
 *
 * The providers hand over an id built for an API — `claude-opus-5`,
 * `gpt-6-astra`, `claude-sonnet-4-5-20250929` — and that string is a third of
 * a card's width, most of it punctuation and a date. What a person calls it is
 * two words.
 *
 * ⚠️ Rules, not a table. A lookup of known ids is wrong the week a model ships
 * and stays wrong until somebody notices, which for a personal tool is never —
 * and being wrong here means a card that says nothing about what it is
 * spending. Anything unrecognised falls through to its own id, tidied.
 */

/** `2025 09 29` — the build date at the end of a Claude id, and nothing else. */
const DATE = /^\d{8}$/;

function titled(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * `claude-sonnet-4-5-20250929` -> `Sonnet 4.5`, `gpt-6-astra` -> `GPT-6 Astra`.
 *
 * @param id as the provider writes it. Empty or unknown gives `""`.
 */
export function modelName(id?: string | null): string {
  const parts = (id ?? "").toLowerCase().split(/[-_]/).filter(Boolean).filter(part => !DATE.test(part));
  if (!parts.length) return "";

  if (parts[0] === "claude") {
    const rest = parts.slice(1);
    /* ⚠️ The version can sit on EITHER side of the family: `claude-opus-5`
     * and `claude-3-5-haiku` are both real and both mean the same shape of
     * thing. So the digits are collected wherever they fall and the words
     * keep their own order. */
    const digits = rest.filter(part => /^\d+$/.test(part));
    const words = rest.filter(part => !/^\d+$/.test(part)).map(titled);
    const version = digits.join(".");
    return [words.join(" "), version].filter(Boolean).join(" ");
  }

  if (parts[0] === "gpt" || parts[0] === "o") {
    /* The number belongs TO the name here — "GPT 6" is not a thing, "GPT-6"
     * is — so the first number keeps its hyphen and the rest are words. */
    const [, second, ...rest] = parts;
    const head = /^[\d.]+$/.test(second ?? "") ? `GPT-${second}` : "GPT";
    const tail = (/^[\d.]+$/.test(second ?? "") ? rest : [second, ...rest])
      .filter(Boolean)
      .map(titled);
    return [head, ...tail].join(" ");
  }

  // Anything else: its own id, tidied, rather than a blank or a guess.
  return parts.map(titled).join(" ");
}
