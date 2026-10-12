// A stylesheet import is a side effect only: the bundle injects it as a `<style>` tag when the
// plugin's factory runs (see tsdown.config.ts).
declare module '*.css' {}
