import { compactPlanLine } from '../ui/format.js';
import {
  prepareArchiveRootReview,
  selectArchiveRoot,
} from '../archive/root-choice.js';

export { prepareArchiveRootReview, selectArchiveRoot };

export function showArchiveRootChoice(controller, review) {
  controller.showMenu('archive-root-choice', archiveRootMenuItems(review), 'Archive root needs confirmation', 0, [
    `The ZIP contains one top-level directory: ${review.wrapper}/`,
    'Using the wrong root could create one new folder while removing or replacing the actual project files.',
  ]);
  controller.message('Archive root needs confirmation', archiveRootActivityLines(review), 'warning');
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
