import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { TestCase, TestSuiteResult } from "./types.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function findJUnitFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".xml"))
    .map((entry) => join(dir, entry.name));
}

export function parseJUnitFile(path: string): TestSuiteResult[] {
  const xml = readFileSync(path, "utf8");
  const doc = parser.parse(xml);

  const suitesNode = doc.testsuites?.testsuite ?? doc.testsuite;
  const suiteList: unknown[] = Array.isArray(suitesNode) ? suitesNode : suitesNode ? [suitesNode] : [];

  return suiteList.map((suite) => {
    const s = suite as Record<string, unknown>;
    const rawCases = s.testcase ?? [];
    const cases = Array.isArray(rawCases) ? rawCases : [rawCases];
    return {
      name: (s["@_name"] as string | undefined) ?? path,
      tests: cases.map((c) => toTestCase(c as Record<string, unknown>)),
    };
  });
}

function toTestCase(raw: Record<string, unknown>): TestCase {
  const name = (raw["@_name"] as string | undefined) ?? "unnamed test";
  const classname = raw["@_classname"] as string | undefined;
  const timeRaw = raw["@_time"] as string | undefined;
  const timeSeconds = timeRaw ? Number(timeRaw) : undefined;

  if (raw.failure) {
    const node = raw.failure as Record<string, unknown> | string;
    return { name, classname, status: "failed", timeSeconds, message: text(node, "@_message"), details: text(node) };
  }
  if (raw.error) {
    const node = raw.error as Record<string, unknown> | string;
    return { name, classname, status: "error", timeSeconds, message: text(node, "@_message"), details: text(node) };
  }
  if (raw.skipped !== undefined) {
    return { name, classname, status: "skipped", timeSeconds };
  }
  return { name, classname, status: "passed", timeSeconds };
}

function text(node: Record<string, unknown> | string, attr?: string): string | undefined {
  if (typeof node === "string") return node;
  if (attr && typeof node[attr] === "string") return node[attr] as string;
  if ("#text" in node) return String(node["#text"]);
  return undefined;
}
