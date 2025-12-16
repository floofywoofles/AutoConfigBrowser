// eslint-disable-next-line @typescript-eslint/no-var-requires
const xpiModule = require("xpi");
import { tmpdir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, statSync, copyFileSync } from "fs";

// Download the xpi files from the urls in the urls.json file
const urlsFile = Bun.file("./src/urls.json");

/**
 * Downloads an XPI file from a URL and returns it as an ArrayBuffer
 * @param url - The URL of the XPI file to download
 * @returns The downloaded file as an ArrayBuffer
 * @throws Error if download fails
 */
async function downloadXPI(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

/**
 * Extracts the extension ID from an XPI file's manifest.json
 * @param xpiFilePath - The file path to the XPI file
 * @returns The extension ID
 * @throws Error if extraction or parsing fails
 */
async function getExtensionId(xpiFilePath: string): Promise<string> {
    // Use Bun's spawn to extract manifest.json
    const proc = Bun.spawn(["unzip", "-p", xpiFilePath, "manifest.json"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const manifestText = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
        const errorText = await new Response(proc.stderr).text();
        throw new Error(`Failed to extract manifest.json: ${errorText}`);
    }
    const manifest = JSON.parse(manifestText);
    // Try manifest v2 format: applications.gecko.id
    if (manifest.applications?.gecko?.id) {
        return manifest.applications.gecko.id;
    }
    // Try manifest v3 format: browser_specific_settings.gecko.id
    if (manifest.browser_specific_settings?.gecko?.id) {
        return manifest.browser_specific_settings.gecko.id;
    }
    throw new Error("Could not find extension ID in manifest.json");
}

/**
 * Finds and validates the Firefox extensions directory
 * Parses profiles.ini to find the default profile and returns the extensions directory path
 * @returns The path to the Firefox extensions directory
 * @throws Error if profiles.ini is missing, empty, or profile/extensions directory not found
 */
async function getFirefoxExtensionsDirectory(): Promise<string> {
    const profilesIniPath = resolve(process.env.HOME || "", ".mozilla/firefox/profiles.ini");
    if (!existsSync(profilesIniPath)) {
        throw new Error("profiles.ini file not found");
    }
    const profilesContent = await Bun.file(profilesIniPath).text();
    if (!profilesContent) {
        throw new Error("profiles.ini file is empty");
    }
    // Parse profiles.ini to find the default profile
    // Format: [Install...] section has Default=profileName
    // Or [ProfileX] sections have Path=profileName and Default=1
    let profileName: string | null = null;
    const lines = profilesContent.split("\n");
    // First, try to find Default= in [Install...] section
    let inInstallSection = false;
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith("[Install")) {
            inInstallSection = true;
        } else if (trimmedLine.startsWith("[")) {
            inInstallSection = false;
        } else if (inInstallSection && trimmedLine.startsWith("Default=")) {
            const parts = trimmedLine.split("=");
            const defaultValue = parts[1];
            if (defaultValue !== undefined) {
                profileName = defaultValue.trim();
                break;
            }
        }
    }
    // If not found, look for profile with Default=1
    if (!profileName) {
        let currentProfilePath: string | null = null;
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("[Profile")) {
                currentProfilePath = null;
            } else if (trimmedLine.startsWith("Path=")) {
                const parts = trimmedLine.split("=");
                const pathValue = parts[1];
                if (pathValue !== undefined) {
                    currentProfilePath = pathValue.trim();
                }
            } else if (trimmedLine.startsWith("Default=1") && currentProfilePath) {
                profileName = currentProfilePath;
                break;
            }
        }
    }
    if (!profileName) {
        throw new Error("Could not find default profile in profiles.ini");
    }
    // Resolve the profile directory (handle both relative and absolute paths)
    const firefoxDir = resolve(process.env.HOME || "", ".mozilla/firefox");
    const profileDirectory = resolve(firefoxDir, profileName);
    const xpiDirectory = resolve(profileDirectory, "extensions");
    // Check if profile directory exists
    if (!existsSync(profileDirectory)) {
        throw new Error(`Profile directory not found: ${profileDirectory}`);
    }
    // Check if extensions directory exists, create it if it doesn't
    if (!existsSync(xpiDirectory)) {
        console.log(`Creating extensions directory: ${xpiDirectory}`);
        mkdirSync(xpiDirectory, { recursive: true });
    } else {
        // Verify it's actually a directory
        const stats = statSync(xpiDirectory);
        if (!stats.isDirectory()) {
            throw new Error(`extensions path exists but is not a directory: ${xpiDirectory}`);
        }
    }
    console.log(`Extensions directory ready: ${xpiDirectory}`);
    return xpiDirectory;
}

