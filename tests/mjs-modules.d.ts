// Plain .mjs fixtures and scripts have no type declarations; tests import them
// through createRequire-style dynamic imports that are intentionally untyped.
declare module "*.mjs";
