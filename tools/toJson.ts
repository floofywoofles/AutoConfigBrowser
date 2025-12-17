import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { getDefaultFirefoxProfileDirectoryPath } from "./profile-discovery";

// Type definitions
type UrlsJson = Readonly<{ urls: readonly string[] }>;

type FirefoxAddOnSource = Readonly<{
  sourceURI?: string;
}>;

type FirefoxAddOn = Readonly<{
  active?: boolean;
  defaultLocale?: Readonly<{ name?: string }>;
  id?: string;
  location?: string;
  sourceURI?: string;
  type?: string;
}>;

type FirefoxExtensionsJson = Readonly<{
  addons?: readonly FirefoxAddOn[];
}>;

type FirefoxAddonsJson = Readonly<{
  addons?: readonly FirefoxAddOnSource[];
}>;

// Constants
const URLS_JSON_RELATIVE_PATH: string = "./src/urls.json";
const FIREFOX_EXTENSIONS_JSON_FILENAME: string = "extensions.json";
const FIREFOX_ADDONS_JSON_FILENAME: string = "addons.json";
const FIREFOX_PROFILE_LOCATION_PROFILE: string = "app-profile";
const FIREFOX_ADDON_TYPE_EXTENSION: string = "extension";

/**
 * Create (or overwrite) `src/urls.json` based on extensions currently installed in Firefox.
 * The function finds your default Firefox profile via `profiles.ini`, reads `extensions.json` (preferred)
 * or `addons.json` (fallback), then writes the collected `sourceURI` values as `urls`.
 */
export const writeUrlsJsonFromInstalledFirefoxExtensions = async (): Promise<UrlsJson> => {
  const profileDirectoryPath: string = await getDefaultFirefoxProfileDirectoryPath();
  const urls: readonly string[] = await getInstalledExtensionSourceUrls({ profileDirectoryPath });
  const urlsJson: UrlsJson = { urls };
  await writeJsonFile({ absoluteOrRelativeFilePath: URLS_JSON_RELATIVE_PATH, json: urlsJson });
  return urlsJson;
};

// Get source URLs from the profile's installed extensions
const getInstalledExtensionSourceUrls = async (params: Readonly<{ profileDirectoryPath: string }>): Promise<readonly string[]> => {
  const extensionsJsonPath: string = resolve(params.profileDirectoryPath, FIREFOX_EXTENSIONS_JSON_FILENAME);
  if (existsSync(extensionsJsonPath)) {
    const extensionsJsonText: string = await Bun.file(extensionsJsonPath).text();
    const extensionsJson: FirefoxExtensionsJson = parseJson<FirefoxExtensionsJson>({ jsonText: extensionsJsonText, filePathForErrors: extensionsJsonPath });
    return extractUrlsFromExtensionsJson({ extensionsJson });
  }
  const addonsJsonPath: string = resolve(params.profileDirectoryPath, FIREFOX_ADDONS_JSON_FILENAME);
  if (existsSync(addonsJsonPath)) {
    const addonsJsonText: string = await Bun.file(addonsJsonPath).text();
    const addonsJson: FirefoxAddonsJson = parseJson<FirefoxAddonsJson>({ jsonText: addonsJsonText, filePathForErrors: addonsJsonPath });
    return extractUrlsFromAddonsJson({ addonsJson });
  }
  throw new Error(`Could not find ${FIREFOX_EXTENSIONS_JSON_FILENAME} or ${FIREFOX_ADDONS_JSON_FILENAME} in profile directory: ${params.profileDirectoryPath}`);
};

// Extract URLs from extensions.json (active extensions only)
const extractUrlsFromExtensionsJson = (params: Readonly<{ extensionsJson: FirefoxExtensionsJson }>): readonly string[] => {
  const addons: readonly FirefoxAddOn[] = params.extensionsJson.addons ?? [];
  const urls: string[] = [];
  for (const addon of addons) {
    const isExtension: boolean = addon.type === FIREFOX_ADDON_TYPE_EXTENSION;
    if (!isExtension) {
      continue;
    }
    const isFromProfile: boolean = addon.location === FIREFOX_PROFILE_LOCATION_PROFILE;
    if (!isFromProfile) {
      continue;
    }
    const isActive: boolean = addon.active === true;
    if (!isActive) {
      continue;
    }
    const sourceUrl: string | undefined = addon.sourceURI;
    if (!sourceUrl) {
      continue;
    }
    urls.push(sourceUrl);
  }
  return uniqStable(urls);
};

// Extract URLs from addons.json (fallback)
const extractUrlsFromAddonsJson = (params: Readonly<{ addonsJson: FirefoxAddonsJson }>): readonly string[] => {
  const addons: readonly FirefoxAddOnSource[] = params.addonsJson.addons ?? [];
  const urls: string[] = [];
  for (const addon of addons) {
    const sourceUrl: string | undefined = addon.sourceURI;
    if (!sourceUrl) {
      continue;
    }
    urls.push(sourceUrl);
  }
  return uniqStable(urls);
};

// Write JSON file to disk with proper formatting
const writeJsonFile = async (params: Readonly<{ absoluteOrRelativeFilePath: string; json: unknown }>): Promise<void> => {
  const resolvedPath: string = resolve(params.absoluteOrRelativeFilePath);
  const dirPath: string = dirname(resolvedPath);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const jsonText: string = JSON.stringify(params.json, null, 2);
  await Bun.write(resolvedPath, `${jsonText}\n`);
};

// Parse JSON with error handling
const parseJson = <T>(params: Readonly<{ jsonText: string; filePathForErrors: string }>): T => {
  try {
    return JSON.parse(params.jsonText) as T;
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from ${params.filePathForErrors}: ${message}`);
  }
};

// Remove duplicates while preserving order
const uniqStable = (items: readonly string[]): readonly string[] => {
  const seen: Set<string> = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
};

// CLI entrypoint
if (import.meta.main) {
  await writeUrlsJsonFromInstalledFirefoxExtensions().then((urlsJson: UrlsJson) => {
    console.log(`Wrote ${URLS_JSON_RELATIVE_PATH} with ${urlsJson.urls.length} URL(s).`);
  });
}
