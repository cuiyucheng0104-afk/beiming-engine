// legacy-page 帧源的统一出口：能力声明、会话接口，和已发布作品的锁文件与基线核对
export { caps, THREE_VERSION, VERSION } from './caps.mjs';
export { open, pageDriver, pixelHash, SourceError, SRGB_TO_LINEAR } from './host.mjs';
export { getBaselineHashes, loadLegacyLock, PUBLISHED_LOCKS, PUBLISHED_WORKS, verifyBaselineHashes } from './locks.mjs';
