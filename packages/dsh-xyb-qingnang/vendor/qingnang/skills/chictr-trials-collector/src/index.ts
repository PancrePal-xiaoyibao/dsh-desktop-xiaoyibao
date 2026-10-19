#!/usr/bin/env node

import { BrowserManager } from "./browser.js";
import { getTrialDetail } from "./services/detail.js";
import { searchTrials } from "./services/search.js";
import { ChallengeDetector } from "./runtime/challenge-detector.js";
import { validateRegistrationNumber, validateSearchInput } from "./runtime/input-validation.js";
import { RequestOrchestrator } from "./runtime/orchestrator.js";
import { closeGlobalCacheManager } from "./runtime/cache-singleton.js";

interface CliArguments {
  command?: "search" | "detail";
  options: Record<string, string>;
}

function parseCliArguments(argv: string[]): CliArguments {
  const [command, ...rawOptions] = argv;
  if (command !== "search" && command !== "detail") {
    return { options: {} };
  }

  const options: Record<string, string> = {};
  for (let index = 0; index < rawOptions.length; index += 2) {
    const key = rawOptions[index];
    const value = rawOptions[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`无效参数: ${key ?? ""}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function printHelp(): void {
  console.log(`ChiCTR Trials Collector

Usage:
  chictr-trials-collector search [--keyword <text>] [--registration-number <ChiCTR...>] [--year <YYYY>] [--max-results <1-100>]
  chictr-trials-collector detail --registration-number <ChiCTR...>

Examples:
  chictr-trials-collector search --keyword "胰腺癌" --year 2026 --max-results 10
  chictr-trials-collector detail --registration-number ChiCTR2500111173

Environment:
  CACHE_DB_PATH, HTTP_PROXY, HTTPS_PROXY
`);
}

async function main(): Promise<void> {
  const { command, options } = parseCliArguments(process.argv.slice(2));
  if (!command) {
    printHelp();
    return;
  }

  const browserManager = new BrowserManager();
  const orchestrator = RequestOrchestrator.createDefault();
  const challengeDetector = new ChallengeDetector(
    Number(process.env.CHALLENGE_COOLDOWN_MS || 10 * 60 * 1000)
  );

  try {
    await browserManager.initialize();
    if (command === "search") {
      const input = validateSearchInput({
        keyword: options.keyword,
        registration_number: options["registration-number"],
        year: options.year === undefined ? undefined : Number(options.year),
        max_results: options["max-results"] === undefined ? undefined : Number(options["max-results"]),
      });
      const results = await searchTrials(
        browserManager,
        orchestrator,
        challengeDetector,
        input.keyword,
        input.registrationNumber,
        input.year,
        input.maxResults
      );
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    const registrationNumber = validateRegistrationNumber(options["registration-number"]);
    const detail = await getTrialDetail(browserManager, orchestrator, challengeDetector, registrationNumber);
    console.log(JSON.stringify(detail, null, 2));
  } finally {
    await browserManager.close();
    closeGlobalCacheManager();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
