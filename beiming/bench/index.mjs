// 考题、跑题器、看板与人工审片三页面（B1 / B8 / B9 / B11）统一导出入口
export {
  formatMetricRef,
  normalizeQuestionDraft,
  parseMetricRef,
  projectPublicQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './validate-question.mjs';
export { RESULT_FORMAT, SOURCES, defaultJudge, hasBlockedByChanged, runExamQuestion } from './runner.mjs';
export {
  ALLOWED_RENDERERS,
  BOARD_FORMAT,
  FILM_TYPES,
  TOTAL_PRIORS_BASELINE,
  UNSUPPORTED_REASON,
  appendBoardHistory,
  buildBoard,
  renderBoardHtml,
} from './board.mjs';
export { WALL_FORMAT, DEFAULT_MAX_DAILY, buildFilmWall, renderFilmWallHtml } from './wall.mjs';
export {
  LEDGER_FORMAT,
  MISSED_LAYERS,
  recordRejection,
  translateRejection,
  confirmRejectionTriage,
  recordLedgerRead,
  computeWeeklyRejectionStats,
  loadLedgerState,
  renderLedgerHtml,
} from './wall.mjs';
export {
  BLIND_PUBLIC_FORMAT,
  BLIND_KEY_FORMAT,
  BLIND_BALLOT_FORMAT,
  BLIND_REPORT_FORMAT,
  AGREEMENT_DISABLE_THRESHOLD,
  createBlindSession,
  renderBlindPageHtml,
  recordBlindBallot,
  unblindBlindSession,
} from './wall.mjs';
