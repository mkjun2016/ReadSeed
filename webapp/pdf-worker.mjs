// Static imports run in order, so the polyfill is in place before PDF.js loads.
// A top-level await here would make Safari drop the first messages PDF.js sends.
import "./promise-polyfill.mjs";
import "/shared/vendor/pdfjs/pdf.worker.min.mjs";
