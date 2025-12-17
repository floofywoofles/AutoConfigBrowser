import * as p from "@clack/prompts";
import { installXPIFromUrl, installXPIFromUrls } from "./tools/xpi";
import { writeUrlsJsonFromInstalledFirefoxExtensions } from "./tools/toJson";
import { getDefaultFirefoxProfileDirectoryPath, getExtensionMetadataMap } from "./tools/profile-discovery";

// Type definitions for extension menu items
type ExtensionMenuItem = Readonly<{
  value: string;
  label: string;
}>;

type UrlsJson = Readonly<{ urls: readonly string[] }>;

// Load and parse urls.json file
const loadUrlsJson = async (): Promise<UrlsJson | null> => {
  const urlsFile = Bun.file("./src/urls.json");
  if (!(await urlsFile.exists())) {
    return null;
  }
  try {
    const urlsJson = JSON.parse(await urlsFile.text()) as UrlsJson;
    return urlsJson;
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse urls.json: ${message}`);
    return null;
  }
};

// Build menu items with labels (name + URL) from installed extensions metadata
const buildExtensionMenuItems = async (urls: readonly string[]): Promise<ExtensionMenuItem[]> => {
  const items: ExtensionMenuItem[] = [];
  let metadataMap: Readonly<Record<string, string>> = {};
  try {
    const profileDirectoryPath: string = await getDefaultFirefoxProfileDirectoryPath();
    metadataMap = await getExtensionMetadataMap({ profileDirectoryPath });
  } catch {
    // If metadata cannot be loaded, proceed without labels
  }
  for (const url of urls) {
    const name: string = metadataMap[url] ?? "Unknown";
    const label: string = `${name} - ${url}`;
    items.push({ value: url, label });
  }
  return items;
};

// Main menu action: generate urls.json
const handleGenerateUrls = async (): Promise<void> => {
  const spinnerText = "Generating urls.json from installed extensions...";
  p.spinner();
  try {
    await writeUrlsJsonFromInstalledFirefoxExtensions();
    console.log("✓ Successfully generated urls.json");
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    console.error(`✗ Failed to generate urls.json: ${message}`);
  }
};

// Main menu action: install all extensions
const handleInstallAll = async (): Promise<void> => {
  const urlsJson: UrlsJson | null = await loadUrlsJson();
  if (!urlsJson) {
    console.error("✗ urls.json not found. Please generate it first.");
    return;
  }
  try {
    console.log(`Installing ${urlsJson.urls.length} extension(s)...`);
    await installXPIFromUrls();
    console.log("✓ All extensions installed successfully");
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    console.error(`✗ Error installing extensions: ${message}`);
  }
};

// Main menu action: install selected extensions
const handleInstallSelected = async (): Promise<void> => {
  const urlsJson: UrlsJson | null = await loadUrlsJson();
  if (!urlsJson) {
    console.error("✗ urls.json not found. Please generate it first.");
    return;
  }
  const menuItems: ExtensionMenuItem[] = await buildExtensionMenuItems(urlsJson.urls);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selected: any = await p.multiselect({
    message: "Select extensions to install",
    options: menuItems,
  });
  if (typeof selected === "symbol" || !Array.isArray(selected)) {
    console.log("Installation cancelled.");
    return;
  }
  const selectedUrls = selected as string[];
  if (selectedUrls.length === 0) {
    console.log("No extensions selected.");
    return;
  }
  try {
    console.log(`Installing ${selectedUrls.length} extension(s)...`);
    for (const url of selectedUrls) {
      try {
        await installXPIFromUrl(url);
      } catch (error) {
        const message: string = error instanceof Error ? error.message : String(error);
        console.error(`✗ Error installing ${url}: ${message}`);
      }
    }
    console.log("✓ Selected extensions installed");
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    console.error(`✗ Error during installation: ${message}`);
  }
};

// Main interactive loop
const runMainMenu = async (): Promise<void> => {
  let continueLoop: boolean = true;
  while (continueLoop) {
    const choice: string | symbol = await p.select({
      message: "Browser Extension Manager",
      options: [
        { value: "generate", label: "Generate urls.json from installed extensions" },
        { value: "install-all", label: "Install all from urls.json" },
        { value: "install-selected", label: "Install selected extension(s)" },
        { value: "exit", label: "Exit" },
      ],
    });
    if (typeof choice === "symbol") {
      console.log("Exiting...");
      continueLoop = false;
      continue;
    }
    const selectedChoice: string = choice;
    if (selectedChoice === "generate") {
      await handleGenerateUrls();
    } else if (selectedChoice === "install-all") {
      await handleInstallAll();
    } else if (selectedChoice === "install-selected") {
      await handleInstallSelected();
    } else if (selectedChoice === "exit") {
      continueLoop = false;
    }
  }
};

// CLI entrypoint
runMainMenu().catch((error: Error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
