import path from 'node:path';
import { REPO_ROOT, loadProfiles as loadSharedProfiles } from '../../../engine/render/lib/qa-profiles.mjs';

export { REPO_ROOT, AUTHORITATIVE, resolveProfile, parseFps, fpsOf } from '../../../engine/render/lib/qa-profiles.mjs';
export const QA_DIR = path.join(REPO_ROOT, 'tools/qa');
export const BUILTIN_SOURCE = 'tools/qa/profiles.builtin.json';
export const loadProfiles = opts => loadSharedProfiles(opts, BUILTIN_SOURCE);
