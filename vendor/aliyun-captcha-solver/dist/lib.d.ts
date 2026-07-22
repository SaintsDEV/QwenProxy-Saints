export { solve } from './solver.js';
export { templateMatch } from './vision.js';
export { generateHumanTrack, resolveGestureProfile } from './trajectory.js';
export { connectCDP, extractPuzzleImages, dragSlider, checkCaptchaResult, installCaptchaHook, readCapturedParam, getCertifyId, clickTrigger, waitForSelector, sleep, captureScreenshot } from './cdp.js';
export type { SolveOptions, SolveResult } from './solver.js';
export type { CDPClient, PuzzleImages, CaptchaResult } from './cdp.js';
export type { MatchResult } from './vision.js';
export type { GestureProfile, TrackPoint } from './trajectory.js';
