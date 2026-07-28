import { rebaseExtractedArchive } from './extract.js';
import { buildUpdatePlan } from '../plan/build.js';

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
    return {
      prompt: false,
      extracted: useStripped ? stripped : nested,
      plan: useStripped ? strippedPlan : nestedPlan,
    };
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

export function selectArchiveRoot(review, rootId) {
  if (rootId === 'use-wrapper-root') {
    return { extracted: review.stripped, plan: review.strippedPlan, useRoot: true };
  }
  if (rootId === 'keep-wrapper-directory') {
    return { extracted: review.nested, plan: review.nestedPlan, useRoot: false };
  }
  return null;
}

export function archiveRootChoices(review) {
  if (!review?.prompt) return [];
  return [
    {
      id: 'use-wrapper-root',
      path: review.wrapper,
      label: `Use ${review.wrapper}/ as the archive root`,
      description: `Matches ${review.strippedMatch} existing paths.`,
    },
    {
      id: 'keep-wrapper-directory',
      path: `${review.wrapper}/`,
      label: `Keep ${review.wrapper}/ as a project subdirectory`,
      description: `Matches ${review.nestedMatch} existing paths.`,
    },
  ];
}

function planMatchCount(plan) {
  return plan.counts.updated + plan.counts.unchanged;
}
