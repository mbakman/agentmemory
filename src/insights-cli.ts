#!/usr/bin/env node

import { runInsightsCli } from "./cli/insights.js";

process.exitCode = await runInsightsCli(process.argv.slice(2), true);
