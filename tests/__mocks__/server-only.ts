// No-op replacement for the `server-only` package in the Vitest node
// environment. The real package throws unconditionally to prevent client-side
// imports; we replace it with a harmless export so unit tests can import
// server-side modules without Next.js runtime context.
export {};
