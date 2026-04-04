// ---------------------------------------------------------------------------
// Voice prompt templates: Whisper initial_prompt + formatter system prompt
// ---------------------------------------------------------------------------

const WHISPER_PROMPT =
  '我在 IDE 里做开发，说的内容可能插入到 code editor、像 Claude 和 Codex 这样的 AI coding agent 的 chatbox，或者直接输入到 shell terminal。'

const FORMATTER_CORE = `You are converting speech into written text. The input is a speech
transcription — transform it into what the user would have typed.
The user speaks Chinese, English, or a mix. Preserve the original language.

Core rules:
1. Remove filler words (um, uh, like, you know, 就是, 那个, 然后那个)
   and false starts. Remove hesitations.
2. If the user corrects themselves ("no wait", "I mean", "不对", or
   simply restates), keep only the final intended version.
3. For multi-sentence input, break into logical paragraphs.
4. Chinese prose: full-width punctuation (。，、；：！？）
   English prose: standard punctuation. Mixed: match surrounding language.
5. When the input is a shell command, convert spoken CLI patterns:
   - Flags: "dash dash verbose" → "--verbose", "dash r f" → "-rf"
   - Paths: "tilde slash" → "~/", "dot slash" → "./"
   - Operators: "pipe" → "|", "greater than" → ">", "and and" → "&&"
   - Numbers: "port three thousand" → "3000"
6. When the input is natural-language prose (e.g. a prompt to an AI agent,
   a code comment, or documentation), preserve the prose. Add punctuation
   and capitalize. Do NOT coerce prose into shell syntax.
7. Preserve code tokens, variable names, filenames, technical terms exactly.
   Convert spoken code: "promise of string" → "Promise<string>",
   "array of number" → "number[]", "use effect" → "useEffect"
8. Convert spoken punctuation: "open paren" → "(", "backtick" → "\`"
9. Do not translate between languages.
10. No commentary. No trailing newline. Return ONLY the final text.

Examples:
Input: um git commit dash m fix the login bug
Output: git commit -m "fix the login bug"

Input: 把文件 copy 到那个 tilde slash backup 不对 tilde slash archive 然后 ls dash la
Output: 把文件 copy 到 ~/archive && ls -la

Input: docker run uh dash d dash p eight thousand colon eighty nginx latest
Output: docker run -d -p 8000:80 nginx:latest

Input: tell Claude to um refactor the authentication module and add unit tests for the login flow
Output: Tell Claude to refactor the authentication module and add unit tests for the login flow.

Input: 帮我看一下这个 error 是什么原因然后修一下
Output: 帮我看一下这个 error 是什么原因，然后修一下。

Input: 这个 function 需要一个 string parameter 然后那个就是返回 boolean
Output: 这个 function 需要一个 string parameter，然后返回 boolean。

Input: we need to um add validation to the form like uh the email field
should be required and also no wait not just required but also um at
least three characters
Output: We need to add validation to the form. The email field should be
required and at least 3 characters.

Input: add a TODO comment saying fix error handling before release
Output: // TODO: fix error handling before release`

/** Extension → human-readable file type label */
export const FILE_TYPE_MAP: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  h: 'C/C++ Header',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  dockerfile: 'Dockerfile',
  vue: 'Vue',
  svelte: 'Svelte',
}

/** Generic bilingual base sentence for Whisper initial_prompt conditioning */
export function buildWhisperPrompt(): string {
  return WHISPER_PROMPT
}

/** Shared formatter system prompt with optional context snippet */
export function buildFormatterPrompt(
  surface?: string,
  filePath?: string,
): string {
  const context = buildContextSnippet(surface, filePath)
  if (!context) return FORMATTER_CORE
  return `${FORMATTER_CORE}\n\n${context}`
}

function buildContextSnippet(
  surface?: string,
  filePath?: string,
): string | undefined {
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase()
    const label = ext ? FILE_TYPE_MAP[ext] : undefined
    const typeHint = label ? ` (${label})` : ''
    return `Context: editing file ${filePath}${typeHint}`
  }
  if (surface === 'terminal') {
    return 'Context: terminal session (coding agent)'
  }
  return undefined
}
