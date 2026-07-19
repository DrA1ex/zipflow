#!/usr/bin/env node
import { startZipflow } from '../src/index.js';

startZipflow().catch((error) => {
  console.error(`Zipflow failed to start: ${error.message}`);
  process.exitCode = 1;
});
