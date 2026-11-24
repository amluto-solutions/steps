// `pdfmake` in the tests (vitest.config.ts), loaded as each test file's environment would load it.
// Under jsdom it's the browser bundle the apps' builds use (pdfmake's `browser` field). The Node
// build can't load there: pdfkit 0.20 takes jsdom's `document` for a browser and works out its own
// address as http://localhost:3000/pdfkit.js (#132). In plain Node, where the export tests draw
// real PDFs, it's the Node build: the browser bundle needs `Worker` to unpack PNG images.

const pdfmake =
  typeof document === "undefined"
    ? await import("pdfmake/js/index.js")
    : await import("pdfmake/build/pdfmake.js");

export default pdfmake.default ?? pdfmake;
