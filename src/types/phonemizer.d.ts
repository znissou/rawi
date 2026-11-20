// The `phonemizer` package (espeak-ng in WebAssembly) declares its types through package "exports",
// which this project's CommonJS module resolution doesn't read.
declare module 'phonemizer' {
  /** IPA phonemes for `text`, one string per clause (punctuation dropped). */
  export function phonemize(text: string, language?: string): Promise<string[]>;
}