/**
 * Processes an XPI file using the xpi package's SourceEmitter
 * This extracts scripts and overlays from the XPI file
 * @param xpiFilePath - The file path to the XPI file
 * @returns A promise that resolves when processing is complete
 */
async function processXPI(xpiFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const xpiInstance = new xpiModule.SourceEmitter(xpiFilePath);
        const scripts: Array<{ fileName: string; source: string }> = [];
        const overlays: Array<{ fileName: string; source: string }> = [];
        xpiInstance.on("script", (script: { fileName: string; source: string }) => {
            scripts.push(script);
            console.log(`Found script: ${script.fileName}`);
        });
        xpiInstance.on("overlay", (overlay: { fileName: string; source: string }) => {
            overlays.push(overlay);
            console.log(`Found overlay: ${overlay.fileName}`);
        });
        xpiInstance.on("end", () => {
            console.log(`Processing complete. Found ${scripts.length} scripts and ${overlays.length} overlays.`);
            resolve();
        });
        xpiInstance.on("error", (error: Error) => {
            console.error(`Error processing XPI: ${error instanceof Error ? error.message : String(error)}`);
            reject(error);
        });
    });
}

/**
 * Installs an XPI file from a URL to Firefox
 * Downloads, processes, and installs a single XPI file
 * @param url - The URL of the XPI file to install
 * @throws Error if any step of the installation process fails
 */
async function installXPIFromUrl(url: string): Promise<void> {
    // Create a temporary file path
    const tempFilePath = join(tmpdir(), `xpi-${Date.now()}-${Math.random().toString(36).substring(7)}.xpi`);
    try {
        // Download and write the XPI file
        const xpiFileBuffer = await downloadXPI(url);
        await Bun.write(tempFilePath, xpiFileBuffer);
        console.log(`Downloaded XPI file: ${url}`);
        // Process the XPI file
        await processXPI(tempFilePath);
        console.log(`Processed XPI file: ${url}`);
        // Get the Firefox extensions directory
        const xpiDirectory = await getFirefoxExtensionsDirectory();
        // Extract extension ID from the XPI file
        const extensionId = await getExtensionId(tempFilePath);
        console.log(`Extension ID: ${extensionId}`);
        // Determine the target filename (extension ID.xpi)
        const targetXpiPath = resolve(xpiDirectory, `${extensionId}.xpi`);
        // Copy the XPI file to the extensions directory
        copyFileSync(tempFilePath, targetXpiPath);
        console.log(`Installed XPI file to: ${targetXpiPath}`);
    } finally {
        // Clean up the temporary file
        try {
            await Bun.file(tempFilePath).unlink();
        } catch (cleanupError) {
            console.warn(`Failed to delete temporary file ${tempFilePath}: ${cleanupError}`);
        }
    }
}

/**
 * Downloads XPI files from URLs and processes them
 * Downloads each file to a temporary location, processes it, then cleans up
 */
async function installXPIFromUrls(): Promise<void> {
    if (!(await urlsFile.exists())) {
        console.error("urls.json file not found");
        process.exit(1);
    }
    try {
        const urls = JSON.parse(await urlsFile.text());
        console.log(urls);
        for (const url of urls.urls) {
            try {
                await installXPIFromUrl(url);
            } catch (error) {
                console.error(`Error processing URL ${url}:`);
                console.error(error instanceof Error ? error.message : String(error));
                // Continue to the next URL instead of stopping the entire batch
            }
        }
    } catch (error) {
        console.error("Error processing XPI file");
        console.error(error instanceof Error ? error.message : String(error));
        throw error;
    }
}

export { downloadXPI, processXPI, installXPIFromUrl, installXPIFromUrls, getFirefoxExtensionsDirectory }; 