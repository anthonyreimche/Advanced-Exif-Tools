// Bundle the extension to a single self-contained ESM file with an
// `activate(api)` export. React is left external and NOT imported: JSX compiles
// to classic `React.createElement(...)` calls that resolve to the app's React
// instance, which every module pulls from `./rt` (assigned once in activate).
// The store fetches this dist/ as-is — installs never run a build.
export default {
  input: "src/index.tsx",
  // Nothing is imported from "react"; marking it external is belt-and-braces so
  // a stray import can never bundle a second copy (which would break hooks).
  external: ["react", "react-dom", "react/jsx-runtime"],
  transform: {
    // Classic transform: JSX compiles to `React.createElement(...)`, resolving
    // to the app's React that every module pulls from ./rt — no react import.
    jsx: {
      runtime: "classic",
      pragma: "React.createElement",
      pragmaFrag: "React.Fragment",
    },
  },
  output: {
    file: "dist/index.js",
    format: "esm",
    // A metadata/rename tool is not hot; readable output aids trust review.
    minify: false,
  },
};
