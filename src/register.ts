/**
 * Import-side-effect entry point for `node --import filehandle-leak/register`.
 * Starts tracking with default options as soon as this module is loaded, before
 * application code runs — so opens that happen at startup are covered too.
 *
 * Options are not configurable through this entry point; call `track()` directly
 * from your own code if you need `stackDepth`, `onLeak` or `strict`.
 */
import { track } from './tracker.ts';

track();
