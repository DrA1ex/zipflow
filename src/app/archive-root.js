import { rebaseExtractedArchive } from '../archive/extract.js';
import { buildUpdatePlan } from '../plan/build.js';
import { compactPlanLine } from '../ui/format.js';

export async function prepareArchiveRootReview({ project, workflow, extracted }) {
  const wrapper = extracted.wrapperPrefix;
  if (!wrapper) {
    const plan = await buildUpdatePlan({ project, workflow, extracted });
    return { prompt: false, extracted, plan };
  }
  const stripped = rebaseExtractedArchive(extracted, wrapper);
  const nested = rebaseExtractedArchive(extracted, null);
  const [strippedPlan, nestedPlan] = await Promise.all([
    buildUpdatePlan({ project, workflow, extracted: stripped }),
    buildUpdatePlan({ project, workflow, extracted: nested }),
  ]);
  const strippedMatch = planMatchCount(strippedPlan);
  const nestedMatch = planMatchCount(nestedPlan);
  const suspiciousNested = strippedMatch >= Math.max(2, nestedMatch + 2)
    || nestedPlan.counts.deleted >= Math.max(5, strippedPlan.counts.deleted + 5)
    || (nestedPlan.counts.created >= 5 && strippedPlan.counts.created < nestedPlan.counts.created / 2);
  if (!suspiciousNested) {
    const useStripped = Boolean(extracted.rootPrefix);
    return { prompt: false, extracted: useStripped ? stripped : nested, plan: useStripped ? strippedPlan : nestedPlan };
  }
  return {
    prompt: true,
    wrapper,
    stripped,
    nested,
    strippedPlan,
    nestedPlan,
    strippedMatch,
    nestedMatch,
  };
}

export function showArchiveRootChoice(controller, review) {
  controller.showMenu('archive-root-choice', archiveRootMenuItems(review), 'Archive root needs confirmation', 0, [
    `The ZIP contains one top-level directory: ${review.wrapper}/`,
    'Using the wrong root could create one new folder while removing or replacing the actual project files.',
  ]);
  controller.message('Archive root needs confirmation', archiveRootActivityLines(review), 'warning');
}

export function selectArchiveRoot(review, itemId) {
  if (itemId === 'use-wrapper-root') {
    return { extracted: review.stripped, plan: review.strippedPlan, useRoot: true };
  }
  if (itemId === 'keep-wrapper-directory') {
    return { extracted: review.nested, plan: review.nestedPlan, useRoot: false };
  }
  return null;
}

export function archiveRootMenuItems(review) {
  return [
    {
      id: 'use-wrapper-root',
      label: `Use ${review.wrapper}/ as the archive root`,
      description: `Recommended · matches ${review.strippedMatch} existing paths · ${compactPlanLine(review.strippedPlan)}`,
    },
    {
      id: 'keep-wrapper-directory',
      label: `Keep ${review.wrapper}/ as a project subdirectory`,
      description: `Apply the archive literally · matches ${review.nestedMatch} existing paths · ${compactPlanLine(review.nestedPlan)}`,
    },
    { id: 'cancel-root-review', label: 'Cancel and choose another archive', description: 'Do not modify the project.' },
  ];
}

export function archiveRootActivityLines(review) {
  return [
    `${review.wrapper}/ contains the incoming project tree.`,
    `As root: ${compactPlanLine(review.strippedPlan)}.`,
    `As subdirectory: ${compactPlanLine(review.nestedPlan)}.`,
  ];
}

function planMatchCount(plan) {
  return plan.counts.updated + plan.counts.unchanged;
}
