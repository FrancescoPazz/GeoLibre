import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@geolibre/ui";
import { BookOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** The guides, each a list of sections of numbered steps; the text lives in i18n under `guides.*`. */
const GUIDES: ReadonlyArray<{
  id: string;
  sections: ReadonlyArray<{ id: string; steps: number }>;
}> = [
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

interface GuidesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Help → Guides: the geoportal's step-by-step guides for the measurement
 * tools and Play Path — the old geoportal's "trainer" help panes, with the
 * steps rewritten for where the tools live here (Controls → 3D Measure,
 * Controls → Play Path, the terrain profile, Save as layer).
 */
export function GuidesDialog({ open, onOpenChange }: GuidesDialogProps) {
  const { t } = useTranslation();
  const [guideId, setGuideId] = useState(GUIDES[0].id);
  const guide = GUIDES.find((g) => g.id === guideId) ?? GUIDES[0];
  // The keys are built from the guide table above, so they are typed by hand.
  const key = (path: string) => `guides.${guide.id}.${path}` as "guides.measureTools.intro";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="guides-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-sky-500" />
            {t("guides.title")}
          </DialogTitle>
          <DialogDescription>{t("guides.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1 border-b border-border pb-2" role="tablist">
          {GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={g.id === guide.id}
              className={`rounded-md px-3 py-1 text-xs ${g.id === guide.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setGuideId(g.id)}
            >
              {t(`guides.${g.id}.title` as "guides.measureTools.title")}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{t(key("intro"))}</p>
        <div className="space-y-4">
          {guide.sections.map((section) => (
            <section key={section.id} className="space-y-2">
              {guide.sections.length > 1 ? (
                <h3 className="text-sm font-semibold">
                  {t(`guides.${guide.id}.${section.id}.title` as "guides.playPath.playback.title")}
                </h3>
              ) : null}
              <ol className="space-y-2 ps-5">
                {Array.from({ length: section.steps }, (_, i) => i + 1).map((n) => (
                  <li key={n} className="list-decimal text-sm">
                    <div className="font-medium">
                      {t(
                        `guides.${guide.id}.${section.id}.step${n}.title` as "guides.measureTools.gettingStarted.step1.title",
                      )}
                    </div>
                    <p className="whitespace-pre-line text-xs text-muted-foreground">
                      {t(
                        `guides.${guide.id}.${section.id}.step${n}.text` as "guides.measureTools.gettingStarted.step1.text",
                      )}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
