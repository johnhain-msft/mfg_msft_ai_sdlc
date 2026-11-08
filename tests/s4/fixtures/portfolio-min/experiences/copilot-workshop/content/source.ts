// Where the curriculum this workshop teaches lives, and the one revision every link points at.
import provenance from '../provenance.json';

export const REPOSITORY: string = provenance.repository;
export const DOCUMENT_COMMIT: string = provenance.documentCommit;

/** A file of the pinned revision on GitHub, optionally at a heading anchor. */
export const sourceUrl = (path: string, anchor?: string): string =>
  `${REPOSITORY}/blob/${DOCUMENT_COMMIT}/${path}${anchor ? `#${anchor}` : ''}`;

/** A directory of the pinned revision on GitHub. */
export const treeUrl = (path: string): string => `${REPOSITORY}/tree/${DOCUMENT_COMMIT}/${path}`;

/** The project page the whole workshop belongs to. */
export const PROJECT_PAGE = '/projects/everything-github-copilot/';
