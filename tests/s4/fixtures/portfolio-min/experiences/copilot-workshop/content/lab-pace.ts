// Lab pace figures, read from the merged curriculum at the pinned revision so they are never typed twice:
//   presenter / selfPaced  <- `pace:` front matter of labs/<id>.md
//   workshop               <- `pace_workshop_minutes` in docs/_meta/registry.yaml (hosted labs only)
// Regenerate with `npm run sync:workshop-source -- <path to a clean checkout of the pinned revision>`.
export interface LabPace {
  title: string;
  presenter: number;
  selfPaced: number;
  workshop: number | null;
}

export const labPace: Record<string, LabPace> = {
  lab01: { title: 'Lab 1', presenter: 4, selfPaced: 15, workshop: 6 },
  lab02: { title: 'Lab 2', presenter: 4, selfPaced: 15, workshop: 6 },
  lab03: { title: 'Lab 3', presenter: 4, selfPaced: 15, workshop: 6 },
  lab04: { title: 'Lab 4', presenter: 4, selfPaced: 15, workshop: 6 },
  lab05: { title: 'Lab 5', presenter: 4, selfPaced: 15, workshop: 6 },
  lab06: { title: 'Lab 6', presenter: 4, selfPaced: 15, workshop: 6 },
  lab07: { title: 'Lab 7', presenter: 4, selfPaced: 15, workshop: 6 },
  lab08: { title: 'Lab 8', presenter: 4, selfPaced: 15, workshop: 6 },
  lab09: { title: 'Lab 9', presenter: 4, selfPaced: 15, workshop: 6 },
  lab10: { title: 'Lab 10', presenter: 4, selfPaced: 15, workshop: 6 },
  lab11: { title: 'Lab 11', presenter: 4, selfPaced: 15, workshop: 6 },
  lab12: { title: 'Lab 12', presenter: 4, selfPaced: 15, workshop: 6 },
  lab13: { title: 'Lab 13', presenter: 4, selfPaced: 15, workshop: 6 },
  lab14: { title: 'Lab 14', presenter: 4, selfPaced: 15, workshop: 6 },
  lab15: { title: 'Lab 15', presenter: 4, selfPaced: 15, workshop: 6 },
  lab16: { title: 'Lab 16', presenter: 4, selfPaced: 15, workshop: 6 },
  lab17: { title: 'Lab 17', presenter: 4, selfPaced: 15, workshop: 6 },
  lab18: { title: 'Lab 18', presenter: 4, selfPaced: 15, workshop: 6 },
  lab19: { title: 'Lab 19', presenter: 4, selfPaced: 15, workshop: 6 },
  lab20: { title: 'Lab 20', presenter: 4, selfPaced: 15, workshop: 6 },
  'lab-gh-extensions': { title: 'Building a GitHub CLI Extension', presenter: 4, selfPaced: 30, workshop: null },
  'lab-copilot-cli-extensions': { title: 'Authoring a CLI Extension', presenter: 4, selfPaced: 30, workshop: null },
  'lab-hardening': { title: 'Hardening', presenter: 4, selfPaced: 30, workshop: null },
};
