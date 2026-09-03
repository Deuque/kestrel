export type TestStatus = "passed" | "failed" | "skipped" | "error";

export interface TestCase {
  name: string;
  classname?: string;
  status: TestStatus;
  timeSeconds?: number;
  message?: string;
  details?: string;
  screenshotPath?: string;
}

export interface TestSuiteResult {
  name: string;
  tests: TestCase[];
}

export interface RunSummary {
  suites: TestSuiteResult[];
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  startedAt: string;
  finishedAt: string;
  testCommandExitCode: number;
}
