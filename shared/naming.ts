/**
 * Peer naming helpers: slugs and prompt-derived names.
 */

const STOPWORDS = new Set([
  // FR
  "les", "des", "une", "aux", "est", "que", "qui", "quoi", "pas", "pour",
  "avec", "dans", "sur", "par", "mes", "mon", "tes", "ton", "ses", "son",
  "nos", "vos", "ils", "elles", "nous", "vous", "tout", "tous", "toute",
  "toutes", "fait", "faire", "faut", "veux", "peux", "peut", "bien", "tres",
  "comme", "mais", "donc", "alors", "ensuite", "aussi", "encore", "deja",
  "ici", "quand", "comment", "pourquoi", "est-ce", "cette", "ces", "leur",
  "leurs", "moi", "toi", "lui", "etre", "avoir", "sont", "etait", "sera",
  // EN
  "the", "and", "for", "with", "this", "that", "you", "your", "are", "can",
  "what", "when", "how", "why", "please", "want", "need", "make", "have",
  "has", "had", "was", "were", "will", "would", "should", "could", "into",
  "from", "about", "then", "than", "them", "they", "there", "here", "just",
  "also", "some", "any", "all", "not", "now", "let", "lets", "its",
]);

/** Lowercase ASCII slug, hyphen-separated, max 40 chars, no leading/trailing hyphen. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Derive a peer name from a user prompt: strip stopwords, keep the first 4
 * significant tokens (>= 3 chars). Returns null when the prompt has fewer
 * than 4 significant tokens (too weak to name a session from).
 */
export function deriveNameFromPrompt(prompt: string): string | null {
  const tokens = prompt
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length < 4) return null;
  return slugify(tokens.slice(0, 4).join("-"));
}
