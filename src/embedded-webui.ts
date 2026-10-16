/**
 * The built dashboard and the default prompt guides, embedded into the
 * compiled binary.
 *
 * This checked-in copy is a STUB (empty maps) so tsc/tsx pass in a checkout
 * without webui/dist. `npm run build:binary` regenerates this file
 * (scripts/embed-assets.mjs) with real `with { type: "text" }` imports that
 * Bun's --compile packs into the executable.
 */

export const EMBEDDED_WEBUI: Record<string, string> = {};
export const EMBEDDED_PROMPTS: Record<string, string> = {};
