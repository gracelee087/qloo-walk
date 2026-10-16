// Assemble the publish folder for Netlify — the app's static assets ONLY,
// so repo docs/scripts/renders never end up on the public site.
// Used by netlify.toml's build command (CI) and by manual CLI deploys.
import { cpSync, rmSync, mkdirSync } from "node:fs";

const OUT = ".netlify-publish";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync("index.html", `${OUT}/index.html`);
for (const d of ["css", "js", "data"]) cpSync(d, `${OUT}/${d}`, { recursive: true });
console.log("site assembled →", OUT);
