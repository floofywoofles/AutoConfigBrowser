import { existsSync } from "fs";
import { resolve } from "path";

// Constants
const FIREFOX_PROFILES_INI_FILENAME: string = "profiles.ini";
const FIREFOX_PROFILE_SUBDIR_NAME: string = "Profiles";
const FIREFOX_EXTENSIONS_JSON_FILENAME: string = "extensions.json";
const FIREFOX_ADDONS_JSON_FILENAME: string = "addons.json";
const FIREFOX_PROFILE_DIR_SUFFIX: string = ".default";
const FIREFOX_PROFILE_DIR_SUFFIX_RELEASE: string = ".default-release";

/**
 * Type definitions for Firefox/Zen profile metadata
 */
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

/**
 * Get the base directory where Firefox/Zen stores profiles for the current platform.
 * - Linux: `~/.mozilla/firefox`
 * - macOS: `~/Library/Application Support/Firefox` (or Zen if found)
 * - Windows: `%APPDATA%/Mozilla/Firefox`
 * @returns The base Firefox/Zen directory path
 * @throws Error if required environment variables are missing
 */
export const getFirefoxBaseDirectoryPath = (): string => {
  const homeDir: string = process.env.HOME ?? "";
  if (!homeDir) {
    throw new Error("HOME environment variable is not set; cannot locate Firefox profile directory.");
  }
  const platform: NodeJS.Platform = process.platform;
  if (platform === "darwin") {
    const candidates: readonly string[] = [
      resolve(homeDir, "Library", "Application Support", "Firefox"),
      resolve(homeDir, "Library", "Application Support", "zen"),
    ];
    const baseDir: string | null = pickFirstBaseDirWithProfilesIni({ candidates });
    if (!baseDir) {
      return candidates[0] as string;
    }
    return baseDir;
  }
  if (platform === "win32") {
    const appData: string = process.env.APPDATA ?? "";
    if (!appData) {
      throw new Error("APPDATA environment variable is not set; cannot locate Firefox profile directory on Windows.");
    }
    return resolve(appData, "Mozilla", "Firefox");
  }
  return resolve(homeDir, ".mozilla", "firefox");
};

/**
 * Get the default Firefox/Zen profile directory path by reading profiles.ini
 * @returns The full path to the default profile directory
 * @throws Error if profiles.ini cannot be found or parsed
 */
export const getDefaultFirefoxProfileDirectoryPath = async (): Promise<string> => {
  const profilesIniPath: string = resolve(getFirefoxBaseDirectoryPath(), FIREFOX_PROFILES_INI_FILENAME);
  if (!existsSync(profilesIniPath)) {
    throw new Error(`Firefox profiles.ini not found at: ${profilesIniPath}`);
  }
  const profilesIniText: string = await Bun.file(profilesIniPath).text();
  if (!profilesIniText.trim()) {
    throw new Error(`Firefox profiles.ini is empty: ${profilesIniPath}`);
  }
  const defaultProfileRelativePath: string | null = parseDefaultProfilePathFromProfilesIni({ profilesIniText });
  if (defaultProfileRelativePath) {
    return resolve(getFirefoxBaseDirectoryPath(), defaultProfileRelativePath);
  }
  return guessDefaultProfileDirectoryFromProfilesFolder();
};

/**
 * Get the extensions directory for the default Firefox/Zen profile.
 * Creates the directory if it doesn't exist.
 * @returns The path to the extensions directory
 * @throws Error if the profile or extensions directory cannot be found
 */
export const getFirefoxExtensionsDirectory = async (): Promise<string> => {
  const profileDirectoryPath: string = await getDefaultFirefoxProfileDirectoryPath();
  const xpiDirectory: string = resolve(profileDirectoryPath, "extensions");
  if (!existsSync(xpiDirectory)) {
    const { mkdirSync } = await import("fs");
    console.log(`Creating extensions directory: ${xpiDirectory}`);
    mkdirSync(xpiDirectory, { recursive: true });
  }
  return xpiDirectory;
};

/**
 * Read the extensions.json or addons.json from a Firefox profile and extract installed extension metadata.
 * Returns a mapping of extension sourceURI to name (or ID if name not available).
 * @param profileDirectoryPath - Path to the Firefox profile directory
 * @returns Object mapping sourceURI to display name/id
 * @throws Error if neither extensions.json nor addons.json is found
 */
