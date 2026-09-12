import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The Guides dialog builds its i18n keys from a table of sections and step
// counts; every key it can build must exist in both shipped locales.
const GUIDES = [
  { id: "measureTools", sections: [{ id: "gettingStarted", steps: 9 }] },
  {
    id: "playPath",
    sections: [
      { id: "gettingStarted", steps: 5 },
      { id: "playback", steps: 3 },
      { id: "camera", steps: 2 },
      { id: "tips", steps: 3 },
    ],
  },
];

describe("guides dialog", () => {
  for (const lang of ["en", "it"]) {
    it(`has every guide string in ${lang}`, () => {
      const locale = JSON.parse(
        readFileSync(
          new URL(`../apps/geolibre-desktop/src/i18n/locales/${lang}.json`, import.meta.url),
          "utf8",
        ),
      ) as { guides: Record<string, unknown>; toolbar: { command: Record<string, string> } };
      const guides = locale.guides as Record<string, Record<string, unknown>>;
      assert.equal(typeof locale.toolbar.command.guides, "string");
      for (const guide of GUIDES) {
        const g = guides[guide.id];
        assert.equal(typeof g.title, "string", `${guide.id}.title`);
        assert.equal(typeof g.intro, "string", `${guide.id}.intro`);
        for (const section of guide.sections) {
          const s = g[section.id] as Record<string, { title?: string; text?: string }>;
          assert.equal(typeof s.title, "string", `${guide.id}.${section.id}.title`);
          for (let n = 1; n <= section.steps; n += 1) {
            const step = s[`step${n}`];
            assert.equal(typeof step?.title, "string", `${guide.id}.${section.id}.step${n}.title`);
            assert.equal(typeof step?.text, "string", `${guide.id}.${section.id}.step${n}.text`);
          }
          assert.equal(
            s[`step${section.steps + 1}`],
            undefined,
            `${guide.id}.${section.id} has more steps than the table`,
          );
        }
      }
    });
  }
});
