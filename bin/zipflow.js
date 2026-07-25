#!/usr/bin/env node
import { ZIPFLOW_VERSION } from '../src/version.js';

if (process.argv.slice(2).some((argument) => argument === '--version' || argument === '-v')) {
  process.stdout.write(`${ZIPFLOW_VERSION}\n`);
} else {
  const { startZipflow } = await import('../src/index.js');
  startZipflow().catch((error) => {
    console.error(`Zipflow failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