export const getExtensionMetadataMap = async (
  params: Readonly<{ profileDirectoryPath: string }>
): Promise<Readonly<Record<string, string>>> => {
  const extensionsJsonPath: string = resolve(params.profileDirectoryPath, FIREFOX_EXTENSIONS_JSON_FILENAME);
  if (existsSync(extensionsJsonPath)) {
    const extensionsJsonText: string = await Bun.file(extensionsJsonPath).text();
    const extensionsJson: FirefoxExtensionsJson = parseJson<FirefoxExtensionsJson>({
      jsonText: extensionsJsonText,
      filePathForErrors: extensionsJsonPath,
    });
    return buildMetadataMap({ extensionsJson });
  }
  return {};
};

/**
 * Pick the first candidate directory that contains profiles.ini
 */
const pickFirstBaseDirWithProfilesIni = (params: Readonly<{ candidates: readonly string[] }>): string | null => {
  for (const candidate of params.candidates) {
    const profilesIniPath: string = resolve(candidate, FIREFOX_PROFILES_INI_FILENAME);
    if (!existsSync(profilesIniPath)) {
      continue;
    }
    return candidate;
  }
  return null;
};

/**
 * Parse the default profile path from profiles.ini content
 */
const parseDefaultProfilePathFromProfilesIni = (params: Readonly<{ profilesIniText: string }>): string | null => {
  const lines: readonly string[] = params.profilesIniText.split("\n");
  let inInstallSection: boolean = false;
  for (const line of lines) {
    const trimmedLine: string = line.trim();
    if (trimmedLine.startsWith("[Install")) {
      inInstallSection = true;
      continue;
    }
    if (trimmedLine.startsWith("[")) {
      inInstallSection = false;
      continue;
    }
    if (!inInstallSection) {
      continue;
    }
    if (!trimmedLine.startsWith("Default=")) {
      continue;
    }
    const [, defaultValue] = trimmedLine.split("=");
    const profilePath: string = (defaultValue ?? "").trim();
    return profilePath ? profilePath : null;
  }
  let currentProfilePath: string | null = null;
  for (const line of lines) {
    const trimmedLine: string = line.trim();
    if (trimmedLine.startsWith("[Profile")) {
      currentProfilePath = null;
      continue;
    }
    if (trimmedLine.startsWith("Path=")) {
      const [, pathValue] = trimmedLine.split("=");
      currentProfilePath = (pathValue ?? "").trim();
      continue;
    }
    if (trimmedLine.startsWith("Default=1") && currentProfilePath) {
      return currentProfilePath;
    }
  }
  return null;
};

/**
 * Guess the default profile directory from the Profiles folder
 */
const guessDefaultProfileDirectoryFromProfilesFolder = (): string => {
  const baseDir: string = getFirefoxBaseDirectoryPath();
  const profilesDir: string = resolve(baseDir, FIREFOX_PROFILE_SUBDIR_NAME);
  if (!existsSync(profilesDir)) {
    throw new Error(`Firefox Profiles directory not found: ${profilesDir}`);
  }
  const candidates: readonly string[] = [
    resolve(profilesDir, FIREFOX_PROFILE_DIR_SUFFIX_RELEASE),
    resolve(profilesDir, FIREFOX_PROFILE_DIR_SUFFIX),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not determine default profile directory from: ${profilesDir}`);
};

/**
 * Build a metadata map from extensions.json
 */
const buildMetadataMap = (params: Readonly<{ extensionsJson: FirefoxExtensionsJson }>): Record<string, string> => {
  const addons: readonly FirefoxAddOn[] = params.extensionsJson.addons ?? [];
  const map: Record<string, string> = {};
  for (const addon of addons) {
    const sourceUri: string | undefined = addon.sourceURI;
    if (!sourceUri) {
      continue;
    }
    const name: string = addon.defaultLocale?.name ?? addon.id ?? sourceUri;
    map[sourceUri] = name;
  }
  return map;
};

/**
 * Parse JSON with error handling
 */
const parseJson = <T>(params: Readonly<{ jsonText: string; filePathForErrors: string }>): T => {
  try {
    return JSON.parse(params.jsonText) as T;
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from ${params.filePathForErrors}: ${message}`);
  }
};

