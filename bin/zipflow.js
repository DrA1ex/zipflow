#!/usr/bin/env node
import { ZIPFLOW_VERSION } from '../src/version.js';

const arguments_ = process.argv.slice(2);

if (arguments_.some((argument) => argument === '--version' || argument === '-v')) {
  process.stdout.write(`${ZIPFLOW_VERSION}\n`);
} else if (arguments_[0] === 'serve') {
  const { runZipflowServe } = await import('../src/server/serve-command.js');
  runZipflowServe({
    argv: arguments_.slice(1),
    onShutdownError: reportServeFailure,
  }).catch(reportServeFailure);
} else {
  const { startZipflow } = await import('../src/index.js');
  startZipflow().catch((error) => {
    console.error(`Zipflow failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}

function reportServeFailure(error) {
  console.error(`Zipflow server failed: ${error.message}`);
  process.exitCode = 1;
}
